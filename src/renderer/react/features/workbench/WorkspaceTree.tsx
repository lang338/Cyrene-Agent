// 工作台左栏：工作区文件树（懒加载目录）。

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "../../i18n";
import type {
  WorkbenchFileEntry,
  WorkbenchLspDiagnostic,
  WorkbenchLspEnv,
  WorkbenchLspInstallProgress,
  WorkbenchLspInstallResult,
  WorkbenchLspRequestInput,
  WorkbenchLspRequestResult,
} from "../../../../shared/code-workbench-types";
import { FileTypeIcon } from "./file-type-icon";
import { ancestorDirs } from "./follow-changes";

interface WorkbenchApi {
  listDir(sessionId: string, path?: string): Promise<WorkbenchFileEntry[]>;
  readFile(sessionId: string, path: string): Promise<{ path: string; content: string; binary: boolean; truncated: boolean }>;
  writeFile(sessionId: string, path: string, content: string): Promise<void>;
  /** 工作区外的文件：按全盘绝对路径读写（用户手输，见路径栏） */
  readOutsideFile(sessionId: string, path: string): Promise<{ path: string; content: string; binary: boolean; truncated: boolean }>;
  writeOutsideFile(sessionId: string, path: string, content: string): Promise<void>;
  listCheckpoints(sessionId: string): Promise<unknown>;
  diffCheckpoint(sessionId: string, hash: string): Promise<unknown>;
  restoreCheckpoint(sessionId: string, hash: string): Promise<unknown>;
  snapshot(sessionId: string, kind?: "auto" | "pre-restore" | "manual"): Promise<unknown>;
  /**
   * 以下成员在 preload 的 workbenchApi 里都是无条件挂上的对象字面量成员，所以这里声明为
   * 非可选。之前全写成可选，导致内部直接调用（如 api.syncLspDocument(...)）被判定
   * "可能是 undefined"。外部拿到的类型仍是 `WorkbenchApi | undefined`（window.workbench
   * 本身可能不存在），调用方照旧用 `api?.xxx` 保护。
   */
  /** 快照落盘广播订阅；返回退订函数 */
  onCheckpointChanged(callback: (payload: { sessionId: string }) => void): () => void;
  /** 改动账本（时间线）：不要求工作区是 git 仓库，巨型目录同样可用 */
  listLedgerRounds(sessionId: string): Promise<unknown>;
  ledgerFileVersions(sessionId: string, roundId: string, path: string): Promise<unknown>;
  /** 回退前预检：本次回退实际触及的全部相对路径（目标轮及之后，脏缓冲把关用） */
  ledgerRestoreAffected(sessionId: string, roundId: string): Promise<string[]>;
  restoreLedgerRound(sessionId: string, roundId: string): Promise<unknown>;
  ledgerUsage(): Promise<unknown>;
  pruneLedgerRounds(sessionId: string, roundIds: string[]): Promise<unknown>;
  onLedgerChanged(callback: (payload: { sessionId: string }) => void): () => void;
  /** 语言服务（LSP）：把编辑器内容同步给外部语言服务；返回 false = 没有可用服务，编辑器静默降级 */
  syncLspDocument(sessionId: string, path: string, content: string, languageId: string, revision?: number): Promise<boolean>;
  /** 查语言服务环境：有没有可用服务 / 往上有没有项目配置 / 配置该写在哪 / 能不能一键装（渲染端据此说明降级原因） */
  lspEnv(sessionId: string, path: string): Promise<WorkbenchLspEnv | null>;
  closeLspDocument(sessionId: string, path: string): Promise<boolean>;
  /** 编辑器主动提问（补全/悬停/跳转/查引用）；null = 没有可用服务，编辑器静默降级 */
  requestLsp(input: WorkbenchLspRequestInput): Promise<WorkbenchLspRequestResult | null>;
  onLspDiagnostics(callback: (payload: { sessionId: string; path: string; diagnostics: WorkbenchLspDiagnostic[] }) => void): () => void;
  /** 下载并安装语言服务（只认主进程清单里钉死版本的包）；取消与失败都在返回值里区分 */
  installLspServer(serverId: string): Promise<WorkbenchLspInstallResult>;
  cancelLspInstall(serverId: string): Promise<boolean>;
  onLspInstallProgress(callback: (payload: WorkbenchLspInstallProgress) => void): () => void;
}

export function workbenchApi(): WorkbenchApi | undefined {
  return typeof window === "undefined" ? undefined : (window as Window & { workbench?: WorkbenchApi }).workbench;
}

interface WorkspaceTreeProps {
  sessionId: string;
  refreshToken: number;
  activePath: string | null;
  /** 需要定位到的文件（昔涟刚改动的那个）：逐级展开父目录并滚进视野 */
  revealPath?: string | null;
  onOpenFile: (path: string) => void;
}

/** 在已渲染的行里找目标文件；返回 null 表示目录还没展开或数据还没到，下次再试 */
function findRowElement(container: HTMLElement | null, path: string): HTMLElement | null {
  const rows = container?.querySelectorAll<HTMLElement>("[data-path]");
  if (!rows) return null;
  for (const row of rows) {
    if (row.dataset.path === path) return row;
  }
  return null;
}

