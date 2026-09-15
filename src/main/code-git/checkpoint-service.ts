// Checkpoint 时间机器：把工作区状态自动存档到独立 git 提交链上。
//
// 核心机制：
// - 用"临时 index"技术捕获工作区全量状态（含未跟踪文件）：
//   GIT_INDEX_FILE=<临时文件> git add -A && git write-tree
//   全程不触碰用户的真实 index / HEAD / 分支，用户与昔涟完全无感。
// - 快照提交用 git commit-tree 串成一条链，挂在 refs/cyrene-checkpoints/head。
//   这条 ref 让链上所有对象保持可达，git gc 不会回收。
// - 内容没变化（tree hash 相同）就跳过，不打冗余快照。
// - 回退 = read-tree + checkout-index 恢复目标快照内容，再删除
//   "目标快照里没有、当前磁盘上有"的文件（Trae 同款语义：整仓回到那一刻）。
//   回退前自动打一条 pre-restore 快照，后悔药永远存在。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import simpleGit from "simple-git";
import type { ChatSession } from "../../shared/chat-types";
import type {
  CheckpointDiff,
  CheckpointEntry,
  CheckpointKind,
} from "../../shared/code-workbench-types";
import type { ResolvedGitExecutable } from "./git-executable";

/** 每个仓库一条 checkpoint 链 */
export const CHECKPOINT_REF = "refs/cyrene-checkpoints/head";
/** git 空树的固定 hash，用于计算首条快照的 diff */
const EMPTY_TREE_HASH = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const MESSAGE_FIELD_SEP = "\u001f";
const RECORD_SEP = "\u001e";
/** diff patch 最多保留行数，超出截断 */
const MAX_PATCH_LINES = 800;

export interface CheckpointLogRecord {
  hash: string;
  timestamp: string;
  message: string;
}

export interface CheckpointStat {
  files: Array<{ file: string; insertions: number; deletions: number }>;
  insertions: number;
  deletions: number;
  truncated: boolean;
  patch: string;
}

/**
 * checkpoint 专用的低级 git 操作。与业务无关，便于 mock；
 * 实现见 createRealCheckpointClient。
 */
export interface CheckpointGitClient {
  /** 链顶快照；不存在返回 null（新仓库 / 从未快照过） */
  lastCheckpoint(): Promise<{ hash: string; tree: string } | null>;
  /** 把当前工作区状态（含未跟踪文件）写成一个 tree 对象，返回 tree hash */
  writeWorkspaceTree(): Promise<string>;
  commitTree(tree: string, parentHash: string | null, message: string): Promise<string>;
  updateRef(hash: string): Promise<void>;
  /** 全链记录，最新在前 */
  log(): Promise<CheckpointLogRecord[]>;
  /** 某快照相对其 parent（或空树）的 diff 统计与 patch */
  diffWithParent(hash: string): Promise<CheckpointStat>;
  /** 恢复目标快照的全部文件到工作区（只写不删） */
  checkoutTree(hash: string): Promise<void>;
  /** 目标快照包含的全部文件路径 */
  listTreeFiles(hash: string): Promise<string[]>;
  /** 当前磁盘上的文件集合（tracked + untracked，不含 gitignore 与 .git） */
  listWorkspaceFiles(): Promise<string[]>;
  deleteWorkspaceFiles(paths: string[]): Promise<void>;
}

export interface CheckpointServiceDeps {
  getSession: (sessionId: string) => ChatSession | null;
  resolveExecutable: () => Promise<ResolvedGitExecutable | null>;
  /** 测试注入点；缺省用 real 实现 */
  createClient?: (input: { workspaceRoot: string; executable: ResolvedGitExecutable }) => CheckpointGitClient;
  /** 工作区变化到自动快照的防抖窗口，默认 5000ms */
  debounceMs?: number;
  warn?: (message: string) => void;
}

export interface CheckpointService {
  /** 工作区变化通知（接 gitService.onChanged）；防抖后自动快照 */
  notifyActivity(sessionId: string): void;
  /** 立即打一条快照；工作区无变化返回 null */
  snapshot(sessionId: string, kind: CheckpointKind): Promise<CheckpointEntry | null>;
  /** 时间线（最新在前） */
  list(sessionId: string): Promise<CheckpointEntry[]>;
  /** 某条快照相对其上一条的 diff */
  diff(sessionId: string, hash: string): Promise<CheckpointDiff>;
  /** 整仓回退到目标快照；回退前自动打 pre-restore 快照 */
  restore(sessionId: string, hash: string): Promise<{ preRestoreHash: string; restoredHash: string }>;
  dispose(): void;
}

