import { beforeEach, describe, expect, it, vi } from "vitest";
import * as path from "path";
import { IPC } from "../../shared/ipc-channels";
import type { TaskAlertPayload } from "./task-alert-window";

/**
 * 弹窗生命周期与竞态测试。
 * 用 FakeBrowserWindow 手动驱动 did-finish-load / closed 事件，覆盖：
 * - 数据/语音在 did-finish-load 前后到达的暂存与推送
 * - 语音归属校验（旧任务的语音不得配新任务的文字）
 * - 新弹窗顶掉旧弹窗时暂存语音的清空
 */
const alertMocks = vi.hoisted(() => {
  class FakeWebContents {
    handlers: Record<string, Array<() => void>> = {};
    sent: Array<{ channel: string; payload: unknown }> = [];
    loading = true;
    destroyed = false;

    on(evt: string, fn: () => void): void {
      (this.handlers[evt] ??= []).push(fn);
    }
    send(channel: string, payload: unknown): void {
      this.sent.push({ channel, payload });
    }
    isLoading(): boolean {
      return this.loading;
    }
    isDestroyed(): boolean {
      return this.destroyed;
    }
    emit(evt: string): void {
      // 贴近真实 Electron：加载完成事件触发后 isLoading 变为 false
      if (evt === "did-finish-load") this.loading = false;
      for (const fn of this.handlers[evt] ?? []) fn();
    }
  }

  class FakeBrowserWindow {
    static instances: FakeBrowserWindow[] = [];
    webContents = new FakeWebContents();
    closedHandlers: Array<() => void> = [];
    readyHandlers: Array<() => void> = [];
    shown = false;

    constructor(public opts?: unknown) {
      FakeBrowserWindow.instances.push(this);
    }
    isDestroyed(): boolean {
      return this.webContents.destroyed;
    }
    close(): void {
      for (const fn of this.closedHandlers) fn();
      this.webContents.destroyed = true;
    }
    loadURL = vi.fn(async () => {});
    loadFile = vi.fn(async () => {});
    show(): void {
      this.shown = true;
    }
    focus(): void {}
    moveTop(): void {}
    on(evt: string, fn: () => void): void {
      if (evt === "closed") this.closedHandlers.push(fn);
    }
    once(evt: string, fn: () => void): void {
      if (evt === "ready-to-show") this.readyHandlers.push(fn);
    }
  }

  const windowRef = { current: null as FakeBrowserWindow | null };
  const ttsResult: { current: { base64: string; format: string } | { error: string } } = {
    current: { base64: "QUJD", format: "mp3" },
  };
  /** 置 true 时 screen.getPrimaryDisplay 抛错，驱动真实的窗口创建失败路径 */
  const displayFailure = { current: false };

  return {
    FakeBrowserWindow,
    windowRef,
    ttsResult,
    displayFailure,
    reset(): void {
      FakeBrowserWindow.instances.length = 0;
      windowRef.current = null;
      ttsResult.current = { base64: "QUJD", format: "mp3" };
      displayFailure.current = false;
    },
  };
});

vi.mock("electron", () => ({
  BrowserWindow: alertMocks.FakeBrowserWindow,
  screen: {
    getPrimaryDisplay: () => {
      if (alertMocks.displayFailure.current) throw new Error("显示不可用");
      return { workArea: { x: 0, y: 0, width: 1920, height: 1080 } };
    },
  },
  app: { getAppPath: () => "/fake-app" },
}));

vi.mock("../env", () => ({ isDev: false }));

vi.mock("../windows/window-state", () => ({
  getCurrentAppIconPath: () => "/icon.png",
  getTaskAlertWindow: () => alertMocks.windowRef.current,
  setTaskAlertWindow: (win: unknown) => {
    alertMocks.windowRef.current = win as InstanceType<typeof alertMocks.FakeBrowserWindow> | null;
  },
}));

vi.mock("./task-alert-tts", () => ({
  synthesizeTaskAlertTts: vi.fn(async () => alertMocks.ttsResult.current),
}));

function makePayload(overrides: Partial<TaskAlertPayload> = {}): TaskAlertPayload {
  return {
    historyId: "hist-1",
    taskId: "task-A",
    taskTitle: "任务A",
    content: "提醒内容",
    isError: false,
    ...overrides,
  };
}

const sentTo = (win: InstanceType<typeof alertMocks.FakeBrowserWindow>, channel: string) =>
  win.webContents.sent.filter((entry) => entry.channel === channel).map((entry) => entry.payload);

async function loadModule() {
  return await import("./task-alert-window");
}

