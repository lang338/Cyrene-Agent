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
import { parseDeadline } from "../src/quadrant";
import {
  buildReminderPrompt,
  buildReminderTitle,
  cleanupReminders,
  deliverReminders,
  reminderMoments,
  ReminderRegistry,
  REMINDER_FIRE_DELAY_MS,
  removeTodoReminders,
  scanAndSettle,
  syncReminders,
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

  it("标题含种类与事项内容，超长截断（同内容两条提醒在授权列表里可区分）", () => {
    expect(buildReminderTitle(task, "remind-slide")).toBe("待办滑红提醒：写实验报告");
    expect(buildReminderTitle(task, "remind-24h")).toBe("待办截止提醒：写实验报告");
    const long = makeTask({ id: "t2", content: "一二三四五六七八九十一二三四五六七八九十一", deadline: null, quadrant: "red" });
    expect(buildReminderTitle(long, "remind-slide")).toBe("待办滑红提醒：一二三四五六七八九十一二三四五六七八九十…");
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
    expect(s.registry.list()).toEqual([
      { schedulerTaskId: "st-1", todoId: "t1", kind: "remind-slide", deadline: t.deadline },
    ]);
  });

  it("remind-24h：提示词说明不足 24 小时", async () => {
    const t = makeTask({ id: "t1", content: "交房租", deadline: fmt(NOW + 20 * HOUR), quadrant: "red" });
    const s = setup([t]);
    await deliverReminders(s.deps, t, ["remind-24h"]);
    expect(s.scheduler.createCalls[0]?.prompt).toContain("24 小时");
    expect(s.registry.list()[0]).toMatchObject({ kind: "remind-24h", deadline: t.deadline });
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

  it("已有同 (待办, 种类, 截止) 的预建条目：不重复创建", async () => {
    const t = makeTask({ id: "t1", content: "数学作业", deadline: fmt(NOW + 48 * HOUR), quadrant: "green" });
    const s = setup([t]);
    s.registry.add({ schedulerTaskId: "st-x", todoId: "t1", kind: "remind-slide", deadline: t.deadline! });
    await deliverReminders(s.deps, t, ["remind-slide"]);
    expect(s.scheduler.createCalls).toHaveLength(0);
  });
});

describe("cleanupReminders（登记簿回收）", () => {
  async function withReminder() {
    const t = makeTask({ id: "t1", content: "数学作业", deadline: fmt(NOW + 48 * HOUR), quadrant: "green" });
    const s = setup([t]);
    await deliverReminders(s.deps, t, ["remind-slide"]);
    return { s, t };
  }

  it("已触发且结算标记已记：删除 scheduler 任务并清映射", async () => {
    const { s, t } = await withReminder();
    s.scheduler.tasks[0]!.lastFiredAt = new Date(NOW).toISOString();
    const todo = s.store.get("t1")!;
    s.store.replace({ ...todo, reminded: { slide: t.deadline! } });
    await cleanupReminders(s.deps);
    expect(s.scheduler.tasks).toHaveLength(0);
    expect(s.registry.list()).toHaveLength(0);
  });

  it("已触发但结算标记未记：保留一轮（防删后重复重建）", async () => {
    const { s } = await withReminder();
    s.scheduler.tasks[0]!.lastFiredAt = new Date(NOW).toISOString();
    await cleanupReminders(s.deps);
    expect(s.scheduler.tasks).toHaveLength(1);
    expect(s.registry.list()).toHaveLength(1);
  });

  it("在途未触发且待办仍在：保留", async () => {
    const { s } = await withReminder();
    await cleanupReminders(s.deps);
    expect(s.scheduler.tasks).toHaveLength(1);
    expect(s.registry.list()).toHaveLength(1);
  });

  it("待办已删除：回收 scheduler 任务", async () => {
    const { s } = await withReminder();
    s.store.remove("t1");
    await cleanupReminders(s.deps);
    expect(s.scheduler.tasks).toHaveLength(0);
    expect(s.registry.list()).toHaveLength(0);
  });

  it("待办已完成：回收提醒任务", async () => {
    const { s, t } = await withReminder();
    const todo = s.store.get("t1")!;
    s.store.replace({ ...todo, status: "done", completedAt: NOW });
    void t;
    await cleanupReminders(s.deps);
    expect(s.scheduler.tasks).toHaveLength(0);
    expect(s.registry.list()).toHaveLength(0);
  });

  it("scheduler 任务被用户删除：标记本轮已提醒，不再重建", async () => {
    const { s, t } = await withReminder();
    await s.scheduler.service.deleteTask("st-1");
    await cleanupReminders(s.deps);
    expect(s.registry.list()).toHaveLength(0);
    expect(s.store.get("t1")?.reminded?.slide).toBe(t.deadline);
  });

  it("作废的提醒任务（宿主重启归一化：nextFireAt=null 且未触发）：回收并清该轮提醒标记", async () => {
    const t = makeTask({ id: "t1", content: "数学作业", deadline: fmt(NOW + 23 * HOUR), quadrant: "red" });
    const s = setup([t]);
    await deliverReminders(s.deps, t, ["remind-24h"]);
    const stored = s.store.get("t1")!;
    s.store.replace({ ...stored, reminded: { due24: t.deadline! } });
    s.scheduler.tasks[0]!.nextFireAt = null; // 模拟宿主引擎 skipped 归一化
    await cleanupReminders(s.deps);
    expect(s.scheduler.tasks).toHaveLength(0);
    expect(s.registry.list()).toHaveLength(0);
    expect(s.store.get("t1")?.reminded?.due24).toBeUndefined();
  });

  it("listTasks 失败：跳过清理，保留映射", async () => {
    const { s } = await withReminder();
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

describe("removeTodoReminders（删除待办连带清理）", () => {
  it("清掉该待办的全部提醒任务与映射，不影响其他待办", async () => {
    const t1 = makeTask({ id: "t1", content: "甲", deadline: fmt(NOW + 5 * 24 * HOUR), quadrant: "green" });
    const t2 = makeTask({ id: "t2", content: "乙", deadline: fmt(NOW + 6 * 24 * HOUR), quadrant: "red" });
    const s = setup([t1, t2]);
    await syncReminders(s.deps, t1);
    await syncReminders(s.deps, t2);
    expect(s.registry.list()).toHaveLength(3); // 绿两个 + 红一个
    await removeTodoReminders(s.deps, "t1");
    expect(s.registry.list().map((e) => e.todoId)).toEqual(["t2"]);
  });
});

describe("reminderMoments（预建时刻计算）", () => {
  it("绿任务 72h 外：预建滑红 + 24h 两个时刻", () => {
    const t = makeTask({ id: "t1", content: "x", deadline: fmt(NOW + 5 * 24 * HOUR), quadrant: "green" });
    const dl = parseDeadline(t.deadline!)!.getTime();
    expect(reminderMoments(t, NOW)).toEqual([
      { kind: "remind-slide", runAt: dl - 72 * HOUR },
      { kind: "remind-24h", runAt: dl - 24 * HOUR },
    ]);
  });

  it("蓝任务：只预建滑红（滑黄后静默）；红任务：只预建 24h", () => {
    const blue = makeTask({ id: "b", content: "x", deadline: fmt(NOW + 5 * 24 * HOUR), quadrant: "blue" });
    const dl = parseDeadline(blue.deadline!)!.getTime();
    expect(reminderMoments(blue, NOW)).toEqual([{ kind: "remind-slide", runAt: dl - 72 * HOUR }]);
    const red = makeTask({ id: "r", content: "x", deadline: fmt(NOW + 5 * 24 * HOUR), quadrant: "red" });
    expect(reminderMoments(red, NOW)).toEqual([{ kind: "remind-24h", runAt: dl - 24 * HOUR }]);
  });

  it("已过的时刻不预建，未来时刻照常预建（绿剩 48h：滑红即时、24h 预建；剩 10h：全即时）", () => {
    const dl5 = fmt(NOW + 5 * 24 * HOUR);
    expect(reminderMoments(makeTask({ id: "y", content: "x", deadline: dl5, quadrant: "yellow" }), NOW)).toEqual([]);
    expect(reminderMoments(makeTask({ id: "n", content: "x", deadline: null, quadrant: "green" }), NOW)).toEqual([]);
    expect(reminderMoments(makeTask({ id: "d", content: "x", deadline: dl5, quadrant: "green", status: "done" }), NOW)).toEqual([]);
    const t48 = makeTask({ id: "w", content: "x", deadline: fmt(NOW + 48 * HOUR), quadrant: "green" });
    const dl48 = parseDeadline(t48.deadline!)!.getTime();
    expect(reminderMoments(t48, NOW)).toEqual([{ kind: "remind-24h", runAt: dl48 - 24 * HOUR }]);
    expect(reminderMoments(makeTask({ id: "w2", content: "x", deadline: fmt(NOW + 10 * HOUR), quadrant: "green" }), NOW)).toEqual([]);
  });
});

describe("syncReminders（预建同步）", () => {
  it("绿任务远期：预建两个提醒任务，runAt 为对应提醒时刻", async () => {
    const t = makeTask({ id: "t1", content: "数学作业", deadline: fmt(NOW + 5 * 24 * HOUR), quadrant: "green" });
    const s = setup([t]);
    await syncReminders(s.deps, t);
    expect(s.scheduler.createCalls).toHaveLength(2);
    const dl = parseDeadline(t.deadline!)!.getTime();
    const runs = s.scheduler.createCalls.map((c) =>
      c.schedule.kind === "once" ? Date.parse(c.schedule.runAt) : Number.NaN,
    );
    expect(runs).toEqual([dl - 72 * HOUR, dl - 24 * HOUR]);
    expect(s.registry.list().map((e) => [e.kind, e.deadline])).toEqual([
      ["remind-slide", t.deadline],
      ["remind-24h", t.deadline],
    ]);
  });

  it("重复同步幂等：不重复创建", async () => {
    const t = makeTask({ id: "t1", content: "数学作业", deadline: fmt(NOW + 5 * 24 * HOUR), quadrant: "green" });
    const s = setup([t]);
    await syncReminders(s.deps, t);
    await syncReminders(s.deps, t);
    expect(s.scheduler.createCalls).toHaveLength(2);
  });

  it("改期：旧提醒任务删除，按新截止重建", async () => {
    const t = makeTask({ id: "t1", content: "数学作业", deadline: fmt(NOW + 5 * 24 * HOUR), quadrant: "green" });
    const s = setup([t]);
    await syncReminders(s.deps, t);
    const moved = { ...t, deadline: fmt(NOW + 10 * 24 * HOUR) };
    await syncReminders(s.deps, moved);
    expect(s.scheduler.createCalls).toHaveLength(4); // 旧 2 + 新 2
    expect(s.registry.list()).toHaveLength(2);
    expect(s.registry.list().every((e) => e.deadline === moved.deadline)).toBe(true);
  });

  it("绿改黄：两类提醒任务全部清除", async () => {
    const t = makeTask({ id: "t1", content: "数学作业", deadline: fmt(NOW + 5 * 24 * HOUR), quadrant: "green" });
    const s = setup([t]);
    await syncReminders(s.deps, t);
    await syncReminders(s.deps, { ...t, quadrant: "yellow" });
    expect(s.scheduler.tasks).toHaveLength(0);
    expect(s.registry.list()).toHaveLength(0);
  });

  it("回归：登记绿剩 13h（写时滑红+即时提醒）后用户改回绿——在途提醒不被误删", async () => {
    const t = makeTask({ id: "t1", content: "早上起来跑步", deadline: fmt(NOW + 13 * HOUR), quadrant: "green" });
    const s = setup([t]);
    // 登记写时结算：滑红 + 两类提醒即时声明（事件路径建任务、记标记）
    await deliverReminders(s.deps, t, ["remind-slide", "remind-24h"]);
    expect(s.scheduler.tasks).toHaveLength(2);
    const stored = s.store.get("t1")!;
    s.store.replace({ ...stored, quadrant: "red", reminded: { slide: t.deadline!, due24: t.deadline! } });
    // 用户要求改回绿：update 流程先跑 syncReminders（此刻任务状态还是绿、时刻已过不进 desired）
    await syncReminders(s.deps, { ...t, quadrant: "green" });
    expect(s.scheduler.tasks).toHaveLength(2); // 已声明的在途提醒保留（修复前此处为 0，提醒静默丢失）
    expect(s.registry.list()).toHaveLength(2);
    // 随后结算按 72h 规则翻回红，标记已记 → 不重复建任务
  });

  it("回归（用户实测）：授权的提醒任务跨重启被宿主作废 → 开机补检重新声明提醒", async () => {
    // 登记时剩 24h03m：24h 时刻在 3 分钟后（未来）→ 预建
    const t = makeTask({ id: "t1", content: "数学作业", deadline: fmt(NOW + 24 * HOUR + 3 * 60_000), quadrant: "red" });
    const s = setup([t]);
    // 登记：预建 24h 提醒任务，用户授权
    await syncReminders(s.deps, t);
    expect(s.scheduler.tasks).toHaveLength(1);
    s.scheduler.tasks[0]!.enabled = true;
    // 关机期间错过触发时刻：宿主引擎归一化 → 记 skipped、清授权、nextFireAt=null
    s.scheduler.tasks[0]!.enabled = false;
    s.scheduler.tasks[0]!.nextFireAt = null;
    // 重启开机补检：cleanup + scan 同轮（index.ts pass 顺序），事件路径重发提醒
    await cleanupReminders(s.deps);
    scanAndSettle(s.deps);
    await deliverReminders(s.deps, t, ["remind-24h"]);
    expect(s.scheduler.tasks).toHaveLength(1); // 旧 husk 已回收，新任务在列
    const fresh = s.scheduler.tasks[0]!;
    expect(fresh.enabled).toBe(false); // 停用待授权
    expect(Date.parse((fresh.schedule as { kind: "once"; runAt: string }).runAt)).toBe(NOW + REMINDER_FIRE_DELAY_MS);
    expect(s.registry.list()).toEqual([
      { schedulerTaskId: fresh.id, todoId: "t1", kind: "remind-24h", deadline: t.deadline },
    ]);
    // 用户再授权 → 时刻已过 → 引擎立即补跑（宿主语义，插件侧无需处理）
  });

  it("转为完成态：清空全部提醒任务", async () => {
    const t = makeTask({ id: "t1", content: "数学作业", deadline: fmt(NOW + 5 * 24 * HOUR), quadrant: "green" });
    const s = setup([t]);
    await syncReminders(s.deps, t);
    await syncReminders(s.deps, { ...t, status: "done", completedAt: NOW });
    expect(s.scheduler.tasks).toHaveLength(0);
    expect(s.registry.list()).toHaveLength(0);
  });
});

describe("ReminderRegistry 持久化", () => {
  it("跨实例共享 storage，remove 落盘", () => {
    const storage = makeStorage();
    const r1 = new ReminderRegistry(storage);
    r1.add({ schedulerTaskId: "s1", todoId: "t1", kind: "remind-slide", deadline: "2026-11-01 20:00" });
    r1.add({ schedulerTaskId: "s2", todoId: "t1", kind: "remind-24h", deadline: "2026-11-01 20:00" });
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
    const deadline = fmt(NOW + 48 * HOUR);
    store.add(makeTask({ id: "t1", content: "数学作业", deadline, quadrant: "green" }));
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
    expect(registry.list()).toEqual([{ schedulerTaskId: "st-1", todoId: "t1", kind: "remind-slide", deadline }]);
  });
});
