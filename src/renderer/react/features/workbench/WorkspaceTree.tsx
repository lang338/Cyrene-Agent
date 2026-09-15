// 工作台左栏：工作区文件树（懒加载目录）。

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "../../i18n";
import type { WorkbenchFileEntry } from "../../../../shared/code-workbench-types";

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

  const loadDir = useCallback(async (dirPath: string) => {
    const api = workbenchApi();
    if (!api) return;
    try {
      const entries = await api.listDir(sessionId, dirPath);
      setChildren((current) => {
        const next = new Map(current);
        next.set(dirPath, entries);
        return next;
      });
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [sessionId]);

  useEffect(() => {
    // 首次与外部变更令牌变化时：刷新根目录 + 已展开目录
    void loadDir("");
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

  function renderEntries(entries: WorkbenchFileEntry[], depth: number): React.ReactNode {
    return entries.map((entry) => {
      if (entry.type === "dir") {
        const isOpen = expanded.has(entry.path);
        return (
          <div key={entry.path}>
            <button
              type="button"
              className={`cy-workbench-tree__row ${isOpen ? "is-open" : ""}`}
              style={{ paddingLeft: 10 + depth * 14 }}
              onClick={() => toggleDir(entry.path)}
            >
              <span className="cy-workbench-tree__chevron">{isOpen ? "▾" : "▸"}</span>
              <span className="cy-workbench-tree__name">{entry.name}</span>
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
          style={{ paddingLeft: 10 + depth * 14 + 14 }}
          onClick={() => onOpenFile(entry.path)}
        >
          <span className="cy-workbench-tree__dot" />
          <span className="cy-workbench-tree__name" title={entry.path}>{entry.name}</span>
        </button>
      );
    });
  }

  const rootEntries = children.get("") ?? [];

  return (
    <div className="cy-workbench-tree" aria-label={t("workbench.treeAria")}>
      {error && <div className="cy-workbench-tree__error">{error}</div>}
      {!error && rootEntries.length === 0 && <div className="cy-workbench-tree__empty">{t("workbench.treeLoading")}</div>}
      {renderEntries(rootEntries, 0)}
    </div>
  );
}
