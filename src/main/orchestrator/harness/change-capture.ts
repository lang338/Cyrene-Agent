// 改动账本的抓取层：在"会写工作区文件"的工具执行前后各取一次内容快照。
//
// 为什么放在调度层，而不是让每个写文件工具自己上报：
// 工具只回结构化证据（路径 + 增删行数），**不含旧内容**；而回退必须要旧内容。
// 让每个工具把全文塞进证据里，会把这段数据一路带进模型上下文（证据也会发给模型），代价太大。
// 在调度层"执行前抢一份"是最省的做法，也顺带覆盖了将来新加的写文件工具（按 risk 判定，不按名字）。
//
// 三个硬约束：
// 1. 只在工作区内记账（越界路径一律不记）；
// 2. 二进制与超限文件只记"被改过"，不记内容——记不住内容就不该假装能回退；
// 3. 抓取失败绝不打断 AI 运行（记账是附加能力，不是主流程）。

import * as fs from "node:fs";
import * as path from "node:path";
import type { LedgerChangeKind, LedgerSkipReason, LedgerSource } from "../../../shared/code-workbench-types";
import { DEFAULT_MAX_TEXT_BYTES, type ChangeLedger } from "../../code-git/change-ledger-service";
import { extractFileChangesFromOutput } from "../tools/registry/tool-evidence";

/** 永不记账的目录：这些位置的改动不需要回退（要么是依赖，要么是产物，重装/重建即可） */
const EXCLUDED_SEGMENTS = new Set(["node_modules", ".git", "dist", "build", "out", "models"]);

/** 写文件工具的路径参数：不同工具叫法不同，逐个列出来比"猜字段名"稳 */
const PATH_ARG_KEYS = ["path", "file_path", "filePath", "filename", "file"];

/** 本轮基线的缓存条目上限：只保留最近几轮，避免长会话里无限增长 */
const MAX_CACHED_RUNS = 8;

export interface ChangeCaptureInput {
  ledger?: ChangeLedger;
  toolId: string;
  /** 工具的 risk 标记；只有 fs-write 才需要抓取 */
  risk?: string;
  args: Record<string, unknown>;
  conversationId?: string;
  runId?: string;
  workspaceRoot?: string;
  /** 本轮的用户消息，作为时间线上的标签 */
  label?: string;
}

export interface ChangeCaptureSession {
  /** 工具执行结束后调用；best-effort，内部已吞掉异常 */
  finish(output: string | undefined): Promise<void>;
}

/** 本轮基线：同一轮同一文件只认第一次看到的版本（否则第二次会拿到中间态）。
 *  值语义：string=内容；null=文件当时不存在；undefined=内容未入库（不可回退） */
const runBaselines = new Map<string, Map<string, string | null | undefined>>();

/** 仅供测试：清掉进程内缓存 */
export function resetChangeCaptureCache(): void {
  runBaselines.clear();
}

export async function beginChangeCapture(input: ChangeCaptureInput): Promise<ChangeCaptureSession | null> {
  const { ledger, conversationId, runId, workspaceRoot } = input;
  if (!ledger || !conversationId || !runId || !workspaceRoot) return null;
  if (input.risk !== "fs-write") return null;

  const candidates = extractWriteTargets(input.toolId, input.args);
  if (candidates.length === 0) return null;

  const runKey = `${conversationId}:${runId}`;
  const baseline = runBaselines.get(runKey) ?? new Map<string, string | null | undefined>();
  runBaselines.delete(runKey);
  runBaselines.set(runKey, baseline);
  while (runBaselines.size > MAX_CACHED_RUNS) {
    const oldest = runBaselines.keys().next().value;
    if (oldest === undefined) break;
    runBaselines.delete(oldest);
  }

  for (const candidate of candidates) {
    const relPath = toWorkspaceRelative(candidate, workspaceRoot);
    if (!relPath) continue;
    if (baseline.has(relPath)) continue; // 本轮已经记过：保留最早那份
    const read = await readFileForLedger(path.join(workspaceRoot, relPath));
    // 基线拿不到内容（二进制/超限/读不了）时，只记"改动后"，回退时该文件会被标为不可恢复
    baseline.set(relPath, read.kind === "content" ? read.content : undefined);
  }

  return {
    async finish(output) {
      try {
        const changes = extractFileChangesFromOutput(output);
        if (!changes?.length) return;
        for (const change of changes) {
          const relPath = toWorkspaceRelative(change.file, workspaceRoot);
          if (!relPath) continue;
          const hasBaseline = baseline.has(relPath) && baseline.get(relPath) !== undefined;
          const before = hasBaseline ? baseline.get(relPath) : undefined;
          const read = change.kind === "deleted"
            ? { kind: "content" as const, content: null }
            : await readFileForLedger(path.join(workspaceRoot, relPath));
          await ledger.record({
            conversationId,
            runId,
            toolCallId: "",
            toolId: input.toolId,
            path: relPath,
            kind: toKind(change.kind),
            source: "ai" as LedgerSource,
            insertions: change.insertions ?? 0,
            deletions: change.deletions ?? 0,
            ...(hasBaseline ? { before } : {}),
            after: read.kind === "content" ? read.content : undefined,
            ...(read.kind === "skipped" ? { afterSkipped: read.reason } : {}),
            ...(input.label ? { label: input.label } : {}),
          });
        }
      } catch (error) {
        // 记账失败不能影响 AI 主流程，只留一条告警
        console.warn("[change-ledger] 记录失败，已跳过:", error);
      }
    },
  };
}

