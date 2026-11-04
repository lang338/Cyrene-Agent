/**
 * settle.ts 单测：扫描结算单轮逻辑（定时扫描/开机补检共用）。
 * 提醒的计时与送达见 reminders.test.ts（§8.2 插件自建通道）。
 */
import { describe, expect, it, vi } from "vitest";
import { fmt, makeStorage, NOW } from "./helpers";
import { scanAndSettle, type SettleDeps } from "../src/settle";
import { TaskStore } from "../src/store";
import type { Task } from "../src/types";

const HOUR = 3_600_000;

function makeTask(partial: Partial<Task> & Pick<Task, "id" | "content">): Task {
  return {
    deadline: null,
    quadrant: "blue",
    status: "pending",
    createdAt: NOW,
    ...partial,
  };
}

function setup(tasks: Task[] = []) {
  const storage = makeStorage();
  const store = new TaskStore(storage);
  for (const t of tasks) store.add(t);
  const onSettleEvents = vi.fn();
  const log = vi.fn();
  const deps: SettleDeps = { store, now: () => NOW, onSettleEvents, log };
  return { deps, store, onSettleEvents, log, storage };
}

describe("scanAndSettle（定时扫描/开机补检共用单轮逻辑）", () => {
  it("绿任务进入 72h 窗口：滑红落库并抛 slide-red/remind-slide", () => {
    const deadline = fmt(NOW + 48 * HOUR);
    const { deps, store, onSettleEvents } = setup([
      makeTask({ id: "t1", content: "数学作业", deadline, quadrant: "green" }),
    ]);
    expect(scanAndSettle(deps)).toBe(1);
    const after = store.get("t1");
    expect(after?.quadrant).toBe("red");
    expect(after?.slidFrom).toBe("green");
    expect(after?.reminded?.slide).toBe(deadline);
    expect(onSettleEvents).toHaveBeenCalledTimes(1);
    const [task, events] = onSettleEvents.mock.calls[0] ?? [];
    expect(task?.id).toBe("t1");
    expect(events).toContain("slide-red");
    expect(events).toContain("remind-slide");
  });

  it("蓝任务进窗口：滑黄但不提醒（蓝滑黄静默，§3.15）", () => {
    const deadline = fmt(NOW + 48 * HOUR);
    const { deps, onSettleEvents } = setup([
      makeTask({ id: "t1", content: "测试", deadline, quadrant: "blue" }),
    ]);
    scanAndSettle(deps);
    const events = onSettleEvents.mock.calls[0]?.[1] ?? [];
    expect(events).toContain("slide-yellow");
    expect(events).not.toContain("remind-slide");
    expect(events).not.toContain("remind-24h");
  });

  it("红任务剩 ≤24h：抛 remind-24h 且标记落库；第二轮无变更不重复提醒", () => {
    const deadline = fmt(NOW + 10 * HOUR);
    const { deps, store, onSettleEvents } = setup([
      makeTask({ id: "t1", content: "测试", deadline, quadrant: "red" }),
    ]);
    scanAndSettle(deps);
    expect(store.get("t1")?.reminded?.due24).toBe(deadline);
    expect(scanAndSettle(deps)).toBe(0);
    expect(onSettleEvents).toHaveBeenCalledTimes(1);
  });

  it("过点无人处理 → auto-done 落库并抛事件", () => {
    const { deps, store, onSettleEvents } = setup([
      makeTask({ id: "t1", content: "过期的事", deadline: fmt(NOW - HOUR), quadrant: "red" }),
    ]);
    expect(scanAndSettle(deps)).toBe(1);
    expect(store.get("t1")?.status).toBe("auto-done");
    expect(onSettleEvents.mock.calls[0]?.[1]).toContain("auto-done");
  });

  it("全部未到期 → 返回 0 且不抛事件", () => {
    const { deps, onSettleEvents } = setup([
      makeTask({ id: "t1", content: "测试", deadline: fmt(NOW + 7 * 24 * HOUR), quadrant: "green" }),
    ]);
    expect(scanAndSettle(deps)).toBe(0);
    expect(onSettleEvents).not.toHaveBeenCalled();
  });
});
