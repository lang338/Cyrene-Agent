/**
 * 提醒通道（§8.2，插件自建，不经宿主定时任务）：结算产生 remind-* 事件 →
 * 系统通知；计时用插件自管的精确 setTimeout（每个提醒时刻独立一个，任务
 * 数据任何变更即重排），超出定时器上限的远期时刻由兜底扫描覆盖，关机错过
 * 由开机补检补发。
 *
 * 本文件保持纯逻辑（不 import electron）——Electron 侧的胶水（Notification、
 * AppUserModelID、点击通知打开工作台）在 index.ts，经 notify/onFire 回调注入，
 * 便于单测。
 */
import { DUE_WINDOW_HOURS, parseDeadline, SLIDE_WINDOW_HOURS, type SettleEvent } from "./quadrant";
import type { TaskStore } from "./store";
import type { Task } from "./types";

const HOUR_MS = 3_600_000;
/** 单个 Node 定时器上限（2^31-1 ms ≈ 24.8 天）；更远的时刻交给兜底扫描 */
export const MAX_TIMEOUT_MS = 2_147_483_647;

export type ReminderKind = "remind-slide" | "remind-24h";
const REMINDER_KINDS: readonly ReminderKind[] = ["remind-slide", "remind-24h"];

/** 单个提醒的期望时刻 */
export interface ReminderMoment {
  kind: ReminderKind;
  runAt: number;
}

/**
 * 当前任务状态下需要提醒的时刻（§3.15）：只算"未来仍会到来"的时刻；
 * 已进入窗口的时刻由写时结算即时送达，两者按剩余窗口天然互斥。
 * 绿任务到 24h 窗口前必已滑红（72h 滑动无条件），故绿同样排 24h 提醒；
 * 蓝滑黄后静默（§3.15：蓝滑黄不提醒），故蓝不排 24h。
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

/** 通知文案（纯函数）：title 为通知栏粗体行，body 为正文 */
export function reminderNotice(task: Task, kind: ReminderKind): { title: string; body: string } {
  const content = task.content.length > 20 ? `${task.content.slice(0, 20)}…` : task.content;
  const deadline = task.deadline ?? "无明确截止时间";
  return kind === "remind-slide"
    ? {
        title: `待办滑红提醒：${content}`,
        body: `「${task.content}」距截止（${deadline}）已不足 72 小时，已进入紧急象限`,
      }
    : {
        title: `待办截止提醒：${content}`,
        body: `「${task.content}」将在 24 小时内到期，截止 ${deadline}`,
      };
}

/** 通知派发依赖：notify 由 index.ts 提供（Electron Notification 胶水） */
export interface NotifyDeps {
  notify?: (notice: { title: string; body: string }) => void;
  log?: (...args: unknown[]) => void;
}

/** 把 remind-* 结算事件转成系统通知；其余事件忽略。自行兜异常——提醒失败只记日志，不阻断结算 */
export function notifySettleEvents(deps: NotifyDeps, task: Task, events: readonly SettleEvent[]): void {
  for (const kind of REMINDER_KINDS) {
    if (!events.includes(kind)) continue;
    try {
      if (!deps.notify) {
        deps.log?.("四象限待办：notify 未装配，提醒仅记录不发送");
        continue;
      }
      deps.notify(reminderNotice(task, kind));
    } catch (err) {
      deps.log?.(`四象限待办：提醒通知失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** 精确计时器依赖：onFire（到点回调）由 index.ts 提供——跑一轮"扫描结算 + 重排" */
export interface ReminderTimerDeps {
  store: TaskStore;
  /** 可注入时钟（单测用）；默认系统时间 */
  now?: () => number;
  onFire: () => void;
  log?: (...args: unknown[]) => void;
}

/**
 * 精确提醒计时器（§8.2）：按当前任务清单为每个未来提醒时刻挂一个 setTimeout；
 * rearm() 全清重排——任何数据变更（登记/修改/完成/删除）与每轮扫描后调用。
 */
export class ReminderTimers {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private deps: ReminderTimerDeps) {}

  rearm(): void {
    this.clearAll();
    const now = (this.deps.now ?? Date.now)();
    for (const task of this.deps.store.list()) {
      for (const m of reminderMoments(task, now)) {
        const delay = m.runAt - now;
        // 已到点的时刻由结算即时送达；超出定时器上限的远期时刻交兜底扫描
        if (delay <= 0 || delay > MAX_TIMEOUT_MS) continue;
        const key = `${task.id}:${m.kind}`;
        this.timers.set(
          key,
          setTimeout(() => {
            this.timers.delete(key);
            this.deps.onFire();
          }, delay),
        );
      }
    }
  }

  dispose(): void {
    this.clearAll();
  }

  private clearAll(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}
