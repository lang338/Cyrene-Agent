import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { createMessageConnection, type MessageConnection } from "vscode-jsonrpc/node";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LspClient, resolveLaunchTarget, type LspChildProcess } from "./client";
import type { ResolvedLspServer } from "./server-discovery";

const roots: string[] = [];

class FakeLspProcess extends EventEmitter implements LspChildProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn(() => true);
  readonly initialized: unknown[] = [];
  readonly opened: unknown[] = [];
  readonly changed: unknown[] = [];
  readonly closed: unknown[] = [];
  initializeParams: { capabilities?: { textDocument?: Record<string, unknown> } } | null = null;
  private readonly server: MessageConnection;

  constructor() {
    super();
    const server = createMessageConnection(this.stdin, this.stdout);
    this.server = server;
    server.onRequest("initialize", (params: { capabilities?: { textDocument?: Record<string, unknown> } }) => {
      this.initializeParams = params;
      // 与真实服务端一致：声明增量同步（缺失等价于 None，那样就不该发 didChange 了）
      return { capabilities: { hoverProvider: true, textDocumentSync: { change: 2 } } };
    });
    server.onNotification("initialized", (params: unknown) => this.initialized.push(params));
    server.onNotification("textDocument/didOpen", (params: unknown) => this.opened.push(params));
    server.onNotification("textDocument/didChange", (params: unknown) => this.changed.push(params));
    server.onNotification("textDocument/didClose", (params: unknown) => this.closed.push(params));
    server.onRequest("shutdown", () => null);
    server.listen();
  }

  /** 模拟服务端主动推诊断（真实 tls 就是这么发的） */
  publishDiagnostics(filePath: string, diagnostics: unknown[]): void {
    void this.server.sendNotification("textDocument/publishDiagnostics", {
      uri: pathToFileURL(filePath).toString(),
      diagnostics,
    });
  }
}

function resolvedServer(): ResolvedLspServer {
  return {
    definition: {
      id: "fake-lsp",
      extensions: [".ts"],
      commands: [{ command: "fake-lsp", args: ["--stdio"] }],
      rootMarkers: [],
      installHint: "安装 fake-lsp。",
    },
    executablePath: "C:\\tools\\fake-lsp.exe",
    args: ["--stdio"],
  };
}

