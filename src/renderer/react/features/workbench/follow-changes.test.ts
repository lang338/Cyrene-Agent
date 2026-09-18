import { describe, expect, it } from "vitest";
import type { ToolExecutionRecord } from "../../../../shared/chat-types";
import { ancestorDirs, advanceAiFileChangeBaseline, resolveWorkspaceRelative } from "./follow-changes";

function tool(overrides: Partial<ToolExecutionRecord> & Pick<ToolExecutionRecord, "id">): ToolExecutionRecord {
  return { name: "write_file", status: "success", ...overrides };
}

function message(id: string, tools: ToolExecutionRecord[]) {
  return { id, toolExecutions: tools };
}

const writeChange = (file: string, kind: "added" | "modified" | "deleted" | "renamed" = "modified") => ({
  file,
  kind,
  insertions: 1,
  deletions: 0,
});

describe("resolveWorkspaceRelative", () => {
  const root = "C:\\projects\\daily";

  it("keeps workspace-relative paths and normalizes separators", () => {
    expect(resolveWorkspaceRelative("src/a.ts", root)).toBe("src/a.ts");
    expect(resolveWorkspaceRelative("./src/a.ts", root)).toBe("src/a.ts");
    expect(resolveWorkspaceRelative("src\\nested\\a.ts", root)).toBe("src/nested/a.ts");
    expect(resolveWorkspaceRelative("  src/a.ts  ", root)).toBe("src/a.ts");
  });

  it("maps absolute paths inside the workspace back to relative ones", () => {
    expect(resolveWorkspaceRelative("C:\\projects\\daily\\src\\a.ts", root)).toBe("src/a.ts");
    expect(resolveWorkspaceRelative("c:/PROJECTS/DAILY/src/a.ts", root)).toBe("src/a.ts");
  });

  it("rejects paths outside the workspace", () => {
    expect(resolveWorkspaceRelative("C:\\Users\\me\\Desktop\\a.ts", root)).toBeNull();
    expect(resolveWorkspaceRelative("C:\\projects\\daily-other\\a.ts", root)).toBeNull();
    expect(resolveWorkspaceRelative("D:\\a.ts", root)).toBeNull();
  });

  it("keeps POSIX prefix matching case-sensitive", () => {
    expect(resolveWorkspaceRelative("/home/me/proj/a.ts", "/home/me/proj")).toBe("a.ts");
    expect(resolveWorkspaceRelative("/home/me/PROJ/a.ts", "/home/me/proj")).toBeNull();
  });

  it("rejects traversal, empty and root-only inputs", () => {
    expect(resolveWorkspaceRelative("src/../a.ts", root)).toBeNull();
    expect(resolveWorkspaceRelative("..\\a.ts", root)).toBeNull();
    expect(resolveWorkspaceRelative("", root)).toBeNull();
    expect(resolveWorkspaceRelative("   ", root)).toBeNull();
    expect(resolveWorkspaceRelative("C:\\projects\\daily", root)).toBeNull();
    expect(resolveWorkspaceRelative("src/a\0.ts", root)).toBeNull();
  });

  it("drops absolute paths when the session has no workspace", () => {
    expect(resolveWorkspaceRelative("C:\\projects\\daily\\a.ts", undefined)).toBeNull();
    expect(resolveWorkspaceRelative("src/a.ts", undefined)).toBe("src/a.ts");
  });
});

describe("ancestorDirs", () => {
  it("lists every parent directory of the target file", () => {
    expect(ancestorDirs("a/b/c.ts")).toEqual(["a", "a/b"]);
    expect(ancestorDirs("a\\b\\c.ts")).toEqual(["a", "a/b"]);
  });

  it("returns nothing for root-level files", () => {
    expect(ancestorDirs("a.ts")).toEqual([]);
  });
});

describe("advanceAiFileChangeBaseline", () => {
  const root = "C:\\proj";
  const history = [message("m1", [tool({ id: "t1", changes: [writeChange("src/a.ts")] })])];

  it("registers existing evidence on the first scan without replaying it", () => {
    const first = advanceAiFileChangeBaseline(null, "s1", history, root);
    expect(first.fresh).toEqual([]);
    expect(first.baseline?.keys.has("m1:t1")).toBe(true);

    const second = advanceAiFileChangeBaseline(first.baseline, "s1", history, root);
    expect(second.fresh).toEqual([]);
  });

  it("reports newly finished tool changes only once", () => {
    const initial = advanceAiFileChangeBaseline(null, "s1", history, root);
    const next = [...history, message("m2", [tool({ id: "t2", changes: [writeChange("src/b.ts", "added")] })])];
    const second = advanceAiFileChangeBaseline(initial.baseline, "s1", next, root);
    expect(second.fresh).toEqual([{ key: "m2:t2", path: "src/b.ts", kind: "added" }]);

    const third = advanceAiFileChangeBaseline(second.baseline, "s1", next, root);
    expect(third.fresh).toEqual([]);
  });

  it("does not take an empty message list as a baseline", () => {
    const empty = advanceAiFileChangeBaseline(null, "s1", [], root);
    expect(empty.baseline).toBeNull();
    // 历史随后到位：不能因为之前扫过空列表就把历史当成刚发生
    const loaded = advanceAiFileChangeBaseline(empty.baseline, "s1", history, root);
    expect(loaded.fresh).toEqual([]);
    expect(loaded.baseline?.keys.has("m1:t1")).toBe(true);
  });

  it("rebuilds the baseline when the session changes", () => {
    const sessionOne = advanceAiFileChangeBaseline(null, "s1", [], root);
    const switched = advanceAiFileChangeBaseline(sessionOne.baseline, "s2", history, root);
    expect(switched.fresh).toEqual([]);
    expect(switched.baseline?.sessionId).toBe("s2");
  });

  it("ignores tools that are still running or carry no evidence", () => {
    const scan = advanceAiFileChangeBaseline(
      { sessionId: "s1", keys: new Set() },
      "s1",
      [
        message("m1", [
          tool({ id: "t1", status: "running", changes: [writeChange("src/a.ts")] }),
          tool({ id: "t2", result: "done" }),
        ]),
      ],
      root,
    );
    expect(scan.fresh).toEqual([]);
    expect(scan.baseline?.keys.size).toBe(0);
  });

  it("drops changes outside the workspace but still marks the tool as seen", () => {
    const scan = advanceAiFileChangeBaseline(
      { sessionId: "s1", keys: new Set() },
      "s1",
      [message("m1", [tool({ id: "t1", changes: [writeChange("C:\\Users\\me\\Desktop\\a.ts")] })])],
      root,
    );
    expect(scan.fresh).toEqual([]);
    expect(scan.baseline?.keys.has("m1:t1")).toBe(true);
  });

  it("reports every file of a single tool call in order", () => {
    const scan = advanceAiFileChangeBaseline(
      { sessionId: "s1", keys: new Set() },
      "s1",
      [message("m1", [tool({ id: "t1", changes: [writeChange("src/a.ts"), writeChange("src/b.ts", "added")] })])],
      root,
    );
    expect(scan.fresh.map((change) => change.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(new Set(scan.fresh.map((change) => change.key))).toEqual(new Set(["m1:t1"]));
  });
});
