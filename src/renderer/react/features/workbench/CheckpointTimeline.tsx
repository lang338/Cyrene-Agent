// 工作台中栏"历史"页签：checkpoint 时间线 + 单条 diff 查看 + 一键回退。

import { useCallback, useEffect, useState } from "react";
import { Modal } from "antd";
import { useTranslation } from "../../i18n";
import type { CheckpointDiff, CheckpointEntry } from "../../../../shared/code-workbench-types";
import { workbenchApi } from "./WorkspaceTree";

interface CheckpointTimelineProps {
  sessionId: string;
  refreshToken: number;
  busy: boolean;
  onBusyChange: (busy: boolean) => void;
  /** 回退成功后通知外层（清编辑缓冲、刷新文件树） */
  onAfterRestore?: () => void;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** 把统一 diff patch 按行渲染成红绿对比 */
function DiffPatchView({ patch }: { patch: string }) {
  const lines = patch.split("\n");
  return (
    <pre className="cy-workbench-diff">
      {lines.map((line, index) => {
        const kind = line.startsWith("+") && !line.startsWith("+++")
          ? "add"
          : line.startsWith("-") && !line.startsWith("---")
            ? "del"
            : line.startsWith("@@") ? "hunk" : line.startsWith("diff ") || line.startsWith("index ") ? "meta" : "ctx";
        return <span key={index} className={`cy-workbench-diff__line is-${kind}`}>{line + "\n"}</span>;
      })}
    </pre>
  );
}

export function CheckpointTimeline({ sessionId, refreshToken, busy, onBusyChange, onAfterRestore }: CheckpointTimelineProps) {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<CheckpointEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<CheckpointDiff | null>(null);
  const [selectedLoading, setSelectedLoading] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState<CheckpointEntry | null>(null);

  const load = useCallback(async () => {
    const api = workbenchApi();
    if (!api) return;
    try {
      setEntries(await api.listCheckpoints(sessionId) as CheckpointEntry[]);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [sessionId]);

  useEffect(() => {
    void load();
    setSelected(null);
  }, [load, refreshToken]);

  async function openDiff(entry: CheckpointEntry) {
    const api = workbenchApi();
    if (!api) return;
    setSelectedLoading(true);
    try {
      setSelected(await api.diffCheckpoint(sessionId, entry.hash) as CheckpointDiff);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSelectedLoading(false);
    }
  }

  async function doRestore(entry: CheckpointEntry) {
    const api = workbenchApi();
    if (!api) return;
    onBusyChange(true);
    try {
      await api.restoreCheckpoint(sessionId, entry.hash);
      setRestoreTarget(null);
      setSelected(null);
      await load();
      onAfterRestore?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      onBusyChange(false);
    }
  }

  return (
    <div className="cy-workbench-history">
      {error && <div className="cy-workbench-history__error">{error}</div>}
      {entries.length === 0 && !error && (
        <div className="cy-workbench-history__empty">{t("workbench.noCheckpoints")}</div>
      )}
      <ul className="cy-workbench-history__list">
        {entries.map((entry) => (
          <li key={entry.hash} className={`cy-workbench-history__item ${selected?.toHash === entry.hash ? "is-selected" : ""}`}>
            <button type="button" className="cy-workbench-history__open" onClick={() => void openDiff(entry)}>
              <span className={`cy-workbench-history__kind is-${entry.kind}`}>
                {entry.kind === "pre-restore" ? t("workbench.kindPreRestore") : entry.kind === "manual" ? t("workbench.kindManual") : t("workbench.kindAuto")}
              </span>
              <time>{formatTime(entry.timestamp)}</time>
            </button>
            <button
              type="button"
              className="cy-workbench-history__restore"
              disabled={busy}
              onClick={() => setRestoreTarget(entry)}
              title={t("workbench.restoreTitle")}
            >
              {t("workbench.restore")}
            </button>
          </li>
        ))}
      </ul>

      <div className="cy-workbench-history__detail">
        {selectedLoading && <div className="cy-workbench-history__empty">{t("workbench.diffLoading")}</div>}
        {!selectedLoading && selected && (
          <>
            <div className="cy-workbench-history__summary">
              <span className="cy-workbench-diff__ins">+{selected.insertions}</span>
              <span className="cy-workbench-diff__del">-{selected.deletions}</span>
              <span>{t("workbench.fileCount", { count: selected.perFile.length })}</span>
              {selected.truncated && <em>{t("workbench.diffTruncated")}</em>}
            </div>
            <ul className="cy-workbench-diff__files">
              {selected.perFile.map((file) => (
                <li key={file.file}>
                  <code>{file.file}</code>
                  <span className="cy-workbench-diff__ins">+{file.insertions}</span>
                  <span className="cy-workbench-diff__del">-{file.deletions}</span>
                </li>
              ))}
            </ul>
            <DiffPatchView patch={selected.patch} />
          </>
        )}
        {!selectedLoading && !selected && entries.length > 0 && (
          <div className="cy-workbench-history__empty">{t("workbench.pickCheckpoint")}</div>
        )}
      </div>

      <Modal
        open={restoreTarget !== null}
        title={t("workbench.restoreConfirmTitle")}
        onCancel={() => setRestoreTarget(null)}
        footer={null}
        className="cy-workbench-modal"
      >
        <p className="cy-workbench-modal__hint">{t("workbench.restoreConfirmHint")}</p>
        <p className="cy-workbench-modal__hint">{t("workbench.restoreConfirmSafe")}</p>
        <div className="cy-workbench-modal__actions">
          <button type="button" onClick={() => setRestoreTarget(null)}>{t("workbench.cancel")}</button>
          <button
            type="button"
            className="is-primary"
            disabled={busy}
            onClick={() => restoreTarget && void doRestore(restoreTarget)}
          >
            {t("workbench.restoreConfirmGo")}
          </button>
        </div>
      </Modal>
    </div>
  );
}