function createWorkspace(): { root: string; file: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-lsp-client-"));
  roots.push(root);
  const file = path.join(root, "src", "entry.ts");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "export const value = 1;\n", "utf8");
  return { root, file };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("LspClient", () => {
  it("initializes one stdio server and synchronizes disk-backed document changes", async () => {
    const { root, file } = createWorkspace();
    const child = new FakeLspProcess();
    const spawnImpl = vi.fn(() => child);
    const client = new LspClient({ server: resolvedServer(), workspaceRoot: root, spawnImpl });

    await client.initialize();
    await client.touchFile(file, "typescript");
    fs.writeFileSync(file, "export const value = 2;\n", "utf8");
    await client.touchFile(file, "typescript");
    await client.dispose();

    expect(spawnImpl).toHaveBeenCalledWith("C:\\tools\\fake-lsp.exe", ["--stdio"], expect.objectContaining({
      cwd: root,
      shell: false,
      windowsHide: true,
    }));
    expect(child.initialized).toHaveLength(1);
    expect(child.opened).toHaveLength(1);
    expect(child.changed).toHaveLength(1);
    expect(child.kill).toHaveBeenCalled();
    // tls 只按「客户端有没有声明这个能力」决定推不推诊断，缺了 getDiagnostics 永远为空
    expect(child.initializeParams?.capabilities?.textDocument?.publishDiagnostics).toBeDefined();
  });

  it("丢弃迟到的旧同步：修订号更小的那次不能覆盖新内容", async () => {
    const { root, file } = createWorkspace();
    const child = new FakeLspProcess();
    const client = new LspClient({ server: resolvedServer(), workspaceRoot: root, spawnImpl: () => child });

    // 编辑器与防抖同步两条路都会送内容，一次落后的同步若被照单全收，
    // 语言服务就会按旧内容算补全（真机上表现为"刚敲那行拿不到成员补全"）。
    await client.syncFromEditor(file, "typescript", "export const value = 2;\n", 7);
    await client.syncFromEditor(file, "typescript", "export const value = 1;\n", 3); // 迟到的旧同步：应被丢弃
    await client.syncFromEditor(file, "typescript", "export const value = 3;\n", 9); // 更新的：应发出去
    await client.dispose();

    expect(child.opened).toHaveLength(1);
    // 两次变更只放行了一次，且放行的是修订号更大的那次
    expect(child.changed).toHaveLength(1);
    expect(JSON.stringify(child.changed[0])).toContain("value = 3");
  });

  it("rejects a cancelled request without disposing the shared server", async () => {
    const { root } = createWorkspace();
    const child = new FakeLspProcess();
    const client = new LspClient({ server: resolvedServer(), workspaceRoot: root, spawnImpl: () => child });
    const controller = new AbortController();
    controller.abort();

    await expect(client.request("textDocument/hover", {}, 10_000, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("treats editor content as the source of truth and streams diagnostics to subscribers", async () => {
    const { root, file } = createWorkspace();
    const child = new FakeLspProcess();
    const client = new LspClient({ server: resolvedServer(), workspaceRoot: root, spawnImpl: () => child });
    const seen: Array<{ filePath: string; count: number }> = [];
    client.onDiagnostics((filePath, diagnostics) => seen.push({ filePath, count: diagnostics.length }));

    // 编辑器打开文件（磁盘上还是旧内容）
    await client.syncFromEditor(file, "typescript", "export const value = 42;\n");
    // 磁盘被外部改过、编辑器内容又变了：应以编辑器内容为准，且不该重复 didOpen
    fs.writeFileSync(file, "export const value = 999;\n", "utf8");
    await client.syncFromEditor(file, "typescript", "export const value = 43;\n");
    // 通知是异步送达服务端的，断言前先让出一次事件循环
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(child.opened).toHaveLength(1);
    expect(child.changed).toHaveLength(1);

    // AI 工具走的是按磁盘读的老链路，绝不能把编辑器内容顶掉
    await client.touchFile(file, "typescript");
    expect(child.changed).toHaveLength(1);

    child.publishDiagnostics(file, [{ message: "boom" }]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(client.getDiagnostics(file)).toHaveLength(1);
    expect(seen).toEqual([{ filePath: path.normalize(file), count: 1 }]);

    await client.closeFromEditor(file);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(child.closed).toHaveLength(1);
  });

  it("并发调用 initialize 只会拉起一个语言服务进程", async () => {
    const { root } = createWorkspace();
    const child = new FakeLspProcess();
    const spawnImpl = vi.fn(() => child);
    const client = new LspClient({ server: resolvedServer(), workspaceRoot: root, spawnImpl });

    // 昔涟的 lsp 工具与工作台编辑器共用同一个 client，两边可能同时进 initialize
    await Promise.all([client.initialize(), client.initialize(), client.initialize()]);

    expect(spawnImpl).toHaveBeenCalledTimes(1);
    await client.dispose();
  });
});

describe("resolveLaunchTarget", () => {
  it("passes through non-Windows targets and directly executable files", () => {
    expect(resolveLaunchTarget("/usr/bin/tls", ["--stdio"], "linux")).toEqual({ command: "/usr/bin/tls", args: ["--stdio"] });
    expect(resolveLaunchTarget("C:\\tools\\fake-lsp.exe", ["--stdio"], "win32")).toEqual({
      command: "C:\\tools\\fake-lsp.exe",
      args: ["--stdio"],
    });
  });

  it("rewrites an npm cmd shim on Windows into a direct node invocation", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-lsp-shim-"));
    roots.push(root);
    const entry = path.join(root, "node_modules", "typescript-language-server", "lib", "cli.mjs");
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(entry, "// entry\n", "utf8");
    const binDir = path.join(root, "node_modules", ".bin");
    fs.mkdirSync(binDir, { recursive: true });
    const shim = path.join(binDir, "typescript-language-server.cmd");
    // 与 npm 实际生成的壳保持同构：只有最后一行能看出真正的 JS 入口
    fs.writeFileSync(
      shim,
      [
        "@ECHO off",
        "GOTO start",
        ":find_dp0",
        "SET dp0=%~dp0",
        "EXIT /b",
        ":start",
        "SETLOCAL",
        "CALL :find_dp0",
        "endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & \"%_prog%\"  \"%dp0%\\..\\typescript-language-server\\lib\\cli.mjs\" %*",
        "",
      ].join("\r\n"),
      "utf8",
    );

    expect(resolveLaunchTarget(shim, ["--stdio"], "win32", "C:\\node\\node.exe")).toEqual({
      command: "C:\\node\\node.exe",
      args: [entry, "--stdio"],
    });
  });

  it("throws a readable error when the shim has no node entry", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-lsp-shim-bad-"));
    roots.push(root);
    const shim = path.join(root, "broken.cmd");
    fs.writeFileSync(shim, "@ECHO off\r\nrem nothing useful\r\n", "utf8");

    // 解析不出入口还硬 spawn，Windows 上只会得到 EINVAL；不如在这里说清楚
    expect(() => resolveLaunchTarget(shim, [], "win32", "C:\\node\\node.exe")).toThrow(/无法解析语言服务的启动壳/);
  });

  it("打包后把 asar 内的入口换成 asar.unpacked 的真实路径", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-lsp-asar-"));
    roots.push(root);
    const relative = path.join("node_modules", "typescript-language-server", "lib", "cli.mjs");
    const packedEntry = path.join(root, "app.asar", relative);
    const unpackedEntry = path.join(root, "app.asar.unpacked", relative);
    // 模拟 Electron 的 asar 感知 fs：两个路径都"读得到"（真实文件在 unpacked）
    for (const target of [packedEntry, unpackedEntry]) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, "// entry\n", "utf8");
    }
    const shim = path.join(root, "app.asar", "node_modules", ".bin", "typescript-language-server.cmd");
    fs.mkdirSync(path.dirname(shim), { recursive: true });
    fs.writeFileSync(
      shim,
      "@ECHO off\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & \"%_prog%\"  \"%dp0%\\..\\typescript-language-server\\lib\\cli.mjs\" %*\r\n",
      "utf8",
    );

    const target = resolveLaunchTarget(shim, ["--stdio"], "win32", "C:\\app\\electron.exe", true);
    // 子进程（node）不认识 asar 虚拟路径，必须给真实磁盘路径
    expect(target.args[0]).toBe(unpackedEntry);
  });

  it("adds the Node-mode env var only when running under Electron", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-lsp-shim-electron-"));
    roots.push(root);
    const entry = path.join(root, "node_modules", "typescript-language-server", "lib", "cli.mjs");
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(entry, "// entry\n", "utf8");
    const binDir = path.join(root, "node_modules", ".bin");
    fs.mkdirSync(binDir, { recursive: true });
    const shim = path.join(binDir, "typescript-language-server.cmd");
    fs.writeFileSync(
      shim,
      "@ECHO off\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & \"%_prog%\"  \"%dp0%\\..\\typescript-language-server\\lib\\cli.mjs\" %*\r\n",
      "utf8",
    );

    // 纯 node 环境：直接跑脚本即可，不需要额外变量
    expect(resolveLaunchTarget(shim, ["--stdio"], "win32", "C:\\node\\node.exe", false).env).toBeUndefined();
    // Electron：execPath 是 electron.exe，不补这个变量脚本根本不会被执行
    expect(resolveLaunchTarget(shim, ["--stdio"], "win32", "C:\\app\\electron.exe", true)).toEqual({
      command: "C:\\app\\electron.exe",
      args: [entry, "--stdio"],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    });
  });

  it("应用内安装下来的托管副本是裸 JS 文件：所有平台都用 execPath + 纯 Node 模式跑", () => {
    const entry = "C:\\Users\\me\\AppData\\Roaming\\cyrene\\lsp-servers\\python-pyright\\1.1.414\\langserver.index.js";
    // Windows 上直接 spawn 一个 .js 会走文件关联，不能这么干
    expect(resolveLaunchTarget(entry, ["--stdio"], "win32", "C:\\app\\electron.exe", true)).toEqual({
      command: "C:\\app\\electron.exe",
      args: [entry, "--stdio"],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    });
    // 非 Windows 同理（不能靠 shebang）
    expect(resolveLaunchTarget("/home/me/.config/cyrene/lsp-servers/python-pyright/langserver.index.js", ["--stdio"], "linux", "/usr/bin/node", false)).toEqual({
      command: "/usr/bin/node",
      args: ["/home/me/.config/cyrene/lsp-servers/python-pyright/langserver.index.js", "--stdio"],
    });
  });
});
