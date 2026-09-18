// 把 Monaco 的补全 / 悬停 / 跳转 / 查引用，托管给主进程里的外部语言服务。
//
// 为什么用模块级变量而不是 React context：Monaco 的 provider 是按"语言"全局注册的，
// 回调活在 React 之外，读不到 context。工作台挂载时把会话写进来即可。
//
// 拿不到语言服务时全部返回 null / 空数组——编辑器静默降级：补全菜单不弹、跳转没反应，
// 但输入和保存照常，不会报错打扰用户。

import * as monaco from "monaco-editor";
import type {
  LspRange,
  WorkbenchLspCompletionItem,
  WorkbenchLspRequestMethod,
  WorkbenchLspRequestResult,
} from "../../../../shared/code-workbench-types";
import { workbenchApi } from "./WorkspaceTree";

/** 当前活动的会话；null = 不在工作台里，provider 一律不响应 */
let activeSessionId: string | null = null;
let registered = false;

export function setLspProviderSession(sessionId: string | null): void {
  activeSessionId = sessionId;
}

/**
 * 从 model 的 URI 反推工作区相对路径。
 * 工作台把 model 的 path 设成 `file:///<文件键>`，工作区内的文件键就是相对路径；
 * 工作区外的文件用的是绝对路径（`C:/...`），它不属于任何项目，返回 null 让语言服务不参与。
 */
function relativePathFromModel(model: monaco.editor.ITextModel): string | null {
  const withoutLeadingSlash = (model.uri.path ?? "").replace(/^\/+/, "");
  if (!withoutLeadingSlash) return null;
  if (/^[a-zA-Z]:\//.test(withoutLeadingSlash)) return null; // 盘符绝对路径 = 工作区外
  return withoutLeadingSlash;
}

/** LSP 位置（0 起）→ Monaco 位置（1 起）。两边差 1，错一位就会标错行 */
function toMonacoRange(range: LspRange): monaco.IRange {
  return {
    startLineNumber: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLineNumber: range.end.line + 1,
    endColumn: range.end.character + 1,
  };
}

/** 问一次语言服务；任何异常/超时都当作"没有答案"，不让它冒到编辑器上 */
async function askLsp(
  model: monaco.editor.ITextModel,
  position: monaco.Position,
  method: WorkbenchLspRequestMethod,
): Promise<WorkbenchLspRequestResult | null> {
  const sessionId = activeSessionId;
  if (!sessionId) return null;
  const path = relativePathFromModel(model);
  if (!path) return null;
  const api = workbenchApi();
  if (!api?.requestLsp) return null;
  try {
    return await api.requestLsp({
      sessionId,
      path,
      method,
      // Monaco 行列从 1 起算，LSP 从 0 起算
      position: { line: position.lineNumber - 1, character: position.column - 1 },
      includeDeclaration: method === "references" ? true : undefined,
    });
  } catch {
    return null;
  }
}

/** 补全项 → Monaco 补全项。两边的 kind 编码刻意保持一致（Monaco 照 LSP 抄的），可以直接透传 */
function toMonacoCompletion(
  item: WorkbenchLspCompletionItem,
  defaultRange: monaco.IRange,
): monaco.languages.CompletionItem {
  const insertText = item.insertText ?? item.label;
  // 语言服务给的函数补全常带 `${1:参数}` 占位，按片段插入才能让用户按 Tab 跳参数
  const isSnippet = insertText.includes("${");
  return {
    label: item.label,
    kind: (item.kind ?? monaco.languages.CompletionItemKind.Text) as monaco.languages.CompletionItemKind,
    detail: item.detail,
    documentation: item.documentation ? { value: item.documentation } : undefined,
    insertText,
    insertTextRules: isSnippet ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
    sortText: item.sortText,
    filterText: item.filterText,
    range: item.textEditRange ? toMonacoRange(item.textEditRange) : defaultRange,
  };
}

function provideCompletionItems(
  model: monaco.editor.ITextModel,
  position: monaco.Position,
): Promise<monaco.languages.CompletionList> {
  const word = model.getWordUntilPosition(position);
  const defaultRange: monaco.IRange = {
    startLineNumber: position.lineNumber,
    startColumn: word.startColumn,
    endLineNumber: position.lineNumber,
    endColumn: word.endColumn,
  };
  return askLsp(model, position, "completion").then((result) => {
    const items = result?.completions ?? [];
    return { suggestions: items.map((item) => toMonacoCompletion(item, defaultRange)) };
  });
}

function provideHover(
  model: monaco.editor.ITextModel,
  position: monaco.Position,
): Promise<monaco.languages.Hover | null> {
  return askLsp(model, position, "hover").then((result) => {
    const hover = result?.hover;
    if (!hover) return null;
    return {
      // 语言服务没给范围时，用整行兜底，否则悬停内容会挂在零宽的位置上不显示
      range: hover.range
        ? toMonacoRange(hover.range)
        : {
            startLineNumber: position.lineNumber,
            startColumn: 1,
            endLineNumber: position.lineNumber,
            endColumn: model.getLineMaxColumn(position.lineNumber),
          },
      contents: [{ value: hover.contents }],
    };
  });
}

/** 位置列表 → Monaco 可跳转的位置；工作区外的定义（在依赖里）跳不过去，直接滤掉 */
function toMonacoLocations(result: WorkbenchLspRequestResult | null): monaco.languages.Location[] {
  return (result?.locations ?? []).flatMap((location) => {
    if (!location.path) return [];
    return [{ uri: monaco.Uri.parse(`file:///${location.path}`), range: toMonacoRange(location.range) }];
  });
}

function provideDefinition(
  model: monaco.editor.ITextModel,
  position: monaco.Position,
): Promise<monaco.languages.Location[]> {
  return askLsp(model, position, "definition").then(toMonacoLocations);
}

function provideReferences(
  model: monaco.editor.ITextModel,
  position: monaco.Position,
): Promise<monaco.languages.Location[]> {
  return askLsp(model, position, "references").then(toMonacoLocations);
}

/** 只在 TS/JS 上注册：其余语言的补全留给 Monaco 自己或对应语言服务 */
const PROVIDER_LANGUAGES = ["typescript", "javascript"];

export function registerLspProviders(): void {
  if (registered) return;
  registered = true;
  for (const language of PROVIDER_LANGUAGES) {
    monaco.languages.registerCompletionItemProvider(language, {
      // 打这些字符时主动问一次，其余靠 quickSuggestions 的自动触发
      triggerCharacters: [".", '"', "'", "`", "/", "@", "<"],
      provideCompletionItems,
    });
    monaco.languages.registerHoverProvider(language, { provideHover });
    monaco.languages.registerDefinitionProvider(language, { provideDefinition });
    monaco.languages.registerReferenceProvider(language, { provideReferences });
  }
}
