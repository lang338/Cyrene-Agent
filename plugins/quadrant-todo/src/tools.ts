/**
 * Agent 工具面（§八）：五个工具，全部只操作插件自有数据。
 * 三要素硬校验（措施一，真兜底）：时间/内容/分类任缺其一拒绝写入，报错
 * "缺时间"/"缺内容"/"缺分类"。任何写操作落地前后对该任务即时结算（§9.2 写时结算）。
 */
import { randomUUID } from "node:crypto";
import type { PluginTool } from "../../../src/plugins/api";
import { evaluateGoalCompletion, parseDeadline, sameInstant, settleTask, type SettleEvent, type SettleOptions, type TreeKind } from "./quadrant";
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
const ERR_NO_CONFIRM = "登记失败：分类未获用户确认（先用自然的方式问清这件事重不重要、急不着急，得到用户明确回答后重试）";

/** deadline 工具入参 → 存储值；"无明确截止时间"（及宽容别名）归 null，其余须可解析（UI 桥接层复用） */
export function parseDeadlineInput(raw: unknown): { ok: true; value: string | null } | { ok: false } {
  if (typeof raw !== "string") return { ok: false };
  const s = raw.trim();
  if (!s) return { ok: false };
  if (NO_DEADLINE_INPUTS.has(s)) return { ok: true, value: null };
  if (parseDeadline(s)) return { ok: true, value: s };
  return { ok: false };
}

