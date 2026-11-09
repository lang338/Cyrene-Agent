/** 四象限与完成状态的存储枚举；展示用中文映射见 QUADRANT_LABELS / STATUS_LABELS */
export type Quadrant = "red" | "green" | "yellow" | "blue";
// red=重要紧急 green=重要不紧急 yellow=不重要紧急 blue=不重要不紧急

export type Status = "pending" | "done" | "auto-done";
// pending=未完成 done=已完成(用户) auto-done=默认完成(到点自动)

export interface Task {
  id: string; // crypto.randomUUID()
  content: string; // 属性二：内容
  /** 属性一："YYYY-MM-DD HH:mm" | "YYYY-MM-DD"（只有日期按当日 00:00 计）| null（无明确截止时间）。字段恒存在，null 是合法值 */
  deadline: string | null;
  /** 属性三：用户拍板；滑动会真实改写此字段。小目标从属大目标，恒等于父级分类 */
  quadrant: Quadrant;
  /** 属性四：录入默认 "pending" */
  status: Status;
  /** 功能二：所属大目标 id。带此字段即小目标——机制资格按数据形态推导（§3.24） */
  parentId?: string;
  /** 持久化大目标身份（§3.24）：首次挂入小目标时置 true——删光小目标后身份不丢失，
   * 仍按大目标豁免结算且可继续挂新小目标（旧数据无此字段，靠"被引用"兜底推导） */
  goal?: boolean;
  /** 功能二：小目标自定义提醒（§3.23），单次时刻，默认不提醒；大目标恒无 */
  reminder?: ReminderSpec | null;
  /** 滑动结算记录的原分类，用于自动滑回；用户手动改分类时清除。小目标永不滑动，恒无此字段 */
  slidFrom?: Quadrant;
  /** 提醒标记：值为"已提醒时对应的 deadline 字符串"（slide/due24）或提醒时刻（custom）；deadline 变更（字符串不等）即新一轮 */
  reminded?: {
    slide?: string;
    due24?: string;
    /** 小目标自定义单次提醒的已触发标记（值为提醒时刻字符串） */
    custom?: string;
  };
  createdAt: number;
  /** 转入完成态的时刻（已完成列表排序用）；完成态长期保存，不做清理 */
  completedAt?: number;
}

/**
 * 小目标自定义提醒（§3.23）：单次时刻（"YYYY-MM-DD HH:mm"）。周期提醒不做
 * （§3.24，2026-11-10 决策）——重复性提醒诉求由昔涟按用户明确需求逐次设定
 * 单次提醒实现。
 */
export type ReminderSpec = { type: "once"; at: string };

export const QUADRANT_LABELS: Record<Quadrant, string> = {
  red: "重要紧急",
  green: "重要不紧急",
  yellow: "不重要紧急",
  blue: "不重要不紧急",
};

export const STATUS_LABELS: Record<Status, string> = {
  pending: "未完成",
  done: "已完成",
  "auto-done": "默认完成",
};

/** 工具入参的中文四词 → 存储枚举（§七：分类存储英文枚举、工具参数接受中文四词） */
export const QUADRANT_INPUT: Record<string, Quadrant> = {
  重要紧急: "red",
  重要不紧急: "green",
  不重要紧急: "yellow",
  不重要不紧急: "blue",
};

/** "无明确截止时间"的合法字面值（§5.2 属性一；"null"/"none"/"无"作宽容别名） */
export const NO_DEADLINE_INPUTS: ReadonlySet<string> = new Set([
  "无明确截止时间",
  "null",
  "none",
  "无",
]);
