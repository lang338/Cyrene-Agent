/**
 * 结算器编排层（§9.2/§9.3）。三路结算中的两路在这里：
 * - 开机补检：register 时先跑一轮 scanAndSettle（§9.3：与在线触发完全同形，
 *   离线期间跨过滑动/默认完成/提醒时刻的任务在这里被补结算、补提醒）
 * - 定时扫描：index.ts 挂 setInterval 每小时一轮，本文件只提供单轮逻辑
 * （第三路写时结算在 tools.ts settleAndPersist，M1 已落地。）
 *
 * 提醒发送通道（§9.2）：结算产生 remind-slide / remind-24h 事件后，经 scheduler
 * 注册 mode:"chat" 的一次性任务——落本地聊天 + Toast（事实 #6）。任务默认停用，
 * 须用户在宿主"定时任务"界面授权；宿主引擎语义：授权时触发时刻已过的 once 任务
 * 会立即补跑（store.onChange → 重排计时器），故迟到授权仍能送达提醒。
 * scheduler 任务与待办的对应关系记入登记簿（storage key "reminders"），
 * 已触发 / 待办已删 / 任务被用户删除的映射由 cleanupReminders 回收。
 */
import type { PluginScheduledTask, PluginSchedulerService, PluginStorage } from "../../../src/plugins/api";
import {
  DUE_WINDOW_HOURS,
  parseDeadline,
  settleAll,
  SLIDE_WINDOW_HOURS,
  type SettleEvent,
} from "./quadrant";
import type { TaskStore } from "./store";
import type { Task } from "./types";

const HOUR_MS = 3_600_000;

/** 定时扫描间隔：每小时一轮（2026-10-28 用户定稿；写时结算与开机补检为主，扫描兜底） */
export const SCAN_INTERVAL_MS = 60 * 60_000;
/** 提醒任务的触发时刻 = 判定时刻 + 本延迟（宿主校验 once 任务必须晚于当前时间） */
export const REMINDER_FIRE_DELAY_MS = 2 * 60_000;
/** 提醒任务标题里事项内容的最长展示字符数 */
const TITLE_CONTENT_MAX = 20;

const REMINDER_KINDS = ["remind-slide", "remind-24h"] as const;
export type ReminderKind = (typeof REMINDER_KINDS)[number];

/** 登记簿条目：scheduler 任务 ↔ 待办/提醒种类的对应 */
export interface ReminderEntry {
  schedulerTaskId: string;
  todoId: string;
  kind: ReminderKind;
  /** 创建任务时对应的待办 deadline（字符串判等）；deadline 变更后旧条目视为过期 */
  deadline: string;
}

const REGISTRY_KEY = "reminders";

/** 提醒登记簿：持久化到 PluginStorage，读写全程同步（与 TaskStore 同一口径） */
export class ReminderRegistry {
  constructor(private storage: PluginStorage) {}

  private load(): ReminderEntry[] {
    const raw = this.storage.get<ReminderEntry[]>(REGISTRY_KEY);
    return Array.isArray(raw) ? raw : [];
  }

  private persist(entries: ReminderEntry[]): void {
    this.storage.set(REGISTRY_KEY, entries);
  }

  list(): readonly ReminderEntry[] {
    return this.load();
  }

  add(entry: ReminderEntry): void {
    const entries = this.load();
    entries.push(entry);
    this.persist(entries);
  }

  /** 按 scheduler 任务 id 移除；返回是否真的移除了 */
  remove(schedulerTaskId: string): boolean {
    const entries = this.load();
    const i = entries.findIndex((e) => e.schedulerTaskId === schedulerTaskId);
    if (i < 0) return false;
    entries.splice(i, 1);
    this.persist(entries);
    return true;
  }
}

/** 结算编排依赖；onSettleEvents 是全部结算事件的唯一出口（扫描路与写时结算共用） */
export interface SettleDeps {
  store: TaskStore;
  registry: ReminderRegistry;
  scheduler?: PluginSchedulerService;
  /** 可注入时钟（单测用）；默认系统时间 */
  now?: () => number;
  onSettleEvents?: (task: Task, events: SettleEvent[]) => void;
  log?: (...args: unknown[]) => void;
}

/**
 * 单轮扫描结算（定时扫描与开机补检共用同形逻辑）：扫描全部未完成任务 →
 * 结算变更落库 → 逐任务抛事件。返回发生变更的条数。
 */
export function scanAndSettle(deps: SettleDeps): number {
  const pending = deps.store.list().filter((t) => t.status === "pending");
  const changed = settleAll(pending, (deps.now ?? Date.now)());
  for (const r of changed) deps.store.replace(r.task);
  for (const r of changed) {
    if (r.events.length > 0) deps.onSettleEvents?.(r.task, r.events);
  }
  return changed.length;
}

