/**
 * reminders.ts 单测（§8.2 插件自建提醒通道）：提醒时刻计算、通知文案、
 * remind-* 事件派发、精确计时器（fake timers）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fmt, makeStorage, NOW } from "./helpers";
import { parseDeadline } from "../src/quadrant";
import {
  MAX_TIMEOUT_MS,
  notifySettleEvents,
  reminderMoments,
  reminderNotice,
  ReminderTimers,
} from "../src/reminders";
import { TaskStore } from "../src/store";
import type { Task } from "../src/types";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function makeTask(partial: Partial<Task> & Pick<Task, "id" | "content">): Task {
  return { deadline: null, quadrant: "blue", status: "pending", createdAt: NOW, ...partial };
}

/** deadline 存储串 → 精确时刻（parseDeadline 按分钟截断，避免秒级偏差） */
const dl = (deadline: string): number => parseDeadline(deadline)!.getTime();

describe("reminderMoments（未来提醒时刻计算，§3.15）", () => {
  it("绿任务（远期）：排 滑红 + 24h 两个时刻", () => {
    const d = fmt(NOW + 7 * DAY);
    const t = makeTask({ id: "t1", content: "x", deadline: d, quadrant: "green" });
    expect(reminderMoments(t, NOW)).toEqual([
      { kind: "remind-slide", runAt: dl(d) - 72 * HOUR },
      { kind: "remind-24h", runAt: dl(d) - 24 * HOUR },
    ]);
  });

  it("蓝任务：只排滑红时刻，不排 24h（滑黄后静默）", () => {
    const d = fmt(NOW + 7 * DAY);
    const t = makeTask({ id: "t1", content: "x", deadline: d, quadrant: "blue" });
    expect(reminderMoments(t, NOW)).toEqual([{ kind: "remind-slide", runAt: dl(d) - 72 * HOUR }]);
  });

  it("红任务：只排 24h 时刻（已是终点，无滑红）", () => {
    const d = fmt(NOW + 7 * DAY);
    const t = makeTask({ id: "t1", content: "x", deadline: d, quadrant: "red" });
    expect(reminderMoments(t, NOW)).toEqual([{ kind: "remind-24h", runAt: dl(d) - 24 * HOUR }]);
  });

  it("黄任务：零提醒时刻", () => {
    const d = fmt(NOW + 7 * DAY);
    const t = makeTask({ id: "t1", content: "x", deadline: d, quadrant: "yellow" });
    expect(reminderMoments(t, NOW)).toEqual([]);
  });

  it("已进入 72h 窗口的绿任务：滑红时刻已过不排，只排未来的 24h 时刻", () => {
    const d = fmt(NOW + 48 * HOUR);
    const t = makeTask({ id: "t1", content: "x", deadline: d, quadrant: "green" });
    expect(reminderMoments(t, NOW)).toEqual([{ kind: "remind-24h", runAt: dl(d) - 24 * HOUR }]);
  });

  it("小目标（child）：只排自定义单次提醒，不排 72h/24h（§3.24）", () => {
    const d = fmt(NOW + 7 * DAY);
    const t = makeTask({
      id: "c1",
      content: "x",
      parentId: "g1",
      deadline: d,
      quadrant: "green",
      reminder: { type: "once", at: fmt(NOW + 2 * HOUR) },
    });
    expect(reminderMoments(t, NOW, "child")).toEqual([{ kind: "remind-custom", runAt: dl(fmt(NOW + 2 * HOUR)) }]);
  });

  it("小目标无自定义提醒 / 周期型扩展位：零时刻", () => {
    const d = fmt(NOW + 7 * DAY);
    expect(reminderMoments(makeTask({ id: "c1", content: "x", parentId: "g1", deadline: d, quadrant: "green" }), NOW, "child")).toEqual([]);
    expect(
      reminderMoments(
        makeTask({ id: "c1", content: "x", parentId: "g1", deadline: d, quadrant: "green", reminder: { type: "periodic", everyNDays: 1, time: "08:00" } }),
        NOW,
        "child",
      ),
    ).toEqual([]);
  });

  it("大目标（goal）：无主动提醒时刻", () => {
    const d = fmt(NOW + 7 * DAY);
    const t = makeTask({ id: "g1", content: "x", deadline: d, quadrant: "green" });
    expect(reminderMoments(t, NOW, "goal")).toEqual([]);
  });

  it("已完成 / 无截止时间 → 空数组", () => {
    const far = makeTask({ id: "t1", content: "x", deadline: fmt(NOW + 7 * DAY), quadrant: "green", status: "done" });
    const noDeadline = makeTask({ id: "t2", content: "x", deadline: null, quadrant: "green" });
    expect(reminderMoments(far, NOW)).toEqual([]);
    expect(reminderMoments(noDeadline, NOW)).toEqual([]);
  });
});

describe("reminderNotice（通知文案）", () => {
  const t = makeTask({ id: "t1", content: "写周报", deadline: fmt(NOW + 48 * HOUR), quadrant: "green" });

  it("滑红提醒文案：区分种类并带截止时间", () => {
    const n = reminderNotice(t, "remind-slide");
    expect(n.title).toBe("待办滑红提醒：写周报");
    expect(n.body).toContain("写周报");
    expect(n.body).toContain("72 小时");
    expect(n.body).toContain(t.deadline!);
  });

  it("24h 提醒文案", () => {
    const n = reminderNotice(t, "remind-24h");
    expect(n.title).toBe("待办截止提醒：写周报");
    expect(n.body).toContain("24 小时");
  });

  it("超长内容截断标题，正文保留全文", () => {
    const long = makeTask({ id: "t2", content: "这是一条特别特别长的待办内容超过二十个字的边界", deadline: null, quadrant: "red" });
    const n = reminderNotice(long, "remind-24h");
    expect(n.title).toBe(`待办截止提醒：${long.content.slice(0, 20)}…`);
    expect(n.body).toContain(long.content);
  });
});

