/**
 * 工作台数据桥（§3.36 UI 操作 → 功能一规则的落点）：渲染页经 invoke 通道调用，
 * 本层把 UI 操作翻译成与工具面同构的存储/结算编排——写操作全部走
 * "结算 → 落库 → 抛事件"，保证 UI 修改与对话修改共享同一套规则
 * （滑动/滑回/默认完成/提醒触发），并驱动提醒计时器重排。
 *
 * 与工具面的差异：UI 路径的用户表态由用户本人操作天然保证（§3.13 双保险的
 * UI 侧），无需 LLM 自检项；报错文案直接面向界面展示。
 * 设置面（§3.4/§3.43）：NapCat 地址/token/目标 QQ 存插件自有存储 key "settings"，
 * 本期只做配置入口与存储，外发通道随 M6 功能四实现。
 */
import { randomUUID } from "node:crypto";
import type { PluginStorage } from "../../../src/plugins/api";
import { evaluateGoalCompletion, sameInstant, settleTask, type SettleEvent, type TreeKind } from "./quadrant";
import { parseDeadlineInput, parseQuadrantInput } from "./tools";
import type { TaskStore } from "./store";
import { NO_DEADLINE_INPUTS, type Quadrant, type Status, type Task } from "./types";

const SETTINGS_KEY = "settings";

/** NapCat 外发配置（§3.42 前提配置）；未配置时外发通道整体跳过（优雅降级） */
export interface NapCatSettings {
  /** OneBot HTTP 服务地址，如 http://127.0.0.1:3000 */
  url?: string;
  /** access token */
  token?: string;
  /** 目标 QQ 号 */
  targetQq?: string;
}

export type UiOpResult =
  | { ok: true; task?: Task }
  | { ok: false; error: string };

export interface UiBridgeDeps {
  store: TaskStore;
  storage: PluginStorage;
  /** 可注入时钟（单测用）；默认系统时间 */
  now?: () => number;
  /** 结算事件出口（与工具面共用同一个 settleDeps.onSettleEvents：remind-* → 系统通知） */
  onSettleEvents?: (task: Task, events: SettleEvent[]) => void;
  /** 任何数据变更后回调——提醒计时器据此重排（§8.2） */
  onStoreChanged?: () => void;
  log?: (...args: unknown[]) => void;
}

/** settings 存储值形态守卫：非对象/缺字段一律按空配置处理（读路径 fail-safe） */
function readSettings(storage: PluginStorage): NapCatSettings {
  const raw = storage.get<unknown>(SETTINGS_KEY);
  if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const obj = raw as Record<string, unknown>;
  const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  return { url: str(obj.url), token: str(obj.token), targetQq: str(obj.targetQq) };
}

const ERR_EDIT_DONE = "完成态任务不支持修改属性，可在已完成列表删除后重走新建（反悔）。";
const ERR_COMPLETE_DONE = "该待办已是完成态。";
const ERR_NOT_FOUND = "未找到该待办，请刷新后重试。";

