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
import { LspInstallCancelledError, type LspServerInstaller } from "./server-installer";
import type { LspEditorSupport, LspManager } from "./manager";

/** 补全首次触发要等语言服务把项目索引建起来，比诊断宽松得多 */
const REQUEST_TIMEOUT_MS = 15_000;

interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: any[]) => unknown): void;
}

export interface WorkbenchLspBridgeDeps {
  lsp: Pick<LspManager, "acquireEditorClient" | "describeServerFor">;
  /** 应用内安装语言服务的能力；不传就不注册安装相关的 IPC（测试/无托管场景） */
  installer?: Pick<LspServerInstaller, "getPackage" | "isInstalling" | "install" | "cancel">;
  ipc?: IpcScope;
  ipcMain?: IpcMainLike;
  /** 取会话绑定的工作区根；与文件读写同源，保证语言服务看到的目录和用户选的一致 */
  getWorkspaceRoot: (sessionId: string) => string | undefined;
  /** 把诊断推给渲染端 */
  publishDiagnostics: (payload: { sessionId: string; path: string; diagnostics: unknown[] }) => void;
}

/**
 * 一条绑定 = 会话 × 工作区 × **一台语言服务**。
 *
 * 为什么 key 里必须有 serverId：工作台现在同时支持多种语言（TS / Python / Go…），
 * 同一个会话里可能既有 `.ts` 又有 `.py`，它们要的是**不同的语言服务进程**。
 * 早期只有 TS/JS 时"一个会话一条绑定"够用；多语言之后必须按服务分开，否则
 * 先开 `.ts`（绑定到 tsserver）再开 `.py` 会复用同一个 client —— Python 的
 * 补全/跳转被问到 TS 服务上（结果要么空、要么毫不相关），pyright 永远起不来，
 * 而 `hasService` 还会误报 true，界面连"没装服务"都不提示。
 */
interface SessionBinding {
  root: string;
  serverId: string;
  client: LspEditorSupport;
  unsubscribe: () => void;
}

