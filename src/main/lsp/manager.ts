import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { LspClient } from "./client";
import { BUILTIN_LSP_SERVERS, findServerCandidates } from "./server-catalog";
import { resolveLspServer, type ResolvedLspServer } from "./server-discovery";
import { LspContractError, toProtocolPosition, type LspQuery, type LspServerOverride, type LspToolResult } from "./types";
import type { Diagnostic } from "vscode-languageserver-types";

export interface LspClientLike {
  initialize(): Promise<void>;
  touchFile(filePath: string, languageId: string): Promise<void>;
  request(method: string, params: unknown, timeoutMs?: number, signal?: AbortSignal): Promise<unknown>;
  getDiagnostics(filePath: string): unknown[];
  dispose(): Promise<void>;
}

/**
 * 工作台编辑器需要的能力。单列一个接口而不是扩展 LspClientLike：
 * LspClientLike 是给 AI 工具链用的最小契约，让它背上编辑器的方法会逼着所有替身一起实现。
 */
export interface LspEditorSupport {
  syncFromEditor(filePath: string, languageId: string, content: string): Promise<void>;
  closeFromEditor(filePath: string): Promise<void>;
  onDiagnostics(listener: (filePath: string, diagnostics: Diagnostic[]) => void): () => void;
  /** 编辑器主动提问（补全/悬停/跳转/查引用）：返回语言服务的原始结果，形状由调用方拍平 */
  request<T = unknown>(method: string, params: unknown, timeoutMs?: number): Promise<T>;
}

function asEditorSupport(client: LspClientLike): LspEditorSupport | null {
  const candidate = client as Partial<LspEditorSupport>;
  const supported =
    typeof candidate.syncFromEditor === "function" &&
    typeof candidate.closeFromEditor === "function" &&
    typeof candidate.onDiagnostics === "function" &&
    typeof candidate.request === "function";
  return supported ? (candidate as LspEditorSupport) : null;
}

export interface LspManagerOptions {
  resolveServer?: (definition: ResolvedLspServer["definition"], workspaceRoot: string) => ResolvedLspServer | null;
  createClient?: (input: { server: ResolvedLspServer; workspaceRoot: string }) => LspClientLike;
  /** 从设置缓存读取；每次执行重新取值，用户保存配置后无需重启。 */
  getServerOverrides?: () => readonly LspServerOverride[];
}

export interface LspExecutionContext {
  resolvedWorkspaceRoot?: string;
  signal?: AbortSignal;
}