export function createUiBridge(deps: UiBridgeDeps) {
  const now = deps.now ?? Date.now;

  /** 树内机制资格（§3.24）：与 tools.ts 同规则，按数据形态推导 */
  const kindOf = (t: Task): TreeKind => {
    if (t.parentId) return "child";
    return deps.store.list().some((c) => c.parentId === t.id) ? "goal" : "normal";
  };

  /** 写时结算编排（与 tools.ts settleAndPersist 同形）：结算→落库→抛事件。kind 按数据形态推导 */
  const settleAndPersist = (task: Task, options: Parameters<typeof settleTask>[2] = {}): Task => {
    const r = settleTask(task, now(), options, kindOf(task));
    deps.store.replace(r.task);
    if (r.events.length > 0) deps.onSettleEvents?.(r.task, r.events);
    return r.task;
  };

  /** 大目标默认完成联动（§3.25）：小目标写入后评估其父级 */
  const settleParentLinkage = (child: Task): void => {
    if (!child.parentId) return;
    const parent = deps.store.get(child.parentId);
    if (!parent || parent.status !== "pending") return;
    const children = deps.store.list().filter((t) => t.parentId === parent.id);
    const r = evaluateGoalCompletion(parent, children, now());
    if (r) {
      deps.store.replace(r.task);
      if (r.events.length > 0) deps.onSettleEvents?.(r.task, r.events);
    }
  };

  /** 大目标删除连带（§3.26）：连带删除其下全部小目标，返回连带条数 */
  const cascadeDeleteChildren = (goalId: string): number => {
    const children = deps.store.list().filter((t) => t.parentId === goalId);
    for (const c of children) deps.store.remove(c.id);
    return children.length;
  };

  /** 大目标手动标完成连带（§3.25）：未完成小目标连带标"已完成" */
  const cascadeCompleteChildren = (goalId: string): number => {
    let n = 0;
    for (const c of deps.store.list().filter((t) => t.parentId === goalId)) {
      if (c.status === "pending") {
        deps.store.replace({ ...c, status: "done", completedAt: now() });
        n += 1;
      }
    }
    return n;
  };

  const changed = (): void => {
    deps.onStoreChanged?.();
  };

  return {
    /** 全量数据：UI 自行按形态分组（未完成/已完成） */
    load(): { tasks: Task[]; settings: NapCatSettings } {
      return { tasks: [...deps.store.list()], settings: readSettings(deps.storage) };
    },

    /** UI 新建（反悔"删除+新建"的新建半步）：三要素校验与工具面同源，UI 操作即用户表态。
     * input.parentId 存在 = 挂入大目标的小目标（分类随父级、截止时间须到时分） */
    addTask(input: unknown): UiOpResult {
      const args = (input ?? {}) as Record<string, unknown>;
      const content = typeof args.content === "string" ? args.content.trim() : "";
      if (!content) return { ok: false, error: "内容不能为空。" };

      const deadline = parseDeadlineInput(args.deadline);
      if (!deadline.ok) return { ok: false, error: "时间无效：须为具体日期时间，或勾选“无明确截止时间”。" };

      const parentId = typeof args.parentId === "string" ? args.parentId.trim() : "";
      let quadrant: Quadrant;
      if (parentId) {
        const parent = deps.store.get(parentId);
        if (!parent) return { ok: false, error: "未找到该大目标。" };
        if (parent.parentId) return { ok: false, error: "小目标只能挂在顶层大目标下。" };
        if (parent.status !== "pending") return { ok: false, error: "该大目标已是完成态，不能再挂小目标。" };
        if (!deadline.value || deadline.value.length <= 10) {
          return { ok: false, error: "小目标的截止时间须精确到时分。" };
        }
        quadrant = parent.quadrant; // 分类从属大目标（§3.23）
      } else {
        const parsed = parseQuadrantInput(args.quadrant);
        if (!parsed) return { ok: false, error: "分类无效：只能从四个象限中选择。" };
        quadrant = parsed;
      }

      const task: Task = {
        id: randomUUID(),
        content,
        deadline: deadline.value,
        quadrant,
        status: "pending",
        createdAt: now(),
        ...(parentId ? { parentId, reminder: null } : {}),
      };
      deps.store.add(task);
      const settled = settleAndPersist(task);
      if (parentId) settleParentLinkage(settled);
      changed();
      deps.log?.(`UI 登记待办: ${settled.content}`);
      return { ok: true, task: settled };
    },

    /** 编辑未完成待办属性（内容/截止时间/分类）；改期自动滑回并重置提醒（新一轮） */
    updateTask(id: unknown, patch: unknown): UiOpResult {
      const tid = typeof id === "string" ? id : "";
      const stored = deps.store.get(tid);
      if (!stored) return { ok: false, error: ERR_NOT_FOUND };
      // 先结算再校验（§8.1 写时结算）：工作台可能赶在小时扫描前拿到过期任务，
      // 先让它走完默认完成/滑动结算，再做编辑资格判定（CodeRabbit 评审）
      const task = settleAndPersist(stored);
      const reject = (error: string): UiOpResult => {
        if (task !== stored) changed();
        return { ok: false, error };
      };
      if (task.status !== "pending") return reject(ERR_EDIT_DONE);
      const isChild = !!task.parentId;
      const isGoal = !isChild && deps.store.list().some((c) => c.parentId === task.id);

      const p = (patch ?? {}) as Record<string, unknown>;
      let next = task;
      let deadlineChanged = false;

      if (p.content !== undefined) {
        const content = typeof p.content === "string" ? p.content.trim() : "";
        if (!content) return reject("内容不能为空。");
        next = { ...next, content };
      }
      if (p.quadrant !== undefined) {
        const quadrant = parseQuadrantInput(p.quadrant);
        if (!quadrant) return reject("分类无效：只能从四个象限中选择。");
        // §3.23：小目标分类从属大目标，不可直接修改
        if (isChild) return reject("小目标的分类随大目标，如需调整请修改大目标分类。");
        // 等值跳过：工作台每次编辑都全量回传三属性，同值回传不算"手动改分类"
        // ——否则会清掉滑动记录，让后续改期无法自动滑回（CodeRabbit 评审）
        if (quadrant !== next.quadrant) {
          // §七：手动改分类直接覆盖并清除滑动记录
          next = { ...next, quadrant, slidFrom: undefined };
        }
      }
      if (p.deadline !== undefined) {
        const deadline = parseDeadlineInput(p.deadline);
        if (!deadline.ok) return reject("时间无效：须为具体日期时间，或勾选“无明确截止时间”。");
        // 等值跳过：日期型 deadline 在编辑器里被补全成 "YYYY-MM-DD 00:00"，
        // 字符串不等但时刻相等，视为未变更（否则提醒标记被误清、重复提醒）
        const changedDeadline = !sameInstant(next.deadline, deadline.value);
        if (changedDeadline) {
          next = { ...next, deadline: deadline.value };
          deadlineChanged = true;
        }
      }
      if (next === task) return reject("没有需要修改的属性。");

      // 大目标级联（§3.26/§3.25）：改分类 → 小目标跟随；手动标完成 → 未完成小目标连带完成
      const cascadeQuadrant = isGoal && next.quadrant !== task.quadrant ? next.quadrant : null;
      const manualDone = isGoal && next.status === "done";

      const settled = settleAndPersist(next, { deadlineChanged });
      if (cascadeQuadrant) {
        for (const c of deps.store.list().filter((t) => t.parentId === settled.id)) {
          deps.store.replace({ ...c, quadrant: cascadeQuadrant });
        }
      }
      if (manualDone) cascadeCompleteChildren(settled.id);
      if (settled.parentId) settleParentLinkage(settled);
      changed();
      deps.log?.(`UI 修改待办: ${settled.content}`);
      return { ok: true, task: settled };
    },

    /** 标记完成（仅未完成态；status 仅接受 done——默认完成由结算产生） */
    completeTask(id: unknown, status?: unknown): UiOpResult {
      const tid = typeof id === "string" ? id : "";
      const stored = deps.store.get(tid);
      if (!stored) return { ok: false, error: ERR_NOT_FOUND };
      // 先结算再校验：过期未扫描的 pending 任务先转默认完成，再拒绝手动完成
      const task = settleAndPersist(stored);
      const reject = (error: string): UiOpResult => {
        if (task !== stored) changed();
        return { ok: false, error };
      };
      if (task.status !== "pending") return reject(ERR_COMPLETE_DONE);
      if (status !== undefined && status !== "done") return reject("完成状态仅支持标记完成。");

      const settled = settleAndPersist({ ...task, status: "done" as Status, completedAt: now() });
      // 大目标手动标完成（§3.25）：未完成小目标连带标"已完成"；小目标完成 → 父级联动评估
      if (!settled.parentId && deps.store.list().some((t) => t.parentId === settled.id)) {
        cascadeCompleteChildren(settled.id);
      }
      if (settled.parentId) settleParentLinkage(settled);
      changed();
      deps.log?.(`UI 完成待办: ${settled.content}`);
      return { ok: true, task: settled };
    },

    /** 纯删除（§3.36：待办与完成态都可删；反悔的删除半步也走这里）。
     * 删除大目标 = 连带删除其下全部小目标（§3.26，UI 侧弹连带确认提示） */
    removeTask(id: unknown): UiOpResult {
      const tid = typeof id === "string" ? id : "";
      const task = deps.store.get(tid);
      if (!task) return { ok: false, error: ERR_NOT_FOUND };
      deps.store.remove(tid);
      const cascaded = cascadeDeleteChildren(tid);
      if (cascaded > 0) deps.log?.(`UI 删除待办: ${task.content}（连带 ${cascaded} 条小目标）`);
      changed();
      deps.log?.(`UI 删除待办: ${task.content}`);
      return { ok: true };
    },

    getSettings(): NapCatSettings {
      return readSettings(deps.storage);
    },

    /** 保存 NapCat 配置（§3.43 配置面）：全量覆盖写入，字段可显式清空 */
    saveSettings(input: unknown): { ok: true; settings: NapCatSettings } | { ok: false; error: string } {
      const p = (input ?? {}) as Record<string, unknown>;
      const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
      if (p.url !== undefined && str(p.url) === undefined && p.url !== "") {
        return { ok: false, error: "地址须为文本。" };
      }
      const settings: NapCatSettings = {
        url: str(p.url),
        token: str(p.token),
        targetQq: str(p.targetQq),
      };
      deps.storage.set(SETTINGS_KEY, settings);
      deps.log?.("UI 保存 NapCat 配置");
      return { ok: true, settings };
    },
  };
}

/** 渲染端可用的象限/状态展示常量（与 types.ts 中文映射保持同源语义） */
export const UI_LABELS = {
  quadrants: ["重要紧急", "重要不紧急", "不重要紧急", "不重要不紧急"] as const,
  noDeadline: NO_DEADLINE_INPUTS,
} satisfies { quadrants: readonly string[]; noDeadline: ReadonlySet<string> };

export type { Quadrant, Task };
