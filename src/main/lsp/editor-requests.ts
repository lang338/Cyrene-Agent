// 把语言服务返回的 LSP 原始结构，拍平成渲染端好用的简单形状。
//
// 为什么单独抽一个文件：LSP 的返回形状花样很多——补全可能是 CompletionItem[] 也可能是
// CompletionList；悬停内容可能是 MarkupContent / MarkedString / 混排数组；定义可能是
// Location、LocationLink，甚至是带 targetUri 的链接。这些差异只该在主进程里消化掉，
// 渲染端不该为了几个字段去依赖整个 LSP 类型包。
// 全是纯函数，方便单测。

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
  LspPosition,
  LspRange,
  WorkbenchLspCompletionItem,
  WorkbenchLspHover,
  WorkbenchLspLocation,
  WorkbenchLspRequestMethod,
  WorkbenchLspRequestResult,
} from "../../shared/code-workbench-types";

/** 渲染端只说用途，协议方法名在这里翻译，免得 LSP 方法名散落到渲染端 */
const LSP_METHODS: Record<WorkbenchLspRequestMethod, string> = {
  completion: "textDocument/completion",
  hover: "textDocument/hover",
  definition: "textDocument/definition",
  references: "textDocument/references",
};

/** 一次返回几百项之后就没有意义了，还会把 IPC 撑大，按语言服务通行做法截断 */
const MAX_COMPLETIONS = 300;

export function lspMethodFor(method: WorkbenchLspRequestMethod): string {
  return LSP_METHODS[method];
}

/** 组装请求参数：URI 必须由主进程按绝对路径生成，渲染端给不出可信的 URI */
export function buildLspRequestParams(input: {
  method: WorkbenchLspRequestMethod;
  absolutePath: string;
  position: LspPosition;
  includeDeclaration?: boolean;
}): unknown {
  const uri = pathToFileURL(input.absolutePath).toString();
  const base = { textDocument: { uri }, position: input.position };
  return input.method === "references"
    ? { ...base, context: { includeDeclaration: input.includeDeclaration ?? true } }
    : base;
}

function toPosition(raw: unknown): LspPosition | null {
  if (!raw || typeof raw !== "object") return null;
  const { line, character } = raw as { line?: unknown; character?: unknown };
  if (typeof line !== "number" || typeof character !== "number") return null;
  return { line, character };
}

function toRange(raw: unknown): LspRange | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const { start, end } = raw as { start?: unknown; end?: unknown };
  const from = toPosition(start);
  const to = toPosition(end);
  return from && to ? { start: from, end: to } : undefined;
}

/**
 * 文档说明的统一拍平。
 * LSP 允许 string、{ language, value }、MarkupContent、以及它们的数组混排，
 * 渲染端只想要一段纯文本，所以在这里全部压平。
 */
function documentationToText(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") return value.trim() ? value : undefined;
  if (Array.isArray(value)) {
    const parts = value.map(documentationToText).filter((part): part is string => Boolean(part));
    return parts.length ? parts.join("\n\n") : undefined;
  }
  if (typeof value === "object") {
    const inner = (value as { value?: unknown }).value;
    if (typeof inner === "string") return inner.trim() ? inner : undefined;
  }
  return undefined;
}

/** 补全项：CompletionItem[] 与 CompletionList（{ items, isIncomplete }）两种形态都要认 */
export function normalizeCompletions(raw: unknown): WorkbenchLspCompletionItem[] {
  const container = raw as { items?: unknown } | null;
  const items = Array.isArray(raw) ? raw : Array.isArray(container?.items) ? container.items : [];
  const result: WorkbenchLspCompletionItem[] = [];
  for (const entry of items.slice(0, MAX_COMPLETIONS)) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    const label = typeof item.label === "string" ? item.label : undefined;
    if (!label) continue;
    // 插入文本有两种表达：textEdit.newText（带替换范围）或 insertText（无范围）。
    // InsertReplaceEdit 也会带 range，所以统一从 textEdit.range 取范围。
    const edit = item.textEdit as { range?: unknown; newText?: unknown } | undefined;
    result.push({
      label,
      kind: typeof item.kind === "number" ? item.kind : undefined,
      detail: typeof item.detail === "string" ? item.detail : undefined,
      documentation: documentationToText(item.documentation),
      insertText: typeof edit?.newText === "string" ? edit.newText : typeof item.insertText === "string" ? item.insertText : undefined,
      sortText: typeof item.sortText === "string" ? item.sortText : undefined,
      filterText: typeof item.filterText === "string" ? item.filterText : undefined,
      textEditRange: toRange(edit?.range),
    });
  }
  return result;
}

/** 悬停内容：可能是 MarkupContent、MarkedString、或字符串数组，统一拍成多行纯文本 */
export function normalizeHover(raw: unknown): WorkbenchLspHover | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as { contents?: unknown; range?: unknown };
  const text = documentationToText(record.contents);
  if (!text) return null;
  return { contents: text, range: toRange(record.range) };
}

/**
 * 定义 / 引用 → 位置列表。
 * 只接受 file:// 的 URI：语言服务有时会返回 jdt:// 之类的虚拟文档，编辑器打不开，直接丢掉。
 * 落在工作区内的给相对路径，工作区外的给绝对路径（好让界面说明"定义在依赖里"）。
 */
export function normalizeLocations(raw: unknown, workspaceRoot: string): WorkbenchLspLocation[] {
  const list = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
  const locations: WorkbenchLspLocation[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const uri =
      typeof record.uri === "string" ? record.uri : typeof record.targetUri === "string" ? record.targetUri : undefined;
    if (!uri || !uri.startsWith("file://")) continue;
    let absolutePath: string;
    try {
      absolutePath = fileURLToPath(uri);
    } catch {
      continue;
    }
    // Location 用 range，LocationLink 用 targetSelectionRange
    const range = toRange(record.range) ?? toRange(record.targetSelectionRange);
    if (!range) continue;
    const relative = path.relative(workspaceRoot, absolutePath);
    const inside =
      relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    locations.push(
      inside
        ? { path: relative.split(path.sep).join("/"), range }
        : { path: null, externalPath: absolutePath, range },
    );
  }
  return locations;
}

/** 统一入口：按方法拍平，渲染端拿到的永远是同一种形状 */
export function normalizeLspResult(
  method: WorkbenchLspRequestMethod,
  raw: unknown,
  workspaceRoot: string,
): WorkbenchLspRequestResult {
  if (method === "completion") return { method, completions: normalizeCompletions(raw) };
  if (method === "hover") return { method, hover: normalizeHover(raw) };
  return { method, locations: normalizeLocations(raw, workspaceRoot) };
}
