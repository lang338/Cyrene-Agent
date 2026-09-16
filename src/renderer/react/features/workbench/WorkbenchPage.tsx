// 工作台主页面：全屏覆盖层，三栏布局（文件树 | 代码编辑器 + 历史 | 对话流）。
// 从 ChatPage（work/code 模式）进入；会话消息与发送沿用 ChatPage 的运行时，
// 这里不做任何独立的 run 控制——单事实来源，避免双控制器。

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Editor from "@monaco-editor/react";
import * as monacoNs from "monaco-editor";
import { useTranslation } from "../../i18n";
import type { ConversationMode } from "../../../../shared/chat-types";
import type { WorkbenchFileContent } from "../../../../shared/code-workbench-types";
import { ChatMessageList, type ChatMessageItem } from "../chat/components/ChatMessageList";
import { ComposerInteractionPanel, type ComposerInteractionCallbacks } from "../chat/components/ComposerSlot";
import type { ComposerInteraction } from "../chat/components/run-presentation";
import { monacoLanguageFor, setupMonaco } from "./monaco-setup";
import { buildActiveFileContext, type ActiveFileSelection } from "./active-file-context";
import { useResizableColumns } from "./use-resizable-columns";
import { workbenchApi, WorkspaceTree } from "./WorkspaceTree";
import { advanceAiFileChangeBaseline, type AiFileChangeBaseline } from "./follow-changes";
import { CheckpointTimeline } from "./CheckpointTimeline";
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

/** 编辑器走"微调"定位：不开补全、不渲染校验装饰（诊断在 monaco-setup 里全局关闭） */
const EDITOR_OPTIONS = {
  automaticLayout: true,
  minimap: { enabled: false },
  fontSize: 13,
  scrollBeyondLastLine: false,
  wordWrap: "on" as const,
  quickSuggestions: false,
  suggestOnTriggerCharacters: false,
  renderValidationDecorations: "off" as const,
  occurrencesHighlight: "off" as const,
  selectionHighlight: false,
  tabSize: 2,
};

function fileBaseName(path: string): string {
  const normalized = path.split("\\").join("/");
  return normalized.split("/").pop() ?? path;
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
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
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

  const editorRef = useRef<monacoNs.editor.IStandaloneCodeEditor | null>(null);
  const autoSnapshotTimer = useRef<number | null>(null);
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

  /** 用户点开文件：已打开（含脏缓冲）只切过去，绝不重新读盘覆盖未保存修改 */
  const openFile = useCallback(async (filePath: string) => {
    setActivePath(filePath);
    setMiddleTab("code");
    if (buffersRef.current[filePath]) return;
    setOpenTabs((current) => (current.includes(filePath) ? current : [...current, filePath]));
    await loadBuffer(filePath, "fresh");
  }, [loadBuffer]);

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
    try {
      await api.writeFile(sessionId, filePath, savedContent);
      setBuffers((current) => {
        const latest = current[filePath];
        if (!latest) return current;
        if (latest.content !== savedContent) return current; // 保存飞行中又有新编辑：保留 dirty
        return { ...current, [filePath]: { ...latest, dirty: false } };
      });
      setTreeRefresh((value) => value + 1);
      setError(null);
      // 用户已用保存做出选择：跟随被挡下的提示不再成立
      setFollowBlockedPath((current) => (current === filePath ? null : current));
      scheduleAutoSnapshot();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
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

  const handleRestore = useCallback(() => {
    // 回退后磁盘内容已变：丢弃所有打开的缓冲，避免旧草稿覆盖新状态
    setOpenTabs([]);
    setActivePath(null);
    setBuffers({});
    setFollowBlockedPath(null);
    setTreeRefresh((value) => value + 1);
  }, []);

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
        selection: readEditorSelection(),
      })
      : null;
    if (await onSendText(text, context ? [context] : undefined)) {
      // 只在草稿仍是刚提交的那份时才清空：否则会把发送期间敲的新内容一起抹掉
      setChatDraft((current) => (current === submitted ? "" : current));
    }
  }, [activePath, chatDraft, includeActiveFile, onSendText, readEditorSelection]);

  const activeEntry = activePath ? buffers[activePath] : undefined;

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
            onPointerDown={(event) => columns.beginDrag("left", event)}
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
              <CheckpointTimeline
                sessionId={sessionId}
                refreshToken={timelineRefresh}
                busy={snapshotBusy}
                onBusyChange={setSnapshotBusy}
                onAfterRestore={handleRestore}
              />
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
            onPointerDown={(event) => columns.beginDrag("right", event)}
          />
        )}

        <section className="cy-workbench__col cy-workbench__col--right" style={{ width: columns.right }}>
          <div className="cy-workbench__col-header">{t("workbench.chatHeader")}</div>
          <div className="cy-workbench__col-body cy-workbench__chat-body">
            {messages.length > 0 && (
              <ChatMessageList
                messages={messages}
                conversationId={sessionId}
                mode={mode}
                preferredAddress={preferredAddress}
                stickerSize={stickerSize}
                onTtsCacheKey={onTtsCacheKey}
              />
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
