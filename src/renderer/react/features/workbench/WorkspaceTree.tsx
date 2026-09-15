// 工作台左栏：工作区文件树（懒加载目录）。

import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { useTranslation } from "../../i18n";
import type { WorkbenchFileEntry } from "../../../../shared/code-workbench-types";
import { FileTypeIcon } from "./file-type-icon";

interface WorkbenchApi {
  listDir(sessionId: string, path?: string): Promise<WorkbenchFileEntry[]>;
  readFile(sessionId: string, path: string): Promise<{ path: string; content: string; binary: boolean; truncated: boolean }>;
  writeFile(sessionId: string, path: string, content: string): Promise<void>;
  listCheckpoints(sessionId: string): Promise<unknown>;
  diffCheckpoint(sessionId: string, hash: string): Promise<unknown>;
  restoreCheckpoint(sessionId: string, hash: string): Promise<unknown>;
  snapshot(sessionId: string, kind?: "auto" | "pre-restore" | "manual"): Promise<unknown>;
}

export function workbenchApi(): WorkbenchApi | undefined {
  return typeof window === "undefined" ? undefined : (window as Window & { workbench?: WorkbenchApi }).workbench;
}

interface WorkspaceTreeProps {
  sessionId: string;
  refreshToken: number;
  activePath: string | null;
  onOpenFile: (path: string) => void;
}

export function WorkspaceTree({ sessionId, refreshToken, activePath, onOpenFile }: WorkspaceTreeProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [children, setChildren] = useState<Map<string, WorkbenchFileEntry[]>>(new Map());
  const [error, setError] = useState<string | null>(null);
  // 根目录请求是否已完成：区分"还在加载"与"工作区真的是空的"
  const [rootLoaded, setRootLoaded] = useState(false);

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
    <div className="cy-workbench-tree" aria-label={t("workbench.treeAria")}>
      {error && <div className="cy-workbench-tree__error">{error}</div>}
      {!error && !rootLoaded && <div className="cy-workbench-tree__empty">{t("workbench.treeLoading")}</div>}
      {!error && rootLoaded && rootEntries.length === 0 && (
        <div className="cy-workbench-tree__empty">{t("workbench.treeEmpty")}</div>
      )}
      {renderEntries(rootEntries, 0)}
    </div>
  );
}
