import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC } from "../../shared/ipc-channels";
import { createSchedulerStore } from "./scheduler-store";

/**
 * scheduler IPC 预生成链路测试。
 * 用真实 store（内存 + 临时文件）+ 受控的 pregenerateTaskAlert mock，覆盖：
 * - mode 变更触发重新预生成
 * - 预生成令牌：旧完成不覆盖新内容（乱序完成只保留最新）
 * - 任务删除后完成回调静默丢弃（真实 store 对不存在任务 updateTask 会抛错）
 * - 失败路径写入 alertContentError 并复位标志
 */
const pregenState = vi.hoisted(() => ({
  calls: 0,
  pending: [] as Array<(result: { content: string } | { error: string }) => void>,
}));

vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: () => [] },
}));

vi.mock("./task-alert-pregen", () => ({
  pregenerateTaskAlert: () =>
    new Promise<{ content: string } | { error: string }>((resolve) => {
      pregenState.calls += 1;
      pregenState.pending.push(resolve);
    }),
}));

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-scheduler-ipc-"));
}

async function loadModule() {
  return await import("./scheduler-ipc");
}

function makeHarness() {
  const dir = tmpDir();
  let n = 0;
  const store = createSchedulerStore({
    tasksFile: path.join(dir, "scheduled-tasks.json"),
    historyFile: path.join(dir, "scheduled-tasks-history.jsonl"),
    now: () => new Date("2026-09-06T08:00:00.000Z"),
    id: () => `task-${++n}`,
  });
  store.load();
  const handlers = new Map<string, (event: unknown, ...args: never[]) => unknown>();
  const ipc = { handle: (channel: string, fn: (event: unknown, ...args: never[]) => unknown) => void handlers.set(channel, fn) } as never;
  const engine = { fireNow: vi.fn(async () => ({ ok: true })) };
  return { store, handlers, ipc, engine, dir };
}

function call<T>(handlers: Map<string, (event: unknown, ...args: never[]) => unknown>, channel: string, ...args: never[]): T {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`handler not registered: ${channel}`);
  return handler(null, ...args) as T;
}

function resolvePregen(index: number, result: { content: string } | { error: string }): void {
  const resolve = pregenState.pending[index];
  if (!resolve) throw new Error(`no pending pregen #${index}`);
  resolve(result);
}

/** 冲刷微任务队列：让 fire-and-forget 的完成回调跑完 */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 4; i += 1) await new Promise((r) => setTimeout(r, 0));
};

const addInput = { title: "每日整理", prompt: "整理资料", schedule: { kind: "daily", timeOfDay: "09:00" } } as never;

beforeEach(() => {
  vi.resetModules(); // schedulerIpcRegistered 是模块级标志，必须重置模块才能重复注册
  pregenState.calls = 0;
  pregenState.pending = [];
});

describe("scheduler IPC 预生成链路", () => {
  it("新建任务触发预生成；修改 mode 也触发重新预生成", async () => {
    const mod = await loadModule();
    const h = makeHarness();
    mod.registerSchedulerIpc(h.store as never, h.engine as never, () => [], h.ipc, async () => "生成内容");

    const added = call<{ ok: true; value: { id: string } }>(h.handlers, IPC.SCHEDULER_ADD, addInput);
    expect(pregenState.calls).toBe(1);

    call(h.handlers, IPC.SCHEDULER_UPDATE, added.value.id as never, { mode: "chat" } as never);
    expect(pregenState.calls).toBe(2);
  });

  it("旧预生成完成不覆盖新内容：乱序完成只保留最新一次（令牌守卫）", async () => {
    const mod = await loadModule();
    const h = makeHarness();
    mod.registerSchedulerIpc(h.store as never, h.engine as never, () => [], h.ipc, async () => "生成内容");

    const added = call<{ ok: true; value: { id: string } }>(h.handlers, IPC.SCHEDULER_ADD, addInput);
    const id = added.value.id;
    call(h.handlers, IPC.SCHEDULER_UPDATE, id as never, { title: "改名一" } as never);
    call(h.handlers, IPC.SCHEDULER_UPDATE, id as never, { title: "改名二" } as never);
    expect(pregenState.calls).toBe(3);

    // 最新请求先完成，最旧请求后完成
    resolvePregen(2, { content: "最新内容" });
    await flush();
    resolvePregen(0, { content: "过期内容" });
    await flush();

    const task = h.store.getTasks().find(t => t.id === id);
    expect(task?.alertContent).toBe("最新内容");
    expect(task?.alertPregenerating).toBe(false);
    expect(task?.alertContentError).toBeUndefined();
  });

  it("任务删除后完成回调静默丢弃，不抛 unhandled rejection", async () => {
    const mod = await loadModule();
    const h = makeHarness();
    mod.registerSchedulerIpc(h.store as never, h.engine as never, () => [], h.ipc, async () => "生成内容");

    const added = call<{ ok: true; value: { id: string } }>(h.handlers, IPC.SCHEDULER_ADD, addInput);
    const id = added.value.id;
    call(h.handlers, IPC.SCHEDULER_DELETE, id as never);
    expect(h.store.getTasks()).toHaveLength(0);

    // 真实 store 对不存在任务 updateTask 会抛错；令牌守卫必须先拦下
    resolvePregen(0, { content: "迟到内容" });
    await flush();

    expect(pregenState.calls).toBe(1);
  });

  it("预生成失败写入 alertContentError 并复位标志", async () => {
    const mod = await loadModule();
    const h = makeHarness();
    mod.registerSchedulerIpc(h.store as never, h.engine as never, () => [], h.ipc, async () => "生成内容");

    const added = call<{ ok: true; value: { id: string } }>(h.handlers, IPC.SCHEDULER_ADD, addInput);
    resolvePregen(0, { error: "模型超时" });
    await flush();

    const task = h.store.getTasks().find(t => t.id === added.value.id);
    expect(task?.alertContentError).toBe("模型超时");
    expect(task?.alertPregenerating).toBe(false);
    expect(task?.alertContent).toBeUndefined();
  });
});
