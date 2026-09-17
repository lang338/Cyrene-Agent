import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  beginChangeCapture,
  extractWriteTargets,
  resetChangeCaptureCache,
  toWorkspaceRelative,
} from "./change-capture";
import type { ChangeLedger } from "../../code-git/change-ledger-service";

let workspaceRoot: string;

beforeEach(async () => {
  workspaceRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "cyrene-capture-"));
  resetChangeCaptureCache();
});

afterEach(async () => {
  await fs.promises.rm(workspaceRoot, { recursive: true, force: true });
});

function fakeLedger() {
  const records: Parameters<ChangeLedger["record"]>[0][] = [];
  const ledger = {
    record: vi.fn(async (input: Parameters<ChangeLedger["record"]>[0]) => {
      records.push(input);
      return { evicted: [] };
    }),
  } as unknown as ChangeLedger;
  return { ledger, records };
}

function captureInput(overrides: Record<string, unknown> = {}) {
  return {
    toolId: "write_file",
    risk: "fs-write",
    args: { path: "src/a.ts" },
    conversationId: "c1",
    runId: "run-1",
    workspaceRoot,
    label: "帮我改一下",
    ...overrides,
  };
}

async function seed(relPath: string, content: string | Buffer): Promise<string> {
  const target = path.join(workspaceRoot, relPath);
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  await fs.promises.writeFile(target, content);
  return target;
}

describe("extractWriteTargets", () => {
  it("覆盖各工具的路径参数写法", () => {
    expect(extractWriteTargets("write_file", { path: "a.ts" })).toEqual(["a.ts"]);
    expect(extractWriteTargets("str_replace", { file_path: "b.ts" })).toEqual(["b.ts"]);
    expect(extractWriteTargets("write_markdown", { filename: "c.md" })).toEqual(["c.md"]);
  });

  it("apply_patch：从补丁文本里解析出涉及的路径（含移动目标）", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/a.ts",
      "@@",
      "-old",
      "+new",
      "*** Add File: src/b.ts",
      "+hello",
      "*** Delete File: src/c.ts",
      "*** Move to: src/d.ts",
      "*** End Patch",
    ].join("\n");
    expect(extractWriteTargets("apply_patch", { patch })).toEqual([
      "src/a.ts",
      "src/b.ts",
      "src/c.ts",
      "src/d.ts",
    ]);
  });

  it("ast_grep_replace：只认像文件的路径（目录与 . 不预读）", () => {
    expect(extractWriteTargets("ast_grep_replace", { paths: ["src", ".", "src/x.ts"] })).toEqual(["src/x.ts"]);
  });
});

describe("toWorkspaceRelative", () => {
  it("工作区内的绝对路径与相对路径都收敛成正斜杠相对路径", () => {
    const absolute = path.join(workspaceRoot, "src", "a.ts");
    expect(toWorkspaceRelative(absolute, workspaceRoot)).toBe("src/a.ts");
    expect(toWorkspaceRelative("src\\a.ts", workspaceRoot)).toBe("src/a.ts");
    expect(toWorkspaceRelative("./src/a.ts", workspaceRoot)).toBe("src/a.ts");
  });

  it("工作区外与非法路径一律拒绝", () => {
    expect(toWorkspaceRelative("D:\\outside\\a.ts", workspaceRoot)).toBeNull();
    expect(toWorkspaceRelative("src/../../outside.ts", workspaceRoot)).toBeNull();
    expect(toWorkspaceRelative(workspaceRoot, workspaceRoot)).toBeNull();
  });

  it("排除目录不记账", () => {
    expect(toWorkspaceRelative("node_modules/x/a.ts", workspaceRoot)).toBeNull();
    expect(toWorkspaceRelative("dist/a.js", workspaceRoot)).toBeNull();
    expect(toWorkspaceRelative("src/a.ts", workspaceRoot)).toBe("src/a.ts");
  });
});

