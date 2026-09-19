// 工作台编辑器 ↔ 语言服务（LSP）的桥。
//
// 职责边界：
// - 渲染端只说"这个文件现在是什么内容"，主进程负责"哪个工作区、哪个语言服务、路径合不合法"；
// - 与 AI 工具链共用 LspManager 里的同一个服务进程（同一工作区同一语言只跑一个）；
// - 拿不到语言服务时全程静默降级：编辑器照常可用，只是没有诊断。

import path from "node:path";
import { ipcMain } from "electron";
import { IPC } from "../../shared/ipc-channels";
import { createIpcScope, type IpcScope, type IpcScopeMainLike } from "../application/ipc-scope";
import { buildLspRequestParams, lspMethodFor, normalizeLspResult } from "./editor-requests";
import { buildRecommendedTsconfig, findProjectConfig } from "./project-config";
import type { LspEditorSupport, LspManager } from "./manager";

/** 补全首次触发要等语言服务把项目索引建起来，比诊断宽松得多 */
const REQUEST_TIMEOUT_MS = 15_000;

interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: any[]) => unknown): void;
}

export interface WorkbenchLspBridgeDeps {
  lsp: Pick<LspManager, "acquireEditorClient">;
  ipc?: IpcScope;
  ipcMain?: IpcMainLike;
  /** 取会话绑定的工作区根；与文件读写同源，保证语言服务看到的目录和用户选的一致 */
  getWorkspaceRoot: (sessionId: string) => string | undefined;
  /** 把诊断推给渲染端 */
  publishDiagnostics: (payload: { sessionId: string; path: string; diagnostics: unknown[] }) => void;
}

interface SessionBinding {
  root: string;
  client: LspEditorSupport;
  unsubscribe: () => void;
}

function requireSessionId(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("缺少会话标识");
  return value;
}

/** 把工作区相对路径解析成绝对路径，并挡住越界（`..` 与绝对路径） */
function resolveInsideWorkspace(root: string, relativePath: string): string {
  const absolute = path.resolve(root, relativePath);
  const relative = path.relative(root, absolute);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("文件路径不在工作区内");
  }
  return absolute;
}

/** 诊断推送用的是绝对路径，转成工作台的文件键（相对根、统一正斜杠）才好对上 */
function relativeToRoot(root: string, absolutePath: string): string {
  return path.relative(root, absolutePath).split(path.sep).join("/");
}

