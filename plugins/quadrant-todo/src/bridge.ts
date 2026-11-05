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
import { parseDeadline, settleTask, type SettleEvent } from "./quadrant";
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

/**
 * 两个 deadline 存储值是否指向同一时刻：字符串不同但时刻相同（如
 * "2026-11-10" 与 "2026-11-10 00:00"）视为等值；任一端不可解析（null/非法）
 * 时退回字符串判等——null 与带时刻的值互为真变更。
 */
function sameInstant(a: string | null, b: string | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  const da = parseDeadline(a);
  const db = parseDeadline(b);
  if (!da || !db) return false;
  return da.getTime() === db.getTime();
}

export function createUiBridge(deps: UiBridgeDeps) {
  const now = deps.now ?? Date.now;

  /** 写时结算编排（与 tools.ts settleAndPersist 同形）：结算→落库→抛事件 */
  const settleAndPersist = (task: Task, options: Parameters<typeof settleTask>[2] = {}): Task => {
    const r = settleTask(task, now(), options);
    deps.store.replace(r.task);
    if (r.events.length > 0) deps.onSettleEvents?.(r.task, r.events);
    return r.task;
  };

  const changed = (): void => {
    deps.onStoreChanged?.();
  };

  return {
    /** 全量数据：UI 自行按形态分组（未完成/已完成） */
    load(): { tasks: Task[]; settings: NapCatSettings } {
      return { tasks: [...deps.store.list()], settings: readSettings(deps.storage) };
    },

    /** UI 新建（反悔"删除+新建"的新建半步）：三要素校验与工具面同源，UI 操作即用户表态 */
    addTask(input: unknown): UiOpResult {
      const args = (input ?? {}) as Record<string, unknown>;
      const content = typeof args.content === "string" ? args.content.trim() : "";
      if (!content) return { ok: false, error: "内容不能为空。" };

      const deadline = parseDeadlineInput(args.deadline);
      if (!deadline.ok) return { ok: false, error: "时间无效：须为具体日期时间，或勾选“无明确截止时间”。" };

      const quadrant = parseQuadrantInput(args.quadrant);
      if (!quadrant) return { ok: false, error: "分类无效：只能从四个象限中选择。" };

      const task: Task = {
        id: randomUUID(),
        content,
        deadline: deadline.value,
        quadrant,
        status: "pending",
        createdAt: now(),
      };
      deps.store.add(task);
      const settled = settleAndPersist(task);
      changed();
      deps.log?.(`UI 登记待办: ${settled.content}`);
      return { ok: true, task: settled };
    },

    /** 编辑未完成待办属性（内容/截止时间/分类）；改期自动滑回并重置提醒（新一轮） */
    updateTask(id: unknown, patch: unknown): UiOpResult {
      const tid = typeof id === "string" ? id : "";
      const task = deps.store.get(tid);
      if (!task) return { ok: false, error: ERR_NOT_FOUND };
      if (task.status !== "pending") return { ok: false, error: ERR_EDIT_DONE };

      const p = (patch ?? {}) as Record<string, unknown>;
      let next = task;
      let deadlineChanged = false;

      if (p.content !== undefined) {
        const content = typeof p.content === "string" ? p.content.trim() : "";
        if (!content) return { ok: false, error: "内容不能为空。" };
        next = { ...next, content };
      }
      if (p.quadrant !== undefined) {
        const quadrant = parseQuadrantInput(p.quadrant);
        if (!quadrant) return { ok: false, error: "分类无效：只能从四个象限中选择。" };
        // 等值跳过：工作台每次编辑都全量回传三属性，同值回传不算"手动改分类"
        // ——否则会清掉滑动记录，让后续改期无法自动滑回（CodeRabbit 评审）
        if (quadrant !== next.quadrant) {
          // §七：手动改分类直接覆盖并清除滑动记录
          next = { ...next, quadrant, slidFrom: undefined };
        }
      }
      if (p.deadline !== undefined) {
        const deadline = parseDeadlineInput(p.deadline);
        if (!deadline.ok) return { ok: false, error: "时间无效：须为具体日期时间，或勾选“无明确截止时间”。" };
        // 等值跳过：日期型 deadline 在编辑器里被补全成 "YYYY-MM-DD 00:00"，
        // 字符串不等但时刻相等，视为未变更（否则提醒标记被误清、重复提醒）
        const changed = !sameInstant(next.deadline, deadline.value);
        if (changed) {
          next = { ...next, deadline: deadline.value };
          deadlineChanged = true;
        }
      }
      if (next === task) return { ok: false, error: "没有需要修改的属性。" };

      const settled = settleAndPersist(next, { deadlineChanged });
      changed();
      deps.log?.(`UI 修改待办: ${settled.content}`);
      return { ok: true, task: settled };
    },

    /** 标记完成（仅未完成态；status 仅接受 done——默认完成由结算产生） */
    completeTask(id: unknown, status?: unknown): UiOpResult {
      const tid = typeof id === "string" ? id : "";
      const task = deps.store.get(tid);
      if (!task) return { ok: false, error: ERR_NOT_FOUND };
      if (task.status !== "pending") return { ok: false, error: ERR_COMPLETE_DONE };
      if (status !== undefined && status !== "done") return { ok: false, error: "完成状态仅支持标记完成。" };

      const settled = settleAndPersist({ ...task, status: "done" as Status, completedAt: now() });
      changed();
      deps.log?.(`UI 完成待办: ${settled.content}`);
      return { ok: true, task: settled };
    },

    /** 纯删除（§3.36：待办与完成态都可删；反悔的删除半步也走这里） */
    removeTask(id: unknown): UiOpResult {
      const tid = typeof id === "string" ? id : "";
      const task = deps.store.get(tid);
      if (!task) return { ok: false, error: ERR_NOT_FOUND };
      deps.store.remove(tid);
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
