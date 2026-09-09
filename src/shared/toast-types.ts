// 注意力 Toast 中心契约（主进程与渲染页共享的类型定义）。
// ToastService（主进程）是 toast 生命周期的唯一权威：创建、去重、抑制、超时、
// 结算清退全部在主进程决策；toast 渲染页只负责显示、动画、音效与用户输入上报。
// 运行时常量（超时时长、窗口宽度等）留在 src/main/toast/types.ts，属主进程私有。

/** 档位：等待操作（agent 挂起等待用户）/ 通知（事情已发生） */
export type ToastTier = "action-pending" | "notify";

/** 提醒类别：任务完成 / 权限审批 / ASK 选择 / 抽查 / 计划审批 */
export type ToastKind =
  | "task-finished"
  | "approval"
  | "ask-choice"
  | "pop-quiz"
  | "plan-review";

/**
 * 跳转目标：用户点击 toast 时由主进程解析并转发激活代理；
 * 渲染端只上报"点了哪个 toast"，不参与跳转决策。
 * - session：切到指定会话（计划审批卡事件自带 sessionId）
 * - window：只激活窗口（审批/选择/抽查事件在主进程侧拿不到所属会话；
 *   任务完成结果落在任务历史而非聊天流）
 */
export type ToastTarget =
  | { type: "session"; sessionId: string }
  | { type: "window"; window: "chat" | "tasks" };

/** 主进程维护、推送给渲染页的 toast 条目 */
export interface ToastItem {
  id: string;
  kind: ToastKind;
  tier: ToastTier;
  /** 去重与结算匹配的业务身份：审批 id / 选择卡 id / quizId / schedulerRunId / 计划 runId */
  sourceId: string;
  title: string;
  summary?: string;
  target: ToastTarget;
  createdAt: number;
}

/** 推送给渲染页的载荷：条目 + 当次是否播提示音（设置页音效开关 + 并发合并后由主进程决定） */
export interface ToastPushPayload extends ToastItem {
  sound: boolean;
}

/** 移除原因：渲染页据此决定语音播报是否随之终止（仅超时消隐不打断播报） */
export type ToastRemoveReason = "timeout" | "user" | "settled";

/** 移除条目载荷：id + 消隐原因 */
export interface ToastRemovePayload {
  id: string;
  reason: ToastRemoveReason;
}

/** 主进程合成完任务语音后下发的播放载荷 */
export interface ToastTaskTtsPayload {
  /** 关联的 task-finished toast id：渲染页据此与卡片绑定（移除时停播） */
  toastId: string;
  /** base64 音频数据 */
  base64: string;
  /** 音频 MIME（audio/mpeg / audio/wav / audio/pcm） */
  mime: string;
}

/** 单窗口内最多同时显示的 toast 条数：等待操作档优先占位，超出容器内部滚动 */
export const TOAST_MAX_VISIBLE = 4;

/** preload 暴露给 toast 渲染页的 API 形状（contextBridge 穿透后仅保留函数） */
export interface ToastRendererApi {
  /** 页面加载/重载后恢复当前显示列表（主进程权威状态的快照） */
  getAll(): Promise<ToastItem[]>;
  /** 用户点击卡片主体：只上报 id，跳转由主进程解析 */
  clicked(id: string): void;
  /** 用户点关闭按钮：只上报 id，视觉消隐与否由主进程回执决定 */
  dismissed(id: string): void;
  /** 高度协议：上报内容区实际高度，主进程 clamp 后调整窗口尺寸 */
  reportHeight(height: number): void;
  /** 订阅推送（同 id 覆盖）；返回退订函数 */
  onPush(callback: (payload: ToastPushPayload) => void): () => void;
  /** 订阅移除（主进程已决定移除，渲染页播退出动画；reason 供语音播报决定是否随停）；返回退订函数 */
  onRemove(callback: (payload: ToastRemovePayload) => void): () => void;
  /** 订阅任务语音播报（主进程合成完成后下发；渲染页负责播放与随卡片移除停播） */
  onTaskTts(callback: (payload: ToastTaskTtsPayload) => void): () => void;
}