function truncateContent(content: string): string {
  return content.length > TITLE_CONTENT_MAX ? `${content.slice(0, TITLE_CONTENT_MAX)}…` : content;
}

/** 单个提醒的期望时刻 */
export interface ReminderMoment {
  kind: ReminderKind;
  runAt: number;
}

/**
 * 当前任务状态下应当预建的提醒任务（v0.3 验收补强）：只算"未来仍会到来"的时刻；
 * 已进入窗口的时刻由写时结算即时派发（+2min），两者按 remain 窗口天然互斥。
 * 绿任务到 24h 窗口前必已滑红（72h 滑动无条件），故绿同样预建 24h 提醒；
 * 蓝滑黄后静默，故蓝不预建 24h 提醒。
 */
export function reminderMoments(task: Task, now: number): ReminderMoment[] {
  if (task.status !== "pending" || task.deadline === null) return [];
  const deadline = parseDeadline(task.deadline);
  if (!deadline) return [];
  const dl = deadline.getTime();
  const moments: ReminderMoment[] = [];
  if ((task.quadrant === "green" || task.quadrant === "blue") && dl - SLIDE_WINDOW_HOURS * HOUR_MS > now) {
    moments.push({ kind: "remind-slide", runAt: dl - SLIDE_WINDOW_HOURS * HOUR_MS });
  }
  if ((task.quadrant === "green" || task.quadrant === "red") && dl - DUE_WINDOW_HOURS * HOUR_MS > now) {
    moments.push({ kind: "remind-24h", runAt: dl - DUE_WINDOW_HOURS * HOUR_MS });
  }
  return moments;
}

/**
 * 提醒任务同步（v0.3 验收补强）：以 reminderMoments 为期望对登记簿做增删。
 * 登记/修改属性/完成时调用——把授权时点从提醒时刻提前到登记时刻，用户登记完
 * 就能在宿主"设置→定时任务"里一次性授权；期望为空时清空该待办全部提醒任务。
 */
