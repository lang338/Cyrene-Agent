/**
 * settle.ts 单测：扫描结算单轮逻辑（定时扫描/开机补检共用）、提醒登记簿、
 * 提醒派发（scheduler 一次性任务）、登记簿清理。
 */
import { describe, expect, it, vi } from "vitest";
import type {
  PluginScheduledTask,
  PluginSchedulerService,
  PluginScheduledTaskInput,
  PluginStorage,
} from "../../../src/plugins/api";
import { fmt, makeStorage, NOW } from "./helpers";
import {
  buildReminderPrompt,
  buildReminderTitle,
  cleanupReminders,
  deliverReminders,
  ReminderRegistry,
  REMINDER_FIRE_DELAY_MS,
  scanAndSettle,
  type SettleDeps,
} from "../src/settle";
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

/** 内存版 PluginSchedulerService（只实现插件实际用到的 create/list/delete） */
function makeScheduler() {
  const tasks: PluginScheduledTask[] = [];
  const createCalls: PluginScheduledTaskInput[] = [];
  let n = 0;
  const service: PluginSchedulerService = {
    async createTask(input) {
      createCalls.push(input);
      const task: PluginScheduledTask = {
        id: `st-${++n}`,
        title: input.title,
        prompt: input.prompt,
        schedule: input.schedule,
        mode: input.mode,
        allowedToolIds: [...input.allowedToolIds],
        enabled: false,
        nextFireAt: input.schedule.kind === "once" ? input.schedule.runAt : null,
        createdAt: new Date(NOW).toISOString(),
        updatedAt: new Date(NOW).toISOString(),
      };
      tasks.push(task);
      return { ...task };
    },
    async listTasks() {
      return tasks.map((t) => ({ ...t }));
    },
    async updateTask() {
      throw new Error("unused in tests");
    },
    async deleteTask(id) {
      const i = tasks.findIndex((t) => t.id === id);
      if (i < 0) return false;
      tasks.splice(i, 1);
      return true;
    },
    async getHistory() {
      return [];
    },
  };
  return { service, tasks, createCalls };
}

interface SetupResult {
  deps: SettleDeps;
  store: TaskStore;
  registry: ReminderRegistry;
  storage: PluginStorage;
  onSettleEvents: ReturnType<typeof vi.fn>;
  scheduler: ReturnType<typeof makeScheduler>;
  log: ReturnType<typeof vi.fn>;
}

function setup(tasks: Task[] = []): SetupResult {
  const storage = makeStorage();
  const store = new TaskStore(storage);
  for (const t of tasks) store.add(t);
  const sched = makeScheduler();
  const registry = new ReminderRegistry(storage);
  const onSettleEvents = vi.fn();
  const log = vi.fn();
  const deps: SettleDeps = {
    store,
    registry,
    scheduler: sched.service,
    now: () => NOW,
    onSettleEvents,
    log,
  };
  return { deps, store, registry, storage, onSettleEvents, scheduler: sched, log };
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
    expect(onSettleEvents.mock.calls[0]?.[1]).toEqual(expect.arrayContaining(["slide-red", "remind-slide"]));
  });

  it("离线跨越两窗：一次扫描同时滑红并标记两类提醒", () => {
    const deadline = fmt(NOW + 10 * HOUR);
    const { deps, store, onSettleEvents } = setup([
      makeTask({ id: "t1", content: "交报告", deadline, quadrant: "green" }),
    ]);
    scanAndSettle(deps);
    const after = store.get("t1");
    expect(after?.quadrant).toBe("red");
    expect(after?.reminded?.slide).toBe(deadline);
    expect(after?.reminded?.due24).toBe(deadline);
    expect(onSettleEvents.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining(["slide-red", "remind-slide", "remind-24h"]),
    );
  });

  it("过截止时刻仍未完成：自动转默认完成", () => {
    const { deps, store, onSettleEvents } = setup([
      makeTask({ id: "t1", content: "过期事", deadline: fmt(NOW - HOUR), quadrant: "red" }),
    ]);
    expect(scanAndSettle(deps)).toBe(1);
    const after = store.get("t1");
    expect(after?.status).toBe("auto-done");
    expect(after?.completedAt).toBe(NOW);
    expect(onSettleEvents.mock.calls[0]?.[1]).toEqual(["auto-done"]);
  });

  it("无到期变化、完成态与无截止时间任务：零事件", () => {
    const { deps, onSettleEvents } = setup([
      makeTask({ id: "a", content: "远期事", deadline: fmt(NOW + 30 * 24 * HOUR), quadrant: "blue" }),
      makeTask({ id: "b", content: "已完成", deadline: fmt(NOW - HOUR), quadrant: "red", status: "done" }),
      makeTask({ id: "c", content: "无期限", deadline: null, quadrant: "green" }),
    ]);
    expect(scanAndSettle(deps)).toBe(0);
    expect(onSettleEvents).not.toHaveBeenCalled();
  });

  it("重复扫描：提醒标记已记不重复抛事件", () => {
    const { deps, onSettleEvents } = setup([
      makeTask({ id: "t1", content: "数学作业", deadline: fmt(NOW + 48 * HOUR), quadrant: "green" }),
    ]);
    scanAndSettle(deps);
    scanAndSettle(deps);
    expect(onSettleEvents).toHaveBeenCalledTimes(1);
  });
});