export function WorkspaceTree({ sessionId, refreshToken, activePath, revealPath, onOpenFile }: WorkspaceTreeProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [children, setChildren] = useState<Map<string, WorkbenchFileEntry[]>>(new Map());
  const [error, setError] = useState<string | null>(null);
  // 根目录请求是否已完成：区分"还在加载"与"工作区真的是空的"
  const [rootLoaded, setRootLoaded] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const loadDir = useCallback(async (dirPath: string, isRoot = false) => {
    const api = workbenchApi();
    if (!api) return;
    try {
      const entries = await api.listDir(sessionId, dirPath);
      setChildren((current) => {
        const next = new Map(current);
        next.set(dirPath, entries);
        return next;
      });
      if (isRoot) setRootLoaded(true);
      setError(null);
    } catch (cause) {
      if (isRoot) setRootLoaded(true);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [sessionId]);

  useEffect(() => {
    // 首次与外部变更令牌变化时：刷新根目录 + 已展开目录
    void loadDir("", true);
    for (const dir of expanded) void loadDir(dir);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, refreshToken]);

  // 待滚动到的文件；滚到了就清空
  const pendingRevealRef = useRef<string | null>(null);

  // 定位到昔涟刚改动的文件：展开各级父目录并触发加载
  useEffect(() => {
    if (!revealPath) return;
    const dirs = ancestorDirs(revealPath);
    if (dirs.length > 0) {
      setExpanded((current) => {
        const next = new Set(current);
        for (const dir of dirs) next.add(dir);
        return next;
      });
    }
    pendingRevealRef.current = revealPath;
    for (const dir of dirs) void loadDir(dir);
  }, [revealPath, loadDir]);

  /**
   * 滚动到待定位的那一行：树数据或展开态一变就重试，找到即停。
   * 不赌"等完哪几个 promise 之后 DOM 里就有那一行"——目录加载与真实渲染未必同帧
   * （根级文件的父目录集合为空、刷新与跳转同帧发生时更是如此），
   * 而 useEffect 在 DOM 提交之后运行，所以这里看到的就是真实渲染结果。
   */
  useEffect(() => {
    const target = pendingRevealRef.current;
    if (!target) return;
    const row = findRowElement(containerRef.current, target);
    if (!row) return;
    row.scrollIntoView({ block: "nearest" });
    pendingRevealRef.current = null;
  }, [children, expanded]);

  function toggleDir(dirPath: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(dirPath)) next.delete(dirPath);
      else {
        next.add(dirPath);
        void loadDir(dirPath);
      }
      return next;
    });
  }

  /** VS Code 风格的缩进引导线：每一级一条，落在祖先展开箭头的正中 */
  function IndentGuides({ depth }: { depth: number }) {
    if (depth === 0) return null;
    return (
      <span className="cy-workbench-tree__guides" aria-hidden="true">
        {Array.from({ length: depth }, (_, i) => (
          <span key={i} className="cy-workbench-tree__guide" style={{ left: 15.5 + i * 8 }} />
        ))}
      </span>
    );
  }

  function renderEntries(entries: WorkbenchFileEntry[], depth: number): React.ReactNode {
    return entries.map((entry) => {
      const rowStyle = { "--tree-depth": depth } as CSSProperties;
      if (entry.type === "dir") {
        const isOpen = expanded.has(entry.path);
        return (
          <div key={entry.path}>
            <button
              type="button"
              className={`cy-workbench-tree__row ${isOpen ? "is-open" : ""}`}
              style={rowStyle}
              onClick={() => toggleDir(entry.path)}
            >
              <IndentGuides depth={depth} />
              <span className="cy-workbench-tree__twisty">
                <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                  <path
                    d="M6 3.8l4.2 4.2L6 12.2"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
              <FileTypeIcon name={entry.name} isDir dirOpen={isOpen} />
              <span className="cy-workbench-tree__name" title={entry.path}>{entry.name}</span>
            </button>
            {isOpen && children.has(entry.path) && (
              <div className="cy-workbench-tree__children">
                {renderEntries(children.get(entry.path) ?? [], depth + 1)}
              </div>
            )}
          </div>
        );
      }
      return (
        <button
          key={entry.path}
          type="button"
          data-path={entry.path}
          className={`cy-workbench-tree__row ${activePath === entry.path ? "is-active" : ""}`}
          style={rowStyle}
          onClick={() => onOpenFile(entry.path)}
        >
          <IndentGuides depth={depth} />
          {/* 文件保留一个空的箭头位，与目录名对齐 */}
          <span className="cy-workbench-tree__twisty" aria-hidden="true" />
          <FileTypeIcon name={entry.name} />
          <span className="cy-workbench-tree__name" title={entry.path}>{entry.name}</span>
        </button>
      );
    });
  }

  const rootEntries = children.get("") ?? [];

  return (
    <div className="cy-workbench-tree" aria-label={t("workbench.treeAria")} ref={containerRef}>
      {error && <div className="cy-workbench-tree__error">{error}</div>}
      {!error && !rootLoaded && <div className="cy-workbench-tree__empty">{t("workbench.treeLoading")}</div>}
      {!error && rootLoaded && rootEntries.length === 0 && (
        <div className="cy-workbench-tree__empty">{t("workbench.treeEmpty")}</div>
      )}
      {renderEntries(rootEntries, 0)}
    </div>
  );
}