describe("notifySettleEvents（remind-* 事件 → 系统通知）", () => {
  const t = makeTask({ id: "t1", content: "写周报", deadline: fmt(NOW + 48 * HOUR), quadrant: "green" });

  it("remind-* 事件 → notify 逐条调用", () => {
    const notify = vi.fn();
    notifySettleEvents({ notify }, t, ["slide-red", "remind-slide", "remind-24h"]);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls[0]?.[0].title).toContain("待办滑红提醒");
    expect(notify.mock.calls[1]?.[0].title).toContain("待办截止提醒");
  });

  it("非 remind 事件（滑黄等）不触发通知", () => {
    const notify = vi.fn();
    notifySettleEvents({ notify }, t, ["slide-yellow"]);
    expect(notify).not.toHaveBeenCalled();
  });

  it("notify 抛异常不外泄（提醒失败只记日志，不阻断结算）", () => {
    const notify = vi.fn(() => {
      throw new Error("boom");
    });
    const log = vi.fn();
    expect(() => notifySettleEvents({ notify, log }, t, ["remind-24h"])).not.toThrow();
    expect(log).toHaveBeenCalled();
  });

  it("notify 未装配 → 仅记日志", () => {
    const log = vi.fn();
    notifySettleEvents({ log }, t, ["remind-24h"]);
    expect(log).toHaveBeenCalled();
  });
});

describe("ReminderTimers（精确计时器，fake timers）", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function makeTimerDeps(tasks: Task[]) {
    const storage = makeStorage();
    const store = new TaskStore(storage);
    for (const t of tasks) store.add(t);
    const onFire = vi.fn();
    // 不注入 now：默认走 Date.now()，在 fake timers 下随时钟推进，与真实行为一致
    const timers = new ReminderTimers({ store, onFire });
    return { store, onFire, timers };
  }

  it("未来时刻到点触发 onFire（恰好一次）", () => {
    const { onFire, timers } = makeTimerDeps([
      makeTask({ id: "t1", content: "x", deadline: fmt(NOW + 34 * HOUR), quadrant: "red" }),
    ]);
    timers.rearm();
    vi.advanceTimersByTime(10 * HOUR); // 24h 时刻 = deadline - 24h = NOW + 10h
    expect(onFire).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(48 * HOUR);
    expect(onFire).toHaveBeenCalledTimes(1); // 一次性，不重复触发
  });

  it("rearm 全清重排：改期后旧时刻不再触发，新时刻触发", () => {
    const { store, onFire, timers } = makeTimerDeps([
      makeTask({ id: "t1", content: "x", deadline: fmt(NOW + 7 * DAY), quadrant: "green" }),
    ]);
    timers.rearm(); // 旧滑红时刻 = 7d - 72h = 4d
    vi.advanceTimersByTime(DAY); // 过了 1 天，用户改期
    const t = store.get("t1")!;
    store.replace({ ...t, deadline: fmt(NOW + 10 * DAY) }); // 新滑红时刻 = 7d（比旧的更晚）
    timers.rearm(); // 清掉旧的 4d 定时器，按新时刻 7d 重排
    vi.advanceTimersByTime(3 * DAY + HOUR); // 推到 4d+1h：旧时刻已过但定时器已被清 → 不触发
    expect(onFire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2 * DAY + 23 * HOUR); // 推到 7d+1h：新滑红时刻到点
    expect(onFire).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(DAY); // 推到 8d+1h：新 24h 时刻在 9d，尚未触发
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it("dispose 后不再触发", () => {
    const { onFire, timers } = makeTimerDeps([
      makeTask({ id: "t1", content: "x", deadline: fmt(NOW + 34 * HOUR), quadrant: "red" }),
    ]);
    timers.rearm();
    timers.dispose();
    vi.advanceTimersByTime(48 * HOUR);
    expect(onFire).not.toHaveBeenCalled();
  });

  it("超出定时器上限的远期时刻不挂（交兜底扫描，§8.2）", () => {
    const { onFire, timers } = makeTimerDeps([
      makeTask({ id: "t1", content: "x", deadline: fmt(NOW + 40 * DAY), quadrant: "red" }),
    ]);
    timers.rearm(); // 24h 时刻在 39d 后 > 上限 ~24.8d，跳过
    vi.advanceTimersByTime(MAX_TIMEOUT_MS);
    expect(onFire).not.toHaveBeenCalled();
  });

  it("多任务多时刻互不干扰", () => {
    const { onFire, timers } = makeTimerDeps([
      makeTask({ id: "a", content: "x", deadline: fmt(NOW + 34 * HOUR), quadrant: "red" }), // 24h 时刻 10h
      makeTask({ id: "b", content: "y", deadline: fmt(NOW + 36 * HOUR), quadrant: "green" }), // 滑红已过、24h 时刻 12h
    ]);
    timers.rearm();
    vi.advanceTimersByTime(10 * HOUR);
    expect(onFire).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2 * HOUR);
    expect(onFire).toHaveBeenCalledTimes(2);
  });
});
