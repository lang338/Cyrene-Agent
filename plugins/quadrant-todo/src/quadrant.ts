/**
 * 滑动/滑回/默认完成/提醒触发判定——全部纯函数，不碰存储不碰 IO（§9.2 结算器
 * 的判定核心）。时间规则代码说了算（设计原则 2）：prompt 只负责让模型少犯错。
 */
import type { Task } from "./types";

/** 象限滑动窗口：剩余 ≤72h 时绿/蓝滑红/黄（§5.4） */
export const SLIDE_WINDOW_HOURS = 72;
/** 主动提醒窗口：重要紧急剩余 ≤24h 提醒一次（§5.5） */
export const DUE_WINDOW_HOURS = 24;

const HOUR_MS = 3_600_000;

const DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * 解析 deadline 存储值："YYYY-MM-DD HH:mm" | "YYYY-MM-DD"（按当日 00:00 计）。
 * 非法返回 null。严格校验：Date 构造会滚动溢出（如 2026-02-30 → 03-02），
 * 回读字段不一致即拒绝。
 */
export function parseDeadline(value: string): Date | null {
  const m = DATETIME_RE.exec(value) ?? DATE_RE.exec(value);
  if (!m) return null;
  const [, y, mo, d, h = "0", mi = "0"] = m;
  const date = new Date(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    0,
    0,
  );
  if (
    date.getFullYear() !== Number(y)
    || date.getMonth() !== Number(mo) - 1
    || date.getDate() !== Number(d)
    || date.getHours() !== Number(h)
    || date.getMinutes() !== Number(mi)
  ) {
    return null;
  }
  return date;
}

/** 距截止时间的剩余毫秒数；无 deadline 返回 null（§5.4：无截止时间永不滑动） */
export function msRemaining(task: Task, now: number): number | null {
  if (task.deadline === null) return null;
  const deadline = parseDeadline(task.deadline);
  return deadline ? deadline.getTime() - now : null;
}

/**
 * 两个 deadline 存储值是否指向同一时刻：字符串不同但时刻相同（如
 * "2026-11-10" 与 "2026-11-10 00:00"）视为等值；任一端不可解析（null/非法）
 * 时退回字符串判等——null 与带时刻的值互为真变更。
 * 供工具面（tools.ts）与工作台桥（bridge.ts）共用：改期判定须按时刻而非字符串，
 * 否则等值回传会误清提醒标记、造成重复提醒（CodeRabbit 评审）。
 */
export function sameInstant(a: string | null, b: string | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  const da = parseDeadline(a);
  const db = parseDeadline(b);
  if (!da || !db) return false;
  return da.getTime() === db.getTime();
}

/** 结算事件：滑动 / 滑回 / 默认完成 / 提醒触发（功能一两类 + 小目标自定义） */
export type SettleEvent =
  | "slide-red" // green → red
  | "slide-yellow" // blue → yellow
  | "slide-back" // 滑回原分类
  | "auto-done" // 过期默认完成
  | "remind-slide" // 滑红提醒
  | "remind-24h" // 重要紧急剩 24h 提醒
  | "remind-custom"; // 小目标自定义单次提醒（§3.23/§3.24）

/**
 * 树内机制资格（§3.24，按数据形态推导）：小目标不滑动不做 72h/24h 提醒、
 * 到点自动转；大目标不滑动无主动提醒、默认完成由联动结算（evaluateGoalCompletion）
 * 负责；普通任务走功能一全量机制。kind 由调用方按全量数据推导后传入。
 */
export type TreeKind = "normal" | "child" | "goal";

export interface SettleOptions {
  /**
   * 本次结算因 deadline 变更触发（§8.2）：先清提醒标记（新一轮，D6），
   * 再无条件滑回滑动产物（§5.4 自动滑回），然后按新时间走标准结算。
   */
  deadlineChanged?: boolean;
}

export interface SettleResult {
  task: Task;
  events: SettleEvent[];
}

/**
 * 对单个任务做一次结算。status ≠ pending 的任务原样返回（完成态不再结算）。
 * kind 为树内机制资格（§3.24）：normal 走功能一全量机制；child 不滑动不做
 * 72h/24h 提醒（保留到点自动转 + 自定义单次提醒）；goal 全部机制豁免——其
 * 默认完成由 evaluateGoalCompletion 联动结算负责。kind 由调用方按全量数据
 * 推导后传入（数据形态：有 parentId 即 child，被引用即 goal）。
 * 返回的新 task 对象仅在发生变更时与输入不同（不原地修改）。
 */