describe("buildReminderTitle / buildReminderPrompt", () => {
  const task = makeTask({ id: "t1", content: "写实验报告", deadline: fmt(NOW + 10 * HOUR), quadrant: "red" });

  it("标题含事项内容，超长截断", () => {
    expect(buildReminderTitle(task)).toBe("待办提醒：写实验报告");
    const long = makeTask({ id: "t2", content: "一二三四五六七八九十一二三四五六七八九十一", deadline: null, quadrant: "red" });
    expect(buildReminderTitle(long)).toBe("待办提醒：一二三四五六七八九十一二三四五六七八九十…");
  });

  it("滑红提醒说明 72 小时缘由；24h 提醒说明不足 24 小时", () => {
    const slide = buildReminderPrompt(task, "remind-slide");
    expect(slide).toContain("重要紧急");
    expect(slide).toContain("72 小时");
    expect(slide).toContain("写实验报告");
    expect(slide).toContain(task.deadline ?? "");
    const due24 = buildReminderPrompt(task, "remind-24h");
    expect(due24).toContain("24 小时");
    expect(due24).not.toContain("72 小时");
  });
});

describe("deliverReminders（提醒 → scheduler 一次性任务）", () => {
  it("remind-slide：创建 mode:chat 白名单一次性任务并登记映射", async () => {
    const t = makeTask({ id: "t1", content: "数学作业", deadline: fmt(NOW + 48 * HOUR), quadrant: "green" });
    const s = setup([t]);
    await deliverReminders(s.deps, t, ["remind-slide"]);
    const calls = s.scheduler.createCalls;
    expect(calls).toHaveLength(1);
    const input = calls[0]!;
    expect(input.mode).toBe("chat");
    expect(input.allowedToolIds).toEqual(["quadrant-todo_list_tasks"]);
    expect(input.title).toContain("数学作业");
    expect(input.prompt).toContain("数学作业");
    expect(input.schedule.kind).toBe("once");
    if (input.schedule.kind === "once") {
      expect(Date.parse(input.schedule.runAt)).toBe(NOW + REMINDER_FIRE_DELAY_MS);
    }
    expect(s.registry.list()).toEqual([{ schedulerTaskId: "st-1", todoId: "t1", kind: "remind-slide" }]);
  });

  it("remind-24h：提示词说明不足 24 小时", async () => {
    const t = makeTask({ id: "t1", content: "交房租", deadline: fmt(NOW + 20 * HOUR), quadrant: "red" });
    const s = setup([t]);
    await deliverReminders(s.deps, t, ["remind-24h"]);
    expect(s.scheduler.createCalls[0]?.prompt).toContain("24 小时");
    expect(s.registry.list()[0]?.kind).toBe("remind-24h");
  });

  it("一轮同时滑红且进入 24h：创建两个提醒任务", async () => {
    const t = makeTask({ id: "t1", content: "交报告", deadline: fmt(NOW + 10 * HOUR), quadrant: "green" });
    const s = setup([t]);
    await deliverReminders(s.deps, t, ["slide-red", "remind-slide", "remind-24h"]);
    expect(s.scheduler.createCalls).toHaveLength(2);
    expect(s.registry.list()).toHaveLength(2);
  });

  it("非提醒事件（slide-yellow/auto-done）：不创建任务", async () => {
    const t = makeTask({ id: "t1", content: "无关事", deadline: fmt(NOW + 48 * HOUR), quadrant: "blue" });
    const s = setup([t]);
    await deliverReminders(s.deps, t, ["slide-yellow", "auto-done"]);
    expect(s.scheduler.createCalls).toHaveLength(0);
    expect(s.registry.list()).toHaveLength(0);
  });

  it("scheduler 服务不可用：不抛异常，仅记日志", async () => {
    const t = makeTask({ id: "t1", content: "数学作业", deadline: fmt(NOW + 48 * HOUR), quadrant: "green" });
    const s = setup([t]);
    const depsNoScheduler: SettleDeps = { ...s.deps, scheduler: undefined };
    await expect(deliverReminders(depsNoScheduler, t, ["remind-slide"])).resolves.toBeUndefined();
    expect(s.log).toHaveBeenCalled();
  });
});

