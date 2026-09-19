/**
 * 工作台 LSP 桥的并发行为测试。
 *
 * 关注点：同一条 WORKBENCH_LSP_SYNC 可能被并发触发（编辑器连续同步 + 昔涟的 lsp 工具），
 * 若"建立绑定"这一步不收敛，就会订阅两次诊断（前端重复 setState）、并丢掉一个退订函数。
 */

import { describe, expect, it, vi } from "vitest";
import { IPC } from "../../shared/ipc-channels";
import { registerWorkbenchLspBridge } from "./editor-bridge";
import type { LspEditorSupport } from "./manager";

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
      lsp: { acquireEditorClient: acquire, describeServerFor: () => null },
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
      lsp: { acquireEditorClient: acquire, describeServerFor: () => null },
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
});
