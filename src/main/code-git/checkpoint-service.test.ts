import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ChatSession } from "../../shared/chat-types";
import type { ResolvedGitExecutable } from "./git-executable";
import {
  computeFilesToDelete,
  createCheckpointService,
  splitNulOutput,
  type CheckpointGitClient,
  type CheckpointLogRecord,
  type CheckpointStat,
} from "./checkpoint-service";

const EXECUTABLE: ResolvedGitExecutable = { command: "git", source: "system", version: "2.51.0" };

function fakeSession(workspaceRoot = "D:/ws"): ChatSession {
  return {
    mode: "code",
    workspaceBinding: { workspaceRoot, displayName: "ws" },
  } as unknown as ChatSession;
}

interface FakeChainRecord {
  hash: string;
  tree: string;
  message: string;
  timestamp: string;
}

interface FakeClientOptions {
  last?: { hash: string; tree: string } | null;
  nextTree?: string;
  log?: CheckpointLogRecord[];
  treeFiles?: string[];
  workspaceFiles?: string[];
}

function createFakeClient(options: FakeClientOptions = {}) {
  const calls: Array<{ op: string; args?: unknown[] }> = [];
  let committed = 0;
  const client: CheckpointGitClient = {
    lastCheckpoint: vi.fn(async () => options.last ?? null),
    writeWorkspaceTree: vi.fn(async () => options.nextTree ?? `tree-${(options.last?.tree ?? "base")}-${committed}`),
    commitTree: vi.fn(async (tree, parentHash, message) => {
      committed += 1;
      calls.push({ op: "commitTree", args: [tree, parentHash, message] });
      return `hash-${committed}`;
    }),
    updateRef: vi.fn(async () => undefined),
    log: vi.fn(async () => options.log ?? []),
    diffWithParent: vi.fn(async (): Promise<CheckpointStat> => ({
      files: [{ file: "a.ts", insertions: 3, deletions: 1 }],
      insertions: 3,
      deletions: 1,
      truncated: false,
      patch: "diff",
    })),
    checkoutTree: vi.fn(async () => undefined),
    listTreeFiles: vi.fn(async () => options.treeFiles ?? []),
    listWorkspaceFiles: vi.fn(async () => options.workspaceFiles ?? []),
    deleteWorkspaceFiles: vi.fn(async () => undefined),
  };
  return { client, calls };
}

function createDeps(client: CheckpointGitClient, extra: Partial<Parameters<typeof createCheckpointService>[0]> = {}) {
  return {
    getSession: vi.fn(() => fakeSession()),
    resolveExecutable: vi.fn(async () => EXECUTABLE),
    createClient: vi.fn(() => client),
    ...extra,
  };
}