beforeEach(() => {
  alertMocks.reset();
  vi.resetModules();
});

describe("showTaskAlertWindow", () => {
  it("did-finish-load 后推送暂存数据，未暂存语音时不发 AUDIO", async () => {
    const mod = await loadModule();
    mod.showTaskAlertWindow(makePayload());

    const win = alertMocks.FakeBrowserWindow.instances[0];
    win.webContents.emit("did-finish-load");

    expect(sentTo(win, IPC.TASK_ALERT_DATA)).toEqual([makePayload()]);
    expect(sentTo(win, IPC.TASK_ALERT_AUDIO)).toEqual([]);
  });

  it("被顶掉的旧弹窗先关闭再建新窗：同一时刻只有一个提醒窗口", async () => {
    const mod = await loadModule();
    mod.showTaskAlertWindow(makePayload({ taskId: "task-A" }));
    const winA = alertMocks.FakeBrowserWindow.instances[0];

    mod.showTaskAlertWindow(makePayload({ taskId: "task-B", taskTitle: "任务B" }));
    const winB = alertMocks.FakeBrowserWindow.instances[1];

    expect(winA.isDestroyed()).toBe(true);
    expect(alertMocks.windowRef.current).toBe(winB);
    expect(alertMocks.FakeBrowserWindow.instances).toHaveLength(2);
  });

  it("生产环境加载 dist 下的 task-alert 页面", async () => {
    const mod = await loadModule();
    mod.showTaskAlertWindow(makePayload());
    const win = alertMocks.FakeBrowserWindow.instances[0];
    expect(win.loadFile).toHaveBeenCalledWith(
      expect.stringContaining(path.join("dist", "renderer", "task-alert", "index.html")),
    );
  });
});

describe("sendTaskAlertAudio 归属与暂存", () => {
  it("页面加载中到达的语音先暂存，did-finish-load 后与数据一起推送", async () => {
    const mod = await loadModule();
    mod.showTaskAlertWindow(makePayload());
    const win = alertMocks.FakeBrowserWindow.instances[0];

    const audio = { base64: "QUJD", format: "mp3" };
    mod.sendTaskAlertAudio("hist-1", audio);
    expect(sentTo(win, IPC.TASK_ALERT_AUDIO)).toEqual([]);

    win.webContents.emit("did-finish-load");
    expect(sentTo(win, IPC.TASK_ALERT_AUDIO)).toEqual([audio]);
  });

  it("页面已加载的窗口直接推送语音", async () => {
    const mod = await loadModule();
    mod.showTaskAlertWindow(makePayload());
    const win = alertMocks.FakeBrowserWindow.instances[0];
    win.webContents.emit("did-finish-load");

    const audio = { base64: "QUJD", format: "mp3" };
    mod.sendTaskAlertAudio("hist-1", audio);

    expect(sentTo(win, IPC.TASK_ALERT_AUDIO)).toEqual([audio]);
  });

  it("弹窗已归属其他运行时丢弃过期语音（防串台）", async () => {
    const mod = await loadModule();
    mod.showTaskAlertWindow(makePayload({ taskId: "task-A", historyId: "hist-1" }));
    mod.showTaskAlertWindow(makePayload({ taskId: "task-B", taskTitle: "任务B", historyId: "hist-2" }));
    const winB = alertMocks.FakeBrowserWindow.instances[1];
    winB.webContents.emit("did-finish-load");

    mod.sendTaskAlertAudio("hist-1", { base64: "QUJD", format: "mp3" });

    expect(sentTo(winB, IPC.TASK_ALERT_AUDIO)).toEqual([]);
    expect(sentTo(winB, IPC.TASK_ALERT_DATA)).toEqual([
      makePayload({ taskId: "task-B", taskTitle: "任务B", historyId: "hist-2" }),
    ]);
  });

  it("同一任务重跑：旧运行的语音不得配新弹窗（按 historyId 校验归属）", async () => {
    const mod = await loadModule();
    const audio = { base64: "QUJD", format: "mp3" };
    mod.showTaskAlertWindow(makePayload({ taskId: "task-A", historyId: "hist-1" }));
    // 第一轮的 TTS 尚未就绪，窗口还在加载中
    mod.sendTaskAlertAudio("hist-1", audio);

    // 同一任务再次触发：新弹窗顶掉旧窗，归属切到 hist-2
    mod.showTaskAlertWindow(makePayload({ taskId: "task-A", historyId: "hist-2" }));
    const win2 = alertMocks.FakeBrowserWindow.instances[1];
    win2.webContents.emit("did-finish-load");

    // 旧运行的语音迟到：任务 id 相同，但运行已过期，必须丢弃
    mod.sendTaskAlertAudio("hist-1", audio);
    expect(sentTo(win2, IPC.TASK_ALERT_AUDIO)).toEqual([]);

    // 新运行的语音正常推送
    mod.sendTaskAlertAudio("hist-2", audio);
    expect(sentTo(win2, IPC.TASK_ALERT_AUDIO)).toEqual([audio]);
  });

  it("新弹窗顶掉旧弹窗时清空暂存的旧语音", async () => {
    const mod = await loadModule();
    mod.showTaskAlertWindow(makePayload({ taskId: "task-A", historyId: "hist-1" }));
    // A 的语音在 A 弹窗加载期间就绪，被暂存
    mod.sendTaskAlertAudio("hist-1", { base64: "QUJD", format: "mp3" });

    mod.showTaskAlertWindow(makePayload({ taskId: "task-B", taskTitle: "任务B", historyId: "hist-2" }));
    const winB = alertMocks.FakeBrowserWindow.instances[1];
    winB.webContents.emit("did-finish-load");

    expect(sentTo(winB, IPC.TASK_ALERT_DATA)).toEqual([
      makePayload({ taskId: "task-B", taskTitle: "任务B", historyId: "hist-2" }),
    ]);
    expect(sentTo(winB, IPC.TASK_ALERT_AUDIO)).toEqual([]);
  });

  it("窗口不存在时静默丢弃不抛错", async () => {
    const mod = await loadModule();
    expect(() => mod.sendTaskAlertAudio("hist-1", { base64: "QUJD", format: "mp3" })).not.toThrow();
  });
});

