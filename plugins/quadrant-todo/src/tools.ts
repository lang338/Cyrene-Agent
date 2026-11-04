/**
 * Agent 工具面（§八）：五个工具，全部只操作插件自有数据。
 * 三要素硬校验（措施一，真兜底）：时间/内容/分类任缺其一拒绝写入，报错
 * "缺时间"/"缺内容"/"缺分类"。任何写操作落地前后对该任务即时结算（§9.2 写时结算）。
 */
import { randomUUID } from "node:crypto";
import type { PluginTool } from "../../../src/plugins/api";
import { parseDeadline, settleTask, type SettleEvent, type SettleOptions } from "./quadrant";
import type { TaskStore } from "./store";
import {
  NO_DEADLINE_INPUTS,
  QUADRANT_INPUT,
  QUADRANT_LABELS,
  STATUS_LABELS,
  type Quadrant,
  type Task,
} from "./types";

export interface ToolsDeps {
  store: TaskStore;
  /** 可注入时钟（单测用）；默认系统时间 */
  now?: () => number;
  /** 结算事件出口（remind-* 事件的消费见 reminders.ts/index.ts） */
  onSettleEvents?: (task: Task, events: SettleEvent[]) => void;
  /** 任何数据变更（登记/修改/完成/删除）后回调——提醒计时器据此重排（§8.2） */
  onStoreChanged?: () => void;
  log?: (...args: unknown[]) => void;
}

const ERR_NO_CONTENT = "登记失败：缺内容（事项内容不能为空）";
const ERR_NO_TIME = "登记失败：缺时间（时间须为“xx年xx月xx日xx小时xx分钟”或“无明确截止时间”二者其一，最低到日期）";
const ERR_NO_QUADRANT = "登记失败：缺分类（分类只能是“重要紧急/重要不紧急/不重要紧急/不重要不紧急”四词之一，且须由用户明确回答）";

/** deadline 工具入参 → 存储值；"无明确截止时间"（及宽容别名）归 null，其余须可解析 */
function parseDeadlineInput(raw: unknown): { ok: true; value: string | null } | { ok: false } {
  if (typeof raw !== "string") return { ok: false };
  const s = raw.trim();
  if (!s) return { ok: false };
  if (NO_DEADLINE_INPUTS.has(s)) return { ok: true, value: null };
  if (parseDeadline(s)) return { ok: true, value: s };
  return { ok: false };
}

function parseQuadrantInput(raw: unknown): Quadrant | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  // 须 own-property 检查：普通对象的 "constructor"/"toString" 会命中原型链
  // 返回继承函数（truthy），绕过"缺分类"硬校验（CodeRabbit 评审发现）
  return Object.hasOwn(QUADRANT_INPUT, s) ? QUADRANT_INPUT[s] : null;
}

/** update 的 status 入参："auto-done" 单列（属程序结算专属，拒收） */
function parseStatusInput(raw: unknown): "pending" | "done" | "auto-done" | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (s === "pending" || s === "未完成") return "pending";
  if (s === "done" || s === "已完成") return "done";
  if (s === "auto-done" || s === "默认完成") return "auto-done";
  return null;
}

function formatDeadline(deadline: string | null): string {
  return deadline ?? "无明确截止时间";
}

function describeTask(task: Task): string {
  const quadrant = QUADRANT_LABELS[task.quadrant];
  const status = STATUS_LABELS[task.status];
  return `「${task.content}」（${quadrant}，截止 ${formatDeadline(task.deadline)}，${status}）`;
}

/**
 * 宿主 chat 模式（昔涟日常对话）只把 chatBuiltin === true 的工具放进模型清单
 * （run-capabilities.ts / build-options.ts 白名单机制），其余插件工具需用户在
 * 设置里手动 opt-in。PluginTool 端口类型未文档化此字段，但宿主信任边界
 * （plugin-runtime.ts）按 as 直转透传——交叉类型补字段即可，官方宿主同样生效。
 */
type ChatPluginTool = PluginTool & { chatBuiltin?: boolean };

