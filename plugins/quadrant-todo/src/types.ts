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
  /** 属性三：用户拍板；滑动会真实改写此字段 */
  quadrant: Quadrant;
  /** 属性四：录入默认 "pending" */
  status: Status;
  /** 滑动结算记录的原分类，用于自动滑回；用户手动改分类时清除 */
  slidFrom?: Quadrant;
  /** 提醒标记：值为"已提醒时对应的 deadline 字符串"；deadline 变更（字符串不等）即新一轮 */
  reminded?: {
    slide?: string;
    due24?: string;
  };
  createdAt: number;
  /** 转入完成态的时刻（已完成列表排序用）；完成态长期保存，不做清理 */
  completedAt?: number;
}

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