export async function syncReminders(deps: SettleDeps, task: Task): Promise<void> {
  const scheduler = deps.scheduler;
  if (!scheduler) return;
  const desired = reminderMoments(task, (deps.now ?? Date.now)());
  const mine = () => deps.registry.list().filter((e) => e.todoId === task.id);
  for (const entry of mine()) {
    const still = desired.some((d) => d.kind === entry.kind && entry.deadline === task.deadline);
    if (still) continue;
    try {
      await scheduler.deleteTask(entry.schedulerTaskId);
    } catch (err) {
      deps.log?.(`四象限待办：提醒任务删除失败：${err instanceof Error ? err.message : String(err)}`);
    }
    deps.registry.remove(entry.schedulerTaskId);
  }
  for (const d of desired) {
    if (mine().some((e) => e.kind === d.kind && e.deadline === task.deadline)) continue;
    try {
      const created = await scheduler.createTask({
        title: buildReminderTitle(task),
        prompt: buildReminderPrompt(task, d.kind),
        schedule: { kind: "once", runAt: new Date(d.runAt).toISOString() },
        mode: "chat",
        allowedToolIds: ["quadrant-todo_list_tasks"],
      });
      deps.registry.add({
        schedulerTaskId: created.id,
        todoId: task.id,
        kind: d.kind,
        deadline: task.deadline as string,
      });
      deps.log?.(`四象限待办：提醒任务已预建（待用户在定时任务界面授权）：${created.title}`);
    } catch (err) {
      deps.log?.(`四象限待办：提醒任务预建失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** 待办被删除时连带清掉它的全部提醒任务（否则要等下一轮扫描兜底） */
export async function removeTodoReminders(deps: SettleDeps, todoId: string): Promise<void> {
  const scheduler = deps.scheduler;
  if (!scheduler) return;
  for (const entry of [...deps.registry.list()].filter((e) => e.todoId === todoId)) {
    try {
      await scheduler.deleteTask(entry.schedulerTaskId);
    } catch (err) {
      deps.log?.(`四象限待办：提醒任务删除失败：${err instanceof Error ? err.message : String(err)}`);
    }
    deps.registry.remove(entry.schedulerTaskId);
  }
}

/** 提醒任务标题（宿主"定时任务"界面展示用，授权时用户看到的就是它） */
export function buildReminderTitle(task: Task): string {
  return `待办提醒：${truncateContent(task.content)}`;
}

/** 提醒任务提示词：注入该轮 chat 会话的"用户消息"，说明提醒缘由与发送要求 */
export function buildReminderPrompt(task: Task, kind: ReminderKind): string {
  const reason = kind === "remind-slide"
    ? "有一条待办已滑入「重要紧急」（距截止时间不足 72 小时）"
    : "有一条重要紧急待办距截止时间已不足 24 小时";
  const deadline = task.deadline ?? "无明确截止时间";
  return [
    `【四象限待办提醒】${reason}。`,
    `待办内容：「${task.content}」，截止时间：${deadline}。`,
    "请先调用 quadrant-todo_list_tasks 确认这条待办当前的状态：若仍是未完成（24 小时提醒时分类仍是重要紧急），用一到两句自然的话向用户发送提醒（说清是什么事、什么时候截止、现在已经比较紧迫了）；若已完成、已不在列表中、或分类已不再符合提醒条件（用户可能改过分类），就简单说明这项待办已有交代即可，不渲染紧迫。",
  ].join("\n");
}

/**
 * 提醒发送：把 remind-* 事件转成 scheduler 一次性任务（§9.2）。
 * 调用方以 fire-and-forget 方式发起（void deliverReminders(...)），本函数
 * 自行兜住全部异常，不向外抛——提醒失败只记日志，不阻断结算。
 */
export async function deliverReminders(deps: SettleDeps, task: Task, events: readonly SettleEvent[]): Promise<void> {
  const kinds = REMINDER_KINDS.filter((k) => events.includes(k));
  if (kinds.length === 0) return;
  const scheduler = deps.scheduler;
  if (!scheduler) {
    deps.log?.("四象限待办：scheduler 服务不可用，本轮提醒仅记录不发送");
    return;
  }
  for (const kind of kinds) {
    // 已有同 (待办, 种类, 截止) 的预建任务则不重复建（v0.3 预建口径）
    if (deps.registry.list().some((e) => e.todoId === task.id && e.kind === kind && e.deadline === task.deadline)) {
      continue;
    }
    try {
      const created = await scheduler.createTask({
        title: buildReminderTitle(task),
        prompt: buildReminderPrompt(task, kind),
        schedule: {
          kind: "once",
          runAt: new Date((deps.now ?? Date.now)() + REMINDER_FIRE_DELAY_MS).toISOString(),
        },
        mode: "chat",
        allowedToolIds: ["quadrant-todo_list_tasks"],
      });
      deps.registry.add({
        schedulerTaskId: created.id,
        todoId: task.id,
        kind,
        deadline: task.deadline as string,
      });
      deps.log?.(`四象限待办：提醒任务已注册（待用户在定时任务界面授权）：${created.title}`);
    } catch (err) {
      deps.log?.(`四象限待办：提醒任务注册失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/**
 * 登记簿清理（随每轮扫描执行）：待办已删/已完成、deadline 已变、已触发且结算
 * 标记已记的条目——删除 scheduler 任务并清映射；用户手动删掉提醒任务的视为
 * 放弃本轮提醒（标记提醒位后不再重建）；已触发但标记未跟上的留一轮防重复。
 */
export async function cleanupReminders(deps: SettleDeps): Promise<void> {
  const scheduler = deps.scheduler;
  if (!scheduler) return;
  const entries = [...deps.registry.list()];
  if (entries.length === 0) return;
  let tasks: PluginScheduledTask[];
  try {
    tasks = await scheduler.listTasks();
  } catch (err) {
    deps.log?.(`四象限待办：登记簿清理跳过（listTasks 失败）：${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  for (const entry of entries) {
    const scheduled = tasks.find((t) => t.id === entry.schedulerTaskId);
    const todo = deps.store.get(entry.todoId);
    const drop = async (): Promise<void> => {
      if (scheduled) {
        try {
          await scheduler.deleteTask(entry.schedulerTaskId);
        } catch (err) {
          deps.log?.(`四象限待办：提醒任务删除失败：${err instanceof Error ? err.message : String(err)}`);
        }
      }
      deps.registry.remove(entry.schedulerTaskId);
    };
    // 待办已删 / 已完成：提醒无意义，回收
    if (!todo || todo.status !== "pending") {
      await drop();
      continue;
    }
    // deadline 已变（写时同步应已处理，这里兜底）
    if (todo.deadline !== entry.deadline) {
      await drop();
      continue;
    }
    // 用户在宿主界面删掉了提醒任务：视为放弃本轮提醒，标记后不再重建
    if (!scheduled) {
      deps.store.replace({
        ...todo,
        reminded: { ...todo.reminded, [entry.kind === "remind-slide" ? "slide" : "due24"]: entry.deadline },
      });
      deps.registry.remove(entry.schedulerTaskId);
      continue;
    }
    const fired = Boolean(scheduled.lastFiredAt);
    const flagMarked = entry.kind === "remind-slide"
      ? todo.reminded?.slide === entry.deadline
      : todo.reminded?.due24 === entry.deadline;
    // 已触发但结算标记还没跟上：留一轮，等扫描先记标记（防止删后重复重建）
    if (fired && !flagMarked) continue;
    if (fired) {
      await drop();
      continue;
    }
    // 在途未触发且待办仍在：保留
  }
}
