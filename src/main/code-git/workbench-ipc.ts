// 工作台 IPC：checkpoint 时间机器 + 工作区文件读写。
// 与 code-git-ipc 相同的注册风格：入参全部校验，错误直接抛给渲染端展示。

import { ipcMain } from "electron";
import { IPC } from "../../shared/ipc-channels";
import { createIpcScope, type IpcScope, type IpcScopeMainLike } from "../application/ipc-scope";
import type { CheckpointKind } from "../../shared/code-workbench-types";
import type { CheckpointService } from "./checkpoint-service";
import type { ChangeLedger } from "./change-ledger-service";
import { isMissingFileError } from "./change-ledger-service";
import type { WorkspaceFileService } from "./workspace-files";

interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: any[]) => unknown): void;
}

export interface RegisterWorkbenchIpcDeps {
  ipc?: IpcScope;
  ipcMain?: IpcMainLike;
  checkpoint: CheckpointService;
  files: WorkspaceFileService;
  /** 改动账本；未注入时相关通道不可用（工作台界面会自行降级） */
  ledger?: ChangeLedger;
  /** 账本写入后的广播（时间线自动刷新） */
  onLedgerChanged?: (sessionId: string) => void;
  /** 取会话绑定的工作区根目录（回退要用它解析路径） */
  getWorkspaceRoot?: (sessionId: string) => string | undefined;
}

const CHECKPOINT_KINDS: ReadonlySet<string> = new Set(["auto", "pre-restore", "manual"]);