/** 四词中文 → 存储枚举；own-property 检查防原型链绕过（UI 桥接层复用） */
export function parseQuadrantInput(raw: unknown): Quadrant | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  // 须 own-property 检查：普通对象的 "constructor"/"toString" 会命中原型链
  // 返回继承函数（truthy），绕过"缺分类"硬校验（CodeRabbit 评审发现）
  const mapped = Object.hasOwn(QUADRANT_INPUT, s) ? QUADRANT_INPUT[s] : undefined;
  return mapped ?? null;
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

  /** 树内机制资格（§3.24）：按数据形态推导——带 parentId 即小目标，被引用即大目标 */
  const kindOf = (t: Task): TreeKind => {
    if (t.parentId) return "child";
    return deps.store.list().some((c) => c.parentId === t.id) ? "goal" : "normal";
  };

  /** 写时结算：结算→最终状态写回 store（update/complete 传入的是未入库新对象，必须写；add 场景写回同引用幂等）→抛事件。kind 按数据形态推导 */
  const settleAndPersist = (task: Task, options: SettleOptions = {}): Task => {
    const r = settleTask(task, now(), options, kindOf(task));
    deps.store.replace(r.task);
    emit(r.task, r.events);
    return r.task;
  };

  /** 大目标默认完成联动（§3.25）：小目标写入后评估其父级——已到时限 且 所有小目标完成即自动转 */
  const settleParentLinkage = (child: Task): void => {
    if (!child.parentId) return;
    const parent = deps.store.get(child.parentId);
    if (!parent || parent.status !== "pending") return;
    const children = deps.store.list().filter((t) => t.parentId === parent.id);
    const r = evaluateGoalCompletion(parent, children, now());
    if (r) {
      deps.store.replace(r.task);
      emit(r.task, r.events);
    }
  };

  /** 小目标挂载校验（§3.22/§3.23）：父级须为未完成的顶层大目标，不支持嵌套 */
  const validateParentForChild = (parentId: string): string | null => {
    const parent = deps.store.get(parentId);
    if (!parent) return "未找到该大目标，可用 quadrant-todo_list_tasks 查看现有列表。";
    if (parent.parentId) return "小目标只能挂在顶层大目标下，不支持嵌套。";
    if (parent.status !== "pending") return "该大目标已是完成态，不能再挂小目标。";
    return null;
  };

  /** 大目标删除连带（§3.26）：连带删除其下全部小目标，返回连带条数 */
  const cascadeDeleteChildren = (goalId: string): number => {
    const children = deps.store.list().filter((t) => t.parentId === goalId);
    for (const c of children) deps.store.remove(c.id);
    return children.length;
  };

  /** 大目标手动标完成连带（§3.25）：其下全部未完成小目标连带标"已完成"（亮灰），返回连带条数 */
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

  const addTask: ChatPluginTool = {
    id: "quadrant-todo_add_task",
    chatBuiltin: true,
    name: "登记待办",
    description:
      "把一条待办登记进四象限待办列表，也用于登记大目标拆解出的小目标。顶层任务：调用前必须完成属性收集——四象限分类只能由用户明确回答（可以建议，不得代答），时间与内容以用户表述为准，缺什么追问什么，属性齐备前不得调用。小目标（传 parentId 挂入大目标）：分类自动随大目标（无需询问、无需确认门），截止时间须精确到时分，录入前逐个询问用户是否需要提醒（需要且为单次时刻时传 reminder；仅在用户要求时设置）。属性收集过程即确认，调用前不做整体复述。",
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
            "截止时间，取值三选一：“YYYY-MM-DD HH:mm”、“YYYY-MM-DD”（按当天 00:00 计）、字面值“无明确截止时间”。小目标须精确到时分",
        },
        quadrant: {
          type: "string",
          enum: ["重要紧急", "重要不紧急", "不重要紧急", "不重要不紧急"],
          description: "四象限分类，顶层任务必须由用户明确回答；登记小目标时省略（自动随大目标）",
        },
        quadrantConfirmed: {
          type: "boolean",
          description:
            "顶层任务提交前必答自检：是否已获得用户对四象限分类的明确表态（提问卡片点选或文字回答都算）？用户尚未表态时必须传 false（程序将拒绝本次登记），严禁未经询问就传 true。登记小目标时省略",
        },
        parentId: {
          type: "string",
          description: "（可选）所属大目标 id——登记大目标拆解出的小目标时传入；分类自动随大目标",
        },
        reminder: {
          type: "object",
          description:
            '（可选，仅小目标）自定义提醒：{"type":"once","at":"YYYY-MM-DD HH:mm"} 单次时刻。仅按用户要求设置，用户没要求不传',
          properties: {
            type: { type: "string", enum: ["once"] },
            at: { type: "string", description: "提醒时刻 YYYY-MM-DD HH:mm" },
          },
        },
      },
      required: ["content", "deadline"],
    },
    async execute(args) {
      const content = typeof args.content === "string" ? args.content.trim() : "";
      if (!content) return ERR_NO_CONTENT;

      const deadline = parseDeadlineInput(args.deadline);
      if (!deadline.ok) return ERR_NO_TIME;

      // 功能二：parentId 存在即小目标录入（§3.22/§3.23）
      const parentId = typeof args.parentId === "string" ? args.parentId.trim() : "";
      const parentErr = parentId ? validateParentForChild(parentId) : null;
      if (parentErr) return parentErr;

      let quadrant: Quadrant;
      if (parentId) {
        // 小目标时间精确时限，最低到时分（§3.23）——日期型按 00:00 计，不算时分
        if (!deadline.value || deadline.value.length <= 10) {
          return "登记失败：小目标的截止时间须精确到时分（“YYYY-MM-DD HH:mm”）。";
        }
        // 小目标分类从属大目标：继承父级，无需用户拍板，不算缺分类（§3.23）
        quadrant = deps.store.get(parentId)!.quadrant;
      } else {
        // 分类确认门（§六硬校验）：模型先答"是否已获用户表态"，否/缺省即拒写；
        // 确认放行后再校验分类取值本身
        if (args.quadrantConfirmed !== true) return ERR_NO_CONFIRM;
        const parsed = parseQuadrantInput(args.quadrant);
        if (!parsed) return ERR_NO_QUADRANT;
        quadrant = parsed;
      }

      // 小目标自定义提醒（可选，仅单次时刻；模型按用户要求设置，§3.23 权限边界）。
      // 严格校验：用 parseDeadline 拒绝宽容别名（"none" 等），非法直接报错而非
      // 静默丢弃——否则模型以为提醒已设，实际永不触发（CodeRabbit 评审）
      let reminder: Task["reminder"] = null;
      if (parentId && args.reminder !== undefined && args.reminder !== null) {
        const r = args.reminder as Record<string, unknown>;
        if (r.type !== "once" || typeof r.at !== "string" || !r.at.trim()) {
          return "登记失败：自定义提醒格式无效（须为 {\"type\":\"once\",\"at\":\"YYYY-MM-DD HH:mm\"}）。";
        }
        const at = r.at.trim();
        // 须为完整到分的时刻：parseDeadline 宽容接受纯日期（按当日 00:00 计），
        // 会放过漏写时刻的提醒并让它在午夜静默触发（CodeRabbit 评审）
        if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(at) || !parseDeadline(at)) {
          return "登记失败：提醒时刻无效（须为“YYYY-MM-DD HH:mm”）。";
        }
        // 提醒时刻须早于截止时间：小目标到点先转默认完成，晚于/等于截止的提醒
        // 永远轮不到触发（CodeRabbit 评审）；仅登记时校验，改期不自动调整既有
        // 提醒（§3.26——改小目标截止时间，其自定义提醒不自动调整）
        if (parseDeadline(at)!.getTime() >= parseDeadline(deadline.value!)!.getTime()) {
          return "登记失败：提醒时刻须早于小目标的截止时间。";
        }
        reminder = { type: "once", at };
      }

      const task: Task = {
        id: randomUUID(),
        content,
        deadline: deadline.value,
        quadrant,
        status: "pending",
        createdAt: now(),
        ...(parentId ? { parentId, reminder } : {}),
      };
      deps.store.add(task);
      const settled = settleAndPersist(task);
      if (parentId) settleParentLinkage(settled);
      deps.onStoreChanged?.();
      log(`登记待办: ${settled.content}`);
      return `已登记待办：${describeTask(settled)}${parentId ? "（小目标，已挂入大目标）" : ""}`;
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
      const stored = deps.store.get(id);
      if (!stored) return "未找到该待办，可用 quadrant-todo_list_tasks 查看现有列表。";
      // 先结算再校验（§8.1 写时结算）：过期未扫描的 pending 任务先走默认完成/
      // 滑动结算，再做修改资格判定（CodeRabbit 评审）
      const task = settleAndPersist(stored);
      const reject = (message: string): string => {
        if (task !== stored) deps.onStoreChanged?.();
        return message;
      };
      if (task.status !== "pending") {
        return reject("该待办已是完成态，不支持修改属性；如发现没做完，可删除后重新登记（反悔）。");
      }
      const isChild = !!task.parentId;
      const isGoal = !isChild && deps.store.list().some((c) => c.parentId === task.id);

      let next = task;
      let deadlineChanged = false;

      if (args.content !== undefined) {
        const content = typeof args.content === "string" ? args.content.trim() : "";
        if (!content) return reject("修改失败：内容不能为空。");
        next = { ...next, content };
      }
      if (args.quadrant !== undefined) {
        const quadrant = parseQuadrantInput(args.quadrant);
        if (!quadrant) return reject("修改失败：分类无效（只能是四词之一）。");
        // §3.23：小目标分类从属大目标，不可直接修改
        if (isChild) return reject("修改失败：小目标的分类随大目标，如需调整请修改大目标分类。");
        // 等值跳过：同值回传不算"手动改分类"——否则会清掉滑动记录，让后续
        // 改期无法自动滑回（CodeRabbit 评审；与 bridge.ts 同规则）
        if (quadrant !== next.quadrant) {
          // §七：用户手动改分类直接覆盖并清除滑动记录
          next = { ...next, quadrant, slidFrom: undefined };
        }
      }
      if (args.deadline !== undefined) {
        const deadline = parseDeadlineInput(args.deadline);
        if (!deadline.ok) return reject("修改失败：时间格式无效（须为“YYYY-MM-DD HH:mm”、“YYYY-MM-DD”或“无明确截止时间”）。");
        // 时刻判等：字符串不同但时刻相同（日期型被补全等）不算改期，不重置提醒
        if (!sameInstant(next.deadline, deadline.value)) {
          next = { ...next, deadline: deadline.value };
          deadlineChanged = true;
        }
      }
      if (args.status !== undefined) {
        const status = parseStatusInput(args.status);
        if (status === null) return reject("修改失败：完成状态无效。");
        if (status === "auto-done") return reject("默认完成状态由程序到点结算产生，不能手动设置。");
        if (status === "done") next = { ...next, status: "done", completedAt: now() };
      }

      if (next === task) return reject("没有需要修改的属性，请至少给出一项。");

      // 大目标级联（§3.26/§3.25）：改分类 → 小目标跟随；手动标完成 → 未完成小目标连带完成
      const cascadeQuadrant = isGoal && next.quadrant !== task.quadrant ? next.quadrant : null;
      const manualDone = isGoal && next.status === "done";

      const settled = settleAndPersist(next, { deadlineChanged });
      let extra = "";
      if (cascadeQuadrant) {
        const children = deps.store.list().filter((t) => t.parentId === settled.id);
        for (const c of children) deps.store.replace({ ...c, quadrant: cascadeQuadrant });
        extra = `，其下 ${children.length} 个小目标分类已跟随`;
      }
      if (manualDone) {
        const n = cascadeCompleteChildren(settled.id);
        if (n > 0) extra += `${extra ? "；" : ""}${n} 个未完成小目标已连带标为已完成`;
      }
      if (settled.parentId) settleParentLinkage(settled);
      deps.onStoreChanged?.();
      log(`修改待办: ${settled.content}`);
      return `已修改待办：${describeTask(settled)}${extra}`;
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
      const stored = deps.store.get(id);
      if (!stored) return "未找到该待办，可用 quadrant-todo_list_tasks 查看现有列表。";
      // 先结算再校验：过期未扫描的 pending 任务先转默认完成，再拒绝手动完成
      const task = settleAndPersist(stored);
      const reject = (message: string): string => {
        if (task !== stored) deps.onStoreChanged?.();
        return message;
      };
      if (task.status === "done") return reject("该待办此前已被标记为已完成。");
      if (task.status === "auto-done") return reject("该待办已到点自动转为默认完成，无需再标记。");
      const next: Task = { ...task, status: "done", completedAt: now() };
      const settled = settleAndPersist(next);
      // 大目标手动标完成（§3.25）：未完成小目标连带标"已完成"；小目标完成 → 父级联动评估
      let extra = "";
      if (!settled.parentId && deps.store.list().some((t) => t.parentId === settled.id)) {
        const n = cascadeCompleteChildren(settled.id);
        if (n > 0) extra = `，${n} 个未完成小目标已连带标为已完成`;
      }
      if (settled.parentId) settleParentLinkage(settled);
      deps.onStoreChanged?.();
      log(`完成待办: ${settled.content}`);
      return `已完成：${describeTask(settled)}${extra}`;
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
      // 删除大目标 = 连带删除其下全部小目标（§3.26；口述删除的连带范围确认由 prompt 规范约束）
      const cascaded = cascadeDeleteChildren(id);
      deps.onStoreChanged?.();
      log(`删除待办: ${task.content}${cascaded ? `（连带 ${cascaded} 条小目标）` : ""}`);
      return `已删除待办：${describeTask(task)}${cascaded ? `，连带删除其下 ${cascaded} 条小目标` : ""}`;
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
        // 小目标标注隶属关系（§3.27 树形），模型回答拆解类问题需要看到从属
        const attach = t.parentId ? ` ｜ 隶属「${deps.store.get(t.parentId)?.content ?? "?"}」` : "";
        return t.completedAt ? `${base}${attach}（完成于 ${new Date(t.completedAt).toLocaleString("zh-CN")}）` : `${base}${attach}`;
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
