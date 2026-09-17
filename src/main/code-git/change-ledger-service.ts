// 工作台"改动账本"：只记录被改动过的**文件内容**，不记录整个工作区。
//
// 为什么不用 checkpoint 那套（工作区 git tree）：那套要求工作区是 git 仓库、且文件数/体积不超限，
// 真实使用里工作区常常是一个"装了很多东西的父目录"，于是它静默失效。改动级记录没有这两个前提。
//
// 为什么自己管内容库而不是借 git：我们只需要"按内容去重地存文本"这一件事，
// 不需要 git 的历史与 diff（diff 交给渲染端的 Monaco DiffEditor），
// 这样连 git 可执行文件都不依赖——工作区不是仓库、甚至没装 git 也能记账。

import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import type {
  LedgerChangeKind,
  LedgerFileChange,
  LedgerFileVersions,
  LedgerRestoreResult,
  LedgerRound,
  LedgerSkipReason,
  LedgerSource,
  LedgerUsage,
} from "../../shared/code-workbench-types";

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

/** 单文件文本上限：超过只记"被改过"，不存内容（5MB 对齐业界同类插件默认值） */
export const DEFAULT_MAX_TEXT_BYTES = 5 * 1024 * 1024;
/** 内容库总配额（全局，跨会话） */
export const DEFAULT_MAX_TOTAL_BYTES = 500 * 1024 * 1024;
/** 提示线：用到这个比例就该提示用户清理 */
export const DEFAULT_WARN_RATIO = 0.8;
/** 淘汰目标：一旦超配额，回收到这个比例以下，避免在临界点反复淘汰 */
const EVICT_TARGET_RATIO = 0.7;

/** 落盘的一行记录（内容存对象库，这里只存哈希） */
interface LedgerLine {
  at: number;
  conversationId: string;
  runId: string;
  toolCallId: string;
  toolId: string;
  /** 工作区相对路径（正斜杠） */
  path: string;
  kind: LedgerChangeKind;
  source: LedgerSource;
  insertions: number;
  deletions: number;
  /** 改动前内容：null=当时不存在；缺字段=没有基线 */
  beforeHash?: string | null;
  /** 改动后内容：null=改动后不存在（删除）；缺字段=内容未入库（不可当作删除） */
  afterHash?: string | null;
  /** 内容未入库的原因 */
  skipped?: LedgerSkipReason;
  /** 展示用标签（发起这一轮的用户消息，已截断） */
  label?: string;
}

export interface ChangeLedgerLimits {
  maxTextBytes: number;
  maxTotalBytes: number;
  warnRatio: number;
}

export interface RecordChangeInput {
  conversationId: string;
  runId: string;
  toolCallId: string;
  toolId: string;
  /** 工作区相对路径（正斜杠） */
  path: string;
  kind: LedgerChangeKind;
  source: LedgerSource;
  insertions: number;
  deletions: number;
  /** 改动前内容：undefined=没拿到基线；null=当时不存在 */
  before?: string | null;
  beforeSkipped?: LedgerSkipReason;
  /** 改动后内容：null=删除；undefined=内容未知（未入库），不可当作删除 */
  after: string | null | undefined;
  afterSkipped?: LedgerSkipReason;
  label?: string;
}

export interface RecordChangeResult {
  /** 配额淘汰掉的轮次（调用方据此提示用户） */
  evicted: Array<{ conversationId: string; roundId: string }>;
}

export interface ChangeLedger {
  record(input: RecordChangeInput): Promise<RecordChangeResult>;
  listRounds(conversationId: string): Promise<LedgerRound[]>;
  fileVersions(conversationId: string, roundId: string, relPath: string): Promise<LedgerFileVersions>;
  restore(conversationId: string, roundId: string, workspaceRoot: string): Promise<LedgerRestoreResult>;
  usage(): Promise<LedgerUsage>;
  /** 按轮删除（用户手动清理） */
  pruneRounds(conversationId: string, roundIds: string[]): Promise<void>;
  /** 会话删除时清账（避免孤儿目录） */
  dropConversation(conversationId: string): Promise<void>;
  /** 读一份内容（给测试与内部复用） */
  readContent(hash: string): Promise<string | null>;
}

