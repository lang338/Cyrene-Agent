/**
 * 工作台 LSP 桥的行为测试。
 *
 * 两个关注点：
 * 1. 同一条 WORKBENCH_LSP_SYNC 可能被并发触发（编辑器连续同步 + 昔涟的 lsp 工具），
 *    若"建立绑定"这一步不收敛，就会订阅两次诊断（前端重复 setState）、并丢掉一个退订函数；
 * 2. 绑定必须**按语言服务分开**——同一个会话里既有 .ts 又有 .py 时，
 *    它们要的是两台不同的服务进程，复用会让 Python 的请求被问到 tsserver 上。
 */

import { describe, expect, it, vi } from "vitest";
import { IPC } from "../../shared/ipc-channels";
import { registerWorkbenchLspBridge } from "./editor-bridge";
import type { LspEditorSupport } from "./manager";

const TS_SERVER = { serverId: "typescript-language-server", installHint: "安装 tsserver。" };
const PY_SERVER = { serverId: "python-pyright", installHint: "安装 pyright。" };

/** 按扩展名分派语言服务：模拟"工作区里同时有 TS 与 Python" */
const serverByExtension = (filePath: string) => (filePath.endsWith(".py") ? PY_SERVER : TS_SERVER);

interface CapturedHandlers {
  sync?: (event: unknown, payload: unknown) => unknown;
  close?: (event: unknown, payload: unknown) => unknown;
  env?: (event: unknown, payload: unknown) => Promise<unknown>;
}

function fakeIpc(captured: CapturedHandlers) {
  return {
    handle(channel: string, listener: (event: unknown, payload: unknown) => unknown) {
      if (channel === IPC.WORKBENCH_LSP_SYNC) captured.sync = listener;
      if (channel === IPC.WORKBENCH_LSP_CLOSE) captured.close = listener;
      if (channel === IPC.WORKBENCH_LSP_ENV) captured.env = listener as CapturedHandlers["env"];
    },
    removeHandler() {},
    on() {},
    dispose() {},
  };
}

