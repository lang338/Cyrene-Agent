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
import type { LedgerRestoreResult, WorkbenchFileContent, WorkbenchFileEntry } from "../../../../shared/code-workbench-types";
import { ChatMessageList, type ChatMessageItem } from "../chat/components/ChatMessageList";
import { MessageFileLinkContext, type MessageFileOpenTarget } from "../chat/components/message-file-link";
import { ComposerInteractionPanel, type ComposerInteractionCallbacks } from "../chat/components/ComposerSlot";
import type { ComposerInteraction } from "../chat/components/run-presentation";
import { monacoLanguageFor, setupMonaco } from "./monaco-setup";
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
 * 编辑器选项。
 * 补全已打开：语言智能属于"方便编码"的一部分，不自我设限。
 * 诊断仍不渲染，理由见 monaco-setup：Monaco 的 TS 服务没有项目上下文
 * （不读 tsconfig、不解析依赖），打开会大面积误报"找不到模块"。
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
  renderValidationDecorations: "off" as const,
  occurrencesHighlight: "off" as const,
  selectionHighlight: false,
  tabSize: 2,
};

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
  // 得等目标文件真的载入后再落到编辑器上（见下面那个 effect）
  const [pendingReveal, setPendingReveal] = useState<{ path: string; line: number } | null>(null);
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
  const autoSnapshotTimer = useRef<number | null>(null);
  // 键盘收起那一侧后，分隔条会被卸载，焦点得交给这两个边缘箭头
  const revealLeftRef = useRef<HTMLButtonElement | null>(null);
  const revealRightRef = useRef<HTMLButtonElement | null>(null);
  // buffers 的最新镜像：openFile/saveFile 的异步回调里读取，避免依赖闭包里的旧状态
  const buffersRef = useRef<Record<string, BufferEntry>>({});
  // 只在提交后的布局阶段同步 ref：渲染体保持纯净（StrictMode/并发渲染安全）
  useLayoutEffect(() => {
    buffersRef.current = buffers;
  }, [buffers]);

  // 快照动作的 ref 化：Monaco 命令 / window 快捷键读到的是最新实现
  const saveActiveRef = useRef<() => void>(() => {});

  useEffect(() => {
    setupMonaco();
  }, []);

  // 进入工作台：做一次 auto 快照（无变化时服务端去重返回 null），刷新时间线
  useEffect(() => {
    const api = workbenchApi();
    if (!api) return;
    void api
      .snapshot(sessionId, "auto")
      .then(() => setTimelineRefresh((value) => value + 1))
      .catch(() => {
        // 未绑定工作区等场景静默：文件树会显示各自错误
      });
  }, [sessionId]);

  // 快照落盘广播（AI 回合结束 / 编辑器保存防抖 / 回退保底）→ 时间线自动跟上，
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
    // 根换了，左栏必须重列，否则还停在上一个工作区的目录快照上
    setTreeRefresh((value) => value + 1);
  }, [workspaceRoot]);

  // 当前文件换了（树里点、昔涟跟随、切标签）：路径栏丢掉草稿与报错，回到显示实际路径
  useEffect(() => {
    setPathDraft(null);
    setPathError(null);
  }, [activePath]);

  // 卸载：清掉挂起的防抖快照
  useEffect(() => () => {
    if (autoSnapshotTimer.current !== null) window.clearTimeout(autoSnapshotTimer.current);
  }, []);

  const scheduleAutoSnapshot = useCallback(() => {
    if (autoSnapshotTimer.current !== null) window.clearTimeout(autoSnapshotTimer.current);
    autoSnapshotTimer.current = window.setTimeout(() => {
      autoSnapshotTimer.current = null;
      const api = workbenchApi();
      if (!api) return;
      void api
        .snapshot(sessionId, "auto")
        .then(() => setTimelineRefresh((value) => value + 1))
        .catch(() => undefined);
    }, 5000);
  }, [sessionId]);

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
    const line = Math.max(1, pendingReveal.line);
    editor.revealLineInCenter(line);
    editor.setPosition({ lineNumber: line, column: 1 });
    setPendingReveal(null);
  }, [pendingReveal, activePath, buffers]);

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
        scheduleAutoSnapshot();
      }
      setError(null);
      // 用户已用保存做出选择：跟随被挡下的提示不再成立
      setFollowBlockedPath((current) => (current === filePath ? null : current));
    } catch (cause) {
      setError(cleanIpcError(cause));
    }
  }, [scheduleAutoSnapshot, sessionId]);

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
   */
  function onResizerKeyDown(event: ReactKeyboardEvent<HTMLDivElement>, side: ColumnSide) {
    const delta = resizerKeyDelta(event.key, side);
    if (delta === null) return;
    event.preventDefault();
    if (!columns.step(side, delta).collapsed) return;
    if (side === "left") revealLeftRef.current?.focus();
    else revealRightRef.current?.focus();
  }

  return createPortal(
    <div className="cy-workbench" role="dialog" aria-label={t("workbench.title")}>
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
        <aside className="cy-workbench__col cy-workbench__col--left" style={{ width: columns.left }}>
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
                      language={monacoLanguageFor(activePath)}
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

        <section className="cy-workbench__col cy-workbench__col--right" style={{ width: columns.right }}>
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
            onClick={() => columns.reveal("left")}
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
            onClick={() => columns.reveal("right")}
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
