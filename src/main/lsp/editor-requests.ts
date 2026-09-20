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
  WorkbenchLspSignature,
  WorkbenchLspSignatureHelp,
  WorkbenchLspSignatureParameter,
} from "../../shared/code-workbench-types";

/** 渲染端只说用途，协议方法名在这里翻译，免得 LSP 方法名散落到渲染端 */
const LSP_METHODS: Record<WorkbenchLspRequestMethod, string> = {
  completion: "textDocument/completion",
  hover: "textDocument/hover",
  definition: "textDocument/definition",
  implementation: "textDocument/implementation",
  references: "textDocument/references",
  signatureHelp: "textDocument/signatureHelp",
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

/**
 * 一个参数的归一化；形状不对就返回 null（调用方只丢掉这一个参数，不牵连整条签名）。
 *
 * 偏移标签的语义是"相对**签名文本**的起含止不含区间"（Monaco 与 LSP 都是这个意思），
 * 所以除了"非负整数 + 恰好两个"，还得要求 start <= end 且 end 不超出签名文本长度——
 * 否则不管语言服务给的是坏数据还是我们认错了，Monaco 都会把高亮画到签名外面去。
 */
function toSignatureParameter(entry: unknown, signatureLabel: string): WorkbenchLspSignatureParameter | null {
  if (typeof entry === "string") return { label: entry };
  if (!entry || typeof entry !== "object") return null;
  const label = (entry as { label?: unknown }).label;
  if (typeof label === "string") return { label };
  if (!Array.isArray(label) || label.length !== 2) return null;
  const [start, end] = label;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null;
  if ((start as number) < 0 || (end as number) < (start as number) || (end as number) > signatureLabel.length) return null;
  return { label: [start as number, end as number] };
}

/**
 * 参数列表归一化。除了参数本身，还要把"第 i 个保留项对应原始数组里的下标"带出来：
 * activeParameter 是语言服务按**原始数组**给的，滤掉非法项之后不能直接当新下标用。
 */
function toSignatureParameters(
  raw: unknown,
  signatureLabel: string,
): { parameters: WorkbenchLspSignatureParameter[]; sourceIndexes: number[] } {
  const parameters: WorkbenchLspSignatureParameter[] = [];
  const sourceIndexes: number[] = [];
  const entries = Array.isArray(raw) ? raw : [];
  for (let index = 0; index < entries.length; index += 1) {
    const parameter = toSignatureParameter(entries[index], signatureLabel);
    if (!parameter) continue;
    parameters.push(parameter);
    sourceIndexes.push(index);
  }
  return { parameters, sourceIndexes };
}

/** 原始下标 → 过滤后的下标；这个条目被滤掉了（或本来就是非法值）就退回 0 */
function indexAfterFiltering(value: unknown, sourceIndexes: readonly number[]): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return 0;
  const mapped = sourceIndexes.indexOf(value);
  return mapped < 0 ? 0 : mapped;
}

/**
 * 参数提示：signatures[] + 当前第几个签名、第几个参数。
 *
 * 语言服务这两项都是可选的（不给就按 0 算），而 Monaco 少了下标会当成"没得高亮"，
 * 所以这里统一补成**一定有效的下标**，渲染端不必再夹取。整个结构为空就返回 null，
 * 编辑器就不弹提示框（语法没写完、位置不在调用里，都会是这种情况）。
 *
 * 两个下标都要**过一遍映射**：语言服务给的是原始数组里的位置，而上面会滤掉没 label、
 * 参数形状不对的条目；不映射的话，被丢掉的那条前面只要有内容，就会指着隔壁那条
 * （比如"第 2 条签名"变成"第 1 条"）。映射不到就退回 0。
 */
export function normalizeSignatureHelp(raw: unknown): WorkbenchLspSignatureHelp | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as { signatures?: unknown; activeSignature?: unknown; activeParameter?: unknown };
  const sources = Array.isArray(record.signatures) ? record.signatures : [];
  const signatures: WorkbenchLspSignature[] = [];
  const signatureSourceIndexes: number[] = [];
  const parameterSourceIndexes: number[][] = [];
  for (let index = 0; index < sources.length; index += 1) {
    const entry = sources[index];
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    const label = typeof item.label === "string" ? item.label : undefined;
    if (!label) continue;
    const parameters = toSignatureParameters(item.parameters, label);
    signatures.push({
      label,
      documentation: documentationToText(item.documentation),
      parameters: parameters.parameters.length ? parameters.parameters : undefined,
    });
    signatureSourceIndexes.push(index);
    parameterSourceIndexes.push(parameters.sourceIndexes);
  }
  if (!signatures.length) return null;
  const activeSignature = indexAfterFiltering(record.activeSignature, signatureSourceIndexes);
  const activeParameter = indexAfterFiltering(record.activeParameter, parameterSourceIndexes[activeSignature]);
  return { signatures, activeSignature, activeParameter };
}

/** 统一入口：按方法拍平，渲染端拿到的永远是同一种形状 */
export function normalizeLspResult(
  method: WorkbenchLspRequestMethod,
  raw: unknown,
  workspaceRoot: string,
): WorkbenchLspRequestResult {
  if (method === "completion") return { method, completions: normalizeCompletions(raw) };
  if (method === "hover") return { method, hover: normalizeHover(raw) };
  if (method === "signatureHelp") return { method, signatureHelp: normalizeSignatureHelp(raw) };
  // 定义 / 跳到实现 / 查引用：返回值形状一致（Location 或 LocationLink），走同一条拍平
  return { method, locations: normalizeLocations(raw, workspaceRoot) };
}
