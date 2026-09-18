// 把 Monaco 的补全 / 悬停 / 跳转 / 查引用，托管给主进程里的外部语言服务。
//
// 为什么用模块级变量而不是 React context：Monaco 的 provider 是按"语言"全局注册的，
// 回调活在 React 之外，读不到 context。工作台挂载时把会话写进来即可。
//
// 拿不到语言服务时全部返回 null / 空数组，同时把 Monaco 内建的 TS 语言智能打开兜底
// （见 setBuiltinTsIntelligence）——只"静默降级"是不够的，那等于把用户原本就有的
// 同文件补全也一并拿走了。输入和保存始终照常，不会报错打扰用户。

import * as monaco from "monaco-editor";
import type {
  LspRange,
  WorkbenchLspCompletionItem,
  WorkbenchLspRequestMethod,
  WorkbenchLspRequestResult,
} from "../../../../shared/code-workbench-types";
import { workbenchApi } from "./WorkspaceTree";
import { setBuiltinTsIntelligence } from "./monaco-setup";

/** 当前活动的会话；null = 不在工作台里，provider 一律不响应 */
let activeSessionId: string | null = null;
let registered = false;

export function setLspProviderSession(sessionId: string | null): void {
  activeSessionId = sessionId;
  // 离开工作台就把内建语言智能还原成默认开启：外部服务这条路径已经不再响应，
  // 留着"关闭"既没有意义，也会让下次进来时短暂没有兜底。
  if (!sessionId) setBuiltinTsIntelligence(true);
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
  const path = relativePathFromModel(model);
  const api = workbenchApi();
  if (!sessionId) return null;
  if (!path) return null;
  if (!api?.requestLsp) return null;
  // 问之前必须先同步：工作台那侧的文档同步带 400ms 防抖（避免每敲一个字往返一趟），
  // 但补全是打字时触发的——请求会先到，语言服务手里还是旧文本、位置也偏，
  // 结果要么补出错误内容、要么返回空（表现为只剩"同文件词汇"建议）。
  // 悬停/跳转同理：刚敲完就悬停，看到的是上一版的类型。
  if (api.syncLspDocument) {
    try {
      // 这个返回值就是主进程侧"有没有拿到这个工作区的语言服务"：true 才敢关掉内建兜底
      // 带上模型版本号：主进程据此丢弃迟到的旧同步（旧内容一旦落进去，补全就按旧内容算，
      // 表现为"刚敲的那行拿不到成员补全，而悬停却是对的"）
      const synced = await api.syncLspDocument(
        sessionId,
        path,
        model.getValue(),
        model.getLanguageId(),
        model.getVersionId(),
      );
      setBuiltinTsIntelligence(!synced);
    } catch {
      // 同步失败就照常问：语言服务可能只是暂时不可用，让它自己降级；兜底先放回去
      setBuiltinTsIntelligence(true);
    }
  }
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

/**
 * LSP 的 CompletionItemKind 与 Monaco 的不是同一套编号：LSP 是 Text=1、Method=2…，
 * Monaco 是 Method=0、Function=1、…、Text=18。直接透传会把图标画错（变量显示成方法
 * 图标、片段显示成枚举图标），所以显式翻译一遍；未知值退回 Text。
 */
const LSP_KIND_TO_MONACO: Record<number, monaco.languages.CompletionItemKind> = {
  1: monaco.languages.CompletionItemKind.Text,
  2: monaco.languages.CompletionItemKind.Method,
  3: monaco.languages.CompletionItemKind.Function,
  4: monaco.languages.CompletionItemKind.Constructor,
  5: monaco.languages.CompletionItemKind.Field,
  6: monaco.languages.CompletionItemKind.Variable,
  7: monaco.languages.CompletionItemKind.Class,
  8: monaco.languages.CompletionItemKind.Interface,
  9: monaco.languages.CompletionItemKind.Module,
  10: monaco.languages.CompletionItemKind.Property,
  11: monaco.languages.CompletionItemKind.Unit,
  12: monaco.languages.CompletionItemKind.Value,
  13: monaco.languages.CompletionItemKind.Enum,
  14: monaco.languages.CompletionItemKind.Keyword,
  15: monaco.languages.CompletionItemKind.Snippet,
  16: monaco.languages.CompletionItemKind.Color,
  17: monaco.languages.CompletionItemKind.File,
  18: monaco.languages.CompletionItemKind.Reference,
  19: monaco.languages.CompletionItemKind.Folder,
  20: monaco.languages.CompletionItemKind.EnumMember,
  21: monaco.languages.CompletionItemKind.Constant,
  22: monaco.languages.CompletionItemKind.Struct,
  23: monaco.languages.CompletionItemKind.Event,
  24: monaco.languages.CompletionItemKind.Operator,
  25: monaco.languages.CompletionItemKind.TypeParameter,
};

function toMonacoKind(kind: number | undefined): monaco.languages.CompletionItemKind {
  const mapped = kind === undefined ? undefined : LSP_KIND_TO_MONACO[kind];
  return mapped ?? monaco.languages.CompletionItemKind.Text;
}

/** 补全项 → Monaco 补全项 */
function toMonacoCompletion(
  item: WorkbenchLspCompletionItem,
  defaultRange: monaco.IRange,
): monaco.languages.CompletionItem {
  const insertText = item.insertText ?? item.label;
  // 语言服务给的函数补全常带 `${1:参数}` 占位，按片段插入才能让用户按 Tab 跳参数
  const isSnippet = insertText.includes("${");
  return {
    label: item.label,
    kind: toMonacoKind(item.kind),
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
