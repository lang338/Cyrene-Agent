import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createChangeLedger, isMissingFileError, type ChangeLedger } from "./change-ledger-service";

let rootDir: string;
let workspaceRoot: string;
let ledger: ChangeLedger;

beforeEach(async () => {
  rootDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "cyrene-ledger-"));
  workspaceRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "cyrene-ledger-ws-"));
  ledger = createChangeLedger({ rootDir });
});

afterEach(async () => {
  await fs.promises.rm(rootDir, { recursive: true, force: true });
  await fs.promises.rm(workspaceRoot, { recursive: true, force: true });
});

function change(overrides: Partial<Parameters<ChangeLedger["record"]>[0]> = {}) {
  return {
    conversationId: "c1",
    runId: "run-1",
    toolCallId: "call-1",
    toolId: "write_file",
    path: "src/a.ts",
    kind: "modify" as const,
    source: "ai" as const,
    insertions: 1,
    deletions: 1,
    before: "old\n",
    after: "new\n",
    ...overrides,
  };
}

async function writeWorkspace(relPath: string, content: string): Promise<void> {
  const target = path.join(workspaceRoot, relPath);
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  await fs.promises.writeFile(target, content, "utf8");
}

async function readWorkspace(relPath: string): Promise<string | null> {
  try {
    return await fs.promises.readFile(path.join(workspaceRoot, relPath), "utf8");
  } catch {
    return null;
  }
}

describe("change-ledger 记录与查询", () => {
  it("按轮次分组，带来源与增删行数", async () => {
    await ledger.record(change({ label: "帮我改一下 a" }));
    await ledger.record(change({ path: "src/b.ts", source: "user", toolId: "workbench-save", runId: "run-2" }));

    const rounds = await ledger.listRounds("c1");
    expect(rounds.map((round) => round.roundId)).toEqual(["run-1", "run-2"]);
    expect(rounds[0].label).toBe("帮我改一下 a");
    expect(rounds[0].files).toHaveLength(1);
    expect(rounds[0].files[0]).toMatchObject({ path: "src/a.ts", source: "ai", hasBaseline: true });
    expect(rounds[1].files[0]).toMatchObject({ path: "src/b.ts", source: "user" });
  });

  it("同一轮同一文件改多次：合并成一条，before 取最早、after 取最后", async () => {
    await ledger.record(change({ before: "v1\n", after: "v2\n" }));
    await ledger.record(change({ before: "v2\n", after: "v3\n" }));

    const rounds = await ledger.listRounds("c1");
    expect(rounds[0].files).toHaveLength(1);
    const versions = await ledger.fileVersions("c1", "run-1", "src/a.ts");
    expect(versions.before).toBe("v1\n");
    expect(versions.after).toBe("v3\n");
  });

  it("同样内容只落一份对象（内容寻址去重）", async () => {
    await ledger.record(change({ path: "a.ts", before: "same\n", after: "same\n" }));
    await ledger.record(change({ path: "b.ts", before: "same\n", after: "same\n" }));

    const objects: string[] = [];
    async function walk(dir: string): Promise<void> {
      for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else objects.push(entry.name);
      }
    }
    await walk(path.join(rootDir, "objects"));
    expect(objects).toHaveLength(1);
  });

  it("二进制/超限的文件：标记原因且没有基线（记不住内容，就不该假装能回退）", async () => {
    await ledger.record(change({ before: undefined, beforeSkipped: "binary", after: undefined, afterSkipped: "binary" }));
    const rounds = await ledger.listRounds("c1");
    expect(rounds[0].files[0]).toMatchObject({ hasBaseline: false, contentSkipped: "binary" });
  });
});

