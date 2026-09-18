import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import {
  createMessageConnection,
  type MessageConnection,
} from "vscode-jsonrpc/node";
import type { Diagnostic } from "vscode-languageserver-types";
import type { ResolvedLspServer } from "./server-discovery";

const INITIALIZE_TIMEOUT_MS = 45_000;

export interface LspChildProcess {
  stdin: NodeJS.WritableStream | null;
  stdout: NodeJS.ReadableStream | null;
  stderr?: NodeJS.ReadableStream | null;
  on(event: "error" | "exit", listener: (...args: any[]) => void): unknown;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export interface LspClientOptions {
  server: ResolvedLspServer;
  workspaceRoot: string;
  spawnImpl?: (command: string, args: string[], options: { cwd: string; shell: false; windowsHide: true; stdio: ["pipe", "pipe", "pipe"]; env?: NodeJS.ProcessEnv }) => LspChildProcess;
}

interface OpenDocument {
  uri: string;
  version: number;
  content: string;
  /** 内容来源：editor = 工作台编辑器同步的（可能含未保存改动）；disk = AI 工具按磁盘读的 */
  source: "editor" | "disk";
}

function defaultSpawn(
  command: string,
  args: string[],
  options: { cwd: string; shell: false; windowsHide: true; stdio: ["pipe", "pipe", "pipe"]; env?: NodeJS.ProcessEnv },
): LspChildProcess {
  return spawn(command, args, options) as unknown as LspChildProcess;
}

export interface LspLaunchTarget {
  command: string;
  args: string[];
  /**
   * 子进程要额外附加的环境变量。
   * Electron 主进程里 process.execPath 是 electron(.exe)：直接拿它跑一个 .mjs 不会执行脚本，
   * 而是被当成"启动一个新应用"（实测无任何输出）。必须带 ELECTRON_RUN_AS_NODE=1，
   * 这是 Electron 官方的纯 Node 模式开关，加上它行为才等价于 node。
   */
  env?: Record<string, string>;
}

/**
 * 从 npm 在 Windows 生成的命令壳（`.cmd` / `.bat`）里解析出真正的 JS 入口。
 * 壳的收尾一行很稳定，形如：
 *   ... & "%_prog%"  "%dp0%\..\typescript-language-server\lib\cli.mjs" %*
 */
function readNpmShimEntry(shimPath: string): string | null {
  let content: string;
  try {
    content = fs.readFileSync(shimPath, "utf8");
  } catch {
    return null;
  }
  // 捕获组要连 `..\` 一起带上，交给 path.resolve 去归一
  const match = content.match(/"%dp0%\\([^"]+?\.(?:mjs|cjs|js))"/i);
  if (!match) return null;
  const resolved = path.resolve(path.dirname(shimPath), match[1].replace(/\\/g, path.sep));
  return fs.existsSync(resolved) ? resolved : null;
}

/**
 * 打包后（asar）的路径要换回真实磁盘路径。
 * 语言服务是交给 **node 子进程**跑的，而子进程不认识 asar 虚拟路径——
 * 与 srt-win 踩过的是同一个坑（见 sandbox-exec 的 toUnpackedSrtWinPath）。
 * 开发模式下路径里没有 app.asar，这里是 no-op。
 */
function toRealDiskPath(target: string): string {
  const marker = `${path.sep}app.asar${path.sep}`;
  return target.includes(marker) ? target.replace(marker, `${path.sep}app.asar.unpacked${path.sep}`) : target;
}

/**
 * 计算实际要 spawn 的命令。Windows 上三个坑叠在一起：
 * 1. npm 装的 CLI 是 `.cmd` 壳，Node 20+ 出于安全不再允许直接 spawn（EINVAL）；
 * 2. 改用 `shell: true` 后，路径里的空格会被 cmd 拆断（本项目路径就含空格与中文）；
 * 3. 壳里最终用 node 跑一个 JS 入口，而 Electron 主进程的 execPath 是 electron(.exe)，
 *    拿它跑脚本会被当成"启动一个新应用"，脚本根本不执行（实测无输出）。
 * 所以这里把壳里的 JS 入口解析出来直接用 execPath 跑，并按需补上纯 Node 模式的环境变量。
 * 非 Windows、或 `.exe` 这类本就可直接执行的目标，一律原样返回。
 */