export interface ChangeLedgerDeps {
  /** 账本根目录（userData/cyrene-changes） */
  rootDir: string;
  limits?: Partial<ChangeLedgerLimits>;
  now?: () => number;
}

export function createChangeLedger(deps: ChangeLedgerDeps): ChangeLedger {
  const limits: ChangeLedgerLimits = {
    maxTextBytes: deps.limits?.maxTextBytes ?? DEFAULT_MAX_TEXT_BYTES,
    maxTotalBytes: deps.limits?.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES,
    warnRatio: deps.limits?.warnRatio ?? DEFAULT_WARN_RATIO,
  };
  const now = deps.now ?? (() => Date.now());
  const objectsDir = path.join(deps.rootDir, "objects");
  const sessionsDir = path.join(deps.rootDir, "sessions");
  /** 单会话写入串行化：补丁/多文件写会在同一轮里连续落多条，避免并发追加交错 */
  let tail: Promise<unknown> = Promise.resolve();

  function enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = tail.then(work, work);
    tail = next.catch(() => undefined);
    return next;
  }

  function sessionFile(conversationId: string): string {
    // 会话 ID 是 uuid，但仍过一遍白名单，避免路径拼接被注入
    const safe = conversationId.replace(/[^a-zA-Z0-9_-]/g, "_");
    return path.join(sessionsDir, `${safe}.jsonl`);
  }

  function objectPath(hash: string): string {
    return path.join(objectsDir, hash.slice(0, 2), hash);
  }

  /**
   * 写入内容并返回哈希；同内容只落一份（内容寻址去重）。
   * 超过单文件上限时返回 null 表示"未入库"，由调用方标记原因。
   */
  async function putContent(content: string): Promise<{ hash: string } | { skipped: LedgerSkipReason }> {
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > limits.maxTextBytes) return { skipped: "too-large" };
    const hash = createHash("sha256").update(content, "utf8").digest("hex");
    const target = objectPath(hash);
    if (!fs.existsSync(target)) {
      const packed = await gzip(Buffer.from(content, "utf8"));
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      // 先写临时文件再改名：避免中断留下半截对象被后续当成有效内容读出
      const temp = `${target}.${process.pid}.tmp`;
      await fs.promises.writeFile(temp, packed);
      await fs.promises.rename(temp, target);
      // 新对象落盘：增量维护总占用，配额检查就不必再扫目录
      if (cachedTotalBytes !== null) cachedTotalBytes += packed.byteLength;
    }
    return { hash };
  }

  async function readLines(conversationId: string): Promise<LedgerLine[]> {
    const file = sessionFile(conversationId);
    let raw: string;
    try {
      raw = await fs.promises.readFile(file, "utf8");
    } catch {
      return [];
    }
    const lines: LedgerLine[] = [];
    for (const text of raw.split("\n")) {
      if (!text.trim()) continue;
      try {
        lines.push(JSON.parse(text) as LedgerLine);
      } catch {
        // 单行损坏不影响其余历史：跳过
      }
    }
    return lines;
  }

  async function writeLines(conversationId: string, lines: LedgerLine[]): Promise<void> {
    await fs.promises.mkdir(sessionsDir, { recursive: true });
    const body = lines.map((line) => JSON.stringify(line)).join("\n");
    await fs.promises.writeFile(sessionFile(conversationId), body ? `${body}\n` : "", "utf8");
  }

  async function appendLine(line: LedgerLine): Promise<void> {
    await fs.promises.mkdir(sessionsDir, { recursive: true });
    await fs.promises.appendFile(sessionFile(line.conversationId), `${JSON.stringify(line)}\n`, "utf8");
  }

  async function listSessionIds(): Promise<string[]> {
    try {
      const entries = await fs.promises.readdir(sessionsDir);
      return entries.filter((name) => name.endsWith(".jsonl")).map((name) => name.slice(0, -6));
    } catch {
      return [];
    }
  }

  /**
   * 对象库总占用（内容寻址去重后的真实磁盘开销）。
   * 带内存缓存：每条记录都要查配额，不能每次都把对象目录整个 stat 一遍——
   * 500MB 配额下对象可能上万，那会让每次 AI 写文件都背上几万次 stat。
   */
  let cachedTotalBytes: number | null = null;

  async function totalBytes(): Promise<number> {
    if (cachedTotalBytes === null) cachedTotalBytes = await scanTotalBytes();
    return cachedTotalBytes;
  }

  async function scanTotalBytes(): Promise<number> {
    let sum = 0;
    async function walk(dir: string): Promise<void> {
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.isFile()) sum += (await fs.promises.stat(full)).size;
      }
    }
    await walk(objectsDir);
    return sum;
  }

  /** 把账本里的哈希与"被引用的内容"对齐：删掉没人引用的对象（按轮删除后回收空间） */
  async function collectGarbage(): Promise<void> {
    const referenced = new Set<string>();
    for (const sessionId of await listSessionIds()) {
      for (const line of await readLines(sessionId)) {
        if (line.beforeHash) referenced.add(line.beforeHash);
        if (line.afterHash) referenced.add(line.afterHash);
      }
    }
    async function walk(dir: string): Promise<void> {
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
          continue;
        }
        if (!referenced.has(entry.name)) await fs.promises.rm(full, { force: true });
      }
    }
    await walk(objectsDir);
    // 刚删过对象：缓存的占用数字不再可信，下次重新统计
    cachedTotalBytes = null;
  }

  /**
   * 按轮次取"最早一条"：一字不改地保留"回到这一轮之前"的语义。
   * 同一轮里同一文件被改多次时，只有第一次的 before 是这一轮开始时的状态。
   */
  function earliestPerPath(lines: LedgerLine[]): LedgerLine[] {
    const byPath = new Map<string, LedgerLine>();
    for (const line of lines) {
      if (!byPath.has(line.path)) byPath.set(line.path, line);
    }
    return [...byPath.values()];
  }

  /**
   * 读一个哈希字段的三态语义。
   * 缺字段 = 内容没入库（不可回退/不可比对）；null = 当时不存在；字符串 = 内容哈希。
   */
  function hashField(line: LedgerLine, field: "beforeHash" | "afterHash"): { known: false } | { known: true; hash: string | null } {
    const value = field === "beforeHash" ? line.beforeHash : line.afterHash;
    if (value === undefined) return { known: false };
    return { known: true, hash: value };
  }

  /** 配额检查：超了就按"轮次从旧到新"整轮淘汰，直到回落到目标水位 */
  async function enforceQuota(): Promise<Array<{ conversationId: string; roundId: string }>> {
    if ((await totalBytes()) <= limits.maxTotalBytes) return [];
    // 收集所有会话的轮次，按该轮最早一条记录的时间排序
    const rounds: Array<{ conversationId: string; roundId: string; at: number }> = [];
    for (const sessionId of await listSessionIds()) {
      const lines = await readLines(sessionId);
      const firstAt = new Map<string, number>();
      for (const line of lines) {
        const seen = firstAt.get(line.runId);
        if (seen === undefined || line.at < seen) firstAt.set(line.runId, line.at);
      }
      for (const [roundId, at] of firstAt) rounds.push({ conversationId: sessionId, roundId, at });
    }
    rounds.sort((left, right) => left.at - right.at);

    const target = limits.maxTotalBytes * EVICT_TARGET_RATIO;
    const evicted: Array<{ conversationId: string; roundId: string }> = [];
    // 永远保留最新一轮：刚发生的改动不能刚写进来就被自己淘汰掉
    const newest = rounds.length > 0 ? `${rounds[rounds.length - 1].conversationId}:${rounds[rounds.length - 1].roundId}` : "";
    for (const round of rounds) {
      if (`${round.conversationId}:${round.roundId}` === newest) continue;
      if ((await totalBytes()) <= target) break;
      await pruneRoundsUnlocked(round.conversationId, [round.roundId]);
      // 每淘汰一轮就立刻回收它的内容对象：
      // 只删 jsonl 行的话，下一轮 totalBytes() 仍然把那些对象算进去，
      // 判定永远不达标 → 循环会把历史一路删到只剩最新一轮（且跨所有会话）。
      await collectGarbage();
      evicted.push({ conversationId: round.conversationId, roundId: round.roundId });
    }
    return evicted;
  }

  async function pruneRoundsUnlocked(conversationId: string, roundIds: string[]): Promise<void> {
    const drop = new Set(roundIds);
    const lines = await readLines(conversationId);
    await writeLines(conversationId, lines.filter((line) => !drop.has(line.runId)));
  }

  /** 读一份内容；内容不在库里（被清理/从未入库）返回 null */
  async function readContentByHash(hash: string): Promise<string | null> {
    try {
      const packed = await fs.promises.readFile(objectPath(hash));
      return (await gunzip(packed)).toString("utf8");
    } catch {
      return null;
    }
  }

  return {
    async record(input) {
      return enqueue(async () => {
        // 内容入库失败（二进制/超限）时必须**不写哈希字段**：
        // 写成 null 会被读成"文件当时不存在"，回退时就会把文件删掉——语义完全不同。
        const beforeResult = typeof input.before === "string" ? await putContent(input.before) : null;
        const afterResult = typeof input.after === "string" ? await putContent(input.after) : null;
        const beforeSkipped = beforeResult && "skipped" in beforeResult ? beforeResult.skipped : undefined;
        const afterSkipped = afterResult && "skipped" in afterResult ? afterResult.skipped : undefined;
        // after === undefined 表示"内容未知"（未入库），此时同样不能写成 null
        const afterKnown = input.after !== undefined;

        const line: LedgerLine = {
          at: now(),
          conversationId: input.conversationId,
          runId: input.runId,
          toolCallId: input.toolCallId,
          toolId: input.toolId,
          path: input.path,
          kind: input.kind,
          source: input.source,
          insertions: input.insertions,
          deletions: input.deletions,
        };
        if (input.before !== undefined && !beforeSkipped) {
          line.beforeHash = beforeResult && "hash" in beforeResult ? beforeResult.hash : null;
        }
        if (input.after === null) {
          line.afterHash = null;
        } else if (afterKnown && !afterSkipped) {
          line.afterHash = afterResult && "hash" in afterResult ? afterResult.hash : null;
        }
        const skipped = input.beforeSkipped ?? beforeSkipped ?? input.afterSkipped ?? afterSkipped;
        if (skipped) line.skipped = skipped;
        if (input.label) line.label = input.label;
        await appendLine(line);
        return { evicted: await enforceQuota() };
      });
    },

    async listRounds(conversationId) {
      return enqueue(async () => {
        const lines = await readLines(conversationId);
        const byRound = new Map<string, LedgerLine[]>();
        for (const line of lines) {
          const bucket = byRound.get(line.runId);
          if (bucket) bucket.push(line);
          else byRound.set(line.runId, [line]);
        }
        const rounds: LedgerRound[] = [];
        for (const [roundId, roundLines] of byRound) {
          // 同一文件的多次改动合并成一条：以"最早一次"的 before 与"最后一次"的 after 为准
          const byPath = new Map<string, LedgerLine>();
          for (const line of roundLines) {
            const existing = byPath.get(line.path);
            if (!existing) byPath.set(line.path, line);
            else byPath.set(line.path, { ...line, beforeHash: existing.beforeHash });
          }
          const files: LedgerFileChange[] = [...byPath.values()].map((line) => ({
            path: line.path,
            kind: line.kind,
            source: line.source,
            insertions: line.insertions,
            deletions: line.deletions,
            hasBaseline: hashField(line, "beforeHash").known,
            ...(line.skipped ? { contentSkipped: line.skipped } : {}),
          }));
          rounds.push({
            roundId,
            conversationId,
            at: Math.min(...roundLines.map((line) => line.at)),
            label: roundLines.find((line) => line.label)?.label ?? "",
            files: files.sort((left, right) => left.path.localeCompare(right.path)),
          });
        }
        return rounds.sort((left, right) => left.at - right.at);
      });
    },

    async fileVersions(conversationId, roundId, relPath) {
      return enqueue(async () => {
        const lines = await readLines(conversationId);
        const mine = lines.filter((line) => line.runId === roundId && line.path === relPath);
        if (mine.length === 0) return { path: relPath, before: undefined, after: undefined };
        const first = hashField(mine[0], "beforeHash");
        const last = hashField(mine[mine.length - 1], "afterHash");
        const before = !first.known ? undefined : first.hash === null ? null : await readContentByHash(first.hash);
        const after = !last.known ? undefined : last.hash === null ? null : await readContentByHash(last.hash);
        return { path: relPath, before, after };
      });
    },

    async readContent(hash) {
      return readContentByHash(hash);
    },

    async restore(conversationId, roundId, workspaceRoot) {
      return enqueue(async () => {
        const lines = await readLines(conversationId);
        const targetIndex = lines.findIndex((line) => line.runId === roundId);
        if (targetIndex < 0) throw new Error("找不到这一轮的记录");
        // 目标轮及其之后的所有改动：每个文件取"最早一次"的 before 作为要恢复到的内容
        const affected = earliestPerPath(lines.slice(targetIndex));
        // 每个文件"最新一次记录"的 after：回退前用它比对磁盘，判断期间有没有被外部改过
        const lastByPath = new Map<string, LedgerLine>();
        for (const line of lines.slice(targetIndex)) lastByPath.set(line.path, line);

        const result: LedgerRestoreResult = { restored: [], deleted: [], skipped: [] };
        // 回退本身也要留下痕迹：记成时间线上新的一轮（来源 restore）。
        // 附带好处：这次回退同样可以被再回退——等于「撤销回退」。
        const restoreRoundId = `restore-${now()}`;
        const actions: Array<{ path: string; kind: LedgerChangeKind; before: string | null; after: string | null }> = [];
        for (const line of affected) {
          const absolute = path.resolve(workspaceRoot, line.path);
          const root = path.resolve(workspaceRoot);
          // 账本里的路径本是工作区相对路径；仍校验一次，绝不因为历史数据把文件写到工作区外
          if (absolute !== root && !absolute.startsWith(root + path.sep)) {
            result.skipped.push({ path: line.path, reason: "路径越出了工作区" });
            continue;
          }
          const beforeField = hashField(line, "beforeHash");
          if (!beforeField.known) {
            result.skipped.push({
              path: line.path,
              reason: line.skipped === "binary"
                ? "二进制文件没有存内容，无法恢复"
                : line.skipped === "too-large"
                  ? "文件过大没有存内容，无法恢复"
                  : "没有更早的版本，无法恢复",
            });
            continue;
          }
          const last = lastByPath.get(line.path);
          const lastField = last ? hashField(last, "afterHash") : { known: false as const };
          if (!lastField.known) {
            // 改动后的内容没入库（二进制/超限）：无从比对，直接跳过，绝不覆盖
            result.skipped.push({ path: line.path, reason: "改动后的内容未入库，无法确认当前状态" });
            continue;
          }
          const expectedContent = lastField.hash === null ? null : await readContentByHash(lastField.hash);
          const current = await readDiskFile(absolute);
          // 期间被外部改过：以你手里的版本为准，不覆盖（与"不覆盖未保存改动"同一条原则）
          if (current !== expectedContent) {
            result.skipped.push({ path: line.path, reason: "记录之后被改过，已跳过" });
            continue;
          }
          if (beforeField.hash === null) {
            await fs.promises.rm(absolute, { force: true });
            result.deleted.push(line.path);
            // 磁盘上本来就没了：不是一次真实改动，不必记
            if (current !== null) actions.push({ path: line.path, kind: "delete", before: current, after: null });
            continue;
          }
          const content = await readContentByHash(beforeField.hash);
          if (content === null) {
            result.skipped.push({ path: line.path, reason: "内容已不在账本里（可能被清理）" });
            continue;
          }
          await fs.promises.mkdir(path.dirname(absolute), { recursive: true });
          await fs.promises.writeFile(absolute, content, "utf8");
          result.restored.push(line.path);
          actions.push({ path: line.path, kind: "modify", before: current, after: content });
        }

        // 把这次回退记成一轮：用户能在时间线上看到"我把哪些文件退回了哪一轮之前"
        if (actions.length > 0) {
          const targetLabel = lines[targetIndex].label?.trim();
          const label = targetLabel
            ? `回退到「${targetLabel}」之前`
            : `回退到 ${new Date(lines[targetIndex].at).toLocaleString("zh-CN")} 之前`;
          for (const action of actions) {
            const beforeResult = action.before === null ? null : await putContent(action.before);
            const afterResult = action.after === null ? null : await putContent(action.after);
            const line: LedgerLine = {
              at: now(),
              conversationId,
              runId: restoreRoundId,
              toolCallId: "",
              toolId: "ledger-restore",
              path: action.path,
              kind: action.kind,
              source: "restore",
              insertions: action.after ? countTextLines(action.after) : 0,
              deletions: action.before ? countTextLines(action.before) : 0,
              label,
            };
            if (beforeResult && "hash" in beforeResult) line.beforeHash = beforeResult.hash;
            else if (action.before === null) line.beforeHash = null;
            if (afterResult && "hash" in afterResult) line.afterHash = afterResult.hash;
            else if (action.after === null) line.afterHash = null;
            await appendLine(line);
          }
          await enforceQuota();
        }
        return result;
      });
    },

    async usage() {
      return enqueue(async () => {
        const bytes = await totalBytes();
        let roundCount = 0;
        for (const sessionId of await listSessionIds()) {
          roundCount += new Set((await readLines(sessionId)).map((line) => line.runId)).size;
        }
        return {
          totalBytes: bytes,
          maxBytes: limits.maxTotalBytes,
          warn: bytes >= limits.maxTotalBytes * limits.warnRatio,
          roundCount,
        };
      });
    },

    async pruneRounds(conversationId, roundIds) {
      return enqueue(async () => {
        await pruneRoundsUnlocked(conversationId, roundIds);
        await collectGarbage();
      });
    },

    async dropConversation(conversationId) {
      return enqueue(async () => {
        await fs.promises.rm(sessionFile(conversationId), { force: true });
        await collectGarbage();
      });
    },
  };
}