export function settleTask(
  input: Task,
  now: number,
  options: SettleOptions = {},
  kind: TreeKind = "normal",
): SettleResult {
  const events: SettleEvent[] = [];
  let task = input;

  if (task.status !== "pending") return { task, events };
  // 大目标全机制豁免：不滑动、无主动提醒、不单点默认完成（§3.24/§3.25/§3.27 过期态）
  if (kind === "goal") return { task, events };

  if (options.deadlineChanged && kind === "normal") {
    // D6：截止时间修改 = 提醒新一轮（仅功能一机制；小目标自定义提醒不随截止时间调整，§3.26）
    if (task.reminded && (task.reminded.slide || task.reminded.due24)) {
      task = { ...task, reminded: {} };
    }
    // §5.4 自动滑回：只撤销滑动产生的变更（slide-back 后按新时间重判滑动）
    if (task.slidFrom) {
      task = { ...task, quadrant: task.slidFrom };
      task = { ...task, slidFrom: undefined };
      events.push("slide-back");
    }
  }

  const remain = msRemaining(task, now);

  // 到达截止时刻仍无人处理 → 默认完成（§5.6 属性四）；无 deadline 永不自动完成
  if (remain !== null && remain <= 0) {
    task = { ...task, status: "auto-done", completedAt: now };
    events.push("auto-done");
    return { task, events };
  }

  // 小目标自定义单次提醒（§3.23/§3.24）：到点触发一次，标记防重复；
  // 不遵循 72h/24h 规律，与滑动机制无关
  if (kind === "child" && task.reminder?.type === "once" && task.reminded?.custom !== task.reminder.at) {
    const at = parseDeadline(task.reminder.at);
    if (at && at.getTime() <= now) {
      task = { ...task, reminded: { ...task.reminded, custom: task.reminder.at } };
      events.push("remind-custom");
      return { task, events };
    }
  }

  if (kind !== "normal") return { task, events };

  // 以下为普通任务专属：象限滑动与 72h/24h 主动提醒（§3.24 资格表）
  // 象限滑动：绿/蓝 + 剩余 ≤72h（唯二条件同时满足）
  if (remain !== null && remain <= SLIDE_WINDOW_HOURS * HOUR_MS) {
    // remain 非 null 蕴含 deadline 非 null（msRemaining 对 null deadline 恒返 null）
    const deadlineStr = task.deadline as string;
    if (task.quadrant === "green") {
      task = { ...task, quadrant: "red", slidFrom: "green" };
      events.push("slide-red");
      // 滑红提醒一次（§5.5：蓝滑黄不提醒）
      if (task.reminded?.slide !== deadlineStr) {
        task = { ...task, reminded: { ...task.reminded, slide: deadlineStr } };
        events.push("remind-slide");
      }
    } else if (task.quadrant === "blue") {
      task = { ...task, quadrant: "yellow", slidFrom: "blue" };
      events.push("slide-yellow");
    }
  }

  // 重要紧急剩 ≤24h 提醒一次（原生红与滑红同享；标记判等以 deadline 字符串为准）
  if (
    task.quadrant === "red"
    && remain !== null
    && remain <= DUE_WINDOW_HOURS * HOUR_MS
    && task.reminded?.due24 !== task.deadline
  ) {
    task = { ...task, reminded: { ...task.reminded, due24: task.deadline as string } };
    events.push("remind-24h");
  }

  return { task, events };
}

/** 批量结算：返回发生变更的任务与各自事件；无变更的任务不出现在结果里。
 * context 为全量任务清单（默认即 tasks），用于推导树内机制资格——被引用的
 * 顶层任务按大目标豁免结算，带 parentId 的按小目标豁免滑动/规律提醒。 */
export function settleAll(
  tasks: readonly Task[],
  now: number,
  options: SettleOptions = {},
  context: readonly Task[] = tasks,
): Array<{ task: Task; events: SettleEvent[] }> {
  const changed: Array<{ task: Task; events: SettleEvent[] }> = [];
  const kindOf = (t: Task): TreeKind => {
    if (t.parentId) return "child";
    // 大目标身份：持久化标记优先，"被引用"推导兜底旧数据（CodeRabbit 评审——
    // 删光小目标后身份不得丢失，否则会被误判普通任务滑动/默认完成）
    return t.goal === true || context.some((c) => c.parentId === t.id) ? "goal" : "normal";
  };
  for (const t of tasks) {
    const r = settleTask(t, now, options, kindOf(t));
    if (r.events.length > 0 || r.task !== t) changed.push(r);
  }
  return changed;
}

/**
 * 大目标默认完成的联动结算（§3.25）：**已到时限 且 所有小目标已完成**——两个
 * 条件中较晚满足的时刻由程序自动转"默认完成"（每轮扫描/写入时判定，天然在
 * 较晚时刻触发）。满足时返回结算结果（auto-done 事件），未满足返回 null。
 * 边界：尚无小目标（未拆解）的大目标即使过期也不自动完成——树上以过期样式
 * 呈现（§3.27）；无时限的大目标永不自动完成（§3.25）。
 */
export function evaluateGoalCompletion(
  goal: Task,
  children: readonly Task[],
  now: number,
): SettleResult | null {
  if (goal.status !== "pending" || goal.parentId) return null;
  if (children.length === 0) return null;
  if (!children.every((c) => c.status !== "pending")) return null;
  const remain = msRemaining(goal, now);
  if (remain === null || remain > 0) return null;
  return { task: { ...goal, status: "auto-done", completedAt: now }, events: ["auto-done"] };
}