describe("checkpoint-service", () => {
  it("首次快照：commitTree 无 parent 并更新 ref", async () => {
    const { client, calls } = createFakeClient({ last: null, nextTree: "tree-1" });
    const service = createCheckpointService(createDeps(client));
    const entry = await service.snapshot("s1", "auto");
    expect(entry).toMatchObject({ hash: "hash-1", kind: "auto", files: 1, insertions: 3, deletions: 1 });
    expect(calls[0]).toEqual({ op: "commitTree", args: ["tree-1", null, expect.stringContaining("checkpoint") ] });
  });

  it("链式快照：parent 指向链顶", async () => {
    const { client, calls } = createFakeClient({ last: { hash: "prev", tree: "tree-old" }, nextTree: "tree-new" });
    const service = createCheckpointService(createDeps(client));
    await service.snapshot("s1", "manual");
    expect(calls[0].args?.[1]).toBe("prev");
  });

  it("内容无变化时跳过快照", async () => {
    const { client } = createFakeClient({ last: { hash: "prev", tree: "same" }, nextTree: "same" });
    const service = createCheckpointService(createDeps(client));
    const entry = await service.snapshot("s1", "auto");
    expect(entry).toBeNull();
  });

  it("notifyActivity 防抖后自动快照，失败只告警不抛出", async () => {
    vi.useFakeTimers();
    try {
      const { client } = createFakeClient({ last: null, nextTree: "tree-1" });
      const warn = vi.fn();
      const service = createCheckpointService({ ...createDeps(client), warn });
      (client.writeWorkspaceTree as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("boom"));
      service.notifyActivity("s1");
      service.notifyActivity("s1"); // 重置防抖
      await vi.advanceTimersByTimeAsync(4_999);
      expect((client.writeWorkspaceTree as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
      await vi.advanceTimersByTimeAsync(2);
      expect((client.writeWorkspaceTree as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
      // 第二轮：这次 writeWorkspaceTree 正常，快照成功
      service.notifyActivity("s1");
      await vi.advanceTimersByTimeAsync(5_000);
      expect((client.updateRef as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("list 解析 message 中的 kind 与 sessionId", async () => {
    const { client } = createFakeClient({
      log: [
        { hash: "h1", timestamp: "2026-09-15T10:00:00.000Z", message: "checkpoint\u001fauto\u001fs9" },
        { hash: "h2", timestamp: "2026-09-15T09:00:00.000Z", message: "checkpoint\u001fpre-restore\u001f-" },
      ],
    });
    const service = createCheckpointService(createDeps(client));
    const entries = await service.list("s1");
    expect(entries[0]).toMatchObject({ hash: "h1", kind: "auto", sessionId: "s9" });
    expect(entries[1]).toMatchObject({ hash: "h2", kind: "pre-restore", sessionId: null });
  });

  it("diff：链中条目 fromHash 指向下一条（更早的快照）", async () => {
    const h1 = "1".repeat(40);
    const h0 = "0".repeat(40);
    const { client } = createFakeClient({
      log: [
        { hash: h1, timestamp: "2026-09-15T10:00:00.000Z", message: "checkpoint\u001fauto\u001fs9" },
        { hash: h0, timestamp: "2026-09-15T09:00:00.000Z", message: "checkpoint\u001fauto\u001fs9" },
      ],
    });
    const service = createCheckpointService(createDeps(client));
    const diff = await service.diff("s1", h1);
    expect(diff).toMatchObject({ fromHash: h0, toHash: h1, insertions: 3 });
  });

  it("diff：不在链上的 hash 拒绝", async () => {
    const { client } = createFakeClient({ log: [] });
    const service = createCheckpointService(createDeps(client));
    await expect(service.diff("s1", "a".repeat(40))).rejects.toThrow("快照不存在");
  });

  it("diff：hash 格式不合法直接拒绝", async () => {
    const { client } = createFakeClient({ log: [] });
    const service = createCheckpointService(createDeps(client));
    await expect(service.diff("s1", "HEAD; rm -rf")).rejects.toThrow("快照标识不合法");
  });

  it("restore：先打 pre-restore 快照，再恢复并删除多余文件", async () => {
    const hashOld = "0".repeat(40);
    const { client } = createFakeClient({
      last: { hash: "top", tree: "tree-top" },
      nextTree: "tree-backup",
      log: [
        { hash: "top".padEnd(40, "a"), timestamp: "2026-09-15T10:00:00.000Z", message: "checkpoint\u001fauto\u001fs9" },
        { hash: hashOld, timestamp: "2026-09-15T09:00:00.000Z", message: "checkpoint\u001fauto\u001fs9" },
      ],
      treeFiles: ["keep.ts"],
      workspaceFiles: ["keep.ts", "stale.ts"],
    });
    const service = createCheckpointService(createDeps(client));
    const result = await service.restore("s1", hashOld);
    expect(result.preRestoreHash).toBe("hash-1"); // pre-restore 快照
    expect(result.restoredHash).toBe(hashOld);
    expect((client.checkoutTree as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(hashOld);
    expect((client.deleteWorkspaceFiles as ReturnType<typeof vi.fn>).mock.calls[0][0]).toEqual(["stale.ts"]);
  });

  it("restore：目标不在链上拒绝且不打快照", async () => {
    const { client } = createFakeClient({ log: [] });
    const service = createCheckpointService(createDeps(client));
    await expect(service.restore("s1", "b".repeat(40))).rejects.toThrow("快照不存在");
    expect((client.writeWorkspaceTree as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it("会话校验：非 code 模式与未绑定工作区都拒绝", async () => {
    const { client } = createFakeClient({});
    const service = createCheckpointService({
      getSession: vi.fn(() => ({ mode: "chat" }) as unknown as ChatSession),
      resolveExecutable: vi.fn(async () => EXECUTABLE),
      createClient: vi.fn(() => client),
    });
    await expect(service.snapshot("s1", "auto")).rejects.toThrow("Code 模式");
    await expect(service.snapshot("s1", "auto")).rejects.toThrow("Code 模式");
    const service2 = createCheckpointService({
      getSession: vi.fn(() => ({ mode: "code", workspaceBinding: null }) as unknown as ChatSession),
      resolveExecutable: vi.fn(async () => EXECUTABLE),
      createClient: vi.fn(() => client),
    });
    await expect(service2.snapshot("s1", "auto")).rejects.toThrow("尚未绑定代码目录");
  });

  it("computeFilesToDelete：目标快照里没有的才删", () => {
    expect(computeFilesToDelete(["a", "b", "c"], new Set(["a"]))).toEqual(["b", "c"]);
    expect(computeFilesToDelete(["a"], new Set(["a", "new.ts"]))).toEqual([]);
  });

  it("computeFilesToDelete：中文等非 ASCII 路径按原值精确匹配（不经 quotepath 转义）", () => {
    // 回归：ls-files 默认把 "你好.ts" 转义成八进制串，按转义串会匹配失败而误删
    const current = ["src/你好.ts", "src/保留.md", "目录/旧文件.txt"];
    const target = new Set(["src/你好.ts", "src/保留.md"]);
    expect(computeFilesToDelete(current, target)).toEqual(["目录/旧文件.txt"]);
  });

  it("restore：中文文件名的多余文件也能被正确识别删除", async () => {
    const hashOld = "0".repeat(40);
    const { client } = createFakeClient({
      last: { hash: "top", tree: "tree-top" },
      nextTree: "tree-backup",
      log: [
        { hash: "top".padEnd(40, "a"), timestamp: "2026-09-15T10:00:00.000Z", message: "checkpoint\u001fauto\u001fs9" },
        { hash: hashOld, timestamp: "2026-09-15T09:00:00.000Z", message: "checkpoint\u001fauto\u001fs9" },
      ],
      treeFiles: ["src/你好.ts"],
      workspaceFiles: ["src/你好.ts", "废弃的文件.js"],
    });
    const service = createCheckpointService(createDeps(client));
    const result = await service.restore("s1", hashOld);
    expect(result.restoredHash).toBe(hashOld);
    expect((client.deleteWorkspaceFiles as ReturnType<typeof vi.fn>).mock.calls[0][0]).toEqual(["废弃的文件.js"]);
  });
});

describe("splitNulOutput（git -z NUL 分隔解析）", () => {
  it("按 NUL 拆分多个路径", () => {
    expect(splitNulOutput("src/a.ts\u0000src/b.ts\u0000")).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("非 ASCII 路径保持原样，不出现八进制转义", () => {
    const output = "src/你好.ts\u0000目录/文件.md\u0000";
    expect(splitNulOutput(output)).toEqual(["src/你好.ts", "目录/文件.md"]);
  });

  it("空输出与只有结尾 NUL 都得到空数组", () => {
    expect(splitNulOutput("")).toEqual([]);
    expect(splitNulOutput("\u0000")).toEqual([]);
  });
});

const execFileAsync = promisify(execFile);
async function systemGitAvailable(): Promise<boolean> {
  try {
    await execFileAsync("git", ["--version"], { windowsHide: true, timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

describe("real git 集成：普通文件夹自动 init + 中文路径 + 固定 ident", () => {
  const SYSTEM_GIT: ResolvedGitExecutable = { command: "git", source: "system", version: "test" };
  let root = "";
  let available = false;

  beforeEach(async () => {
    available = await systemGitAvailable();
    if (available) root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-cp-e2e-"));
  });
  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it("非 git 目录首次快照自动 init；中文文件可 diff；回退还原内容并删除多余文件", async () => {
    if (!available) return;
    fs.writeFileSync(path.join(root, "你好.txt"), "第一版\n");
    const service = createCheckpointService({
      getSession: vi.fn(() => fakeSession(root)),
      resolveExecutable: vi.fn(async () => SYSTEM_GIT),
    });

    const first = await service.snapshot("s1", "auto");
    expect(first).not.toBeNull();
    expect(fs.existsSync(path.join(root, ".git"))).toBe(true); // 自动初始化
    await expect(service.list("s1")).resolves.toHaveLength(1);

    const diff1 = await service.diff("s1", first!.hash);
    expect(diff1.perFile.some((f) => f.file === "你好.txt")).toBe(true); // 中文路径不被转义

    fs.writeFileSync(path.join(root, "你好.txt"), "第二版内容\n");
    fs.writeFileSync(path.join(root, "临时文件.md"), "# temp\n");
    const second = await service.snapshot("s1", "manual");
    expect(second).not.toBeNull();

    await service.restore("s1", first!.hash);
    expect(fs.readFileSync(path.join(root, "你好.txt"), "utf8")).toBe("第一版\n");
    expect(fs.existsSync(path.join(root, "临时文件.md"))).toBe(false);
  });
});
