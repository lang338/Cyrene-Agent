// 工作台主页面：全屏覆盖层，三栏布局（文件树 | 代码编辑器 + 历史 | 对话流）。
// 从 ChatPage（work/code 模式）进入；会话消息与发送沿用 ChatPage 的运行时，
// 这里不做任何独立的 run 控制——单事实来源，避免双控制器。

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import Editor from "@monaco-editor/react";
import * as monacoNs from "monaco-editor";
import { useTranslation } from "../../i18n";
import type { ConversationMode } from "../../../../shared/chat-types";
import type { LedgerRestoreResult, WorkbenchFileContent, WorkbenchFileEntry, WorkbenchLspDiagnostic } from "../../../../shared/code-workbench-types";
import { ChatMessageList, type ChatMessageItem } from "../chat/components/ChatMessageList";
import { MessageFileLinkContext, type MessageFileOpenTarget } from "../chat/components/message-file-link";
import { ComposerInteractionPanel, type ComposerInteractionCallbacks } from "../chat/components/ComposerSlot";
import type { ComposerInteraction } from "../chat/components/run-presentation";
import { setupMonaco } from "./monaco-setup";
import { languageIdForPath } from "../../../../shared/workbench-languages";
import { registerLspProviders, setLspProviderSession } from "./lsp-providers";
import { WorkbenchLspStatus } from "./lsp-status";
import { buildActiveFileContext, type ActiveFileSelection } from "./active-file-context";
import { resizerKeyDelta, useResizableColumns, type ColumnSide } from "./use-resizable-columns";
import { workbenchApi, WorkspaceTree } from "./WorkspaceTree";
import { advanceAiFileChangeBaseline, resolveWorkspaceRelative, type AiFileChangeBaseline } from "./follow-changes";
import { CheckpointTimeline } from "./CheckpointTimeline";
import { ChangeTimeline } from "./ChangeTimeline";
import "./WorkbenchPage.css";

export interface WorkbenchPageProps extends ComposerInteractionCallbacks {
  sessionId: string;
  mode: ConversationMode;
  /** 会话绑定的工作区根目录；用于把昔涟改动证据里的路径解析回工作区相对路径 */
  workspaceRoot?: string;
  /** 当前会话的渲染态消息（ChatPage useSessionMessages 提供，保持实时） */
  messages: ChatMessageItem[];
  busy: boolean;
  preferredAddress: string;
  stickerSize?: "small" | "standard" | "large";
  onTtsCacheKey?: (messageId: string, cacheKey: string, converterVersion: string) => void;
  /** 发送文本到会话；返回 true 表示已接受（忙时主进程侧自动排队）。
   *  contextAttachments 为本轮临时上下文（工作台当前打开的文件），不落历史。 */
  onSendText: (text: string, contextAttachments?: Array<{ name: string; text: string }>) => Promise<boolean>;
  onCancelRun: () => void;
  onClose: () => void;
  /**
   * 工具审批 / 向用户提问 / 小测验卡片。
   * 与聊天页共用同一套卡片与提交通道：AI 在工作台里请求审批时，卡片停靠在中间栏右下角
   * （固定尺寸，不随栏宽伸缩），不必退出工作台回主界面点。
   */
  interaction?: ComposerInteraction;
  interactionBusy?: boolean;
}

interface BufferEntry {
  content: string;
  binary: boolean;
  truncated: boolean;
  dirty: boolean;
  loading: boolean;
  error: string | null;
}

/**
 * loadBuffer 的三种结果。
 * stale 必须和 failed 分开：它表示"磁盘读到了，但被丢弃了"——跟随场景要据此提醒用户
 * （昔涟也改了这份文件，而你手里有更新的编辑），混成 false 会让这个提醒消失。
 */
type LoadOutcome = "ok" | "stale" | "failed";

/**
 * 待跳转目标：切文件会重建编辑器实例，所以要先把"落到哪"记下，等目标文件载入后再应用。
 * 只给 line 时按"滚到那一行行首"处理（消息里的 `path:42` 链接）；给了 column 时按范围选中
 * （语言智能的跳到定义/引用给的就是一段范围）。
 */
interface PendingReveal {
  path: string;
  line: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
}

/**
 * Monaco 的 Uri → 工作台文件键。
 * 两种形式都要认，因为语言智能会给出两类位置：
 * - `file:///<相对路径>`：工作区内的文件，键就是这条相对路径；
 * - `file:///d:/…`：工作区外的文件（依赖、标准库存根），键是盘符绝对路径——工作台能打开全盘文件；
 * 盘符统一成大写，避免同一个文件按 "d:/…" 和 "D:/…" 开成两个页签。
 *
 * 返回 null 表示"不归工作台管"（非 file 协议、空路径），调用方应交回 Monaco 自己处理。
 */