describe("cleanupReminders（登记簿回收）", () => {
  async function withReminder() {
    const t = makeTask({ id: "t1", content: "数学作业", deadline: fmt(NOW + 48 * HOUR), quadrant: "green" });
    const s = setup([t]);
    await deliverReminders(s.deps, t, ["remind-slide"]);
    return s;
  }

  it("已触发的提醒任务：删除 scheduler 任务并清映射", async () => {
    const s = await withReminder();
    s.scheduler.tasks[0]!.lastFiredAt = new Date(NOW).toISOString();
    await cleanupReminders(s.deps);
    expect(s.scheduler.tasks).toHaveLength(0);
    expect(s.registry.list()).toHaveLength(0);
  });

  it("在途未触发且待办仍在：保留", async () => {
    const s = await withReminder();
    await cleanupReminders(s.deps);
    expect(s.scheduler.tasks).toHaveLength(1);
    expect(s.registry.list()).toHaveLength(1);
  });

  it("待办已删除：回收 scheduler 任务", async () => {
    const s = await withReminder();
    s.store.remove("t1");
    await cleanupReminders(s.deps);
    expect(s.scheduler.tasks).toHaveLength(0);
    expect(s.registry.list()).toHaveLength(0);
  });

  it("scheduler 任务被用户删除：仅清映射，不报错", async () => {
    const s = await withReminder();
    await s.scheduler.service.deleteTask("st-1");
    await cleanupReminders(s.deps);
    expect(s.registry.list()).toHaveLength(0);
  });

  it("listTasks 失败：跳过清理，保留映射", async () => {
    const s = await withReminder();
    const failing: PluginSchedulerService = {
      ...s.deps.scheduler!,
      listTasks: async () => {
        throw new Error("boom");
      },
    };
    await cleanupReminders({ ...s.deps, scheduler: failing });
    expect(s.registry.list()).toHaveLength(1);
    expect(s.log).toHaveBeenCalled();
  });
});

describe("ReminderRegistry 持久化", () => {
  it("跨实例共享 storage，remove 落盘", () => {
    const storage = makeStorage();
    const r1 = new ReminderRegistry(storage);
    r1.add({ schedulerTaskId: "s1", todoId: "t1", kind: "remind-slide" });
    r1.add({ schedulerTaskId: "s2", todoId: "t1", kind: "remind-24h" });
    const r2 = new ReminderRegistry(storage);
    expect(r2.list()).toHaveLength(2);
    expect(r2.remove("s1")).toBe(true);
    expect(r2.remove("s1")).toBe(false);
    expect(new ReminderRegistry(storage).list().map((e) => e.schedulerTaskId)).toEqual(["s2"]);
  });
});

describe("端到端（index.ts 接线同形）：扫描滑红 → 自动注册提醒任务", () => {
  it("scanAndSettle 的事件出口接 deliverReminders 后产生 scheduler 任务", async () => {
    const storage = makeStorage();
    const store = new TaskStore(storage);
    store.add(makeTask({ id: "t1", content: "数学作业", deadline: fmt(NOW + 48 * HOUR), quadrant: "green" }));
    const { service, createCalls } = makeScheduler();
    const registry = new ReminderRegistry(storage);
    const deps: SettleDeps = {
      store,
      registry,
      scheduler: service,
      now: () => NOW,
      onSettleEvents: (task, events) => {
        void deliverReminders(deps, task, events);
      },
    };
    scanAndSettle(deps);
    await vi.waitFor(() => expect(createCalls).toHaveLength(1));
    expect(registry.list()).toEqual([{ schedulerTaskId: "st-1", todoId: "t1", kind: "remind-slide" }]);
  });
});