function fakeEditorClient() {
  const listeners = new Set<(filePath: string, diagnostics: unknown[]) => void>();
  const client: LspEditorSupport = {
    syncFromEditor: vi.fn(async () => undefined),
    closeFromEditor: vi.fn(async () => undefined),
    onDiagnostics: vi.fn((listener: (filePath: string, diagnostics: unknown[]) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
  };
  return { client, listeners };
}

describe("工作台 LSP 桥", () => {
  it("并发同步只建立一次绑定（否则同一诊断会被推两遍）", async () => {
    const captured: CapturedHandlers = {};
    const { client, listeners } = fakeEditorClient();
    const acquire = vi.fn(async () => client);

    registerWorkbenchLspBridge({
      lsp: { acquireEditorClient: acquire, describeServerFor: () => TS_SERVER },
      getWorkspaceRoot: () => "D:\\ws",
      publishDiagnostics: vi.fn(),
      ipc: fakeIpc(captured) as never,
    });

    const sync = captured.sync!;
    await Promise.all([
      sync(null, { sessionId: "s1", path: "a.ts", content: "const a = 1;\n", languageId: "typescript" }),
      sync(null, { sessionId: "s1", path: "a.ts", content: "const a = 2;\n", languageId: "typescript" }),
    ]);

    expect(acquire).toHaveBeenCalledTimes(1);
    // 订阅了两次的话，同一条诊断会被推两遍，而且其中一个退订函数已经丢了
    expect(client.onDiagnostics).toHaveBeenCalledTimes(1);
    expect(listeners.size).toBe(1);
  });

  it("越界路径被拒绝，且不会去取语言服务", async () => {
    const captured: CapturedHandlers = {};
    const { client } = fakeEditorClient();
    const acquire = vi.fn(async () => client);

    registerWorkbenchLspBridge({
      lsp: { acquireEditorClient: acquire, describeServerFor: () => TS_SERVER },
      getWorkspaceRoot: () => "D:\\ws",
      publishDiagnostics: vi.fn(),
      ipc: fakeIpc(captured) as never,
    });

    await expect(
      captured.sync!(null, { sessionId: "s1", path: "../outside.ts", content: "x", languageId: "typescript" }),
    ).rejects.toThrow(/不在工作区内/);
    expect(acquire).not.toHaveBeenCalled();
  });

  it("没有对应语言服务的文件类型不查服务、不给安装指引（否则到处都在报缺服务）", async () => {
    const captured: CapturedHandlers = {};
    const acquire = vi.fn(async () => fakeEditorClient().client);

    registerWorkbenchLspBridge({
      lsp: { acquireEditorClient: acquire, describeServerFor: () => null },
      getWorkspaceRoot: () => "D:\\ws",
      publishDiagnostics: vi.fn(),
      ipc: fakeIpc(captured) as never,
    });

    const env = (await captured.env!(null, { sessionId: "s1", path: "README.md" })) as {
      hasService: boolean;
      serverId: string | null;
      installHint: string | null;
    };

    expect(env.serverId).toBeNull();
    expect(env.installHint).toBeNull();
    expect(env.hasService).toBe(false);
    // 关键：连语言服务都不去找，免得每个 .md 都白跑一遍 PATH 探测
    expect(acquire).not.toHaveBeenCalled();
  });

  it("有语言服务定义但本机没装时，返回服务 id 与安装指引", async () => {
    const captured: CapturedHandlers = {};
    const acquire = vi.fn(async () => null);

    registerWorkbenchLspBridge({
      lsp: {
        acquireEditorClient: acquire,
        describeServerFor: () => ({ serverId: "python-pyright", installHint: "安装 pyright。" }),
      },
      getWorkspaceRoot: () => "D:\\ws",
      publishDiagnostics: vi.fn(),
      ipc: fakeIpc(captured) as never,
    });

    const env = (await captured.env!(null, { sessionId: "s1", path: "main.py" })) as {
      hasService: boolean;
      serverId: string | null;
      installHint: string | null;
    };

    expect(env).toMatchObject({ hasService: false, serverId: "python-pyright", installHint: "安装 pyright。" });
    expect(acquire).toHaveBeenCalledTimes(1);
  });

  it("同一个会话里两种语言各建一条绑定，同语言的文件共用一条", async () => {
    const captured: CapturedHandlers = {};
    const ts = fakeEditorClient();
    const py = fakeEditorClient();
    const acquire = vi.fn(async (_root: string, filePath: string) => (filePath.endsWith(".py") ? py.client : ts.client));

    registerWorkbenchLspBridge({
      lsp: { acquireEditorClient: acquire, describeServerFor: serverByExtension },
      getWorkspaceRoot: () => "D:\\ws",
      publishDiagnostics: vi.fn(),
      ipc: fakeIpc(captured) as never,
    });

    await captured.sync!(null, { sessionId: "s1", path: "a.ts", content: "const a = 1;\n", languageId: "typescript" });
    await captured.sync!(null, { sessionId: "s1", path: "main.py", content: "x = 1\n", languageId: "python" });

    // 两台服务各起一次，且各自的文档同步落到各自 client 上（这是这个 bug 的核心：不能复用）
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(ts.client.syncFromEditor).toHaveBeenCalledTimes(1);
    expect(py.client.syncFromEditor).toHaveBeenCalledTimes(1);
    // 诊断各订阅一次——共用一条绑定会让其中一个退订函数丢掉
    expect(ts.listeners.size).toBe(1);
    expect(py.listeners.size).toBe(1);

    // 同一语言的两个文件共用同一条绑定（别过度拆成"一个文件一条"）
    await captured.sync!(null, { sessionId: "s1", path: "b.ts", content: "const b = 2;\n", languageId: "typescript" });
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(ts.client.syncFromEditor).toHaveBeenCalledTimes(2);
  });

  it("先建立的语言服务不污染另一语言的环境判断（hasService 按各自的服务算）", async () => {
    const captured: CapturedHandlers = {};
    const ts = fakeEditorClient();
    // .ts 有服务、.py 没装（pyright 不在本机）
    const acquire = vi.fn(async (_root: string, filePath: string) => (filePath.endsWith(".ts") ? ts.client : null));

    registerWorkbenchLspBridge({
      lsp: { acquireEditorClient: acquire, describeServerFor: serverByExtension },
      getWorkspaceRoot: () => "D:\\ws",
      publishDiagnostics: vi.fn(),
      ipc: fakeIpc(captured) as never,
    });

    await captured.sync!(null, { sessionId: "s1", path: "a.ts", content: "const a = 1;\n", languageId: "typescript" });

    const env = (await captured.env!(null, { sessionId: "s1", path: "main.py" })) as {
      hasService: boolean;
      serverId: string | null;
    };
    // 修 bug 前这里会返回 hasService=true（复用了 TS 的绑定），界面因此连"该装 pyright"都不提示
    expect(env).toMatchObject({ hasService: false, serverId: "python-pyright" });
  });

  it("关闭文档只走已建立的绑定，不为它新建服务", async () => {
    const captured: CapturedHandlers = {};
    const ts = fakeEditorClient();
    const acquire = vi.fn(async () => ts.client);

    registerWorkbenchLspBridge({
      lsp: { acquireEditorClient: acquire, describeServerFor: serverByExtension },
      getWorkspaceRoot: () => "D:\\ws",
      publishDiagnostics: vi.fn(),
      ipc: fakeIpc(captured) as never,
    });

    await captured.sync!(null, { sessionId: "s1", path: "a.ts", content: "const a = 1;\n", languageId: "typescript" });
    await expect(captured.close!(null, { sessionId: "s1", path: "a.ts" })).resolves.toBe(true);
    expect(ts.client.closeFromEditor).toHaveBeenCalledTimes(1);

    // Python 那条绑定从没建立过：关闭它不该顺手起一台 pyright
    await expect(captured.close!(null, { sessionId: "s1", path: "main.py" })).resolves.toBe(false);
    expect(acquire).toHaveBeenCalledTimes(1);
  });
});