function workbenchPathFromUri(uri: monacoNs.Uri): string | null {
  if (uri.scheme !== "file") return null;
  // Monaco 的 Uri.path 已经解码过（中文、空格都是原样），不需要再 decodeURIComponent
  const stripped = (uri.path ?? "").replace(/^\/+/, "");
  if (!stripped) return null;
  return stripped.replace(/^([a-zA-Z]):\//, (_match, drive: string) => `${drive.toUpperCase()}:/`);
}

/** Monaco 给的"落在目标文件的哪个位置" → 待跳转目标 */
function toPendingReveal(path: string, target: monacoNs.IRange | monacoNs.IPosition): PendingReveal {
  if ("startLineNumber" in target) {
    return {
      path,
      line: target.startLineNumber,
      column: target.startColumn,
      endLine: target.endLineNumber,
      endColumn: target.endColumn,
    };
  }
  return { path, line: target.lineNumber, column: target.column };
}

/**
 * 编辑器选项。
 * 补全已打开：语言智能属于"方便编码"的一部分，不自我设限。
 * 诊断渲染也开着，但来源不是 Monaco 自带的 TS 服务——那套在 monaco-setup 里已关掉
 * （它没有项目上下文，会大面积误报"找不到模块 xx"），这里显示的是主进程里
 * 外部语言服务（能读 tsconfig 与依赖）回推的诊断。
 */
const EDITOR_OPTIONS = {
  automaticLayout: true,
  minimap: { enabled: false },
  fontSize: 13,
  scrollBeyondLastLine: false,
  wordWrap: "on" as const,
  quickSuggestions: true,
  suggestOnTriggerCharacters: true,
  parameterHints: { enabled: true },
  // 跳到实现一律"直接跳"，不弹 peek 列表：peek 的预览要求 Monaco 自己能解析出目标文件的
  // model，而工作台只为打开过的文件建 model（peek 会显示"内容不可用"）。走 goto 才会经过
  // 我们注册的 editor opener，把目标文件开成页签并选中符号——和 F12 同一条路。
  // 命中多处时跳到第一处；要看全部用 Shift+F12（查引用）。定义（F12）保持既有行为不动。
  gotoLocation: { multipleImplementations: "goto" as const },
  renderValidationDecorations: "on" as const,
  occurrencesHighlight: "off" as const,
  selectionHighlight: false,
  tabSize: 2,
};

/**
 * LSP 诊断 → Monaco marker。
 * 两边严重级别的编码不同（LSP 1=Error…4=Hint；Monaco Error=8/Warning=4/Info=2/Hint=1），
 * 必须显式映射，否则错误会被画成提示、提示会被画成错误。
 */
function toMonacoMarker(diagnostic: WorkbenchLspDiagnostic): monacoNs.editor.IMarkerData {
  const severity =
    diagnostic.severity === 2
      ? monacoNs.MarkerSeverity.Warning
      : diagnostic.severity === 3
        ? monacoNs.MarkerSeverity.Info
        : diagnostic.severity === 4
          ? monacoNs.MarkerSeverity.Hint
          : monacoNs.MarkerSeverity.Error; // 缺省按 LSP 规范视为 Error
  return {
    severity,
    message: diagnostic.message,
    source: diagnostic.source ?? "lsp",
    startLineNumber: diagnostic.range.start.line + 1,
    startColumn: diagnostic.range.start.character + 1,
    endLineNumber: diagnostic.range.end.line + 1,
    endColumn: diagnostic.range.end.character + 1,
  };
}

function fileBaseName(path: string): string {
  const normalized = path.split("\\").join("/");
  return normalized.split("/").pop() ?? path;
}

/**
 * 键是不是工作区外的文件。
 * 工作区内的键是相对路径（`src/a.ts`），工作区外是绝对路径（`C:/Users/...`）——
 * 两者靠"有没有盘符/前导斜杠"区分，不需要额外字段。
 */
function isExternalPath(key: string): boolean {
  return /^[a-zA-Z]:\//.test(key) || key.startsWith("/");
}

/**
 * 路径栏展示用：把内部键还原成磁盘上的完整路径（Windows 反斜杠）。
 * 工作区内是"工作区根 + 相对路径"，工作区外本身就是绝对路径。
 */
function displayPathFor(key: string, workspaceRoot?: string): string {
  const slashed = key.replace(/\//g, "\\");
  if (isExternalPath(key)) return slashed;
  if (!workspaceRoot) return slashed;
  const root = workspaceRoot.replace(/\//g, "\\").replace(/\\+$/, "");
  return root ? `${root}\\${slashed}` : slashed;
}

/**
 * 输入看起来是全盘绝对路径时，归一成内部键形态（正斜杠）；否则返回 null。
 * 只换分隔符：`..`、重复斜杠这些交给主进程 path.resolve，并采用它回传的路径当标签键，
 * 因此 `C:\a\..\b` 与 `C:/b` 会收敛成同一个标签。
 */
function absolutePathInput(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes("\0")) return null;
  const slashed = trimmed.replace(/\\/g, "/");
  return /^[a-zA-Z]:\//.test(slashed) || slashed.startsWith("/") ? slashed : null;
}

/** IPC 抛回来的错误会被 Electron 包一层前缀（Error invoking remote method '...': Error: …），展示前剥掉 */
function cleanIpcError(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message : String(cause);
  return raw.replace(/^Error invoking remote method '[^']*':\s*/, "").replace(/^Error:\s*/, "");
}

/** "发送时带上当前文件"开关的持久化键；缺省为开 */
const INCLUDE_ACTIVE_FILE_KEY = "cy-workbench-include-active-file";

/**
 * 对话框内"可聚焦元素"的判定（Tab 环绕用）。
 * 只列真正能进键盘顺序的：tabindex="-1" 的容器与 [disabled] 的控件不算。
 */
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "textarea:not([disabled])",
  "select:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(",");

/**
 * 窗口控制桥：preload 挂在 window.chat（与 ChatPage 同款）。
 * 仓库没有全局 Window.chat 声明，按既有惯例（useComposerAttachments 等）显式 cast。
 */
function windowControls(): {
  minimize?: () => void;
  toggleMaximize?: () => void;
  close?: () => void;
} | undefined {
  return (window as typeof window & {
    chat?: { minimize?: () => void; toggleMaximize?: () => void; close?: () => void };
  }).chat;
}

function readIncludeActiveFile(): boolean {
  try {
    return localStorage.getItem(INCLUDE_ACTIVE_FILE_KEY) !== "0";
  } catch {
    return true;
  }
}

function persistIncludeActiveFile(value: boolean): void {
  try {
    localStorage.setItem(INCLUDE_ACTIVE_FILE_KEY, value ? "1" : "0");
  } catch {
    // 存不进就只在本会话生效
  }
}

export function WorkbenchPage({
  sessionId,
  mode,
  workspaceRoot,
  messages,
  busy,
  preferredAddress,
  stickerSize = "standard",
  onTtsCacheKey,
  onSendText,
  onCancelRun,
  onClose,
  interaction,
  interactionBusy,
  ...interactionCallbacks
}: WorkbenchPageProps) {
  const { t } = useTranslation();
  const columns = useResizableColumns({
    storageKey: "cy-workbench-columns",
    initial: { left: 260, right: 360 },
  });

  const [middleTab, setMiddleTab] = useState<"code" | "history">("code");
  // 历史页签下再分两种来源：改动账本（默认，巨型目录也能用）/ 整区快照（要求工作区是 git 仓库）
  const [historyView, setHistoryView] = useState<"changes" | "snapshots">("changes");
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  // 从消息里的路径点进来且带行号时，先把"待跳转"记下：切换文件会重建编辑器实例，
  // 得等目标文件真的载入后再落到编辑器上（见下面那个 effect）。
  // 语言智能的"跳到定义/引用"也复用这里——那时给的是一段范围（起止行列），不只是行号。
  const [pendingReveal, setPendingReveal] = useState<PendingReveal | null>(null);
  const [buffers, setBuffers] = useState<Record<string, BufferEntry>>({});
  const [treeRefresh, setTreeRefresh] = useState(0);
  const [timelineRefresh, setTimelineRefresh] = useState(0);
  // 昔涟刚改动的文件：文件树据此展开到它并把行滚进视野
  const [revealPath, setRevealPath] = useState<string | null>(null);
  // 昔涟改动的文件正好有未保存改动：内容不覆盖，只提示（值是那个文件路径）
  const [followBlockedPath, setFollowBlockedPath] = useState<string | null>(null);
  const [snapshotBusy, setSnapshotBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chatDraft, setChatDraft] = useState("");
  const [includeActiveFile, setIncludeActiveFile] = useState(readIncludeActiveFile);
  // 路径栏：null 表示"没在编辑，显示实际路径"；用户一敲键盘就与状态脱钩，
  // 免得输入到一半被跟随昔涟之类的状态变化顶掉。
  const [pathDraft, setPathDraft] = useState<string | null>(null);
  const [pathError, setPathError] = useState<string | null>(null);

  const editorRef = useRef<monacoNs.editor.IStandaloneCodeEditor | null>(null);
  // 全屏模态的容器：进入时焦点落点、也是 inert 包围盒的对照物
  const dialogRef = useRef<HTMLDivElement | null>(null);
  // 键盘收起/展开后的焦点接力：收起时交给边缘箭头，用箭头展开后交还给分隔条。
  // 两侧元素都是条件渲染的，所以不能在按键/点击的当场 focus——那一刻另一头还没挂载
  // （收起时箭头不存在）或已被卸载（展开时分隔条不存在），focus 打在 null 上，焦点掉回
  // 页面，再按 Tab 就从中栏"代码"页签重新开始。这里只记下待交接的目标，
  // 由下面的 layout effect 在 DOM 就绪后执行。
  const revealLeftRef = useRef<HTMLButtonElement | null>(null);
  const revealRightRef = useRef<HTMLButtonElement | null>(null);
  const resizerLeftRef = useRef<HTMLDivElement | null>(null);
  const resizerRightRef = useRef<HTMLDivElement | null>(null);
  const pendingFocusRef = useRef<{ target: "reveal" | "resizer"; side: ColumnSide } | null>(null);
  // buffers 的最新镜像：openFile/saveFile 的异步回调里读取，避免依赖闭包里的旧状态
  const buffersRef = useRef<Record<string, BufferEntry>>({});
  // 只在提交后的布局阶段同步 ref：渲染体保持纯净（StrictMode/并发渲染安全）
  useLayoutEffect(() => {
    buffersRef.current = buffers;
  }, [buffers]);

  // 收起/展开提交后再交接焦点；目标还没挂载（比如收起失败、箭头没渲染）就留着等下一次
  useLayoutEffect(() => {
    const pending = pendingFocusRef.current;
    if (!pending) return;
    const element = pending.target === "reveal"
      ? (pending.side === "left" ? revealLeftRef.current : revealRightRef.current)
      : (pending.side === "left" ? resizerLeftRef.current : resizerRightRef.current);
    if (!element) return;
    pendingFocusRef.current = null;
    element.focus();
  }, [columns.leftCollapsed, columns.rightCollapsed]);

  /**
   * 进工作台：焦点先搬进对话框，再把底下被盖住的聊天页整片设为 inert。
   * 工作台是 portal 到 body 的全屏模态，DOM 上排在应用根节点之后，所以不做这件事时
   * 打开后前几下半 Tab 都会落在底下那些看不见的控件上游走（表现为"按 Tab 没反应"），
   * 要等它们走完才轮得到工作台。inert 之后 Tab 只在工作台内部循环；
   * 退出时把焦点还给打开工作台的那个按钮，别让键盘用户又回到页面起点。
   */
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const appRoot = document.getElementById("cyrene-react-root");
    if (appRoot) appRoot.inert = true;
    dialogRef.current?.focus();
    return () => {
      if (appRoot) appRoot.inert = false;
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  // 快照动作的 ref 化：Monaco 命令 / window 快捷键读到的是最新实现
  const saveActiveRef = useRef<() => void>(() => {});

  useEffect(() => {
    setupMonaco();
    // 补全/悬停/跳转/引用交给外部语言服务（见 ./lsp-providers.ts）。
    // 拿不到服务时它会返回空并把 Monaco 内建的那套重新打开兜底，用户不会反而更差
    registerLspProviders();
  }, []);

  // 快照落盘广播（回退保底 / 每 N 轮的保底 / 手动按钮）→ 时间线自动跟上，
  // 文件树也一起刷新：快照意味着工作区内容变了，其中包含不经写文件工具的改动（如 shell 建文件）
  useEffect(() => {
    const unsubscribe = workbenchApi()?.onCheckpointChanged?.((payload) => {
      if (payload.sessionId !== sessionId) return;
      setTimelineRefresh((value) => value + 1);
      setTreeRefresh((value) => value + 1);
    });
    return unsubscribe;
  }, [sessionId]);

  // 工作区换根：标签里存的是工作区相对路径，换根后同一条路径指向的是另一个文件。
  // 旧缓冲必须丢弃——否则在那个标签上按保存，会把上一个工作区的正文写进新工作区的同名文件里。
  const boundRootRef = useRef(workspaceRoot);
  useEffect(() => {
    if (boundRootRef.current === workspaceRoot) return;
    boundRootRef.current = workspaceRoot;
    setOpenTabs([]);
    setActivePath(null);
    setBuffers({});
    setFollowBlockedPath(null);
    setError(null);
    // 诊断是按"工作区相对路径"存的：换了根，新工作区里的同名文件会顶着上一份诊断，必须一起清掉
    setLspDiagnostics({});
    // 根换了，左栏必须重列，否则还停在上一个工作区的目录快照上
    setTreeRefresh((value) => value + 1);
  }, [workspaceRoot]);

  // 当前文件换了（树里点、昔涟跟随、切标签）：路径栏丢掉草稿与报错，回到显示实际路径
  useEffect(() => {
    setPathDraft(null);
    setPathError(null);
  }, [activePath]);

  /**
   * 从磁盘装载文件内容。
   * - fresh：首次打开，先落 loading 占位，失败落 error 让编辑器显示原因；
   * - silent：昔涟改动后刷新已打开的文件，不闪占位；期间缓冲被关闭或被用户编辑
   *   则放弃本次结果，保住用户手里的版本。
   */
  const loadBuffer = useCallback(async (filePath: string, mode: "fresh" | "silent"): Promise<LoadOutcome> => {
    const api = workbenchApi();
    if (!api) return "failed";
    const before = buffersRef.current[filePath]?.content;
    if (mode === "fresh") {
      setBuffers((current) => ({
        ...current,
        [filePath]: { content: "", binary: false, truncated: false, dirty: false, loading: true, error: null },
      }));
    }
    try {
      const file = (await api.readFile(sessionId, filePath)) as WorkbenchFileContent;
      // 静默刷新是否作废，必须在提交前用 ref 判定：state updater 里赋的标志外面读不到
      // （React 18 不会同步执行 updater），之前因此把"被丢弃"误报成"已落地"。
      if (mode === "silent") {
        const latest = buffersRef.current[filePath];
        if (!latest || latest.loading || latest.dirty || latest.content !== before) return "stale";
      }
      setBuffers((current) => {
        const existing = current[filePath];
        // 兜底：响应飞行期间标签被关闭、或又被改动的，一律不覆盖
        if (mode === "fresh") {
          // 只有仍是 loading 占位时才落内容
          if (!existing || !existing.loading) return current;
        } else if (!existing || existing.loading || existing.dirty || existing.content !== before) {
          return current;
        }
        return {
          ...current,
          [filePath]: { content: file.content, binary: file.binary, truncated: file.truncated, dirty: false, loading: false, error: null },
        };
      });
      return "ok";
    } catch (cause) {
      if (mode === "silent") return "failed";
      setBuffers((current) => {
        const existing = current[filePath];
        if (!existing || !existing.loading) return current;
        return {
          ...current,
          [filePath]: {
            content: "",
            binary: false,
            truncated: false,
            dirty: false,
            loading: false,
            error: cause instanceof Error ? cause.message : String(cause),
          },
        };
      });
      return "failed";
    }
  }, [sessionId]);

  /**
   * 用户点开文件：已打开（含脏缓冲）只切过去，绝不重新读盘覆盖未保存修改。
   * 返回装载结果给调用方判定"到底打开没有"：消息里的链接必须知道这个答案——
   * 读盘失败时编辑器不会挂载（页签区显示错误），若还当成功去跳行号，
   * 行号请求会一直悬着，用户也看不到"打不开这个文件"的提示。
   */
  const openFile = useCallback(async (filePath: string): Promise<LoadOutcome> => {
    setActivePath(filePath);
    setMiddleTab("code");
    const existing = buffersRef.current[filePath];
    // 错误态说明上一次读盘失败、编辑器没挂载，对调用方而言等同于没打开
    if (existing) return existing.error ? "failed" : "ok";
    setOpenTabs((current) => (current.includes(filePath) ? current : [...current, filePath]));
    return loadBuffer(filePath, "fresh");
  }, [loadBuffer]);

  /**
   * 路径栏里手输路径后跳转；消息里的文件链接也走这里（同一条通道，行为一致）。
   * 两种写法都接受：
   * - 工作区相对路径（判定复用跟随昔涟那套 resolveWorkspaceRelative，绝对路径只要落在工作区内也走这条）
   * - 全盘绝对路径 → 工作区外的文件
   *
   * 存在性判定分两路，都是为了"别把用户丢进英文报错页"：
   * 工作区内可枚举父目录列表；工作区外没法枚举，就直接读一次——读到的内容顺手当装载结果，不读第二遍。
   *
   * 返回实际打开的文件键（与 activePath 同一个值空间：工作区内是相对路径、工作区外是绝对路径），
   * 没打开则返回 null。调用方需要这个值：消息里的链接要按它做行号跳转（用户写的 `./src/a.ts`
   * 和编辑器里的键 `src/a.ts` 不是一个字符串），失败时也要额外提示一次
   * （那时路径栏可能根本没渲染，错误会看不见）。
   */
  const openByPath = useCallback(async (raw: string): Promise<string | null> => {
    const api = workbenchApi();
    if (!api) return null;
    const insidePath = resolveWorkspaceRelative(raw, workspaceRoot);
    const outsidePath = insidePath ? null : absolutePathInput(raw);
    if (!insidePath && !outsidePath) {
      setPathError(t("workbench.pathInvalid"));
      return null;
    }

    if (insidePath) {
      if (insidePath === activePath) {
        setPathDraft(null);
        setPathError(null);
        return insidePath;
      }
      const slash = insidePath.lastIndexOf("/");
      const parent = slash === -1 ? "" : insidePath.slice(0, slash);
      const name = slash === -1 ? insidePath : insidePath.slice(slash + 1);
      let entries: WorkbenchFileEntry[];
      try {
        entries = await api.listDir(sessionId, parent);
      } catch (cause) {
        setPathError(cleanIpcError(cause));
        return null;
      }
      // Windows 的文件名大小写不敏感：按原样找不到时再宽松匹配一次，并采用磁盘上的真实写法
      const match =
        entries.find((entry) => entry.name === name) ??
        entries.find((entry) => entry.name.toLowerCase() === name.toLowerCase());
      if (!match) {
        setPathError(t("workbench.pathMissing"));
        return null;
      }
      if (match.type === "dir") {
        setPathError(t("workbench.pathIsDir"));
        return null;
      }
      setPathError(null);
      setPathDraft(null);
      // 左栏也定位过去：既然用户明确指到了这个文件，树里看不到它会显得像没生效
      setRevealPath(match.path);
      const outcome = await openFile(match.path);
      // 读盘失败时标签仍在（用户能在编辑器区看到失败原因），但对外算"没打开"：
      // 调用方据此提示失败，而不是拿着一个没挂载的文件去跳行号
      return outcome === "ok" ? match.path : null;
    }

    // 工作区外：读盘结果直接当缓冲，key 用主进程解析后的绝对路径（见 absolutePathInput 说明）
    let file: WorkbenchFileContent;
    try {
      file = (await api.readOutsideFile(sessionId, outsidePath as string)) as WorkbenchFileContent;
    } catch (cause) {
      setPathError(cleanIpcError(cause));
      return null;
    }
    setPathError(null);
    setPathDraft(null);
    setMiddleTab("code");
    if (buffersRef.current[file.path]) {
      setActivePath(file.path);
      return file.path;
    }
    setOpenTabs((current) => (current.includes(file.path) ? current : [...current, file.path]));
    setActivePath(file.path);
    setBuffers((current) => ({
      ...current,
      [file.path]: {
        content: file.content,
        binary: file.binary,
        truncated: file.truncated,
        dirty: false,
        loading: false,
        error: null,
      },
    }));
    return file.path;
  }, [activePath, openFile, sessionId, t, workspaceRoot]);

  /**
   * 消息正文里的文件路径被点开：走与路径栏完全同一条通道（解析、存在性校验、错误提示都一致）。
   * 失败时额外在顶栏提示一次——用户刚点的是正文里的链接，视线不在路径栏，而路径栏没打开文件时根本不渲染。
   */
  const handleFileLink = useCallback(async (target: MessageFileOpenTarget) => {
    const openedPath = await openByPath(target.path);
    if (!openedPath) {
      setError(t("workbench.fileLinkFailed", { path: target.path }));
      return;
    }
    if (target.line !== undefined) setPendingReveal({ path: openedPath, line: target.line });
  }, [openByPath, t]);

  /**
   * 语言智能的"跳到定义 / 跳到引用"要打开**另一个文件**，而 Monaco 在 standalone 模式下
   * 遇到"目标文件的 model 不存在"就直接放弃（见 node_modules 里 standaloneCodeEditorService
   * 的 doOpenEditor：findModel 只认当前 model，拿不到就 return null）——表现是 F12 按下毫无反应，
   * 既不报错也不跳转。所以这里注册一个 opener，把"打开资源"接回工作台自己的开文件通道
   * （与路径栏、消息链接完全同一条：存在性校验、错误提示都一致）。
   *
   * 工作区内的相对路径与工作区外的盘符路径都接管（后者打开后是中栏顶部有"工作区外"提示的那种）；
   * 非 file 协议返回 false，交回 Monaco 自己处理。
   */
  useEffect(() => {
    const disposable = monacoNs.editor.registerEditorOpener({
      openCodeEditor(_source, resource, selectionOrPosition) {
        const targetPath = workbenchPathFromUri(resource);
        if (!targetPath) return false;
        setMiddleTab("code");
        void (async () => {
          const openedPath = await openByPath(targetPath);
          if (!openedPath) {
            // 视线在编辑器里，失败原因得写在顶栏，不然用户不知道刚才那下为什么没反应
            setError(t("workbench.fileLinkFailed", { path: targetPath }));
            return;
          }
          if (selectionOrPosition) setPendingReveal(toPendingReveal(openedPath, selectionOrPosition));
        })();
        return true;
      },
    });
    return () => disposable.dispose();
  }, [openByPath, t]);

  // 带行号的链接（`src/a.ts:42`）：文件载入完成后滚到那一行。
  // 不写在 Editor 的 onMount 里，是因为"这个文件本来就开着"时编辑器不会重新挂载。
  // 时序上这里是安全的：切文件时 Editor 因 key 变化重建，子组件的 effect 先于本组件的 effect 执行，
  // 所以读到的一定是新实例。
  useEffect(() => {
    if (!pendingReveal || !activePath) return;
    if (pendingReveal.path !== activePath) return;
    const entry = buffers[activePath];
    if (!entry || entry.loading) return;
    const editor = editorRef.current;
    if (!editor || !editor.getModel()) return;
    const startLine = Math.max(1, pendingReveal.line);
    if (pendingReveal.column === undefined) {
      // 只有行号（消息里的 `path:42`）：滚到行首就行
      editor.revealLineInCenter(startLine);
      editor.setPosition({ lineNumber: startLine, column: 1 });
    } else {
      // 有范围（跳到定义/引用）：选中符号本身，跟 Monaco 原生的跳转观感一致
      const startColumn = Math.max(1, pendingReveal.column);
      const endLine = Math.max(startLine, pendingReveal.endLine ?? startLine);
      const endColumn = Math.max(endLine === startLine ? startColumn : 1, pendingReveal.endColumn ?? startColumn);
      editor.setSelection({ startLineNumber: startLine, startColumn, endLineNumber: endLine, endColumn });
      editor.revealRangeInCenter(
        { startLineNumber: startLine, startColumn, endLineNumber: endLine, endColumn },
        monacoNs.editor.ScrollType.Immediate,
      );
    }
    setPendingReveal(null);
  }, [pendingReveal, activePath, buffers]);

  // ── 语言服务（LSP）诊断 ─────────────────────────────────
  // 主进程里的外部语言服务推回诊断（它读得到 tsconfig 和依赖，不像 Monaco 自带的 TS 服务那样误报），
  // 这里只负责画成 Monaco 的 marker。服务不存在时什么都不会来，编辑器照常可用。
  const [lspDiagnostics, setLspDiagnostics] = useState<Record<string, WorkbenchLspDiagnostic[]>>({});

  useEffect(() => {
    const api = workbenchApi();
    if (!api?.onLspDiagnostics) return;
    return api.onLspDiagnostics((payload) => {
      if (payload.sessionId !== sessionId) return;
      setLspDiagnostics((current) => ({ ...current, [payload.path]: payload.diagnostics }));
    });
  }, [sessionId]);

  // Monaco 的 provider 活在 React 之外，靠这个模块级变量知道"替哪个会话发请求"。
  // 卸载时必须清掉：否则工作台关掉后编辑器还拿着旧会话去问，语言服务白跑一趟。
  useEffect(() => {
    setLspProviderSession(sessionId);
    return () => setLspProviderSession(null);
  }, [sessionId]);

  // marker 挂在 model 上，所以要拿到 model 才画；换文件、诊断更新都要重画一遍
  useEffect(() => {
    const model = editorRef.current?.getModel();
    if (!model || !activePath) return;
    monacoNs.editor.setModelMarkers(model, "lsp", (lspDiagnostics[activePath] ?? []).map(toMonacoMarker));
  }, [activePath, lspDiagnostics, buffers]);

  // 把编辑器当前内容同步给语言服务。防抖是必须的：每敲一个字往返一趟会把语言服务压垮。
  // 二进制/被截断/读失败的文件内容不可信，工作区外的文件不属于任何项目，都不送。
  useEffect(() => {
    if (!activePath || isExternalPath(activePath)) return;
    const entry = buffers[activePath];
    if (!entry || entry.loading || entry.error || entry.binary || entry.truncated) return;
    const api = workbenchApi();
    if (!api?.syncLspDocument) return;
    const sync = () => {
      // 只同步编辑器模型的**实时内容**：它带模型修订号，主进程据此丢弃迟到的旧同步。
      // 模型与当前文件对不上时（正在切文件等瞬时状态）**跳过这一拍**，不要拿 buffers 镜像顶替——
      // 那样送出去的内容没有修订号，落后了也拦不住，反而会把服务端的新内容覆盖成旧的。
      const model = editorRef.current?.getModel();
      const modelPath = (model?.uri.path ?? "").replace(/^\/+/, "");
      if (!model || modelPath !== activePath) return;
      void api
        .syncLspDocument(sessionId, activePath, model.getValue(), languageIdForPath(activePath), model.getVersionId())
        .catch(() => undefined);
    };
    const timer = window.setTimeout(sync, 400);
    return () => {
      // 别把这次改动一起丢掉：切走文件时语言服务手里还是旧内容，诊断会跟眼前对不上
      window.clearTimeout(timer);
      sync();
    };
  }, [activePath, buffers, sessionId]);

  /**
   * 跟随昔涟：它刚改动了某个工作区文件，切过去并刷新内容。
   * 未保存的改动不可被覆盖——那是编辑器里唯一不能让的约束：只提示，不重载。
   */
  const followFile = useCallback(async (filePath: string) => {
    setMiddleTab("code");
    setActivePath(filePath);
    const entry = buffersRef.current[filePath];
    if (entry?.dirty) {
      setFollowBlockedPath(filePath);
      return;
    }
    if (entry?.loading) return; // 首次读盘还在飞行：落地的就是最新内容
    setOpenTabs((current) => (current.includes(filePath) ? current : [...current, filePath]));
    const outcome = await loadBuffer(filePath, entry ? "silent" : "fresh");
    if (outcome === "stale") {
      // 读盘期间用户改了这份文件：保住他手里的版本，并如实告知磁盘上也有新内容
      setFollowBlockedPath(filePath);
      return;
    }
    if (outcome === "ok" || entry) return;
    // 路径其实不在工作区、或文件已被删：撤掉这个标签，不把用户丢在报错页上
    setOpenTabs((current) => current.filter((item) => item !== filePath));
    setActivePath((active) => (active === filePath ? null : active));
    setBuffers((current) => {
      const next = { ...current };
      delete next[filePath];
      return next;
    });
  }, [loadBuffer]);

  // 跟随昔涟：消息里出现新的文件变更证据就刷新文件树并跳到该文件
  const seenAiChangesRef = useRef<AiFileChangeBaseline | null>(null);
  useEffect(() => {
    const advanced = advanceAiFileChangeBaseline(seenAiChangesRef.current, sessionId, messages, workspaceRoot);
    seenAiChangesRef.current = advanced.baseline;
    if (advanced.fresh.length === 0) return;
    setTreeRefresh((value) => value + 1);
    // 一次可能改多个文件：跳到最后一个（本批最后落定的一份）；删除的文件只刷树不跳
    const target = [...advanced.fresh].reverse().find((change) => change.kind !== "deleted");
    if (!target) return;
    setRevealPath(target.path);
    void followFile(target.path);
  }, [followFile, messages, sessionId, workspaceRoot]);

  const saveFile = useCallback(async (filePath: string) => {
    const entry = buffersRef.current[filePath];
    if (!entry || entry.binary || entry.truncated || entry.loading || entry.error) return;
    const api = workbenchApi();
    if (!api) return;
    // 记住本次写盘的内容：响应回来前若用户继续打字，新内容必须保持 dirty
    const savedContent = entry.content;
    // 工作区外的文件走另一条通道（不做工作区限定），且不进快照——保存后没什么可刷新的
    const external = isExternalPath(filePath);
    try {
      if (external) await api.writeOutsideFile(sessionId, filePath, savedContent);
      else await api.writeFile(sessionId, filePath, savedContent);
      setBuffers((current) => {
        const latest = current[filePath];
        if (!latest) return current;
        if (latest.content !== savedContent) return current; // 保存飞行中又有新编辑：保留 dirty
        return { ...current, [filePath]: { ...latest, dirty: false } };
      });
      if (!external) {
        setTreeRefresh((value) => value + 1);
      }
      setError(null);
      // 用户已用保存做出选择：跟随被挡下的提示不再成立
      setFollowBlockedPath((current) => (current === filePath ? null : current));
    } catch (cause) {
      setError(cleanIpcError(cause));
    }
  }, [sessionId]);

  saveActiveRef.current = () => {
    if (activePath) void saveFile(activePath);
  };

  // Ctrl+S：编辑器命令在 onMount 注册，这里兜底覆盖焦点在编辑器外的情况
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        saveActiveRef.current();
      }
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  const closeTab = useCallback((path: string) => {
    const entry = buffers[path];
    if (entry?.dirty && !window.confirm(t("workbench.closeConfirm", { name: fileBaseName(path) }))) return;
    setOpenTabs((current) => {
      const next = current.filter((item) => item !== path);
      setActivePath((active) => {
        if (active !== path) return active;
        const index = current.indexOf(path);
        return next[Math.min(index, next.length - 1)] ?? null;
      });
      return next;
    });
    setBuffers((current) => {
      const next = { ...current };
      delete next[path];
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buffers]);

  /**
   * 回退完成后的收尾。
   * - 整区快照回退（不带 result）：整个工作区都可能变，丢弃全部缓冲最稳
   * - 改动账本回退（带 result）：**只影响它动过的那些文件**，所以只清这些路径——
   *   无端清空其余缓冲会丢掉用户正在看的、与本次回退无关的内容
   */
  const handleRestore = useCallback((result?: LedgerRestoreResult) => {
    if (!result) {
      setOpenTabs([]);
      setActivePath(null);
      setBuffers({});
      setFollowBlockedPath(null);
      setTreeRefresh((value) => value + 1);
      return;
    }
    const touched = new Set([...result.restored, ...result.deleted]);
    setBuffers((current) => {
      const next = { ...current };
      for (const path of touched) delete next[path];
      return next;
    });
    setOpenTabs((current) => current.filter((path) => !touched.has(path)));
    setActivePath((active) => (active && touched.has(active) ? null : active));
    setFollowBlockedPath((current) => (current && touched.has(current) ? null : current));
    setTreeRefresh((value) => value + 1);
  }, []);

  /**
   * 回退前的把关：**有未保存改动的文件不许被回退**。
   * 账本回退是直接改磁盘的，而用户缓冲里那份改动无处安放——先让他保存或撤销，
   * 比"回退完再告诉他草稿没了"诚实得多。
   */
  const canRestorePaths = useCallback((paths: string[]) => {
    const dirty = paths.filter((path) => buffersRef.current[path]?.dirty);
    if (dirty.length === 0) return true;
    setError(t("workbench.restoreBlockedDirty", { count: dirty.length }));
    return false;
  }, [t]);

  const manualSnapshot = useCallback(async () => {
    const api = workbenchApi();
    if (!api || snapshotBusy) return;
    setSnapshotBusy(true);
    try {
      await api.snapshot(sessionId, "manual");
      setTimelineRefresh((value) => value + 1);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSnapshotBusy(false);
    }
  }, [sessionId, snapshotBusy]);

  /** 读编辑器当前选中片段；无选区、不在代码页签、或编辑器已销毁时返回 null */
  const readEditorSelection = useCallback((): ActiveFileSelection | null => {
    // 历史页签下编辑器已卸载，editorRef 可能仍指向已销毁实例
    if (middleTab !== "code") return null;
    try {
      const editor = editorRef.current;
      const model = editor?.getModel();
      const selection = editor?.getSelection();
      if (!editor || !model || !selection || selection.isEmpty()) return null;
      const text = model.getValueInRange(selection);
      if (!text.trim()) return null;
      return { startLine: selection.startLineNumber, endLine: selection.endLineNumber, text };
    } catch {
      return null; // 编辑器已销毁：当作无选区，不影响发送
    }
  }, [middleTab]);

  const toggleIncludeActiveFile = useCallback(() => {
    setIncludeActiveFile((current) => {
      const next = !current;
      persistIncludeActiveFile(next);
      return next;
    });
  }, []);

  const sendChat = useCallback(async () => {
    // 记住提交时的原文：发送是异步的，这期间用户可能已经接着敲下一条
    const submitted = chatDraft;
    const text = submitted.trim();
    if (!text) return;
    // 上下文在"发送这一刻"构建：带上用户此刻真正在看的内容
    const entry = activePath ? buffersRef.current[activePath] : undefined;
    const context = includeActiveFile && activePath
      ? buildActiveFileContext({
        relativePath: activePath,
        content: entry?.content ?? "",
        dirty: Boolean(entry?.dirty),
        // 二进制/被截断的文件内容不可信，只给路径
        readOnly: Boolean(entry?.binary || entry?.truncated),
        // 还在读盘或读失败：内容未知，不要对模型谎称"已保存"
        pending: Boolean(entry?.loading || entry?.error),
        // 工作区外的文件给的是绝对路径，标注一下，免得模型按"相对工作区根"去理解
        outsideWorkspace: isExternalPath(activePath),
        selection: readEditorSelection(),
      })
      : null;
    if (await onSendText(text, context ? [context] : undefined)) {
      // 只在草稿仍是刚提交的那份时才清空：否则会把发送期间敲的新内容一起抹掉
      setChatDraft((current) => (current === submitted ? "" : current));
    }
  }, [activePath, chatDraft, includeActiveFile, onSendText, readEditorSelection]);

  const activeEntry = activePath ? buffers[activePath] : undefined;

  /**
   * 分隔条键盘操作：←/→ 步进 20px，Home/End 直达两端，按过头即收起（与拖动同一阈值）。
   * 收起后分隔条会随渲染卸载，所以必须把焦点显式交给边缘的展开箭头——
   * 否则焦点掉回 body，键盘用户会"迷失"在页面里，这是无障碍里最忌讳的状态。
   * 交接本身延到渲染提交后做（见 pendingFocusRef 的 layout effect）。
   */
  function onResizerKeyDown(event: ReactKeyboardEvent<HTMLDivElement>, side: ColumnSide) {
    const delta = resizerKeyDelta(event.key, side);
    if (delta === null) return;
    event.preventDefault();
    if (!columns.step(side, delta).collapsed) return;
    pendingFocusRef.current = { target: "reveal", side };
  }

  /** 箭头展开那一侧后，把焦点交还给重新挂载的分隔条（同一套延后交接） */
  function onRevealClick(side: ColumnSide) {
    pendingFocusRef.current = { target: "resizer", side };
    columns.reveal(side);
  }

  /**
   * 对话框内的 Tab 环绕。工作台盖住整页、底下应用根节点又是 inert，
   * Tab 从最后一个可聚焦元素（收起右栏后就是最右边那个箭头）再往前走会直接离开窗口，
   * 焦点掉成"什么都没聚焦"。这里在两端折返，焦点始终留在工作台内。
   * 编辑器里的 Tab 归 Monaco 管（缩进），它已经 preventDefault，不能当焦点移动处理。
   */
  function onDialogKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Tab" || event.defaultPrevented) return;
    if ((event.target as HTMLElement | null)?.closest(".monaco-editor")) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    // 收起的那一栏是 inert、隐藏的分区没有渲染盒，都不该参与环绕的首尾判定
    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
      .filter((element) => element.getClientRects().length > 0 && !element.closest("[inert]"));
    if (focusable.length === 0) return;
    const active = document.activeElement;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey ? active === first : active === last) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    }
  }

  return createPortal(
    <div
      ref={dialogRef}
      className="cy-workbench"
      role="dialog"
      aria-modal="true"
      aria-label={t("workbench.title")}
      tabIndex={-1}
      onKeyDown={onDialogKeyDown}
    >
      <header className="cy-workbench__topbar">
        <div className="cy-workbench__topbar-left">
          <button type="button" className="cy-workbench__back" onClick={onClose} title={t("workbench.back")}>
            ‹ {t("workbench.back")}
          </button>
          <span className="cy-workbench__title">{t("workbench.title")}</span>
          <button
            type="button"
            className="cy-workbench__action"
            disabled={snapshotBusy}
            onClick={() => void manualSnapshot()}
          >
            {snapshotBusy ? t("workbench.snapshotBusy") : t("workbench.manualSnapshot")}
          </button>
        </div>
        <div className="cy-workbench__topbar-right">
          {error && (
            <button type="button" className="cy-workbench__error" onClick={() => setError(null)} title={t("workbench.dismissError")}>
              {error} ×
            </button>
          )}
          <div className="cy-workbench__win-controls">
            <button
              type="button"
              className="cy-workbench__win-btn"
              onClick={() => windowControls()?.minimize()}
              aria-label={t("ui.minimize")}
              title={t("ui.minimize")}
            >
              <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                <rect x="1.5" y="5.5" width="9" height="1" rx="0.5" fill="currentColor" />
              </svg>
            </button>
            <button
              type="button"
              className="cy-workbench__win-btn"
              onClick={() => windowControls()?.toggleMaximize()}
              aria-label={t("ui.maximizeOrRestore")}
              title={t("ui.maximizeOrRestore")}
            >
              <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                <rect x="1.5" y="1.5" width="9" height="9" rx="1" fill="none" stroke="currentColor" strokeWidth="1.1" />
              </svg>
            </button>
            <button
              type="button"
              className="cy-workbench__win-btn cy-workbench__win-btn--close"
              onClick={() => windowControls()?.close()}
              aria-label={t("ui.closeChatWindow")}
              title={t("ui.closeChatWindow")}
            >
              <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                <line x1="2.5" y1="2.5" x2="9.5" y2="9.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                <line x1="9.5" y1="2.5" x2="2.5" y2="9.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        </div>
      </header>

      <div className="cy-workbench__body" ref={columns.bodyRef}>
        {/* 收起后这一栏宽度为 0，内容仍在 DOM 里——不 inert 的话 Tab 会落到看不见的文件树上 */}
        <aside
          className="cy-workbench__col cy-workbench__col--left"
          style={{ width: columns.left }}
          inert={columns.leftCollapsed}
        >
          <div className="cy-workbench__col-header">{t("workbench.filesHeader")}</div>
          <div className="cy-workbench__col-body">
            <WorkspaceTree
              sessionId={sessionId}
              refreshToken={treeRefresh}
              activePath={activePath}
              revealPath={revealPath}
              onOpenFile={(path) => void openFile(path)}
            />
          </div>
        </aside>

        {!columns.leftCollapsed && (
          <div
            ref={resizerLeftRef}
            className="cy-workbench__resizer"
            title={t("workbench.resizerHint")}
            role="separator"
            tabIndex={0}
            aria-orientation="vertical"
            aria-label={t("workbench.resizerAriaLeft")}
            aria-valuenow={columns.left}
            aria-valuemin={columns.boundsFor("left").min}
            aria-valuemax={columns.boundsFor("left").max}
            onPointerDown={(event) => columns.beginDrag("left", event)}
            onKeyDown={(event) => onResizerKeyDown(event, "left")}
          />
        )}

        <section className="cy-workbench__col cy-workbench__col--middle">
          <div className="cy-workbench__col-header cy-workbench__col-header--tabs">
            <button
              type="button"
              className={`cy-workbench__tab ${middleTab === "code" ? "is-active" : ""}`}
              onClick={() => setMiddleTab("code")}
            >
              {t("workbench.tabCode")}
            </button>
            <button
              type="button"
              className={`cy-workbench__tab ${middleTab === "history" ? "is-active" : ""}`}
              onClick={() => setMiddleTab("history")}
            >
              {t("workbench.tabHistory")}
            </button>
            {middleTab === "code" && (
              <button
                type="button"
                className="cy-workbench__action cy-workbench__save"
                disabled={!activeEntry?.dirty}
                onClick={() => activePath && void saveFile(activePath)}
                title={t("workbench.saveHint")}
              >
                {t("workbench.save")}
              </button>
            )}
          </div>

          {middleTab === "history" ? (
            <div className="cy-workbench__col-body">
              {/* 两种历史来源切换：改动账本（只记被改文件的内容，不要求 git 仓库）/ 整区快照 */}
              <div className="cy-workbench__history-switch">
                <button
                  type="button"
                  className={`cy-workbench__history-tab ${historyView === "changes" ? "is-active" : ""}`}
                  onClick={() => setHistoryView("changes")}
                >
                  {t("workbench.ledgerTab")}
                </button>
                <button
                  type="button"
                  className={`cy-workbench__history-tab ${historyView === "snapshots" ? "is-active" : ""}`}
                  onClick={() => setHistoryView("snapshots")}
                >
                  {t("workbench.snapshotsTab")}
                </button>
              </div>
              {historyView === "changes" ? (
                <ChangeTimeline
                  sessionId={sessionId}
                  refreshToken={timelineRefresh}
                  // AI 正在跑的时候不许回退：它的写文件和账本回退会互相覆盖（账本只串行自己的操作）
                  busy={busy || snapshotBusy}
                  onBusyChange={setSnapshotBusy}
                  onBeforeRestore={canRestorePaths}
                  onAfterRestore={handleRestore}
                />
              ) : (
                <CheckpointTimeline
                  sessionId={sessionId}
                  refreshToken={timelineRefresh}
                  busy={snapshotBusy}
                  onBusyChange={setSnapshotBusy}
                  onAfterRestore={handleRestore}
                />
              )}
            </div>
          ) : (
            <div className="cy-workbench__col-body cy-workbench__editor-body">
              {openTabs.length > 0 && (
                <div className="cy-workbench__file-tabs">
                  {openTabs.map((path) => (
                    <div
                      key={path}
                      className={`cy-workbench__file-tab ${activePath === path ? "is-active" : ""}`}
                    >
                      <button type="button" className="cy-workbench__file-tab-name" onClick={() => setActivePath(path)} title={path}>
                        {buffers[path]?.dirty ? "● " : ""}{fileBaseName(path)}
                      </button>
                      <button
                        type="button"
                        className="cy-workbench__file-tab-close"
                        onClick={() => closeTab(path)}
                        title={t("workbench.closeTab")}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* 路径栏：显示当前文件的完整路径（工作区内=工作区根 + 相对路径，工作区外=绝对路径），
                  也可直接改路径回车跳过去——相对路径与全盘绝对路径都接受。
                  失焦或 Esc 放弃这次输入（连同报错一起收掉），回到显示实际路径。
                  没打开文件时整条不渲染：那时它只是一行空格子，徒占中栏高度。 */}
              {activePath && (
                <div className="cy-workbench__path-bar">
                  <input
                    type="text"
                    className={`cy-workbench__path-input ${pathError ? "is-invalid" : ""}`}
                    value={pathDraft ?? displayPathFor(activePath, workspaceRoot)}
                    placeholder={t("workbench.pathPlaceholder")}
                    spellCheck={false}
                    aria-label={t("workbench.pathAria")}
                    title={t("workbench.pathHint")}
                    onChange={(event) => {
                      setPathDraft(event.target.value);
                      if (pathError) setPathError(null);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void openByPath(event.currentTarget.value);
                        return;
                      }
                      if (event.key === "Escape") setPathDraft(null);
                    }}
                    onBlur={() => {
                      setPathDraft(null);
                      setPathError(null);
                    }}
                  />
                  {pathError && (
                    <span className="cy-workbench__path-error" title={pathError}>
                      {pathError}
                    </span>
                  )}
                </div>
              )}

              {/* 语言智能状态：只在"语义能力变弱"时出现（缺语言服务 / 缺项目配置），
                  说明原因并给一键生成配置的动作；一切正常时不占位 */}
              <WorkbenchLspStatus
                sessionId={sessionId}
                activePath={activePath}
                external={Boolean(activePath && isExternalPath(activePath))}
                fileReady={Boolean(
                  activePath &&
                    buffers[activePath] &&
                    !buffers[activePath].loading &&
                    !buffers[activePath].error &&
                    !buffers[activePath].binary &&
                    !buffers[activePath].truncated,
                )}
                language={activePath ? languageIdForPath(activePath) : null}
              />

              {/* 昔涟刚改了这个文件，但缓冲里有未保存改动：内容以你的版本为准，只告知 */}
              {followBlockedPath && followBlockedPath === activePath && activeEntry?.dirty && (
                <div className="cy-workbench__editor-notice is-blocked">
                  <span>{t("workbench.followDirtyNotice", { name: fileBaseName(followBlockedPath) })}</span>
                  <button
                    type="button"
                    onClick={() => setFollowBlockedPath(null)}
                    title={t("workbench.dismissNotice")}
                    aria-label={t("workbench.dismissNotice")}
                  >
                    ×
                  </button>
                </div>
              )}

              {/* 工作区外的文件：能读能改，但快照只覆盖工作区——这件事必须写在脸上 */}
              {activePath && isExternalPath(activePath) && (
                <div className="cy-workbench__editor-notice">{t("workbench.externalFileNotice")}</div>
              )}

              {!activePath && (
                <div className="cy-workbench__editor-empty">{t("workbench.emptyEditor")}</div>
              )}

              {activePath && activeEntry?.loading && (
                <div className="cy-workbench__editor-empty">{t("common.loading")}</div>
              )}

              {activePath && activeEntry?.error && (
                <div className="cy-workbench__editor-empty is-error">{activeEntry.error}</div>
              )}

              {activePath && activeEntry && !activeEntry.loading && !activeEntry.error && (
                <>
                  {(activeEntry.binary || activeEntry.truncated) && (
                    <div className="cy-workbench__editor-notice">
                      {activeEntry.binary ? t("workbench.binaryFile") : t("workbench.truncatedFile")}
                    </div>
                  )}
                  <div className="cy-monaco-fill">
                    <Editor
                      key={activePath}
                      // path 必须有：Monaco 的 TS 语言服务按"模型 URI 的扩展名"判断这是不是它的文件，
                      // 缺了它 URI 会是 inmemory://model/N（无扩展名）→ 语义补全一律返回空，
                      // 只剩主线程算的"同文件词汇"建议（表现为输 doc 弹 description 而不是 document）。
                      path={`file:///${activePath}`}
                      language={languageIdForPath(activePath)}
                      theme="vs-dark"
                      value={activeEntry.content}
                      options={{ ...EDITOR_OPTIONS, readOnly: activeEntry.binary || activeEntry.truncated }}
                      onChange={(value) => {
                        const next = value ?? "";
                        setBuffers((current) => ({ ...current, [activePath]: { ...current[activePath], content: next, dirty: true } }));
                      }}
                      onMount={(editor) => {
                        editorRef.current = editor;
                        editor.addCommand(
                          monacoNs.KeyMod.CtrlCmd | monacoNs.KeyCode.KeyS,
                          () => saveActiveRef.current(),
                        );
                        // Ctrl+Space 在中文 Windows 上常被输入法当"中英文切换"抢走，Monaco 收不到，
                        // 所以另给一个不冲突的触发键（Eclipse 系习惯）。Ctrl+Space 的默认绑定保持不动。
                        editor.addCommand(
                          monacoNs.KeyMod.Alt | monacoNs.KeyCode.Slash,
                          () => editor.trigger("keyboard", "editor.action.triggerSuggest", {}),
                        );
                      }}
                    />
                  </div>
                </>
              )}
            </div>
          )}

          {/* 审批 / 提问 / 测验卡片：停靠中栏右下角，固定尺寸不随栏宽伸缩 */}
          {interaction && (
            <div className="cy-workbench__interaction-dock">
              <ComposerInteractionPanel
                interaction={interaction}
                interactionBusy={interactionBusy}
                {...interactionCallbacks}
              />
            </div>
          )}
        </section>

        {!columns.rightCollapsed && (
          <div
            ref={resizerRightRef}
            className="cy-workbench__resizer"
            title={t("workbench.resizerHint")}
            role="separator"
            tabIndex={0}
            aria-orientation="vertical"
            aria-label={t("workbench.resizerAriaRight")}
            aria-valuenow={columns.right}
            aria-valuemin={columns.boundsFor("right").min}
            aria-valuemax={columns.boundsFor("right").max}
            onPointerDown={(event) => columns.beginDrag("right", event)}
            onKeyDown={(event) => onResizerKeyDown(event, "right")}
          />
        )}

        {/* 同左栏：收起后内容还在 DOM 里，必须 inert 掉，否则 Tab 会落到看不见的会话区 */}
        <section
          className="cy-workbench__col cy-workbench__col--right"
          style={{ width: columns.right }}
          inert={columns.rightCollapsed}
        >
          <div className="cy-workbench__col-header">{t("workbench.chatHeader")}</div>
          <div className="cy-workbench__col-body cy-workbench__chat-body">
            {messages.length > 0 && (
              // 只有工作台提供这个上下文：右栏消息里的文件路径才变成可点开的链接。
              // 主聊天页不提供，同一份 ChatMessageList 在那里仍渲染纯文本，行为一行没变。
              <MessageFileLinkContext.Provider value={handleFileLink}>
                <ChatMessageList
                  messages={messages}
                  conversationId={sessionId}
                  mode={mode}
                  preferredAddress={preferredAddress}
                  stickerSize={stickerSize}
                  onTtsCacheKey={onTtsCacheKey}
                />
              </MessageFileLinkContext.Provider>
            )}
            {messages.length === 0 && (
              <div className="cy-workbench__chat-empty">{t("workbench.chatEmpty")}</div>
            )}
            <div className="cy-workbench__chat-composer">
              <button
                type="button"
                className={`cy-workbench__context-chip ${includeActiveFile && activePath ? "is-on" : ""}`}
                onClick={toggleIncludeActiveFile}
                disabled={!activePath}
                aria-pressed={includeActiveFile}
                title={t("workbench.includeActiveFileHint")}
              >
                <span className="cy-workbench__context-dot" aria-hidden="true" />
                {!activePath
                  ? t("workbench.includeActiveFileEmpty")
                  : includeActiveFile
                    ? t("workbench.includeActiveFileOn", { name: fileBaseName(activePath) })
                    : t("workbench.includeActiveFile")}
              </button>
              <textarea
                className="cy-workbench__chat-input"
                value={chatDraft}
                placeholder={busy ? t("workbench.chatQueuedHint") : t("workbench.chatPlaceholder")}
                onChange={(event) => setChatDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void sendChat();
                  }
                }}
              />
              <div className="cy-workbench__chat-actions">
                {busy && (
                  <button type="button" className="cy-workbench__action is-stop" onClick={onCancelRun}>
                    {t("workbench.stop")}
                  </button>
                )}
                <button
                  type="button"
                  className="cy-workbench__action is-send"
                  disabled={!chatDraft.trim()}
                  onClick={() => void sendChat()}
                >
                  {t("workbench.send")}
                </button>
              </div>
            </div>
          </div>
        </section>

        {/* 收起后的找回入口：贴在窗口最左/最右边缘，鼠标移上去浮现箭头 */}
        {columns.leftCollapsed && (
          <button
            ref={revealLeftRef}
            type="button"
            className="cy-workbench__reveal cy-workbench__reveal--left"
            onClick={() => onRevealClick("left")}
            title={t("workbench.expandLeft")}
            aria-label={t("workbench.expandLeft")}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <path d="m3 1 4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
        {columns.rightCollapsed && (
          <button
            ref={revealRightRef}
            type="button"
            className="cy-workbench__reveal cy-workbench__reveal--right"
            onClick={() => onRevealClick("right")}
            title={t("workbench.expandRight")}
            aria-label={t("workbench.expandRight")}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <path d="m7 1-4 4 4 4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
      </div>
    </div>,
    document.body,
  );
}