/** 绑定 key：会话 + 工作区根 + 语言服务 id（三者任一变化都是另一条绑定） */
function bindingKey(sessionId: string, root: string, serverId: string): string {
  return `${sessionId}\u0000${root}\u0000${serverId}`;
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
  /** 正在建立中的绑定（key 见 bindingKey）：把并发请求收敛成一次建立，见 bindingFor */
  const pendingBindings = new Map<string, Promise<SessionBinding | null>>();

  const releaseBinding = (key: string): void => {
    const binding = bindings.get(key);
    if (!binding) return;
    bindings.delete(key);
    binding.unsubscribe();
  };

  /**
   * 取（必要时建立）"这个文件该用的那台语言服务"的客户端；拿不到就返回 null 让调用方降级。
   *
   * 并发的两条 sync 可能同时走到这里（那时都还没绑定），各自 await 之后各自 subscribe，
   * 后写的覆盖 bindings → 前一个退订函数就此丢失 → 同一条诊断被推两次。
   * 所以给"建立中"也建一张表，后来的请求直接复用同一次建立过程。
   * key 里必须带 root 与 serverId：换工作区、换语言，都不能复用一个进行中的建立过程。
   */
  const bindingFor = async (sessionId: string, absolutePath: string): Promise<SessionBinding | null> => {
    const root = deps.getWorkspaceRoot(sessionId);
    if (!root) return null;
    // 先问"这个文件理论上该用哪台服务"：没有对应服务（.md/.css 等）就不必去找客户端。
    // 这也保证了"用哪条绑定"和"真正启动哪台服务"用的是同一份候选列表。
    const support = deps.lsp.describeServerFor(absolutePath);
    if (!support) return null;

    const key = bindingKey(sessionId, root, support.serverId);
    const existing = bindings.get(key);
    if (existing) return existing;
    const inflight = pendingBindings.get(key);
    if (inflight) return inflight;

    const task = (async (): Promise<SessionBinding | null> => {
      // 工作区被换掉：同一会话里属于"别的根"的绑定都要作废，
      // 否则会把新工作区的文件发给上一个工作区的语言服务
      // （多语言下每个根还会各有多条绑定，所以按 root 逐条挑，而不是"一条就够"）
      for (const staleKey of [...bindings.keys()]) {
        const stale = bindings.get(staleKey);
        if (stale && staleKey.startsWith(`${sessionId}\u0000`) && stale.root !== root) releaseBinding(staleKey);
      }
      const client = await deps.lsp.acquireEditorClient(root, absolutePath);
      if (!client) return null;
      const unsubscribe = client.onDiagnostics((filePath, diagnostics) => {
        deps.publishDiagnostics({ sessionId, path: relativeToRoot(root, filePath), diagnostics });
      });
      const binding: SessionBinding = { root, serverId: support.serverId, client, unsubscribe };
      bindings.set(key, binding);
      return binding;
    })().finally(() => {
      pendingBindings.delete(key);
    });

    pendingBindings.set(key, task);
    return task;
  };

  /** 只查已建立的绑定、不新建：关闭文档时用（那时不该为了关一个文档去起一台服务） */
  const existingBindingFor = (sessionId: string, absolutePath: string): SessionBinding | null => {
    const root = deps.getWorkspaceRoot(sessionId);
    if (!root) return null;
    const support = deps.lsp.describeServerFor(absolutePath);
    if (!support) return null;
    return bindings.get(bindingKey(sessionId, root, support.serverId)) ?? null;
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
    const root = deps.getWorkspaceRoot(sessionId);
    if (!root) return false;
    const absolutePath = resolveInsideWorkspace(root, input.path);
    // 关文档不新建绑定：文件可能已经不在标签里，为它起一台服务没有意义
    const binding = existingBindingFor(sessionId, absolutePath);
    if (!binding) return false;
    await binding.client.closeFromEditor(absolutePath);
    return true;
  });

  // 查"这个文件的语言服务环境"：这类文件有没有对应语言服务 / 有没有可用服务 /
  // 往上有没有项目配置 / 没有的话该往哪写。编辑器拿它把"为什么补全很弱"说明白，
  // 并给"一键生成配置 / 安装哪个服务"一个落点。
  ipc.handle(IPC.WORKBENCH_LSP_ENV, async (_event, payload: unknown) => {
    const input = payload as { sessionId?: unknown; path?: unknown } | null;
    if (typeof input?.path !== "string" || !input.path.trim()) throw new Error("缺少文件路径");
    const sessionId = requireSessionId(input?.sessionId);
    const root = deps.getWorkspaceRoot(sessionId);
    if (!root) return null;
    const absolutePath = resolveInsideWorkspace(root, input.path);
    // 先看"理论上该用哪个服务"：返回 null 表示这类文件不在语义补全覆盖范围内
    // （.md/.css 等），编辑器据此完全不提示——不然会变成到处都在报"缺语言服务"
    const support = deps.lsp.describeServerFor(absolutePath);
    const binding = support ? await bindingFor(sessionId, absolutePath) : null;
    const lookup = findProjectConfig(path.dirname(absolutePath), root);
    // 写配置复用既有的 workbench:file-write（只收工作区内相对路径），这里先把相对路径算好
    const relativeRoot = path.relative(root, lookup.projectRoot).split(path.sep).join("/");
    // 没装时优先给"一键下载"；清单里没有这个服务（拖外部运行时的那几种）才退回文字指引
    const managed = support && deps.installer ? deps.installer.getPackage(support.serverId) : null;
    return {
      hasService: Boolean(binding),
      serverId: support?.serverId ?? null,
      installHint: support?.installHint ?? null,
      install: managed && deps.installer
        ? {
            installing: deps.installer.isInstalling(managed.serverId),
            version: managed.version,
            sizeBytes: managed.installBytes,
          }
        : null,
      configFile: lookup.configFile,
      projectRoot: lookup.projectRoot,
      configRelativePath: relativeRoot ? `${relativeRoot}/tsconfig.json` : "tsconfig.json",
      // 内容由主进程给：渲染端只负责"给你看 + 你确认后写入"，两边不重复实现一份
      recommendedConfig: buildRecommendedTsconfig(),
    };
  });

  // 在工作台里下载并安装语言服务（只认清单里钉死版本的包，见 server-installer）。
  // 进度走 WORKBENCH_LSP_INSTALL_PROGRESS 广播；这里等到装完才返回。
  // 失败与"用户取消"都做成返回值而不是抛异常：渲染端要区别对待（取消不该报错），
  // 靠解析异常字符串来判断太脆。
  if (deps.installer) {
    const installer = deps.installer;
    ipc.handle(IPC.WORKBENCH_LSP_INSTALL, async (_event, payload: unknown) => {
      const input = payload as { serverId?: unknown } | null;
      const serverId = typeof input?.serverId === "string" ? input.serverId : "";
      if (!installer.getPackage(serverId)) return { ok: false, cancelled: false, error: "这个语言服务不支持应用内安装" };
      try {
        const info = await installer.install(serverId);
        // 只回渲染端需要的字段：入口绝对路径不该跨进程暴露
        return { ok: true, serverId: info.serverId, version: info.version };
      } catch (error) {
        if (error instanceof LspInstallCancelledError) return { ok: false, cancelled: true };
        return { ok: false, cancelled: false, error: error instanceof Error ? error.message : String(error) };
      }
    });

    ipc.handle(IPC.WORKBENCH_LSP_INSTALL_CANCEL, async (_event, payload: unknown) => {
      const input = payload as { serverId?: unknown } | null;
      const serverId = typeof input?.serverId === "string" ? input.serverId : "";
      return installer.cancel(serverId);
    });
  }

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
      // 多语言下一个会话会有多条绑定（每种语言一条），所以逐条释放
      for (const key of [...bindings.keys()]) releaseBinding(key);
    },
  };
}
