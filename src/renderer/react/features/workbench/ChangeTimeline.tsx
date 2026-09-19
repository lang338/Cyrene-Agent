// 工作台中栏「历史 · 改动」：按轮次列出"昔涟改了哪些文件、你改了哪些"，可看 diff、可回到某一轮之前。
//
// 数据来自改动账本（只存被改动文件的内容），因此**不要求工作区是 git 仓库、也不受工作区规模限制**——
// 这正是它和上面「快照」页签的分工：小仓库用整区快照，巨型目录/普通文件夹用账本。

import { useCallback, useEffect, useRef, useState } from "react";
import { Modal } from "antd";
import { DiffEditor } from "@monaco-editor/react";
import { useTranslation } from "../../i18n";
import type {
  LedgerFileChange,
  LedgerFileVersions,
  LedgerRestoreResult,
  LedgerRound,
  LedgerUsage,
} from "../../../../shared/code-workbench-types";
import { languageIdForPath } from "../../../../shared/workbench-languages";
import { workbenchApi } from "./WorkspaceTree";

interface ChangeTimelineProps {
  sessionId: string;
  refreshToken: number;
  busy: boolean;
  onBusyChange: (busy: boolean) => void;
  /** 回退前的把关：返回 false 表示这次回退被拦下（原因由外层给出） */
  onBeforeRestore?: (paths: string[]) => boolean;
  /** 回退成功后通知外层（只清被动过的那些缓冲、刷新文件树） */
  onAfterRestore?: (result: LedgerRestoreResult) => void;
}