/** 从工具参数里抽出"可能被写的文件" */
export function extractWriteTargets(toolId: string, args: Record<string, unknown>): string[] {
  const targets: string[] = [];
  for (const key of PATH_ARG_KEYS) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) targets.push(value.trim());
  }
  // apply_patch：路径写在补丁文本里
  if (typeof args.patch === "string") {
    for (const match of args.patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)) {
      targets.push(match[1].trim());
    }
    for (const match of args.patch.matchAll(/^\*\*\* Move to: (.+)$/gm)) {
      targets.push(match[1].trim());
    }
  }
  // ast_grep_replace：paths 可能是目录或 "."，只取看起来是文件的（目录展开成本高且多半不在工作区语义内）
  if (Array.isArray(args.paths)) {
    for (const entry of args.paths) {
      if (typeof entry === "string" && path.extname(entry.trim())) targets.push(entry.trim());
    }
  }
  void toolId;
  return [...new Set(targets)];
}

/** 工具给的路径 → 工作区相对路径（正斜杠）；工作区外/非法一律 null */
export function toWorkspaceRelative(candidate: string, workspaceRoot: string): string | null {
  const raw = candidate.trim();
  if (!raw || raw.includes("\0")) return null;
  const slashed = raw.replace(/\\/g, "/");
  const root = workspaceRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!root) return null;

  const caseInsensitive = /^[a-z]:/i.test(root);
  const comparedRoot = caseInsensitive ? root.toLowerCase() : root;
  const compared = caseInsensitive ? slashed.toLowerCase() : slashed;

  let rest: string;
  if (compared === comparedRoot) return null; // 工作区根目录本身不是文件
  if (compared.startsWith(`${comparedRoot}/`)) {
    rest = slashed.slice(root.length + 1);
  } else if (/^[a-z]:/i.test(slashed) || slashed.startsWith("/")) {
    return null; // 绝对路径且不在工作区内
  } else {
    rest = slashed.replace(/^\.\//, "");
  }
  const parts = rest.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.length === 0 || parts.some((part) => part === "..")) return null;
  if (parts.some((part) => EXCLUDED_SEGMENTS.has(part))) return null;
  return parts.join("/");
}

function toKind(kind: string): LedgerChangeKind {
  if (kind === "added") return "create";
  if (kind === "deleted") return "delete";
  return "modify";
}

type LedgerReadOutcome =
  | { kind: "content"; content: string | null }
  | { kind: "skipped"; reason: LedgerSkipReason };

/**
 * 读一份文件内容给账本用。
 * 判定顺序刻意是"先 stat 看大小再读"：避免为一个 200MB 的文件白读一遍。
 * 返回 content:null 表示"文件不在"（删除语义），skipped 表示"内容没入库、不可回退"。
 */
async function readFileForLedger(absolute: string): Promise<LedgerReadOutcome> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(absolute);
  } catch {
    return { kind: "content", content: null };
  }
  if (!stat.isFile()) return { kind: "content", content: null };
  if (stat.size > DEFAULT_MAX_TEXT_BYTES) return { kind: "skipped", reason: "too-large" };
  let buffer: Buffer;
  try {
    buffer = await fs.promises.readFile(absolute);
  } catch {
    return { kind: "skipped", reason: "unreadable" };
  }
  if (isBinary(buffer)) return { kind: "skipped", reason: "binary" };
  return { kind: "content", content: buffer.toString("utf8") };
}

/** 前 8KB 出现 NUL 字节即视为二进制（与工作台编辑器同一口径） */
function isBinary(buffer: Buffer): boolean {
  const scanLength = Math.min(buffer.length, 8192);
  for (let index = 0; index < scanLength; index += 1) {
    if (buffer[index] === 0) return true;
  }
  return false;
}