describe("beginChangeCapture", () => {
  it("非写文件工具直接不抓取（零开销）", async () => {
    const { ledger } = fakeLedger();
    expect(await beginChangeCapture(captureInput({ risk: "read_only" }))).toBeNull();
    expect(await beginChangeCapture(captureInput({ ledger: undefined }))).toBeNull();
    void ledger;
  });

  it("记下改动前后的内容", async () => {
    const { ledger, records } = fakeLedger();
    await seed("src/a.ts", "before\n");
    const session = await beginChangeCapture(captureInput({ ledger }));
    await seed("src/a.ts", "after\n");
    await session?.finish(JSON.stringify({ changes: [{ file: path.join(workspaceRoot, "src/a.ts"), kind: "modified", insertions: 1, deletions: 1 }] }));

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      path: "src/a.ts",
      kind: "modify",
      source: "ai",
      before: "before\n",
      after: "after\n",
      label: "帮我改一下",
    });
  });

  it("新建的文件：before 记为 null（回退时删除它）", async () => {
    const { ledger, records } = fakeLedger();
    const session = await beginChangeCapture(captureInput({ args: { path: "src/new.ts" }, ledger }));
    await seed("src/new.ts", "hello\n");
    await session?.finish(JSON.stringify({ changes: [{ file: path.join(workspaceRoot, "src/new.ts"), kind: "added", insertions: 1, deletions: 0 }] }));

    expect(records[0]).toMatchObject({ kind: "create", before: null, after: "hello\n" });
  });

  it("删除的文件：after 记为 null", async () => {
    const { ledger, records } = fakeLedger();
    await seed("src/gone.ts", "bye\n");
    const session = await beginChangeCapture(captureInput({ args: { path: "src/gone.ts" }, ledger }));
    await fs.promises.rm(path.join(workspaceRoot, "src/gone.ts"));
    await session?.finish(JSON.stringify({ changes: [{ file: path.join(workspaceRoot, "src/gone.ts"), kind: "deleted", insertions: 0, deletions: 1 }] }));

    expect(records[0]).toMatchObject({ kind: "delete", before: "bye\n", after: null });
  });

  it("二进制文件：不存内容、标原因、没有基线（不能假装能回退）", async () => {
    const { ledger, records } = fakeLedger();
    await seed("assets/a.png", Buffer.from([0x89, 0x50, 0x00, 0x4e]));
    const session = await beginChangeCapture(captureInput({ args: { path: "assets/a.png" }, ledger }));
    await session?.finish(JSON.stringify({ changes: [{ file: path.join(workspaceRoot, "assets/a.png"), kind: "modified", insertions: 0, deletions: 0 }] }));

    expect(records[0].before).toBeUndefined();
    expect(records[0].after).toBeUndefined();
    expect(records[0].afterSkipped).toBe("binary");
  });

  it("同一轮同一文件改两次：基线保留最早那份（不会记成中间态）", async () => {
    const { ledger, records } = fakeLedger();
    const evidence = (kind: string) => JSON.stringify({
      changes: [{ file: path.join(workspaceRoot, "src/a.ts"), kind, insertions: 1, deletions: 1 }],
    });
    await seed("src/a.ts", "v1\n");
    const first = await beginChangeCapture(captureInput({ ledger }));
    await seed("src/a.ts", "v2\n");
    await first?.finish(evidence("modified"));

    const second = await beginChangeCapture(captureInput({ ledger }));
    await seed("src/a.ts", "v3\n");
    await second?.finish(evidence("modified"));

    expect(records[0]).toMatchObject({ before: "v1\n", after: "v2\n" });
    expect(records[1]).toMatchObject({ before: "v1\n", after: "v3\n" });
  });

  it("工作区外的改动不记账", async () => {
    const { ledger, records } = fakeLedger();
    const outside = path.join(os.tmpdir(), "outside-ledger.ts");
    const session = await beginChangeCapture(captureInput({ args: { path: outside }, ledger }));
    await fs.promises.writeFile(outside, "x", "utf8");
    await session?.finish(JSON.stringify({ changes: [{ file: outside, kind: "modified", insertions: 1, deletions: 0 }] }));
    await fs.promises.rm(outside, { force: true });

    expect(records).toHaveLength(0);
  });

  it("记账出错不影响主流程", async () => {
    const ledger = {
      record: vi.fn(async () => {
        throw new Error("disk full");
      }),
    } as unknown as ChangeLedger;
    await seed("src/a.ts", "before\n");
    const session = await beginChangeCapture(captureInput({ ledger }));
    await seed("src/a.ts", "after\n");
    const evidence = JSON.stringify({ changes: [{ file: path.join(workspaceRoot, "src/a.ts"), kind: "modified", insertions: 1, deletions: 1 }] });
    await expect(session?.finish(evidence)).resolves.toBeUndefined();
  });
});
