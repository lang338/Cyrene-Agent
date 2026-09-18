// 工作台 IPC：checkpoint 时间机器 + 工作区文件读写。
// 与 code-git-ipc 相同的注册风格：入参全部校验，错误直接抛给渲染端展示。

import { ipcMain } from "electron";
import { IPC } from "../../shared/ipc-channels";
import { createIpcScope, type IpcScope, type IpcScopeMainLike } from "../application/ipc-scope";
import type { CheckpointKind } from "../../shared/code-workbench-types";
import type { CheckpointService } from "./checkpoint-service";
import type { WorkspaceFileService } from "./workspace-files";

interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: any[]) => unknown): void;
}

export interface RegisterWorkbenchIpcDeps {
  ipc?: IpcScope;
  ipcMain?: IpcMainLike;
  checkpoint: CheckpointService;
  files: WorkspaceFileService;
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

  ipc.handle(IPC.WORKBENCH_FILE_WRITE, (_event, payload: unknown) => {
    const input = payload as { sessionId?: unknown; path?: unknown; content?: unknown } | null;
    if (typeof input?.path !== "string" || !input.path.trim()) throw new Error("缺少文件路径");
    if (typeof input?.content !== "string") throw new Error("文件内容必须是文本");
    return deps.files.writeFile(requireSessionId(input.sessionId), input.path, input.content);
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
}

function requireSessionId(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("缺少会话标识");
  return value;
}