export function buildTools(deps: ToolsDeps): PluginTool[] {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});

  const emit = (task: Task, events: SettleEvent[]): void => {
    if (events.length > 0) deps.onSettleEvents?.(task, events);
  };

  /** 写时结算：结算→最终状态写回 store（update/complete 传入的是未入库新对象，必须写；add 场景写回同引用幂等）→抛事件 */
  const settleAndPersist = (task: Task, options: SettleOptions = {}): Task => {
    const r = settleTask(task, now(), options);
    deps.store.replace(r.task);
    emit(r.task, r.events);
    return r.task;
  };

  const addTask: ChatPluginTool = {
    id: "quadrant-todo_add_task",
    chatBuiltin: true,
    name: "登记待办",
    description:
      "把一条待办登记进四象限待办列表。调用前必须完成属性收集：四象限分类只能由用户明确回答（可以建议，不得代答）；时间与内容以用户表述为准，缺什么追问什么，三项属性齐备前不得调用本工具；属性收集过程即确认，调用前不做整体复述。",
    enabled: true,
    risk: "safe",
    effectKind: "mutation",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "事项内容本身" },
        deadline: {
          type: "string",
          description:
            "截止时间，取值三选一：“YYYY-MM-DD HH:mm”、“YYYY-MM-DD”（按当天 00:00 计）、字面值“无明确截止时间”",
        },
        quadrant: {
          type: "string",
          enum: ["重要紧急", "重要不紧急", "不重要紧急", "不重要不紧急"],
          description: "四象限分类，必须由用户明确回答",
        },
      },
      required: ["content", "deadline", "quadrant"],
    },
    async execute(args) {
      const content = typeof args.content === "string" ? args.content.trim() : "";
      if (!content) return ERR_NO_CONTENT;

      const deadline = parseDeadlineInput(args.deadline);
      if (!deadline.ok) return ERR_NO_TIME;

      const quadrant = parseQuadrantInput(args.quadrant);
      if (!quadrant) return ERR_NO_QUADRANT;

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
      deps.onStoreChanged?.();
      log(`登记待办: ${settled.content}`);
      return `已登记待办：${describeTask(settled)}`;
    },
  };

  const updateTask: ChatPluginTool = {
    id: "quadrant-todo_update_task",
    chatBuiltin: true,
    name: "修改待办属性",
    description:
      "修改一条未完成待办的属性（内容/截止时间/四象限分类/完成状态），至少给出一项。修改截止时间会自动滑回被滑动改写的分类并重置提醒（新一轮）；手动改分类会清除滑动记录。仅用户提出修改需求时调用。",
    enabled: true,
    risk: "safe",
    effectKind: "mutation",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "待办 id，来自 list_tasks 返回" },
        content: { type: "string", description: "新的内容（可选）" },
        deadline: {
          type: "string",
          description: "新的截止时间（可选），格式同 add_task；变更即新一轮提醒",
        },
        quadrant: {
          type: "string",
          enum: ["重要紧急", "重要不紧急", "不重要紧急", "不重要不紧急"],
          description: "新的分类（可选）",
        },
        status: {
          type: "string",
          enum: ["pending", "done"],
          description: "完成状态（可选）：done=已完成；默认完成由程序结算产生，不能手动设置",
        },
      },
      required: ["id"],
    },
    async execute(args) {
      const id = typeof args.id === "string" ? args.id : "";
      const task = deps.store.get(id);
      if (!task) return "未找到该待办，可用 quadrant-todo_list_tasks 查看现有列表。";
      if (task.status !== "pending") {
        return "该待办已是完成态，不支持修改属性；如发现没做完，可删除后重新登记（反悔）。";
      }

      let next = task;
      let deadlineChanged = false;

      if (args.content !== undefined) {
        const content = typeof args.content === "string" ? args.content.trim() : "";
        if (!content) return "修改失败：内容不能为空。";
        next = { ...next, content };
      }
      if (args.quadrant !== undefined) {
        const quadrant = parseQuadrantInput(args.quadrant);
        if (!quadrant) return "修改失败：分类无效（只能是四词之一）。";
        // §七：用户手动改分类直接覆盖并清除滑动记录
        next = { ...next, quadrant, slidFrom: undefined };
      }
      if (args.deadline !== undefined) {
        const deadline = parseDeadlineInput(args.deadline);
        if (!deadline.ok) return "修改失败：时间格式无效（须为“YYYY-MM-DD HH:mm”、“YYYY-MM-DD”或“无明确截止时间”）。";
        if (deadline.value !== next.deadline) {
          next = { ...next, deadline: deadline.value };
          deadlineChanged = true;
        }
      }
      if (args.status !== undefined) {
        const status = parseStatusInput(args.status);
        if (status === null) return "修改失败：完成状态无效。";
        if (status === "auto-done") return "默认完成状态由程序到点结算产生，不能手动设置。";
        if (status === "done") next = { ...next, status: "done", completedAt: now() };
      }

      if (next === task) return "没有需要修改的属性，请至少给出一项。";

      const settled = settleAndPersist(next, { deadlineChanged });
      deps.onStoreChanged?.();
      log(`修改待办: ${settled.content}`);
      return `已修改待办：${describeTask(settled)}`;
    },
  };

  const completeTask: ChatPluginTool = {
    id: "quadrant-todo_complete_task",
    chatBuiltin: true,
    name: "标记待办完成",
    description: "把一条未完成待办标记为已完成。仅在用户明确告知该任务已完成时调用。",
    enabled: true,
    risk: "safe",
    effectKind: "mutation",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "待办 id，来自 list_tasks 返回" },
      },
      required: ["id"],
    },
    async execute(args) {
      const id = typeof args.id === "string" ? args.id : "";
      const task = deps.store.get(id);
      if (!task) return "未找到该待办，可用 quadrant-todo_list_tasks 查看现有列表。";
      if (task.status === "done") return "该待办此前已被标记为已完成。";
      if (task.status === "auto-done") return "该待办已到点自动转为默认完成，无需再标记。";
      const next: Task = { ...task, status: "done", completedAt: now() };
      const settled = settleAndPersist(next);
      deps.onStoreChanged?.();
      log(`完成待办: ${settled.content}`);
      return `已完成：${describeTask(settled)}`;
    },
  };

  const deleteTask: ChatPluginTool = {
    id: "quadrant-todo_delete_task",
    chatBuiltin: true,
    name: "删除待办",
    description:
      "从待办列表删除一条记录（纯删除，不新建）。必须是用户明确要求删除的才能调用，禁止自行判断清理。完成态任务删除后如需重做，请走新建流程（反悔）。",
    enabled: true,
    risk: "safe",
    effectKind: "mutation",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "待办 id，来自 list_tasks 返回" },
      },
      required: ["id"],
    },
    async execute(args) {
      const id = typeof args.id === "string" ? args.id : "";
      const task = deps.store.get(id);
      if (!task) return "未找到该待办，可用 quadrant-todo_list_tasks 查看现有列表。";
      deps.store.remove(id);
      deps.onStoreChanged?.();
      log(`删除待办: ${task.content}`);
      return `已删除待办：${describeTask(task)}`;
    },
  };

  const listTasks: ChatPluginTool = {
    id: "quadrant-todo_list_tasks",
    chatBuiltin: true,
    name: "查询待办列表",
    description:
      "查询四象限待办的实际内容。回答“我有什么要做”或对待办个数/内容有疑问时，必须以本工具返回为准，不以记忆为准（用户可能在界面手动修改过）。",
    enabled: true,
    risk: "safe",
    effectKind: "read",
    inputSchema: {
      type: "object",
      properties: {
        scope: {
          type: "string",
          enum: ["active", "completed", "all"],
          description: "查询范围：active=未完成（默认）、completed=已完成（含默认完成）、all=全部",
        },
      },
      required: [],
    },
    async execute(args) {
      const scope = typeof args.scope === "string" ? args.scope : "active";
      const tasks = deps.store.list();

      const render = (t: Task): string => {
        const base = `- [${t.id}] ${t.content} ｜ ${QUADRANT_LABELS[t.quadrant]} ｜ 截止 ${formatDeadline(t.deadline)} ｜ ${STATUS_LABELS[t.status]}`;
        return t.completedAt ? `${base}（完成于 ${new Date(t.completedAt).toLocaleString("zh-CN")}）` : base;
      };

      if (scope === "completed") {
        const done = tasks
          .filter((t) => t.status !== "pending")
          .sort((a, b) => (a.completedAt ?? a.createdAt) - (b.completedAt ?? b.createdAt));
        if (done.length === 0) return "已完成列表为空。";
        return done.map(render).join("\n");
      }
      if (scope === "all") {
        if (tasks.length === 0) return "待办列表为空。";
        const pending = tasks.filter((t) => t.status === "pending");
        const done = tasks.filter((t) => t.status !== "pending");
        const lines = ["【未完成】", ...pending.map(render), "【已完成】", ...done.map(render)];
        return lines.join("\n");
      }
      const pending = tasks.filter((t) => t.status === "pending");
      if (pending.length === 0) return "当前没有未完成的待办。";
      return pending.map(render).join("\n");
    },
  };

  return [addTask, updateTask, completeTask, deleteTask, listTasks];
}