function formatTime(at: number): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatMB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function ChangeTimeline({ sessionId, refreshToken, busy, onBusyChange, onBeforeRestore, onAfterRestore }: ChangeTimelineProps) {
  const { t } = useTranslation();
  const [rounds, setRounds] = useState<LedgerRound[]>([]);
  const [usage, setUsage] = useState<LedgerUsage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string[]>([]);
  const [diffTarget, setDiffTarget] = useState<{ round: LedgerRound; file: LedgerFileChange } | null>(null);
  const [versions, setVersions] = useState<LedgerFileVersions | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState<LedgerRound | null>(null);
  const [pruneTarget, setPruneTarget] = useState<LedgerRound | null>(null);
  // diff 请求序号：快速切换文件时，先发的请求可能后到——只接受最新那一次
  const diffSeq = useRef(0);

  const load = useCallback(async () => {
    const api = workbenchApi();
    if (!api?.listLedgerRounds) return;
    try {
      const [nextRounds, nextUsage] = await Promise.all([
        api.listLedgerRounds(sessionId) as Promise<LedgerRound[]>,
        api.ledgerUsage() as Promise<LedgerUsage>,
      ]);
      setRounds([...nextRounds].reverse()); // 最近的在最上面
      setUsage(nextUsage);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [sessionId]);

  useEffect(() => {
    void load();
    setDiffTarget(null);
  }, [load, refreshToken]);

  // 账本一有写入（昔涟改完、你保存完、回退、清理）就刷新，不必手动点
  useEffect(() => {
    const unsubscribe = workbenchApi()?.onLedgerChanged?.((payload) => {
      if (payload.sessionId !== sessionId) return;
      void load();
    });
    return unsubscribe;
  }, [load, sessionId]);

  async function openDiff(round: LedgerRound, file: LedgerFileChange) {
    const api = workbenchApi();
    if (!api?.ledgerFileVersions) return;
    const seq = ++diffSeq.current;
    setDiffTarget({ round, file });
    setVersions(null);
    setDiffLoading(true);
    try {
      const next = await api.ledgerFileVersions(sessionId, round.roundId, file.path) as LedgerFileVersions;
      if (seq !== diffSeq.current) return; // 已经有更新的一次选择，丢弃这次
      setVersions(next);
    } catch (cause) {
      if (seq !== diffSeq.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
      setDiffTarget(null);
    } finally {
      if (seq === diffSeq.current) setDiffLoading(false);
    }
  }

  async function restore(round: LedgerRound) {
    const api = workbenchApi();
    if (!api?.restoreLedgerRound) return;
    // 守卫必须看到"本次回退真正会动的全部文件"：服务端影响的是目标轮**及其之后**每文件取
    // 最早一条，只看 round.files 会漏掉后续轮次才改、缓冲里正有未保存改动的文件。
    // 预检通道不在（旧 preload）时退回 round.files，绝不能因为拿不到清单就放开守卫。
    let affectedPaths: string[];
    try {
      affectedPaths = api.ledgerRestoreAffected
        ? await api.ledgerRestoreAffected(sessionId, round.roundId)
        : round.files.map((file) => file.path);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setRestoreTarget(null);
      return;
    }
    // 有未保存改动的文件先拦下来：回退直接改磁盘，用户缓冲里那份改动没地方放
    if (onBeforeRestore && !onBeforeRestore(affectedPaths)) {
      setRestoreTarget(null);
      return;
    }
    onBusyChange(true);
    try {
      const result = await api.restoreLedgerRound(sessionId, round.roundId) as LedgerRestoreResult;
      const skipped = result.skipped.length > 0
        ? ` · ${t("workbench.restoreSkipped", { count: result.skipped.length })}`
        : "";
      setNotice(t("workbench.restoreDone", { restored: result.restored.length, deleted: result.deleted.length }) + skipped);
      setError(null);
      onAfterRestore?.(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRestoreTarget(null);
      onBusyChange(false);
      void load();
    }
  }

  async function prune(round: LedgerRound) {
    const api = workbenchApi();
    if (!api?.pruneLedgerRounds) return;
    onBusyChange(true);
    try {
      await api.pruneLedgerRounds(sessionId, [round.roundId]);
      setNotice(t("workbench.pruneDone"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPruneTarget(null);
      onBusyChange(false);
      void load();
    }
  }

  function skippedLabel(file: LedgerFileChange): string | null {
    if (file.contentSkipped === "binary") return t("workbench.ledgerSkippedBinary");
    if (file.contentSkipped === "too-large") return t("workbench.ledgerSkippedLarge");
    // 改动后内容读失败（基线可能还在）：diff 右侧会空白、回退也会跳过——必须说出来
    if (file.contentSkipped === "unreadable") return t("workbench.ledgerSkippedUnreadable");
    if (!file.hasBaseline) return t("workbench.ledgerNoBaseline");
    return null;
  }

  return (
    <div className="cy-changes">
      {usage && (
        <div className={`cy-changes__usage ${usage.warn ? "is-warn" : ""}`}>
          <span>{t("workbench.ledgerUsage", { used: formatMB(usage.totalBytes), max: formatMB(usage.maxBytes) })}</span>
          {usage.warn && <span className="cy-changes__usage-hint">{t("workbench.ledgerWarn")}</span>}
        </div>
      )}
      <p className="cy-changes__hint">{t("workbench.ledgerHint")}</p>

      {error && <div className="cy-changes__error">{error}</div>}
      {notice && (
        <div className="cy-changes__notice">
          <span>{notice}</span>
          <button type="button" onClick={() => setNotice(null)} aria-label={t("workbench.dismissNotice")}>×</button>
        </div>
      )}

      {rounds.length === 0 && <div className="cy-changes__empty">{t("workbench.ledgerEmpty")}</div>}

      <ul className="cy-changes__list">
        {rounds.map((round) => {
          const open = expanded.includes(round.roundId);
          return (
            <li key={round.roundId} className="cy-changes__round">
              <div className="cy-changes__round-head">
                <button
                  type="button"
                  className="cy-changes__round-toggle"
                  onClick={() => setExpanded((current) => open ? current.filter((id) => id !== round.roundId) : [...current, round.roundId])}
                  aria-expanded={open}
                >
                  <span className="cy-changes__caret">{open ? "▾" : "▸"}</span>
                  <span className="cy-changes__time">{formatTime(round.at)}</span>
                  <span className="cy-changes__label">{round.label || t("workbench.ledgerRoundFallback")}</span>
                  <span className="cy-changes__count">{t("workbench.ledgerFileCount", { count: round.files.length })}</span>
                </button>
                <div className="cy-changes__round-actions">
                  <button type="button" onClick={() => setRestoreTarget(round)} disabled={busy}>{t("workbench.restoreToBefore")}</button>
                  <button type="button" onClick={() => setPruneTarget(round)} disabled={busy} title={t("workbench.pruneHint")}>
                    {t("workbench.pruneRound")}
                  </button>
                </div>
              </div>

              {open && (
                <ul className="cy-changes__files">
                  {round.files.map((file) => {
                    const skipped = skippedLabel(file);
                    return (
                      <li key={file.path}>
                        <button type="button" className="cy-changes__file" onClick={() => void openDiff(round, file)}>
                          <span className={`cy-changes__badge is-${file.source}`}>
                            {file.source === "ai"
                              ? t("workbench.sourceAi")
                              : file.source === "restore"
                                ? t("workbench.sourceRestore")
                                : t("workbench.sourceUser")}
                          </span>
                          <span className="cy-changes__path" title={file.path}>{file.path}</span>
                          {file.kind === "create" && <span className="cy-changes__kind">{t("workbench.kindCreated")}</span>}
                          {file.kind === "delete" && <span className="cy-changes__kind">{t("workbench.kindDeleted")}</span>}
                          <span className="cy-changes__stat">+{file.insertions} −{file.deletions}</span>
                          {skipped && <span className="cy-changes__skipped">{skipped}</span>}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          );
        })}
      </ul>

      {/* diff：用 Monaco 的只读对比视图，before 为 null 表示当时不存在（新建） */}
      <Modal
        title={diffTarget ? t("workbench.ledgerDiffTitle", { path: diffTarget.file.path }) : ""}
        open={Boolean(diffTarget)}
        onCancel={() => setDiffTarget(null)}
        footer={null}
        width="82%"
        styles={{ body: { height: "70vh", padding: 0 } }}
      >
        {diffLoading && <div className="cy-changes__empty">{t("common.loading")}</div>}
        {!diffLoading && versions?.before === undefined && (
          <div className="cy-changes__empty">{t("workbench.ledgerNoBaselineDetail")}</div>
        )}
        {!diffLoading && versions && versions.before !== undefined && (
          <DiffEditor
            height="100%"
            theme="vs-dark"
            language={languageIdForPath(diffTarget?.file.path ?? "")}
            original={versions.before ?? ""}
            modified={versions.after ?? ""}
            options={{ readOnly: true, renderSideBySide: true, minimap: { enabled: false }, fontSize: 13 }}
          />
        )}
      </Modal>

      <Modal
        title={t("workbench.restoreConfirmTitle")}
        open={Boolean(restoreTarget)}
        onCancel={() => setRestoreTarget(null)}
        onOk={() => restoreTarget && void restore(restoreTarget)}
        okText={t("workbench.restoreToBefore")}
        cancelText={t("common.cancel")}
        confirmLoading={busy}
      >
        <p>{t("workbench.restoreConfirmBody")}</p>
      </Modal>

      <Modal
        title={t("workbench.pruneConfirmTitle")}
        open={Boolean(pruneTarget)}
        onCancel={() => setPruneTarget(null)}
        onOk={() => pruneTarget && void prune(pruneTarget)}
        okText={t("workbench.pruneRound")}
        cancelText={t("common.cancel")}
        confirmLoading={busy}
      >
        <p>{t("workbench.pruneConfirmBody")}</p>
      </Modal>
    </div>
  );
}
