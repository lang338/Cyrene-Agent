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
/**
 * checkpoint 提交与用户身份无关，固定内部 ident。
 * 自带 Git 运行时屏蔽了系统/全局配置（GIT_CONFIG_NOSYSTEM / GIT_CONFIG_GLOBAL=NUL），
 * 用户机器也可能从没配过 user.name/email，不固定身份 commit-tree 会直接失败。
 */
const CHECKPOINT_IDENT_NAME = "Cyrene Checkpoint";
const CHECKPOINT_IDENT_EMAIL = "checkpoint@cyrene.local";
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
  /**
   * 回退冲突检测：目标快照中存在、当前磁盘上也存在（文件或符号链接），
   * 但现在被 gitignore 忽略的路径。
   * 这类路径不进任何快照（含回退前的 pre-restore 保底快照），
   * checkout-index -f 会不问一声直接覆盖，必须在回退前拦下。
   */
  findIgnoredCollisions(hash: string): Promise<string[]>;
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
      // 冲突检测必须在 pre-restore 保底快照之前：中止时不写任何快照、不动工作区
      const conflicts = await client.findIgnoredCollisions(hash);
      if (conflicts.length) throw new Error(buildRestoreConflictMessage(conflicts));
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

/** 冲突报错里最多点名的文件数，其余折叠为"另有 N 个" */
const MAX_CONFLICT_PATHS_SHOWN = 10;

/**
 * 构造回退冲突的中止错误文案：明确告诉用户哪些文件挡路、为什么危险、怎么处理。
 */
export function buildRestoreConflictMessage(conflicts: string[]): string {
  const shown = conflicts
    .slice(0, MAX_CONFLICT_PATHS_SHOWN)
    .map((file) => `  - ${file}`)
    .join("\n");
  const more =
    conflicts.length > MAX_CONFLICT_PATHS_SHOWN
      ? `\n  ……另有 ${conflicts.length - MAX_CONFLICT_PATHS_SHOWN} 个文件`
      : "";
  return [
    `回退已中止：检测到 ${conflicts.length} 个会被静默覆盖的文件。`,
    "这些文件目前被 .gitignore 忽略（不会进入任何快照，覆盖后无法恢复），但目标快照中存在同名文件：",
    `${shown}${more}`,
    "请先把它们移出目录、改名或取消忽略，再重新回退。",
  ].join("\n");
}

// ── 自动 git init 前的工作区预检 ─────────────────────────────────
/**
 * 非 git 目录允许全量快照的规模上限。
 * 真正的代码项目一般本身就是 git 仓库（走 .gitignore，快照只跟踪源码）；
 * 走到"自动 init"分支的普通文件夹不该到这个量级。
 */
const PREFLIGHT_MAX_FILES = 50_000;
const PREFLIGHT_MAX_TOTAL_BYTES = 1_500_000_000;
/** 目录扫描条目上限：超过即判规模过大并提前停止，避免在巨目录上长时间遍历 */
const PREFLIGHT_SCAN_LIMIT = 60_000;
/** 嵌套仓库报错里最多点名的路径数 */
const MAX_NESTED_REPO_PATHS_SHOWN = 5;

export type InitPreflightFinding =
  | { kind: "system-location" }
  | { kind: "nested-repos"; repos: string[] }
  | { kind: "too-large"; fileCount: number; totalBytes: number; scanLimitHit: boolean };

/**
 * 构造自动 init 预检失败的中止文案：明确点名问题、解释风险、给出处理方向。
 */
export function buildInitPreflightMessage(root: string, finding: InitPreflightFinding): string {
  if (finding.kind === "system-location") {
    return [
      "时间机器已中止：不能把系统根目录或用户主目录作为项目工作区。",
      `当前绑定：${root}`,
      "这里包含操作系统或用户的海量文件，全量快照会占满磁盘且极其缓慢。请在底栏项目选择器中绑定具体的项目文件夹。",
    ].join("\n");
  }
  if (finding.kind === "nested-repos") {
    const shown = finding.repos
      .slice(0, MAX_NESTED_REPO_PATHS_SHOWN)
      .map((repo) => `  - ${repo}`)
      .join("\n");
    const more = finding.repos.length > MAX_NESTED_REPO_PATHS_SHOWN
      ? `\n  ……另有 ${finding.repos.length - MAX_NESTED_REPO_PATHS_SHOWN} 个`
      : "";
    return [
      `时间机器已中止：该文件夹内含 ${finding.repos.length} 个独立的 Git 仓库，快照只能把它们记成占位符，无法保存仓库内部的文件改动：`,
      `${shown}${more}`,
      "请直接绑定具体的项目目录，而不是多个项目的父文件夹。",
    ].join("\n");
  }
  const gb = (finding.totalBytes / 1_000_000_000).toFixed(1);
  const scanNote = finding.scanLimitHit ? "（文件过多，统计在扫描上限处提前停止）" : "";
  return [
    `时间机器已中止：文件夹规模过大（约 ${finding.fileCount} 个文件 / ${gb} GB）${scanNote}，全量快照会非常缓慢并占用大量磁盘。`,
    "请绑定更具体的项目目录。如果目录里主要是 node_modules 等可重建的依赖，请先在该目录执行 git init 并配置 .gitignore，再使用时间机器。",
  ].join("\n");
}

