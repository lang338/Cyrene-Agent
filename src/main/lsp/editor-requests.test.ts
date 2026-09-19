// 归一化层的测试：这些函数负责"把语言服务的各种返回形状拍平"，
// 是补全/悬停/跳转能不能正确显示的最后一环，回归价值高。

import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildLspRequestParams,
  lspMethodFor,
  normalizeCompletions,
  normalizeHover,
  normalizeLocations,
  normalizeLspResult,
  normalizeSignatureHelp,
} from "./editor-requests";

const ROOT = process.platform === "win32" ? "C:\\ws" : "/ws";
const uriFor = (absolutePath: string): string => pathToFileURL(absolutePath).toString();
const range = () => ({ start: { line: 3, character: 0 }, end: { line: 3, character: 5 } });

describe("lspMethodFor", () => {
  it("把用途翻译成协议方法名", () => {
    expect(lspMethodFor("completion")).toBe("textDocument/completion");
    expect(lspMethodFor("hover")).toBe("textDocument/hover");
    expect(lspMethodFor("definition")).toBe("textDocument/definition");
    expect(lspMethodFor("references")).toBe("textDocument/references");
    expect(lspMethodFor("implementation")).toBe("textDocument/implementation");
    expect(lspMethodFor("signatureHelp")).toBe("textDocument/signatureHelp");
  });
});

describe("buildLspRequestParams", () => {
  it("URI 由主进程按绝对路径生成，位置原样透传", () => {
    const params = buildLspRequestParams({
      method: "hover",
      absolutePath: path.join(ROOT, "a.ts"),
      position: { line: 2, character: 4 },
    }) as { textDocument: { uri: string }; position: unknown; context?: unknown };
    expect(params.textDocument.uri).toBe(uriFor(path.join(ROOT, "a.ts")));
    expect(params.position).toEqual({ line: 2, character: 4 });
    expect(params.context).toBeUndefined();
  });

  it("查引用时默认把声明本身也算进去", () => {
    const params = buildLspRequestParams({
      method: "references",
      absolutePath: path.join(ROOT, "a.ts"),
      position: { line: 0, character: 0 },
    }) as { context?: { includeDeclaration?: boolean } };
    expect(params.context?.includeDeclaration).toBe(true);
  });

  it("查引用时可以显式排除声明", () => {
    const params = buildLspRequestParams({
      method: "references",
      absolutePath: path.join(ROOT, "a.ts"),
      position: { line: 0, character: 0 },
      includeDeclaration: false,
    }) as { context?: { includeDeclaration?: boolean } };
    expect(params.context?.includeDeclaration).toBe(false);
  });
});

describe("normalizeCompletions", () => {
  it("认得 CompletionItem[] 与 CompletionList 两种形态", () => {
    expect(normalizeCompletions([{ label: "alpha" }])).toHaveLength(1);
    expect(normalizeCompletions({ isIncomplete: false, items: [{ label: "beta" }] })).toHaveLength(1);
  });

  it("丢掉没有 label 的项，其余字段按需保留", () => {
    const items = normalizeCompletions([
      { kind: 3 },
      { label: "fn", kind: 3, detail: "(x: number) => void", documentation: { kind: "markdown", value: "说明" } },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].label).toBe("fn");
    expect(items[0].detail).toBe("(x: number) => void");
    expect(items[0].documentation).toBe("说明");
  });

  it("优先用 textEdit.newText，并带上替换范围", () => {
    const [item] = normalizeCompletions([
      { label: "fn", textEdit: { newText: "fn(${1:x})", range: range() } },
    ]);
    expect(item.insertText).toBe("fn(${1:x})");
    expect(item.textEditRange).toEqual(range());
  });

  it("没有 textEdit 时退回 insertText", () => {
    const [item] = normalizeCompletions([{ label: "fn", insertText: "fn" }]);
    expect(item.insertText).toBe("fn");
    expect(item.textEditRange).toBeUndefined();
  });

  it("数组之外的异常输入给空列表，不抛", () => {
    expect(normalizeCompletions(null)).toEqual([]);
    expect(normalizeCompletions({})).toEqual([]);
    expect(normalizeCompletions(42)).toEqual([]);
  });
});

describe("normalizeHover", () => {
  it("MarkupContent 拍成纯文本", () => {
    expect(normalizeHover({ contents: { kind: "markdown", value: "const x: number" } })).toEqual({
      contents: "const x: number",
      range: undefined,
    });
  });

  it("MarkedString 数组拼成多段", () => {
    const hover = normalizeHover({ contents: ["第一段", { language: "ts", value: "第二段" }] });
    expect(hover?.contents).toBe("第一段\n\n第二段");
  });

  it("内容为空时返回 null（编辑器就不弹悬浮框）", () => {
    expect(normalizeHover({ contents: "" })).toBeNull();
    expect(normalizeHover(null)).toBeNull();
  });
});