/**
 * 只有 ENOENT 才代表"这个文件不存在"。
 * 权限（EACCES）、句柄耗尽（EMFILE）等错误必须当成"暂时读不到"——否则账本会把
 * 一个真实存在的文件记成"新建"（null 基线），回退时把它删掉。
 * 放在这里而不是 workbench-ipc：本模块不依赖 electron，可以直接单测。
 */
export function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT";
}

/** 行数（末尾空行不计，与工具证据同一口径） */
function countTextLines(text: string): number {
  if (!text) return 0;
  const lines = text.split("\n");
  return lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
}

/** 读磁盘内容：文件不存在返回 null（用于回退前的一致性比对） */
async function readDiskFile(absolute: string): Promise<string | null> {
  try {
    return await fs.promises.readFile(absolute, "utf8");
  } catch {
    return null;
  }
}

/**
 * 进程级账本实例。
 * 抓取点在工具调度层（很深的位置），而账本要写到 userData —— 与其把实例穿透四五层依赖，
 * 不如沿用仓库里 getHarnessRunStore 的既有做法：启动时配置一次，用到的地方直接取。
 * 未配置时返回 undefined，抓取层据此完全不记账（测试与轻量场景零影响）。
 */
let configuredLedger: ChangeLedger | undefined;

export function configureChangeLedger(ledger: ChangeLedger): void {
  configuredLedger = ledger;
}

export function getConfiguredChangeLedger(): ChangeLedger | undefined {
  return configuredLedger;
}