export function createCheckpointService(deps: CheckpointServiceDeps): CheckpointService {
  const createClient = deps.createClient ?? createRealCheckpointClient;
  const debounceMs = deps.debounceMs ?? 5_000;
  const warn = deps.warn ?? ((message: string) => console.warn(`[Checkpoint] ${message}`));
  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  function dispose(): void {
    for (const timer of debounceTimers.values()) clearTimeout(timer);
    debounceTimers.clear();
  }

  async function clientFor(sessionId: string): Promise<CheckpointGitClient> {
    const session = deps.getSession(sessionId);
    if (!session) throw new Error("找不到当前对话");
    if (session.mode !== "code") throw new Error("工作台只在 Code 模式可用");
    const workspaceRoot = session.workspaceBinding?.workspaceRoot;
    if (!workspaceRoot) throw new Error("尚未绑定代码目录");
    const executable = await deps.resolveExecutable();
    if (!executable) throw new Error("未检测到可用 Git");
    return createClient({ workspaceRoot, executable });
  }

  function buildMessage(kind: CheckpointKind, sessionId: string): string {
    return `checkpoint${MESSAGE_FIELD_SEP}${kind}${MESSAGE_FIELD_SEP}${sessionId}`;
  }

  function parseMessage(message: string): { kind: CheckpointKind; sessionId: string | null } {
    const parts = message.split(MESSAGE_FIELD_SEP);
    const kind: CheckpointKind = parts[1] === "pre-restore" || parts[1] === "manual" ? parts[1] : "auto";
    const sessionId = parts[2] && parts[2] !== "-" ? parts[2] : null;
    return { kind, sessionId };
  }

  async function snapshot(sessionId: string, kind: CheckpointKind): Promise<CheckpointEntry | null> {
    const client = await clientFor(sessionId);
    const last = await client.lastCheckpoint().catch(() => null);
    const tree = await client.writeWorkspaceTree();
    if (last && tree === last.tree) return null;

    const message = buildMessage(kind, sessionId);
    const hash = await client.commitTree(tree, last?.hash ?? null, message);
    await client.updateRef(hash);
    const stat = await client.diffWithParent(hash);
    return {
      hash,
      kind,
      sessionId,
      timestamp: new Date().toISOString(),
      files: stat.files.length,
      insertions: stat.insertions,
      deletions: stat.deletions,
    };
  }

  return {
    notifyActivity(sessionId) {
      const existing = debounceTimers.get(sessionId);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(() => {
        debounceTimers.delete(sessionId);
        void snapshot(sessionId, "auto").catch((error) => {
          warn(`自动快照失败（会话 ${sessionId}）：${errorMessage(error)}`);
        });
      }, debounceMs);
      debounceTimers.set(sessionId, timer);
    },

    snapshot,

    async list(sessionId) {
      const client = await clientFor(sessionId);
      const records = await client.log();
      return records.map((record) => ({
        hash: record.hash,
        ...parseMessage(record.message),
        timestamp: record.timestamp,
        // 时间线保持轻量：变更统计在查看单条 diff 时才取
        files: 0,
        insertions: 0,
        deletions: 0,
      }));
    },

    async diff(sessionId, hash) {
      assertHash(hash);
      const client = await clientFor(sessionId);
      const records = await client.log();
      const index = records.findIndex((record) => record.hash === hash);
      if (index < 0) throw new Error("快照不存在或已被清理");
      const stat = await client.diffWithParent(hash);
      return {
        fromHash: index + 1 < records.length ? records[index + 1].hash : null,
        toHash: hash,
        perFile: stat.files,
        insertions: stat.insertions,
        deletions: stat.deletions,
        truncated: stat.truncated,
        patch: stat.patch,
      };
    },

    async restore(sessionId, hash) {
      assertHash(hash);
      const client = await clientFor(sessionId);
      const records = await client.log();
      if (!records.some((record) => record.hash === hash)) {
        throw new Error("快照不存在或已被清理");
      }
      const preRestore = await snapshot(sessionId, "pre-restore");
      await client.checkoutTree(hash);
      const targetFiles = new Set(await client.listTreeFiles(hash));
      const currentFiles = await client.listWorkspaceFiles();
      const stale = computeFilesToDelete(currentFiles, targetFiles);
      if (stale.length) await client.deleteWorkspaceFiles(stale);
      return {
        preRestoreHash: preRestore?.hash ?? records[0].hash,
        restoredHash: hash,
      };
    },

    dispose,
  };
}

/**
 * 回退时要删除的文件 = 当前磁盘上有、目标快照里没有。
 * gitignore 的文件两边都不出现，天然免疫。
 */
export function computeFilesToDelete(currentFiles: string[], targetFiles: Set<string>): string[] {
  return currentFiles.filter((file) => !targetFiles.has(file));
}