describe("normalizeLocations", () => {
  it("工作区内的定义给相对路径（正斜杠）", () => {
    const locations = normalizeLocations([{ uri: uriFor(path.join(ROOT, "src", "a.ts")), range: range() }], ROOT);
    expect(locations).toEqual([{ path: "src/a.ts", range: range() }]);
  });

  it("工作区外的定义给绝对路径，路径字段留空", () => {
    const outside = process.platform === "win32" ? "C:\\other\\dep.d.ts" : "/other/dep.d.ts";
    const [location] = normalizeLocations([{ uri: uriFor(outside), range: range() }], ROOT);
    expect(location.path).toBeNull();
    expect(location.externalPath).toBe(outside);
  });

  it("LocationLink 用 targetUri + targetSelectionRange", () => {
    const locations = normalizeLocations(
      [{ targetUri: uriFor(path.join(ROOT, "b.ts")), targetSelectionRange: range() }],
      ROOT,
    );
    expect(locations).toEqual([{ path: "b.ts", range: range() }]);
  });

  it("非 file:// 的虚拟文档直接丢弃", () => {
    const locations = normalizeLocations(
      [{ uri: "jdt://contents/java.lang/String.class", range: range() }],
      ROOT,
    );
    expect(locations).toEqual([]);
  });

  it("单个 Location（非数组）也认", () => {
    expect(normalizeLocations({ uri: uriFor(path.join(ROOT, "c.ts")), range: range() }, ROOT)).toHaveLength(1);
  });

  it("缺 range 的条目丢掉，不产生不可跳转的位置", () => {
    expect(normalizeLocations([{ uri: uriFor(path.join(ROOT, "d.ts")) }], ROOT)).toEqual([]);
  });
});

describe("normalizeSignatureHelp", () => {
  it("签名与参数标签两种写法都认，文档拍成纯文本", () => {
    const help = normalizeSignatureHelp({
      signatures: [
        {
          label: "writeFile(sessionId, path)",
          documentation: { kind: "markdown", value: "写文件" },
          parameters: [{ label: "sessionId" }, { label: [16, 20] }],
        },
      ],
      activeSignature: 0,
      activeParameter: 1,
    });
    expect(help).toEqual({
      signatures: [
        {
          label: "writeFile(sessionId, path)",
          documentation: "写文件",
          parameters: [{ label: "sessionId" }, { label: [16, 20] }],
        },
      ],
      activeSignature: 0,
      activeParameter: 1,
    });
  });

  it("下标越界/缺失时夹回 0：渲染端拿到的必须永远有效", () => {
    const help = normalizeSignatureHelp({
      signatures: [{ label: "fn(a)", parameters: [{ label: "a" }] }],
      activeSignature: 7,
      activeParameter: -1,
    });
    expect(help?.activeSignature).toBe(0);
    expect(help?.activeParameter).toBe(0);
  });

  it("没有签名就返回 null（编辑器不弹参数框）", () => {
    expect(normalizeSignatureHelp({ signatures: [] })).toBeNull();
    expect(normalizeSignatureHelp({ signatures: [{ label: "" }] })).toBeNull();
    expect(normalizeSignatureHelp(null)).toBeNull();
  });

  it("参数标签是乱七八糟的形状时只丢掉那一个参数，不牵连整条签名", () => {
    const help = normalizeSignatureHelp({
      signatures: [{ label: "fn(a, b)", parameters: [{ label: "a" }, { label: [1] }, 42, { label: "b" }] }],
    });
    expect(help?.signatures[0].parameters).toEqual([{ label: "a" }, { label: "b" }]);
  });
});

describe("normalizeLspResult", () => {
  it("按方法挑对应字段，渲染端永远拿到同一种形状", () => {
    expect(normalizeLspResult("completion", [{ label: "x" }], ROOT).completions).toHaveLength(1);
    expect(normalizeLspResult("hover", { contents: "t" }, ROOT).hover?.contents).toBe("t");
    expect(normalizeLspResult("definition", [], ROOT).locations).toEqual([]);
  });

  it("跳到实现与查引用的返回形状一致，共用同一条拍平", () => {
    const raw = [{ uri: uriFor(path.join(ROOT, "impl.ts")), range: range() }];
    expect(normalizeLspResult("implementation", raw, ROOT).locations).toEqual([{ path: "impl.ts", range: range() }]);
  });

  it("参数提示走自己的拍平，不落到位置那条路上", () => {
    const result = normalizeLspResult("signatureHelp", { signatures: [{ label: "fn()" }] }, ROOT);
    expect(result.signatureHelp?.signatures[0].label).toBe("fn()");
    expect(result.locations).toBeUndefined();
  });
});