export function resolveLaunchTarget(
  executablePath: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
  execPath: string = process.execPath,
  isElectron = Boolean(process.versions?.electron),
): LspLaunchTarget {
  if (platform !== "win32" || !/\.(cmd|bat)$/i.test(executablePath)) {
    return { command: executablePath, args: [...args] };
  }
  const entry = readNpmShimEntry(executablePath);
  if (!entry) {
    // 解析不出 JS 入口还硬 spawn，Windows 上必然 EINVAL，报错比这里更难懂；
    // 宁可在这里说清楚"这个壳不是 npm 生成的标准格式"
    throw new Error(`无法解析语言服务的启动壳：${executablePath}（不是 npm 生成的 .cmd/.bat 格式）`);
  }
  return {
    command: execPath,
    args: [toRealDiskPath(entry), ...args],
    ...(isElectron ? { env: { ELECTRON_RUN_AS_NODE: "1" } } : {}),
  };
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number, message: string, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) return Promise.reject(abortError());
  let timer: ReturnType<typeof setTimeout> | undefined;
  let removeAbortListener: (() => void) | undefined;
  return Promise.race([
    operation,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
    new Promise<T>((_, reject) => {
      if (!signal) return;
      const onAbort = () => reject(abortError());
      signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => signal.removeEventListener("abort", onAbort);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
    removeAbortListener?.();
  });
}

function abortError(): Error {
  const error = new Error("LSP request cancelled");
  error.name = "AbortError";
  return error;
}

/** 一个工作区内单个外部 LSP 服务进程的 JSON-RPC 客户端。 */
export class LspClient {
  private readonly spawnImpl: NonNullable<LspClientOptions["spawnImpl"]>;
  private child: LspChildProcess | null = null;
  private connection: MessageConnection | null = null;
  private readonly documents = new Map<string, OpenDocument>();
  private readonly diagnostics = new Map<string, Diagnostic[]>();
  private readonly diagnosticsListeners = new Set<(filePath: string, diagnostics: Diagnostic[]) => void>();
  private initialized = false;
  private disposed = false;
  /** 进行中的初始化：把并发调用收敛成一次 spawn，见 initialize */
  private initPromise: Promise<void> | null = null;

  constructor(private readonly options: LspClientOptions) {
    this.spawnImpl = options.spawnImpl ?? defaultSpawn;
  }

  /**
   * 初始化（幂等，且**并发安全**）。
   * AI 的 lsp 工具与工作台编辑器共用同一个 client，两边可能同时进这里；
   * 光靠 `initialized` 标志挡不住——它要等服务端的 initialize 响应回来才置位，
   * 中间那段窗口两个调用都过得去，结果 spawn 出两个语言服务进程、前一个没人收尸。
   * 所以用一条"进行中的 Promise"兜住，后来者复用它。
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.disposed) throw new Error("LSP client has been disposed");
    if (!this.initPromise) {
      this.initPromise = this.doInitialize().catch((cause: unknown) => {
        // 失败要允许下次重试：否则一次启动抖动就把这个 client 永久废掉了
        this.initPromise = null;
        throw cause;
      });
    }
    return this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    const launch = resolveLaunchTarget(this.options.server.executablePath, this.options.server.args);
    let child: LspChildProcess;
    try {
      child = this.spawnImpl(launch.command, launch.args, {
        cwd: this.options.workspaceRoot,
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        // Electron 下必须带上纯 Node 模式变量，否则 execPath 只会把脚本当成新应用启动
        ...(launch.env ? { env: { ...process.env, ...launch.env } } : {}),
      });
    } catch (cause) {
      // spawn 失败是同步抛出的（例如 Windows 上直接跑 .cmd 得到的 EINVAL），
      // 原始信息只有一句 "spawn EINVAL"，这里补上服务名与实际命令才便于排查
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`无法启动语言服务 ${this.options.server.definition.id}（${launch.command}）：${detail}`);
    }
    if (!child.stdin || !child.stdout) throw new Error("LSP server did not expose stdio pipes");
    // 语言服务进程意外退出后，再往管道里写会 EPIPE；没有 error 监听的话
    // 这会变成未处理错误（Node 15+ 默认直接终止进程），把整个应用带崩。
    // 这里吞掉管道错误，交给下面的 exit 回调去标记"未初始化"。
    child.stdin.on("error", () => undefined);
    child.stdout.on("error", () => undefined);

    const connection = createMessageConnection(child.stdout, child.stdin);
    connection.onNotification("textDocument/publishDiagnostics", (params: { uri?: string; diagnostics?: Diagnostic[] }) => {
      if (typeof params?.uri !== "string") return;
      const items = [...(params.diagnostics ?? [])];
      this.diagnostics.set(params.uri, items);
      this.emitDiagnostics(params.uri, items);
    });
    // 配置项必须与请求等长地回一个对象；返回空数组会让服务端拿不到任何配置项
    connection.onRequest("workspace/configuration", (params: { items?: unknown[] } | undefined) =>
      (params?.items ?? []).map(() => ({})),
    );
    connection.onRequest("client/registerCapability", () => null);
    connection.onRequest("window/workDoneProgress/create", () => null);
    connection.listen();

    child.on("exit", () => {
      if (!this.disposed) this.initialized = false;
    });
    child.on("error", () => {
      if (!this.disposed) this.initialized = false;
    });

    this.child = child;
    this.connection = connection;
    const rootUri = pathToFileURL(this.options.workspaceRoot).toString();
    await withTimeout(
      connection.sendRequest("initialize", {
        processId: process.pid,
        rootUri,
        workspaceFolders: [{ uri: rootUri, name: path.basename(this.options.workspaceRoot) }],
        // 必须显式声明 textDocument.publishDiagnostics：typescript-language-server
        // 用它判断要不要推诊断（源码里是 diagnosticsSupport = Boolean(publishDiagnostics)）。
        // 此前这里是空对象，导致 publishDiagnostics 一次都不来、getDiagnostics 永远为空。
        capabilities: {
          workspace: { configuration: true },
          textDocument: {
            synchronization: { dynamicRegistration: false },
            publishDiagnostics: { relatedInformation: true, tagSupport: { valueSet: [1, 2] }, versionSupport: true },
            hover: { contentFormat: ["markdown", "plaintext"] },
          },
        },
        initializationOptions: this.options.server.definition.initializationOptions,
      }),
      INITIALIZE_TIMEOUT_MS,
      "LSP_INITIALIZE_TIMEOUT",
    );
    connection.sendNotification("initialized", {});
    this.initialized = true;
  }

  async touchFile(filePath: string, languageId: string): Promise<void> {
    await this.initialize();
    const connection = this.requireConnection();
    const absolutePath = path.resolve(filePath);
    const content = fs.readFileSync(absolutePath, "utf8");
    const uri = pathToFileURL(absolutePath).toString();
    const existing = this.documents.get(uri);
    // 编辑器正开着这个文件（内容可能含未保存改动）：绝不能用磁盘内容把它覆盖掉
    if (existing?.source === "editor") return;
    if (!existing) {
      this.documents.set(uri, { uri, version: 1, content, source: "disk" });
      connection.sendNotification("textDocument/didOpen", {
        textDocument: { uri, languageId, version: 1, text: content },
      });
      return;
    }
    if (existing.content === content) return;
    const version = existing.version + 1;
    this.documents.set(uri, { uri, version, content, source: "disk" });
    connection.sendNotification("textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges: [{ text: content }],
    });
  }

  /**
   * 工作台编辑器同步文档内容。与 touchFile 的差别是内容由调用方给出、不读磁盘：
   * 编辑器里的内容可能还没保存，语言服务必须看到眼前这一份，否则诊断和用户看到的对不上。
   */
  async syncFromEditor(filePath: string, languageId: string, content: string): Promise<void> {
    await this.initialize();
    const connection = this.requireConnection();
    const uri = pathToFileURL(path.resolve(filePath)).toString();
    const existing = this.documents.get(uri);
    if (!existing) {
      this.documents.set(uri, { uri, version: 1, content, source: "editor" });
      connection.sendNotification("textDocument/didOpen", {
        textDocument: { uri, languageId, version: 1, text: content },
      });
      return;
    }
    if (existing.source === "editor" && existing.content === content) return;
    const version = existing.version + 1;
    this.documents.set(uri, { uri, version, content, source: "editor" });
    connection.sendNotification("textDocument/didChange", {
      textDocument: { uri, version },
      // 全量同步：编辑器一次改动可能牵连多处，算增量既不划算也不稳
      contentChanges: [{ text: content }],
    });
  }

  /** 编辑器关掉文件：不注销的话服务端会一直按旧内容算诊断 */
  async closeFromEditor(filePath: string): Promise<void> {
    const uri = pathToFileURL(path.resolve(filePath)).toString();
    const existing = this.documents.get(uri);
    if (!existing || existing.source !== "editor") return;
    this.documents.delete(uri);
    this.diagnostics.delete(uri);
    if (!this.connection || !this.initialized) return;
    this.connection.sendNotification("textDocument/didClose", { textDocument: { uri } });
  }

  /** 订阅诊断推送；返回取消订阅函数 */
  onDiagnostics(listener: (filePath: string, diagnostics: Diagnostic[]) => void): () => void {
    this.diagnosticsListeners.add(listener);
    return () => {
      this.diagnosticsListeners.delete(listener);
    };
  }

  private emitDiagnostics(uri: string, diagnostics: Diagnostic[]): void {
    if (this.diagnosticsListeners.size === 0) return;
    let filePath: string;
    try {
      filePath = fileURLToPath(uri);
    } catch {
      return;
    }
    for (const listener of [...this.diagnosticsListeners]) {
      try {
        listener(filePath, diagnostics);
      } catch {
        // 订阅方自己的异常不能影响 LSP 连接
      }
    }
  }

  async request<T>(method: string, params: unknown, timeoutMs = 10_000, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw abortError();
    await this.initialize();
    return withTimeout(this.requireConnection().sendRequest(method, params), timeoutMs, "LSP_REQUEST_TIMEOUT", signal) as Promise<T>;
  }

  getDiagnostics(filePath: string): Diagnostic[] {
    return [...(this.diagnostics.get(pathToFileURL(path.resolve(filePath)).toString()) ?? [])];
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    try {
      if (this.connection && this.initialized) {
        await withTimeout(this.connection.sendRequest("shutdown"), 2_000, "LSP shutdown timeout");
        this.connection.sendNotification("exit");
      }
    } catch {
      // 进程已退出时仍应继续释放本地资源。
    } finally {
      // exit 通知是异步写出的：紧接着 dispose 连接会把还没落地的帧打断，
      // jsonrpc 会在已销毁的流上继续写，抛出**未处理**的 ERR_STREAM_DESTROYED
      // （测试里表现为 vitest 报 unhandled error 而失败）。给一个极短窗口让它写完。
      await new Promise((resolve) => setTimeout(resolve, 50));
      this.connection?.dispose();
      this.child?.kill();
      this.connection = null;
      this.child = null;
      this.initialized = false;
      this.initPromise = null;
    }
  }

  private requireConnection(): MessageConnection {
    if (!this.connection) throw new Error("LSP server is not initialized");
    return this.connection;
  }
}