export function registerWorkbenchLspBridge(deps: WorkbenchLspBridgeDeps): { dispose: () => void } {
  const ipc: IpcScope = deps.ipc ?? createIpcScope((deps.ipcMain ?? ipcMain) as IpcScopeMainLike);
  const bindings = new Map<string, SessionBinding>();
  /** 正在建立中的绑定（key = sessionId + root）：把并发请求收敛成一次建立，见 bindingFor */
  const pendingBindings = new Map<string, Promise<SessionBinding | null>>();

  const releaseSession = (sessionId: string): void => {
    const binding = bindings.get(sessionId);
    if (!binding) return;
    bindings.delete(sessionId);
    binding.unsubscribe();
  };

  /**
   * 取（必要时建立）会话对应的语言服务客户端；拿不到就返回 null 让调用方降级。
   *
   * 并发的两条 sync 可能同时走到这里（那时都还没绑定），各自 await 之后各自 subscribe，
   * 后写的覆盖 bindings → 前一个退订函数就此丢失 → 同一条诊断被推两次。
   * 所以给"建立中"也建一张表，后来的请求直接复用同一次建立过程。
   * key 里必须带 root：换工作区时那个进行中的建立过程不能被复用。
   */
  const bindingFor = async (sessionId: string, absolutePath: string): Promise<SessionBinding | null> => {
    const root = deps.getWorkspaceRoot(sessionId);
    if (!root) return null;
    const existing = bindings.get(sessionId);
    if (existing && existing.root === root) return existing;

    const key = `${sessionId}\u0000${root}`;
    const inflight = pendingBindings.get(key);
    if (inflight) return inflight;

    const task = (async (): Promise<SessionBinding | null> => {
      // 工作区被换掉：旧绑定必须作废，否则会把新工作区的文件发给上一个工作区的语言服务
      if (existing) releaseSession(sessionId);
      const client = await deps.lsp.acquireEditorClient(root, absolutePath);
      if (!client) return null;
      const unsubscribe = client.onDiagnostics((filePath, diagnostics) => {
        deps.publishDiagnostics({ sessionId, path: relativeToRoot(root, filePath), diagnostics });
      });
      const binding: SessionBinding = { root, client, unsubscribe };
      bindings.set(sessionId, binding);
      return binding;
    })().finally(() => {
      pendingBindings.delete(key);
    });

    pendingBindings.set(key, task);
    return task;
  };

  /** IPC 传来的数字必须是"非负安全整数"：负数、小数、NaN、超范围一律不接受 */
  const isNonNegativeInt = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

  ipc.handle(IPC.WORKBENCH_LSP_SYNC, async (_event, payload: unknown) => {
    const input = payload as
      | { sessionId?: unknown; path?: unknown; content?: unknown; languageId?: unknown; revision?: unknown }
      | null;
    if (typeof input?.path !== "string" || !input.path.trim()) throw new Error("缺少文件路径");
    if (typeof input?.content !== "string") throw new Error("文件内容必须是文本");
    const sessionId = requireSessionId(input?.sessionId);
    const root = deps.getWorkspaceRoot(sessionId);
    if (!root) return false;
    const absolutePath = resolveInsideWorkspace(root, input.path);
    const binding = await bindingFor(sessionId, absolutePath);
    if (!binding) return false;
    const languageId = typeof input?.languageId === "string" && input.languageId.trim() ? input.languageId : "plaintext";
    // 编辑器模型的版本号（可选，单调递增）：client 用它丢弃迟到的旧同步，避免旧内容覆盖新内容。
    // IPC 是外部输入，只收非负安全整数——负值/小数/超范围会让"谁更新"的判断失真
    const revision = isNonNegativeInt(input?.revision) ? input.revision : undefined;
    await binding.client.syncFromEditor(absolutePath, languageId, input.content, revision);
    return true;
  });

  ipc.handle(IPC.WORKBENCH_LSP_CLOSE, async (_event, payload: unknown) => {
    const input = payload as { sessionId?: unknown; path?: unknown } | null;
    if (typeof input?.path !== "string" || !input.path.trim()) throw new Error("缺少文件路径");
    const sessionId = requireSessionId(input?.sessionId);
    const binding = bindings.get(sessionId);
    if (!binding) return false;
    await binding.client.closeFromEditor(resolveInsideWorkspace(binding.root, input.path));
    return true;
  });

  // 查"这个文件的语言服务环境"：有没有可用服务 / 往上有没有项目配置 / 没有的话该往哪写。
  // 编辑器拿它把"为什么补全很弱"说明白，并给一键生成配置一个落点。
  ipc.handle(IPC.WORKBENCH_LSP_ENV, async (_event, payload: unknown) => {
    const input = payload as { sessionId?: unknown; path?: unknown } | null;
    if (typeof input?.path !== "string" || !input.path.trim()) throw new Error("缺少文件路径");
    const sessionId = requireSessionId(input?.sessionId);
    const root = deps.getWorkspaceRoot(sessionId);
    if (!root) return null;
    const absolutePath = resolveInsideWorkspace(root, input.path);
    const binding = await bindingFor(sessionId, absolutePath);
    const lookup = findProjectConfig(path.dirname(absolutePath), root);
    // 写配置复用既有的 workbench:file-write（只收工作区内相对路径），这里先把相对路径算好
    const relativeRoot = path.relative(root, lookup.projectRoot).split(path.sep).join("/");
    return {
      hasService: Boolean(binding),
      configFile: lookup.configFile,
      projectRoot: lookup.projectRoot,
      configRelativePath: relativeRoot ? `${relativeRoot}/tsconfig.json` : "tsconfig.json",
      // 内容由主进程给：渲染端只负责"给你看 + 你确认后写入"，两边不重复实现一份
      recommendedConfig: buildRecommendedTsconfig(),
    };
  });

  // 编辑器主动提问：补全 / 悬停 / 跳转 / 查引用。
  // 与 SYNC 共用同一个绑定，所以问的是"编辑器里现在这份内容"，而不是磁盘上的旧版本；
  // 拿不到语言服务（返回 null）时编辑器静默降级，只是弹不出补全。
  ipc.handle(IPC.WORKBENCH_LSP_REQUEST, async (_event, payload: unknown) => {
    const input = payload as
      | { sessionId?: unknown; path?: unknown; method?: unknown; position?: unknown; includeDeclaration?: unknown }
      | null;
    if (typeof input?.path !== "string" || !input.path.trim()) throw new Error("缺少文件路径");
    const method = input?.method;
    if (method !== "completion" && method !== "hover" && method !== "definition" && method !== "references") {
      throw new Error("不支持的语言服务请求");
    }
    const position = input?.position as { line?: unknown; character?: unknown } | undefined;
    // 位置必须是**非负安全整数**：负值 / 小数 / 超范围都是非法输入，别原样转给语言服务
    if (!isNonNegativeInt(position?.line) || !isNonNegativeInt(position?.character)) {
      throw new Error("缺少位置信息");
    }
    const sessionId = requireSessionId(input?.sessionId);
    const root = deps.getWorkspaceRoot(sessionId);
    if (!root) return null;
    const absolutePath = resolveInsideWorkspace(root, input.path);
    const binding = await bindingFor(sessionId, absolutePath);
    if (!binding) return null;
    const raw = await binding.client.request(
      lspMethodFor(method),
      buildLspRequestParams({
        method,
        absolutePath,
        position: { line: position.line, character: position.character },
        includeDeclaration: typeof input?.includeDeclaration === "boolean" ? input.includeDeclaration : undefined,
      }),
      REQUEST_TIMEOUT_MS,
    );
    return normalizeLspResult(method, raw, binding.root);
  });

  return {
    dispose: () => {
      for (const sessionId of [...bindings.keys()]) releaseSession(sessionId);
    },
  };
}