function languageIdFor(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  if ([".ts", ".tsx"].includes(extension)) return "typescript";
  if ([".js", ".jsx", ".mjs", ".cjs"].includes(extension)) return "javascript";
  if (extension === ".py") return "python";
  if (extension === ".go") return "go";
  if (extension === ".rs") return "rust";
  if ([".c", ".cc", ".cpp", ".cxx", ".h", ".hpp"].includes(extension)) return "cpp";
  return extension.slice(1) || "plaintext";
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function fileParams(filePath: string, query: LspQuery): { textDocument: { uri: string }; position: { line: number; character: number } } {
  if (query.line === undefined || query.character === undefined) {
    throw new LspContractError("LSP_POSITION_INVALID", "该操作需要 line 和 character");
  }
  return {
    textDocument: { uri: pathToFileURL(filePath).toString() },
    position: toProtocolPosition({ line: query.line, character: query.character }),
  };
}

/** 复用同一可信工作区中同一外部语言服务进程的管理器。 */
export class LspManager {
  private readonly clients = new Map<string, LspClientLike>();
  private readonly resolveServer: NonNullable<LspManagerOptions["resolveServer"]>;
  private readonly createClient: NonNullable<LspManagerOptions["createClient"]>;
  private readonly getServerOverrides: NonNullable<LspManagerOptions["getServerOverrides"]>;

  constructor(options: LspManagerOptions = {}) {
    this.resolveServer = options.resolveServer ?? resolveLspServer;
    this.createClient = options.createClient ?? ((input) => new LspClient(input));
    this.getServerOverrides = options.getServerOverrides ?? (() => []);
  }

  async execute(query: LspQuery, context: LspExecutionContext): Promise<LspToolResult> {
    if (!context.resolvedWorkspaceRoot) throw new LspContractError("LSP_WORKSPACE_REQUIRED", "Code 模式需要绑定可信工作目录");
    const workspaceRoot = fs.realpathSync(context.resolvedWorkspaceRoot);
    const filePath = query.filePath ? this.resolveWorkspaceFile(workspaceRoot, query.filePath) : undefined;
    const { client, serverId } = await this.clientFor(workspaceRoot, filePath);

    if (filePath && query.operation !== "workspaceSymbol") {
      await client.touchFile(filePath, languageIdFor(filePath));
    }

    let value: unknown;
    switch (query.operation) {
      case "goToDefinition": value = await this.request(client, "textDocument/definition", fileParams(filePath!, query), context.signal); break;
      case "findReferences": value = await this.request(client, "textDocument/references", { ...fileParams(filePath!, query), context: { includeDeclaration: true } }, context.signal); break;
      case "hover": value = await this.request(client, "textDocument/hover", fileParams(filePath!, query), context.signal); break;
      case "documentSymbol": value = await this.request(client, "textDocument/documentSymbol", { textDocument: { uri: pathToFileURL(filePath!).toString() } }, context.signal); break;
      case "workspaceSymbol": value = await this.request(client, "workspace/symbol", { query: query.query ?? "" }, context.signal); break;
      case "goToImplementation": value = await this.request(client, "textDocument/implementation", fileParams(filePath!, query), context.signal); break;
      case "diagnostics": value = client.getDiagnostics(filePath!); break;
      case "prepareCallHierarchy": value = await this.request(client, "textDocument/prepareCallHierarchy", fileParams(filePath!, query), context.signal); break;
      case "incomingCalls":
        value = await this.request(client, "callHierarchy/incomingCalls", { item: this.callHierarchyItem(query) }, context.signal); break;
      case "outgoingCalls":
        value = await this.request(client, "callHierarchy/outgoingCalls", { item: this.callHierarchyItem(query) }, context.signal); break;
      default: throw new LspContractError("LSP_UNSUPPORTED_OPERATION");
    }

    const items = Array.isArray(value) ? value : value == null ? [] : [value];
    return { serverId, operation: query.operation, workspaceRoot, items, message: items.length > 0 ? "已获得语言服务结果。" : "语言服务未返回结果。" };
  }

  /**
   * 工作台编辑器取语言服务客户端。与 AI 工具链共用同一个 client（同一工作区同一服务只跑一个进程）。
   * 找不到服务、工作区无效、或 client 不具备编辑器能力时返回 null——
   * 工作台据此降级为"没有诊断"，不影响编辑本身。
   */
  async acquireEditorClient(workspaceRoot: string, filePath: string): Promise<LspEditorSupport | null> {
    let root: string;
    try {
      root = fs.realpathSync(workspaceRoot);
    } catch {
      return null;
    }
    try {
      const { client } = await this.clientFor(root, filePath);
      return asEditorSupport(client);
    } catch {
      return null;
    }
  }

  async releaseWorkspace(workspaceRoot: string): Promise<void> {
    const canonical = fs.realpathSync(workspaceRoot);
    const entries = [...this.clients.entries()].filter(([key]) => key.startsWith(`${canonical}\u0000`));
    await Promise.all(entries.map(async ([key, client]) => {
      this.clients.delete(key);
      await client.dispose();
    }));
  }

  async disposeAll(): Promise<void> {
    const clients = [...this.clients.values()];
    this.clients.clear();
    await Promise.all(clients.map((client) => client.dispose()));
  }

  private resolveWorkspaceFile(workspaceRoot: string, requestedPath: string): string {
    const absolute = path.resolve(workspaceRoot, requestedPath);
    if (!isInside(workspaceRoot, absolute)) throw new LspContractError("LSP_PATH_OUTSIDE_WORKSPACE", "文件路径不在绑定工作目录内");
    if (!fs.existsSync(absolute)) throw new LspContractError("LSP_FILE_NOT_FOUND", "找不到请求的文件");
    const realPath = fs.realpathSync(absolute);
    if (!isInside(workspaceRoot, realPath)) throw new LspContractError("LSP_PATH_OUTSIDE_WORKSPACE", "文件真实路径不在绑定工作目录内");
    return realPath;
  }

  private async clientFor(workspaceRoot: string, filePath?: string): Promise<{ client: LspClientLike; serverId: string }> {
    const overrides = this.getServerOverrides();
    const candidates = filePath ? findServerCandidates(filePath, overrides) : [...BUILTIN_LSP_SERVERS];
    for (const definition of candidates) {
      const server = this.resolveServer(definition, workspaceRoot);
      if (!server) continue;
      const key = `${workspaceRoot}\u0000${server.definition.id}\u0000${server.executablePath}`;
      let client = this.clients.get(key);
      if (!client) {
        client = this.createClient({ server, workspaceRoot });
        this.clients.set(key, client);
      }
      await client.initialize();
      return { client, serverId: server.definition.id };
    }
    throw new LspContractError("LSP_SERVER_NOT_FOUND", "没有找到可用的语言服务；请按提示安装或配置对应服务。");
  }

  private callHierarchyItem(query: LspQuery): Record<string, unknown> {
    if (!query.item || Array.isArray(query.item) || Object.keys(query.item).length === 0) {
      throw new LspContractError("LSP_UNSUPPORTED_OPERATION", "调用层级后续查询需要 prepareCallHierarchy 返回的条目");
    }
    return query.item;
  }

  private request(client: LspClientLike, method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    return signal ? client.request(method, params, undefined, signal) : client.request(method, params);
  }
}