function assertHash(hash: string): void {
  if (!/^[0-9a-fA-F]{40}$/.test(hash)) throw new Error("快照标识不合法");
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// real client（simple-git 实现）
// ---------------------------------------------------------------------------

function createRealCheckpointClient(input: { workspaceRoot: string; executable: ResolvedGitExecutable }): CheckpointGitClient {
  const baseEnv = input.executable.env ?? {};
  const git = simpleGit({
    baseDir: input.workspaceRoot,
    binary: input.executable.command,
    maxConcurrentProcesses: 1,
  });
  if (Object.keys(baseEnv).length) git.env(baseEnv);

  /** 带临时 index 的专用实例：GIT_INDEX_FILE 只作用于这些命令，不影响用户 index */
  function gitWithTempIndex(indexFile: string) {
    const instance = simpleGit({
      baseDir: input.workspaceRoot,
      binary: input.executable.command,
      maxConcurrentProcesses: 1,
    });
    return instance.env({ ...baseEnv, GIT_INDEX_FILE: indexFile });
  }

  function newTempIndexPath(): string {
    return path.join(os.tmpdir(), `cyrene-checkpoint-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  }

  return {
    async lastCheckpoint() {
      const hash = (await git.raw(["rev-parse", "--verify", `${CHECKPOINT_REF}^{commit}`]).catch(() => "")).trim();
      if (!hash) return null;
      const tree = (await git.raw(["rev-parse", `${hash}^{tree}`])).trim();
      return { hash, tree };
    },

    async writeWorkspaceTree() {
      const indexFile = newTempIndexPath();
      try {
        const tmp = gitWithTempIndex(indexFile);
        await tmp.raw(["add", "-A"]);
        return (await tmp.raw(["write-tree"])).trim();
      } finally {
        rmTempIndex(indexFile);
      }
    },

    async commitTree(tree, parentHash, message) {
      const args = parentHash
        ? ["commit-tree", tree, "-p", parentHash, "-m", message]
        : ["commit-tree", tree, "-m", message];
      return (await git.raw(args)).trim();
    },

    async updateRef(hash) {
      await git.raw(["update-ref", CHECKPOINT_REF, hash]);
    },

    async log() {
      const output = await git.raw([
        "log",
        CHECKPOINT_REF,
        `--pretty=format:%H${MESSAGE_FIELD_SEP}%aI${MESSAGE_FIELD_SEP}%s${RECORD_SEP}`,
      ]).catch(() => "");
      return output
        .split(RECORD_SEP)
        .map((entry) => entry.replace(/^\n/, ""))
        .filter((entry) => entry.trim().length > 0)
        .map((entry) => {
          const [hash, timestamp, message] = entry.split(MESSAGE_FIELD_SEP);
          return { hash, timestamp, message: message ?? "" };
        });
    },

    async diffWithParent(hash) {
      const parent = (await git.raw(["rev-parse", `${hash}^`]).catch(() => "")).trim();
      const from = parent || EMPTY_TREE_HASH;
      const range = `${from}..${hash}`;
      const [numstat, patch] = await Promise.all([
        git.raw(["diff", "--numstat", range]),
        git.raw(["diff", range]),
      ]);
      const files = numstat
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [insertions, deletions, file] = line.split("\t");
          return {
            file: file?.replace(/^"|"$/g, "") ?? "",
            insertions: /^\d+$/.test(insertions) ? Number(insertions) : 0,
            deletions: /^\d+$/.test(deletions) ? Number(deletions) : 0,
          };
        });
      const insertions = files.reduce((sum, item) => sum + item.insertions, 0);
      const deletions = files.reduce((sum, item) => sum + item.deletions, 0);
      const lines = patch.split("\n");
      const truncated = lines.length > MAX_PATCH_LINES;
      return {
        files,
        insertions,
        deletions,
        truncated,
        patch: truncated ? lines.slice(0, MAX_PATCH_LINES).join("\n") + "\n...（已截断）" : patch,
      };
    },

    async checkoutTree(hash) {
      const indexFile = newTempIndexPath();
      try {
        const tmp = gitWithTempIndex(indexFile);
        await tmp.raw(["read-tree", hash]);
        await tmp.raw(["checkout-index", "-f", "-a"]);
      } finally {
        rmTempIndex(indexFile);
      }
    },

    async listTreeFiles(hash) {
      const output = await git.raw(["ls-tree", "-r", "--name-only", hash]);
      return output.split("\n").map((line) => line.replace(/^"|"$/g, "")).filter(Boolean);
    },

    async listWorkspaceFiles() {
      const indexFile = newTempIndexPath();
      try {
        const tmp = gitWithTempIndex(indexFile);
        await tmp.raw(["add", "-A"]);
        const output = await tmp.raw(["ls-files", "--cached"]);
        return output.split("\n").filter(Boolean);
      } finally {
        rmTempIndex(indexFile);
      }
    },

    async deleteWorkspaceFiles(paths) {
      for (const relative of paths) {
        const absolute = path.resolve(input.workspaceRoot, relative);
        await fs.promises.unlink(absolute).catch((error: NodeJS.ErrnoException) => {
          if (error?.code !== "ENOENT") throw error;
        });
      }
    },
  };
}

function rmTempIndex(indexFile: string): void {
  try {
    fs.rmSync(indexFile, { force: true });
  } catch {
    // 临时 index 清理失败不影响主流程，留给系统临时目录清理
  }
}