/**
 * 解析 `git -z`（NUL 分隔）输出。
 * 默认 git 会按 core.quotepath 把非 ASCII 路径转义成八进制串（如 "你好.ts" →
 * "\344\275\240..."），按行 split 后拿到的是假文件名；-z 输出原始字节路径，
 * 用 NUL 分隔才不会在回退删文件时 ENOENT。
 */
export function splitNulOutput(output: string): string[] {
  return output.split("\0").filter((entry) => entry.length > 0);
}

function assertHash(hash: string): void {
  if (!/^[0-9a-fA-F]{40}$/.test(hash)) throw new Error("快照标识不合法");
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

/** 大小写不敏感、去掉结尾分隔符的路径比较（Windows 盘符/用户目录可能写法不一） */
function normalizeForCompare(target: string): string {
  return path.resolve(target).replace(/[\\/]+$/, "").toLowerCase();
}

/**
 * 绝不允许作为时间机器工作区的位置：盘符根、用户主目录、系统与程序安装目录。
 * 只匹配目录本身；子目录由规模上限兜底。
 */
function findDeniedSystemLocation(root: string): boolean {
  const target = normalizeForCompare(root);
  const candidates = [
    path.parse(root).root,
    os.homedir(),
    process.env.SystemRoot,
    process.env.ProgramFiles,
    process.env["ProgramFiles(x86)"],
    process.env.ProgramData,
  ]
    .filter((candidate): candidate is string => Boolean(candidate))
    .map(normalizeForCompare);
  return candidates.includes(target);
}

function toPosix(relative: string): string {
  return relative.split(path.sep).join("/");
}

/**
 * 对"即将自动 git init 的非 git 目录"做体检，返回需要中止的原因；null 表示可以 init。
 * 拦三类典型误绑定（任一都不静默继续）：
 * 1. 系统根/用户主目录；
 * 2. 内含独立 .git 的父目录——git 只会把内部仓库记成占位符（gitlink），
 *    用户的代码改动一条都进不了快照，是"看似在保护、实际没保护"的陷阱；
 * 3. 规模失控的目录（如安装好的应用本体）——全量 add 会产出 GB 级 .git、快照长期卡顿。
 * 扫描有条目数上限，绝不跟随符号链接（防环、防越出工作区）。
 */
async function preflightNonGitFolder(root: string): Promise<InitPreflightFinding | null> {
  if (findDeniedSystemLocation(root)) return { kind: "system-location" };

  const nestedRepos: string[] = [];
  let fileCount = 0;
  let totalBytes = 0;
  let scanned = 0;
  let scanLimitHit = false;
  let overLimit = false;

  async function walk(dir: string, depth: number): Promise<void> {
    if (scanLimitHit) return;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      // 单个目录无权限/被删：跳过，不因预检本身阻断流程（git add 阶段会再报错）
      return;
    }
    for (const entry of entries) {
      if (scanLimitHit) return;
      scanned += 1;
      if (scanned > PREFLIGHT_SCAN_LIMIT) {
        scanLimitHit = true;
        return;
      }
      const full = path.join(dir, entry.name);
      // 任何层级的 .git 都不进入扫描；depth>0 的属于嵌套仓库，需要点名
      if (entry.name === ".git") {
        if (depth > 0) nestedRepos.push(toPosix(path.relative(root, full)));
        continue;
      }
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
      } else if (entry.isFile()) {
        fileCount += 1;
        // 已确认超规模后不再逐个 stat，继续走目录只为了发现嵌套 .git
        if (!overLimit) {
          try {
            totalBytes += (await fs.promises.lstat(full)).size;
          } catch {
            // 扫描期间文件被删/锁定：忽略单个 stat 失败
          }
          if (fileCount > PREFLIGHT_MAX_FILES || totalBytes > PREFLIGHT_MAX_TOTAL_BYTES) {
            overLimit = true;
          }
        }
      }
    }
  }

  await walk(root, 0);

  if (scanLimitHit || overLimit) {
    return { kind: "too-large", fileCount, totalBytes, scanLimitHit };
  }
  if (nestedRepos.length > 0) return { kind: "nested-repos", repos: nestedRepos };
  return null;
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

  /**
   * checkpoint 追求字节级快照/还原，必须关掉 git 的换行符转换：
   * Windows 上 Git for Windows 默认 core.autocrlf=true，会在 add 时 CRLF→LF、
   * checkout 时 LF→CRLF，导致回退后文件内容与快照那一刻不完全一致。
   * 用命令级 -c 覆盖，不写入仓库或用户的 git config。
   */
  const NO_CRLF = ["-c", "core.autocrlf=false"] as const;

  /** check-ignore 单批路径数：防止 Windows 命令行长度超限（约 32k 字符） */
  const CHECK_IGNORE_BATCH = 100;

  function newTempIndexPath(): string {
    return path.join(os.tmpdir(), `cyrene-checkpoint-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  }

  /**
   * 时间机器对"普通文件夹"也要可用：工作区不是 git 仓库时，首次写操作前静默 git init。
   * init 只在该目录建 .git（文件树对用户隐藏 .git），不提交、不动用户文件；
   * 提交身份走固定 ident 环境变量，不依赖也不污染用户的 git 配置。
   * init 之前必须过预检：系统目录/嵌套仓库/超规模目录一律中止并点名，
   * 绝不静默 init 出 GB 级无用仓库（见 preflightNonGitFolder）。
   */
  let repoReady = false;
  async function ensureRepo(): Promise<void> {
    if (repoReady) return;
    const inside = (await git.raw(["rev-parse", "--is-inside-work-tree"]).catch(() => "")).trim();
    if (inside !== "true") {
      const finding = await preflightNonGitFolder(input.workspaceRoot);
      if (finding) throw new Error(buildInitPreflightMessage(input.workspaceRoot, finding));
      await git.raw(["init", "--quiet"]);
    }
    repoReady = true;
  }

  return {
    async lastCheckpoint() {
      const hash = (await git.raw(["rev-parse", "--verify", `${CHECKPOINT_REF}^{commit}`]).catch(() => "")).trim();
      if (!hash) return null;
      const tree = (await git.raw(["rev-parse", `${hash}^{tree}`])).trim();
      return { hash, tree };
    },

    async writeWorkspaceTree() {
      await ensureRepo();
      const indexFile = newTempIndexPath();
      try {
        const tmp = gitWithTempIndex(indexFile);
        await tmp.raw([...NO_CRLF, "add", "-A"]);
        return (await tmp.raw(["write-tree"])).trim();
      } finally {
        rmTempIndex(indexFile);
      }
    },

    async commitTree(tree, parentHash, message) {
      const args = parentHash
        ? ["commit-tree", tree, "-p", parentHash, "-m", message]
        : ["commit-tree", tree, "-m", message];
      // 独立实例注入固定 ident：不依赖用户/系统 git 配置（自带运行时已屏蔽它们）
      const identified = simpleGit({
        baseDir: input.workspaceRoot,
        binary: input.executable.command,
        maxConcurrentProcesses: 1,
      }).env({
        ...baseEnv,
        GIT_AUTHOR_NAME: CHECKPOINT_IDENT_NAME,
        GIT_AUTHOR_EMAIL: CHECKPOINT_IDENT_EMAIL,
        GIT_COMMITTER_NAME: CHECKPOINT_IDENT_NAME,
        GIT_COMMITTER_EMAIL: CHECKPOINT_IDENT_EMAIL,
      });
      return (await identified.raw(args)).trim();
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
      // core.quotepath=false：非 ASCII 文件名在 numstat/patch 里保持原文，不转义成八进制串
      const [numstat, patch] = await Promise.all([
        git.raw(["-c", "core.quotepath=false", "diff", "--numstat", range]),
        git.raw(["-c", "core.quotepath=false", "diff", range]),
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
        await tmp.raw([...NO_CRLF, "checkout-index", "-f", "-a"]);
      } finally {
        rmTempIndex(indexFile);
      }
    },

    async listTreeFiles(hash) {
      // -z：NUL 分隔的原始路径，中文等非 ASCII 文件名不被 quotepath 转义
      const output = await git.raw(["ls-tree", "-r", "-z", "--name-only", hash]);
      return splitNulOutput(output);
    },

    async findIgnoredCollisions(hash) {
      // 第一步：目标树里的文件，只保留磁盘上真实存在的（文件/符号链接）
      const treeFiles = await this.listTreeFiles(hash);
      const existing: string[] = [];
      await Promise.all(
        treeFiles.map(async (relative) => {
          try {
            const stat = await fs.promises.lstat(path.resolve(input.workspaceRoot, relative));
            if (stat.isFile() || stat.isSymbolicLink()) existing.push(relative);
          } catch {
            // 磁盘上不存在：checkout 是新建而非覆盖，无碰撞
          }
        }),
      );
      // 第二步：批量问 git 哪些路径当前被忽略（已跟踪文件 git 自动不报，
      // 那些文件的内容在用户自己的 git 历史里可达，不属于数据丢失场景）
      const conflicts = new Set<string>();
      for (let index = 0; index < existing.length; index += CHECK_IGNORE_BATCH) {
        const batch = existing.slice(index, index + CHECK_IGNORE_BATCH);
        // 无匹配时 check-ignore 退出码为 1，simple-git 会 reject，按"本批无冲突"处理
        const output = await git
          .raw(["-c", "core.quotepath=false", "check-ignore", "--", ...batch])
          .catch(() => "");
        for (const line of output.split("\n")) {
          if (line.length > 0) conflicts.add(line.replace(/\r$/, ""));
        }
      }
      return [...conflicts].sort();
    },

    async listWorkspaceFiles() {
      const indexFile = newTempIndexPath();
      try {
        const tmp = gitWithTempIndex(indexFile);
        await tmp.raw(["add", "-A"]);
        const output = await tmp.raw(["ls-files", "-z", "--cached"]);
        return splitNulOutput(output);
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