describe("notifyTaskResult", () => {
  it("失败任务只弹窗展示原因，不合成语音", async () => {
    const mod = await loadModule();
    mod.notifyTaskResult(makePayload({ content: "执行失败原因", isError: true }));
    const win = alertMocks.FakeBrowserWindow.instances[0];
    win.webContents.emit("did-finish-load");

    const { synthesizeTaskAlertTts } = await import("./task-alert-tts");
    expect(vi.mocked(synthesizeTaskAlertTts)).not.toHaveBeenCalled();
    expect(sentTo(win, IPC.TASK_ALERT_DATA)).toEqual([
      makePayload({ content: "执行失败原因", isError: true }),
    ]);
  });

  it("空白内容同样不触发 TTS", async () => {
    const mod = await loadModule();
    mod.notifyTaskResult(makePayload({ content: "   " }));
    const { synthesizeTaskAlertTts } = await import("./task-alert-tts");
    expect(vi.mocked(synthesizeTaskAlertTts)).not.toHaveBeenCalled();
  });

  it("成功任务弹窗后合成语音并推送到窗口", async () => {
    const mod = await loadModule();
    mod.notifyTaskResult(makePayload());
    const win = alertMocks.FakeBrowserWindow.instances[0];
    win.webContents.emit("did-finish-load");

    const { synthesizeTaskAlertTts } = await import("./task-alert-tts");
    expect(vi.mocked(synthesizeTaskAlertTts)).toHaveBeenCalledWith("提醒内容");
    await vi.waitFor(() => {
      expect(sentTo(win, IPC.TASK_ALERT_AUDIO)).toEqual([
        { base64: "QUJD", format: "mp3" },
      ]);
    });
  });

  it("TTS 合成返回 error 对象时也照常推送（弹窗侧自行降级）", async () => {
    alertMocks.ttsResult.current = { error: "TTS 未配置" };
    const mod = await loadModule();
    mod.notifyTaskResult(makePayload());
    const win = alertMocks.FakeBrowserWindow.instances[0];
    win.webContents.emit("did-finish-load");

    await vi.waitFor(() => {
      expect(sentTo(win, IPC.TASK_ALERT_AUDIO)).toEqual([{ error: "TTS 未配置" }]);
    });
  });

  it("弹窗打开失败时不抛错（fire-and-forget）", async () => {
    const mod = await loadModule();
    // notifyTaskResult 直接调用模块内 showTaskAlertWindow 绑定，spy 拦不到；
    // 让 screen.getPrimaryDisplay 抛错走真实失败路径（BrowserWindow 构造前）。
    alertMocks.displayFailure.current = true;
    expect(() => mod.notifyTaskResult(makePayload())).not.toThrow();
    expect(alertMocks.FakeBrowserWindow.instances).toHaveLength(0);
  });
});
