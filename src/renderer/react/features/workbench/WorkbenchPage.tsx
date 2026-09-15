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
import { monacoLanguageFor, setupMonaco } from "./monaco-setup";
import { useResizableColumns } from "./use-resizable-columns";
import { workbenchApi, WorkspaceTree } from "./WorkspaceTree";
import { CheckpointTimeline } from "./CheckpointTimeline";
import "./WorkbenchPage.css";

export interface WorkbenchPageProps {
  sessionId: string;
  mode: ConversationMode;
  /** 当前会话的渲染态消息（ChatPage useSessionMessages 提供，保持实时） */
  messages: ChatMessageItem[];
  busy: boolean;
  preferredAddress: string;
  stickerSize?: "small" | "standard" | "large";
  onTtsCacheKey?: (messageId: string, cacheKey: string, converterVersion: string) => void;
  /** 发送文本到会话；返回 true 表示已接受（忙时主进程侧自动排队） */
  onSendText: (text: string) => Promise<boolean>;
  onCancelRun: () => void;
  onClose: () => void;
}

interface BufferEntry {
  content: string;
  binary: boolean;
  truncated: boolean;
  dirty: boolean;
  loading: boolean;
  error: string | null;
}

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

export function WorkbenchPage({
  sessionId,
  mode,
  messages,
  busy,
  preferredAddress,
  stickerSize = "standard",
  onTtsCacheKey,
  onSendText,
  onCancelRun,
  onClose,
}: WorkbenchPageProps) {
  const { t } = useTranslation();
  const columns = useResizableColumns({
    storageKey: "cy-workbench-columns",
    initial: [260, 640],
  });

  const [middleTab, setMiddleTab] = useState<"code" | "history">("code");
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [buffers, setBuffers] = useState<Record<string, BufferEntry>>({});
  const [treeRefresh, setTreeRefresh] = useState(0);
  const [timelineRefresh, setTimelineRefresh] = useState(0);
  const [snapshotBusy, setSnapshotBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chatDraft, setChatDraft] = useState("");

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

  const openFile = useCallback(async (filePath: string) => {
    setActivePath(filePath);
    setMiddleTab("code");
    // 已打开（含脏缓冲）：只切过去，绝不重新读盘覆盖未保存修改
    if (buffersRef.current[filePath]) return;
    setOpenTabs((current) => (current.includes(filePath) ? current : [...current, filePath]));
    setBuffers((current) => {
      if (current[filePath]) return current;
      return { ...current, [filePath]: { content: "", binary: false, truncated: false, dirty: false, loading: true, error: null } };
    });
    const api = workbenchApi();
    if (!api) return;
    try {
      const file = (await api.readFile(sessionId, filePath)) as WorkbenchFileContent;
      setBuffers((current) => {
        // 响应飞行期间标签可能已被关闭：只有仍是 loading 占位时才落内容
        const existing = current[filePath];
        if (!existing || !existing.loading) return current;
        return {
          ...current,
          [filePath]: { content: file.content, binary: file.binary, truncated: file.truncated, dirty: false, loading: false, error: null },
        };
      });
    } catch (cause) {
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
    }
  }, [sessionId]);

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

  const sendChat = useCallback(async () => {
    const text = chatDraft.trim();
    if (!text) return;
    if (await onSendText(text)) setChatDraft("");
  }, [chatDraft, onSendText]);

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
              onClick={() => window.chat?.minimize()}
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
              onClick={() => window.chat?.toggleMaximize()}
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
              onClick={() => window.chat?.close()}
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

      <div className="cy-workbench__body">
        <aside className="cy-workbench__col cy-workbench__col--left" style={{ width: columns.left }}>
          <div className="cy-workbench__col-header">{t("workbench.filesHeader")}</div>
          <div className="cy-workbench__col-body">
            <WorkspaceTree
              sessionId={sessionId}
              refreshToken={treeRefresh}
              activePath={activePath}
              onOpenFile={(path) => void openFile(path)}
            />
          </div>
        </aside>

        <div
          className="cy-workbench__resizer"
          onPointerDown={(event) => columns.beginDrag(0, event)}
          onDoubleClick={() => void 0}
        />

        <section className="cy-workbench__col cy-workbench__col--middle" style={{ width: columns.middle }}>
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
        </section>

        <div
          className="cy-workbench__resizer"
          onPointerDown={(event) => columns.beginDrag(1, event)}
          onDoubleClick={() => void 0}
        />

        <section className="cy-workbench__col cy-workbench__col--right">
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
      </div>
    </div>,
    document.body,
  );
}