describe("change-ledger 回退", () => {
  it("恢复到某一轮之前：写回改动前的内容", async () => {
    await writeWorkspace("src/a.ts", "new\n");
    await ledger.record(change({ before: "old\n", after: "new\n" }));

    const result = await ledger.restore("c1", "run-1", workspaceRoot);
    expect(result.restored).toEqual(["src/a.ts"]);
    expect(await readWorkspace("src/a.ts")).toBe("old\n");
  });

  it("该轮新建的文件：回退时删除", async () => {
    await writeWorkspace("src/new.ts", "hello\n");
    await ledger.record(change({ path: "src/new.ts", kind: "create", before: null, after: "hello\n" }));

    const result = await ledger.restore("c1", "run-1", workspaceRoot);
    expect(result.deleted).toEqual(["src/new.ts"]);
    expect(await readWorkspace("src/new.ts")).toBeNull();
  });

  it("只影响记录里的文件，未记录的文件一律不碰", async () => {
    await writeWorkspace("src/a.ts", "new\n");
    await writeWorkspace("src/other.ts", "untouched\n");
    await ledger.record(change({ before: "old\n", after: "new\n" }));

    await ledger.restore("c1", "run-1", workspaceRoot);
    expect(await readWorkspace("src/other.ts")).toBe("untouched\n");
  });

  it("回退到中间一轮：之后几轮的改动一起撤掉", async () => {
    await writeWorkspace("src/a.ts", "v3\n");
    await ledger.record(change({ runId: "run-1", before: "v1\n", after: "v2\n" }));
    await ledger.record(change({ runId: "run-2", before: "v2\n", after: "v3\n" }));

    const result = await ledger.restore("c1", "run-1", workspaceRoot);
    expect(result.restored).toEqual(["src/a.ts"]);
    expect(await readWorkspace("src/a.ts")).toBe("v1\n");
  });

  it("没有基线的文件：跳过并说明原因", async () => {
    await writeWorkspace("src/cmd.ts", "generated\n");
    await ledger.record(change({ path: "src/cmd.ts", before: undefined, after: "generated\n" }));

    const result = await ledger.restore("c1", "run-1", workspaceRoot);
    expect(result.restored).toEqual([]);
    expect(result.skipped[0]).toMatchObject({ path: "src/cmd.ts" });
    expect(await readWorkspace("src/cmd.ts")).toBe("generated\n");
  });

  it("期间被外部改过：跳过，不覆盖你手里的版本", async () => {
    await writeWorkspace("src/a.ts", "被你自己改过\n");
    await ledger.record(change({ before: "old\n", after: "new\n" }));

    const result = await ledger.restore("c1", "run-1", workspaceRoot);
    expect(result.restored).toEqual([]);
    expect(result.skipped[0].reason).toContain("被改过");
    expect(await readWorkspace("src/a.ts")).toBe("被你自己改过\n");
  });

  it("目标轮及其之后的改动一起撤，未受影响的历史不动", async () => {
    await writeWorkspace("src/a.ts", "v2\n");
    await writeWorkspace("src/b.ts", "b2\n");
    await ledger.record(change({ runId: "run-1", path: "src/a.ts", before: "a1\n", after: "a2\n" }));
    await ledger.record(change({ runId: "run-2", path: "src/a.ts", before: "a2\n", after: "v2\n" }));
    await ledger.record(change({ runId: "run-2", path: "src/b.ts", before: "b1\n", after: "b2\n" }));

    const result = await ledger.restore("c1", "run-2", workspaceRoot);
    expect(result.restored.sort()).toEqual(["src/a.ts", "src/b.ts"]);
    expect(await readWorkspace("src/a.ts")).toBe("a2\n");
    expect(await readWorkspace("src/b.ts")).toBe("b1\n");
  });

  it("回退本身也记一轮（来源 restore），能看出回退了什么", async () => {
    await writeWorkspace("src/a.ts", "new\n");
    await ledger.record(change({ label: "帮我改一下 a", before: "old\n", after: "new\n" }));

    await ledger.restore("c1", "run-1", workspaceRoot);

    const rounds = await ledger.listRounds("c1");
    expect(rounds).toHaveLength(2);
    const restoreRound = rounds[1];
    expect(restoreRound.label).toContain("回退到");
    expect(restoreRound.label).toContain("帮我改一下 a");
    expect(restoreRound.files[0]).toMatchObject({ path: "src/a.ts", source: "restore", kind: "modify", hasBaseline: true });
    // 前后内容：回退前=被回退掉的那版，回退后=恢复回来的那版
    const versions = await ledger.fileVersions("c1", restoreRound.roundId, "src/a.ts");
    expect(versions.before).toBe("new\n");
    expect(versions.after).toBe("old\n");
  });

  it("回退可以再被回退（撤销回退）", async () => {
    await writeWorkspace("src/a.ts", "new\n");
    await ledger.record(change({ before: "old\n", after: "new\n" }));
    await ledger.restore("c1", "run-1", workspaceRoot);
    expect(await readWorkspace("src/a.ts")).toBe("old\n");

    const restoreRound = (await ledger.listRounds("c1"))[1];
    const undone = await ledger.restore("c1", restoreRound.roundId, workspaceRoot);
    expect(undone.restored).toEqual(["src/a.ts"]);
    expect(await readWorkspace("src/a.ts")).toBe("new\n");
  });

  it("回退删除的文件也记一轮", async () => {
    await writeWorkspace("src/new.ts", "hello\n");
    await ledger.record(change({ path: "src/new.ts", kind: "create", before: null, after: "hello\n" }));
    await ledger.restore("c1", "run-1", workspaceRoot);

    const restoreRound = (await ledger.listRounds("c1"))[1];
    expect(restoreRound.files[0]).toMatchObject({ path: "src/new.ts", source: "restore", kind: "delete" });
  });

  it("没有实际改动时不记空轮", async () => {
    await writeWorkspace("src/cmd.ts", "generated\n");
    await ledger.record(change({ path: "src/cmd.ts", before: undefined, after: "generated\n" }));

    const result = await ledger.restore("c1", "run-1", workspaceRoot);
    expect(result.restored).toEqual([]);
    expect(await ledger.listRounds("c1")).toHaveLength(1); // 只有原来那一轮
  });

  it("restoreAffectedPaths：后续轮次才改的文件也在预检清单里（脏缓冲守卫靠它）", async () => {
    await writeWorkspace("src/a.ts", "a2\n");
    await writeWorkspace("src/b.ts", "b2\n");
    await ledger.record(change({ runId: "run-1", path: "src/a.ts", before: "a1\n", after: "a2\n" }));
    await ledger.record(change({ runId: "run-2", path: "src/b.ts", before: "b1\n", after: "b2\n" }));

    // 回退到 run-1：b.ts 不在 run-1 自己的 files 里，但它在 run-2 被改、同样会被撤掉
    const fromFirst = await ledger.restoreAffectedPaths("c1", "run-1");
    expect(fromFirst.sort()).toEqual(["src/a.ts", "src/b.ts"]);
    expect(await ledger.restoreAffectedPaths("c1", "run-2")).toEqual(["src/b.ts"]);

    // 预检口径与真正执行一致：回 run-1 时两个文件都被写回
    const result = await ledger.restore("c1", "run-1", workspaceRoot);
    expect(result.restored.sort()).toEqual(["src/a.ts", "src/b.ts"]);
    expect(await readWorkspace("src/a.ts")).toBe("a1\n");
    expect(await readWorkspace("src/b.ts")).toBe("b1\n");
  });

  it("restoreAffectedPaths：找不到轮次要报错，不能默默返回空清单", async () => {
    await ledger.record(change());
    await expect(ledger.restoreAffectedPaths("c1", "nope")).rejects.toThrow();
  });
});

