/**
 * 结算器编排层（§8.1）。三路结算中的两路在这里：
 * - 开机补检：register 时先跑一轮 scanAndSettle（离线期间跨过滑动/默认完成/
 *   提醒时刻的任务在这里被补结算、补提醒）
 * - 兜底扫描：index.ts 挂 setInterval 每小时一轮，本文件只提供单轮逻辑
 * （第三路写时结算在 tools.ts settleAndPersist。）
 *
 * 提醒的计时与送达在 reminders.ts（§8.2 插件自建通道，不经宿主定时任务）；
 * 本文件只负责"扫描 → 结算 → 抛事件"，事件消费方由 index.ts 装配。
 */
import { evaluateGoalCompletion, settleAll } from "./quadrant";
import type { TaskStore } from "./store";
import type { Task } from "./types";

/** 兜底扫描间隔：每小时一轮（写时结算与开机补检为主，扫描兜底） */
export const SCAN_INTERVAL_MS = 60 * 60_000;

/** 结算编排依赖；onSettleEvents 是全部结算事件的唯一出口（扫描路与写时结算共用） */
export interface SettleDeps {
  store: TaskStore;
  /** 可注入时钟（单测用）；默认系统时间 */
  now?: () => number;
  onSettleEvents?: (task: Task, events: import("./quadrant").SettleEvent[]) => void;
  log?: (...args: unknown[]) => void;
}

/**
 * 单轮扫描结算（定时扫描与开机补检共用同形逻辑）：扫描全部未完成任务 →
 * 按树内资格结算落库 → 大目标联动结算（§3.25）→ 逐任务抛事件。返回发生
 * 变更的条数。
 */
export function scanAndSettle(deps: SettleDeps): number {
  const now = (deps.now ?? Date.now)();
  const all = deps.store.list();
  const pending = all.filter((t) => t.status === "pending");
  const changed = settleAll(pending, now, {}, all);
  for (const r of changed) deps.store.replace(r.task);
  for (const r of changed) {
    if (r.events.length > 0) deps.onSettleEvents?.(r.task, r.events);
  }
  let count = changed.length;

  // 大目标联动结算（§3.25）：已到时限 且 所有小目标已完成 → 默认完成。
  // 在小目标结算落库后评估，天然命中"较晚满足的时刻"。
  const after = deps.store.list();
  for (const goal of after) {
    if (goal.parentId || goal.status !== "pending") continue;
    if (!after.some((t) => t.parentId === goal.id)) continue;
    const children = after.filter((t) => t.parentId === goal.id);
    const r = evaluateGoalCompletion(goal, children, now);
    if (r) {
      deps.store.replace(r.task);
      if (r.events.length > 0) deps.onSettleEvents?.(r.task, r.events);
      count += 1;
    }
  }
  return count;
}
