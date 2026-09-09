// TaskTtsService 单测：开关门控、终态过滤、同 runId 合成去重、
// 存活判定（toast 已消隐则丢弃）、合成失败静默、dispose 退订。

import { describe, expect, it, vi } from "vitest";
import { createToastEventBus } from "./toast-events";
import { createTaskTtsService, type TaskTtsServiceDeps } from "./task-tts-service";
import { IPC } from "../../shared/ipc-channels";

function setup(overrides: Partial<TaskTtsServiceDeps> = {}) {
  const bus = createToastEventBus();
  const sent: Array<{ channel: string; payload: unknown }> = [];
  const synthesize = vi.fn(
    async () => ({ audio: Buffer.from("fake-audio"), mime: "audio/mpeg" }),
  );
  const findActiveTaskToastId = vi.fn((runId: string) => `toast-for-${runId}`);
  const service = createTaskTtsService({
    bus,
    isEnabled: () => true,
    synthesize,
    findActiveTaskToastId,
    send: (channel, payload) => sent.push({ channel, payload }),
    ...overrides,
  });
  return { bus, sent, synthesize, findActiveTaskToastId, service };
}

function successEvent(overrides: Record<string, unknown> = {}) {
  return {
    schedulerRunId: "sched-1",
    taskId: "task-1",
    taskTitle: "每日简报",
    status: "success",
    outputPreview: "今日天气晴好",
    ...overrides,
  };
}

describe("createTaskTtsService", () => {
  it("开关开启 + 成功完成 + toast 仍在屏：合成并下发播放载荷", async () => {
    const { bus, sent, synthesize, findActiveTaskToastId } = setup();
    bus.publishSchedulerFinished(successEvent());
    // 事件监听器同步触发，合成是异步的：让队列跑完
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(synthesize).toHaveBeenCalledWith("今日天气晴好");
    expect(findActiveTaskToastId).toHaveBeenCalledWith("sched-1");
    expect(sent[0]).toEqual({
      channel: IPC.TOAST_TASK_TTS_PLAY,
      payload: {
        toastId: "toast-for-sched-1",
        base64: Buffer.from("fake-audio").toString("base64"),
        mime: "audio/mpeg",
      },
    });
  });

  it("开关关闭：不合成不下发", async () => {
    const { bus, sent, synthesize } = setup({ isEnabled: () => false });
    bus.publishSchedulerFinished(successEvent());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(synthesize).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });

  it("失败终态或无输出预览：不播报", async () => {
    const { bus, sent, synthesize } = setup();
    bus.publishSchedulerFinished(successEvent({ status: "runtime_error" }));
    bus.publishSchedulerFinished(successEvent({ outputPreview: undefined }));
    bus.publishSchedulerFinished(successEvent({ outputPreview: "   " }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(synthesize).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });

  it("toast 已消隐（存活判定返回 null）：丢弃音频不下发", async () => {
    const { bus, sent, synthesize } = setup({ findActiveTaskToastId: () => null });
    bus.publishSchedulerFinished(successEvent());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(synthesize).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(0);
  });

  it("同一 runId 合成中不重复合成（事件重放去重）", async () => {
    let resolveFirst: (() => void) | null = null;
    const synthesizeOverride = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveFirst = () => resolve({ audio: Buffer.from("x"), mime: "audio/mpeg" });
        }),
    );
    const { bus } = setup({ synthesize: synthesizeOverride });
    bus.publishSchedulerFinished(successEvent());
    // 合成挂起期间同一 runId 事件再次到达
    bus.publishSchedulerFinished(successEvent());
    resolveFirst!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(synthesizeOverride).toHaveBeenCalledTimes(1);
  });

  it("合成抛错：静默 warn 不下发", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { bus, sent } = setup({
      synthesize: async () => {
        throw new Error("engine down");
      },
    });
    bus.publishSchedulerFinished(successEvent());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sent).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("dispose 后不再响应事件", async () => {
    const { bus, sent, synthesize, service } = setup();
    service.dispose();
    bus.publishSchedulerFinished(successEvent());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(synthesize).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });
});