export function registerWorkbenchIpc(deps: RegisterWorkbenchIpcDeps): void {
  const ipc: IpcScope = deps.ipc ?? createIpcScope((deps.ipcMain ?? ipcMain) as IpcScopeMainLike);

  ipc.handle(IPC.WORKBENCH_CHECKPOINT_SNAPSHOT, (_event, payload: unknown) => {
    const input = payload as { sessionId?: unknown; kind?: unknown } | null;
    const kind = typeof input?.kind === "string" && CHECKPOINT_KINDS.has(input.kind)
      ? input.kind as CheckpointKind
      : "manual";
    return deps.checkpoint.snapshot(requireSessionId(input?.sessionId), kind);
  });

  ipc.handle(IPC.WORKBENCH_CHECKPOINT_LIST, (_event, sessionId: unknown) => {
    return deps.checkpoint.list(requireSessionId(sessionId));
  });

  ipc.handle(IPC.WORKBENCH_CHECKPOINT_DIFF, (_event, payload: unknown) => {
    const input = payload as { sessionId?: unknown; hash?: unknown } | null;
    if (typeof input?.hash !== "string" || !input.hash.trim()) throw new Error("缺少快照标识");
    return deps.checkpoint.diff(requireSessionId(input.sessionId), input.hash);
  });

  ipc.handle(IPC.WORKBENCH_CHECKPOINT_RESTORE, (_event, payload: unknown) => {
    const input = payload as { sessionId?: unknown; hash?: unknown } | null;
    if (typeof input?.hash !== "string" || !input.hash.trim()) throw new Error("缺少快照标识");
    return deps.checkpoint.restore(requireSessionId(input.sessionId), input.hash);
  });

  ipc.handle(IPC.WORKBENCH_FILE_LIST, (_event, payload: unknown) => {
    const input = payload as { sessionId?: unknown; path?: unknown } | null;
    const relPath = typeof input?.path === "string" ? input.path : "";
    return deps.files.listDir(requireSessionId(input?.sessionId), relPath);
  });

  ipc.handle(IPC.WORKBENCH_FILE_READ, (_event, payload: unknown) => {
    const input = payload as { sessionId?: unknown; path?: unknown } | null;
    if (typeof input?.path !== "string" || !input.path.trim()) throw new Error("缺少文件路径");
    return deps.files.readFile(requireSessionId(input.sessionId), input.path);
  });

  ipc.handle(IPC.WORKBENCH_FILE_WRITE, async (_event, payload: unknown) => {
    const input = payload as { sessionId?: unknown; path?: unknown; content?: unknown } | null;
    if (typeof input?.path !== "string" || !input.path.trim()) throw new Error("缺少文件路径");
    if (typeof input?.content !== "string") throw new Error("文件内容必须是文本");
    const sessionId = requireSessionId(input.sessionId);
    const relPath = input.path.trim();
    const content = input.content;

    // 先取旧内容：改动时间线要记"你改之前"的样子，否则这个文件回退不了。
    // ⚠️ 只有 ENOENT 才代表"文件不存在"（before=null → 回退时删除）；
    // 权限/句柄耗尽等暂时性错误必须给 undefined（= 没有基线，回退跳过），
    // 否则一次 EACCES 就会让回退去删一个用户真实存在的文件。
    let before: string | null | undefined;
    if (deps.ledger) {
      try {
        const existing = await deps.files.readFile(sessionId, relPath);
        before = existing.binary || existing.truncated ? undefined : existing.content;
      } catch (error) {
        before = isMissingFileError(error) ? null : undefined;
      }
    }

    const result = await deps.files.writeFile(sessionId, relPath, content);

    if (deps.ledger) {
      try {
        await deps.ledger.record({
          conversationId: sessionId,
          // 你的保存按分钟归组：连续几次保存不至于刷出一长串条目
          runId: `user-${Math.floor(Date.now() / 60000)}`,
          toolCallId: "",
          toolId: "workbench-save",
          path: relPath.replace(/\\/g, "/").replace(/^\.\//, ""),
          kind: before === null ? "create" : "modify",
          source: "user",
          insertions: countLines(content),
          deletions: typeof before === "string" ? countLines(before) : 0,
          ...(before === undefined ? {} : { before }),
          after: content,
          label: "你在工作台里的改动",
        });
        deps.onLedgerChanged?.(sessionId);
      } catch (error) {
        // 记账失败不能让你存不了文件
        console.warn("[workbench] 保存记账失败:", error);
      }
    }
    return result;
  });

  // 工作区外：路径校验在文件服务里（只接受绝对路径），这里不重复判定
  ipc.handle(IPC.WORKBENCH_FILE_READ_ABSOLUTE, (_event, payload: unknown) => {
    const input = payload as { sessionId?: unknown; path?: unknown } | null;
    if (typeof input?.path !== "string" || !input.path.trim()) throw new Error("缺少文件路径");
    requireSessionId(input.sessionId);
    return deps.files.readOutsideFile(input.path);
  });

  ipc.handle(IPC.WORKBENCH_FILE_WRITE_ABSOLUTE, (_event, payload: unknown) => {
    const input = payload as { sessionId?: unknown; path?: unknown; content?: unknown } | null;
    if (typeof input?.path !== "string" || !input.path.trim()) throw new Error("缺少文件路径");
    if (typeof input?.content !== "string") throw new Error("文件内容必须是文本");
    requireSessionId(input.sessionId);
    return deps.files.writeOutsideFile(input.path, input.content);
  });
  // ── 改动账本（时间线） ─────────────────────────────────
  function requireLedger(): ChangeLedger {
    if (!deps.ledger) throw new Error("改动记录未启用");
    return deps.ledger;
  }

  function requireWorkspaceRoot(sessionId: string): string {
    const root = deps.getWorkspaceRoot?.(sessionId);
    if (!root) throw new Error("尚未绑定代码目录");
    return root;
  }

  ipc.handle(IPC.WORKBENCH_LEDGER_LIST, (_event, sessionId: unknown) => {
    return requireLedger().listRounds(requireSessionId(sessionId));
  });

  ipc.handle(IPC.WORKBENCH_LEDGER_FILE, (_event, payload: unknown) => {
    const input = payload as { sessionId?: unknown; roundId?: unknown; path?: unknown } | null;
    if (typeof input?.roundId !== "string" || !input.roundId.trim()) throw new Error("缺少轮次标识");
    if (typeof input?.path !== "string" || !input.path.trim()) throw new Error("缺少文件路径");
    return requireLedger().fileVersions(requireSessionId(input.sessionId), input.roundId, input.path);
  });

  ipc.handle(IPC.WORKBENCH_LEDGER_RESTORE, async (_event, payload: unknown) => {
    const input = payload as { sessionId?: unknown; roundId?: unknown } | null;
    if (typeof input?.roundId !== "string" || !input.roundId.trim()) throw new Error("缺少轮次标识");
    const sessionId = requireSessionId(input.sessionId);
    const ledger = requireLedger();
    const result = await ledger.restore(sessionId, input.roundId, requireWorkspaceRoot(sessionId));
    deps.onLedgerChanged?.(sessionId);
    return result;
  });

  ipc.handle(IPC.WORKBENCH_LEDGER_USAGE, () => requireLedger().usage());

  ipc.handle(IPC.WORKBENCH_LEDGER_PRUNE, async (_event, payload: unknown) => {
    const input = payload as { sessionId?: unknown; roundIds?: unknown } | null;
    const roundIds = Array.isArray(input?.roundIds)
      ? input.roundIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
      : [];
    if (roundIds.length === 0) throw new Error("没有指定要删除的记录");
    const sessionId = requireSessionId(input?.sessionId);
    await requireLedger().pruneRounds(sessionId, roundIds);
    deps.onLedgerChanged?.(sessionId);
  });
}

/** 行数（与工具证据同一口径：末尾空行不计） */
function countLines(text: string): number {
  if (!text) return 0;
  const lines = text.split("\n");
  return lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
}

function requireSessionId(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("缺少会话标识");
  return value;
}
