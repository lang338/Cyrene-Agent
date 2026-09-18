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
      return { capabilities: { hoverProvider: true } };
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

  it("keeps the original command when the shim has no node entry", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-lsp-shim-bad-"));
    roots.push(root);
    const shim = path.join(root, "broken.cmd");
    fs.writeFileSync(shim, "@ECHO off\r\nrem nothing useful\r\n", "utf8");

    expect(resolveLaunchTarget(shim, [], "win32", "C:\\node\\node.exe")).toEqual({ command: shim, args: [] });
  });
});