describe("isMissingFileError（只有 ENOENT 才算文件不存在）", () => {
  it("ENOENT 为真，其余一律为假", () => {
    expect(isMissingFileError(Object.assign(new Error("nope"), { code: "ENOENT" }))).toBe(true);
    // 权限/句柄等暂时性错误绝不能当成"文件不存在"，否则回退会去删一个真实文件
    expect(isMissingFileError(Object.assign(new Error("denied"), { code: "EACCES" }))).toBe(false);
    expect(isMissingFileError(Object.assign(new Error("too many open files"), { code: "EMFILE" }))).toBe(false);
    expect(isMissingFileError(new Error("plain"))).toBe(false);
    expect(isMissingFileError(undefined)).toBe(false);
    expect(isMissingFileError("ENOENT")).toBe(false);
  });
});

describe("change-ledger 配额与清理", () => {
  it("超配额时按轮次从旧到新淘汰，但永远保留最新一轮", async () => {
    const small = createChangeLedger({ rootDir, limits: { maxTotalBytes: 1000 } });
    // 用不可压缩的内容，否则 gzip 之后测不出体积
    const body = randomBytes(900).toString("base64");
    await small.record({ ...change({ runId: "run-old", path: "a.ts" }), before: body, after: body });
    const result = await small.record({ ...change({ runId: "run-new", path: "b.ts" }), before: `${body}z`, after: `${body}z` });

    expect(result.evicted.map((entry) => entry.roundId)).toEqual(["run-old"]);
    const rounds = await small.listRounds("c1");
    expect(rounds.map((round) => round.roundId)).toEqual(["run-new"]);
  });

  it("配额淘汰只删必要的轮次，不会一路删到只剩最新", async () => {
    const small = createChangeLedger({ rootDir, limits: { maxTotalBytes: 1400 } });
    const base = randomBytes(200).toString("base64");
    const evicted: string[] = [];
    for (const runId of ["r1", "r2", "r3", "r4"]) {
      // 每轮内容不同（避免被内容去重），且不可压缩（否则测不出体积）
      const result = await small.record({ ...change({ runId, path: `${runId}.ts` }), before: `${base}${runId}`, after: `${base}${runId}x` });
      for (const entry of result.evicted) evicted.push(entry.roundId);
    }

    const rounds = await small.listRounds("c1");
    expect(rounds.map((round) => round.roundId)).toContain("r4"); // 最新一轮永远保留
    // 关键：不是"删到只剩最新"（回收没跟上的话会一路删光）
    expect(rounds.length).toBeGreaterThanOrEqual(2);
    expect(evicted[0]).toBe("r1"); // 从最旧的开始淘汰
    expect((await small.usage()).totalBytes).toBeLessThanOrEqual(1400 * 0.7 + 300); // 回落到目标水位附近
  });

  it("淘汰旧轮时只释放它独有的对象：被其他轮次共享的内容必须保留", async () => {
    const small = createChangeLedger({ rootDir, limits: { maxTotalBytes: 2200 } });
    // 不可压缩内容才能用 gzip 后的体积做配额设计；A 在两轮里都被引用（同一版本）
    const shared = randomBytes(300).toString("base64");
    const oldOnly = randomBytes(700).toString("base64");
    const newOnly = randomBytes(1500).toString("base64");
    await small.record({ ...change({ runId: "run-old", path: "a.ts" }), before: shared, after: oldOnly });
    // 新轮使总占用越过配额：旧轮应被淘汰，但共享的 A 还有新轮引用，绝不能删
    const result = await small.record({ ...change({ runId: "run-new", path: "b.ts" }), before: shared, after: newOnly });

    expect(result.evicted.map((entry) => entry.roundId)).toEqual(["run-old"]);
    expect(await small.readContent(await hashOf(shared))).toBe(shared);
    expect(await small.readContent(await hashOf(oldOnly))).toBeNull();
    expect(await small.readContent(await hashOf(newOnly))).toBe(newOnly);
    // 新轮的 before 仍能读出共享内容：引用计数没把它的历史搞坏
    const versions = await small.fileVersions("c1", "run-new", "b.ts");
    expect(versions.before).toBe(shared);
  });

  it("一次保存要淘汰多轮时：循环内增量回收，水位判定准确且最新轮保留", async () => {
    const small = createChangeLedger({ rootDir, limits: { maxTotalBytes: 2000 } });
    // 两个大旧轮（入库时不触发）+ 一个稍小的新轮：新轮落盘后必须在同一次淘汰里连删两轮
    const big1 = `${randomBytes(800).toString("base64")}-1`;
    const big2 = `${randomBytes(800).toString("base64")}-2`;
    const medium3 = `${randomBytes(650).toString("base64")}-3`;
    await small.record({ ...change({ runId: "r1", path: "r1.ts", kind: "create" }), before: null, after: big1 });
    await small.record({ ...change({ runId: "r2", path: "r2.ts", kind: "create" }), before: null, after: big2 });
    const result = await small.record({ ...change({ runId: "r3", path: "r3.ts", kind: "create" }), before: null, after: medium3 });

    expect(result.evicted.map((entry) => entry.roundId)).toEqual(["r1", "r2"]);
    expect((await small.listRounds("c1")).map((round) => round.roundId)).toEqual(["r3"]);
    expect(await small.readContent(await hashOf(medium3))).toBe(medium3);
    // 增量账与磁盘一致：已回落到目标水位附近（0.7），不是删完还按旧总量误判
    expect((await small.usage()).totalBytes).toBeLessThanOrEqual(2000 * 0.7 + 300);
  });

  it("按轮删除后回收对象", async () => {
    await ledger.record(change({ runId: "run-1", path: "a.ts", before: "aaa\n", after: "bbb\n" }));
    await ledger.record(change({ runId: "run-2", path: "c.ts", before: "ccc\n", after: "ddd\n" }));

    const before = await ledger.usage();
    await ledger.pruneRounds("c1", ["run-1"]);
    expect((await ledger.listRounds("c1")).map((round) => round.roundId)).toEqual(["run-2"]);
    // 占用是带缓存的：回收后必须失效，否则配额会一直按旧数字判断
    const after = await ledger.usage();
    expect(after.totalBytes).toBeLessThan(before.totalBytes);
    expect(await ledger.readContent(await hashOf("aaa\n"))).toBeNull();
    expect(await ledger.readContent(await hashOf("ddd\n"))).toBe("ddd\n");
  });

  it("usage 报出占用与提示线", async () => {
    await ledger.record(change());
    const usage = await ledger.usage();
    expect(usage.totalBytes).toBeGreaterThan(0);
    expect(usage.roundCount).toBe(1);
    expect(usage.warn).toBe(false);
  });
});

async function hashOf(content: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(content, "utf8").digest("hex");
}
