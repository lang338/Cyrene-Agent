import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createChangeLedger, type ChangeLedger } from "./change-ledger-service";

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

  it("按轮删除后回收对象", async () => {
    await ledger.record(change({ runId: "run-1", path: "a.ts", before: "aaa\n", after: "bbb\n" }));
    await ledger.record(change({ runId: "run-2", path: "c.ts", before: "ccc\n", after: "ddd\n" }));

    await ledger.pruneRounds("c1", ["run-1"]);
    expect((await ledger.listRounds("c1")).map((round) => round.roundId)).toEqual(["run-2"]);
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
