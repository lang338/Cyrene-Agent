/**
 * PromptProvider（§9.1）：常驻注入八条行为规范 + 当前待办概览。
 * 只经插件机制注入，不改宿主任何代码（设计原则 7）。
 */
import type { PluginPromptProvider } from "../../../src/plugins/api";
import type { TaskStore } from "./store";

/** 行为规范八条（§9.1 清单）+ 完成状态补充说明 */
const RULES = `【四象限待办插件使用规范】
你帮助用户维护"四象限待办"列表（工具前缀 quadrant-todo_）。规则如下：
1. 登记三要素缺一不可：时间、内容、四象限分类必须齐备才能调用 add_task；任缺其一程序会拒写并报错"缺时间/缺内容/缺分类"。
2. 时间取值二者其一：明确截止时间（"xx年xx月xx日xx小时xx分钟"，最低标准为日期；传参用 "YYYY-MM-DD HH:mm" 或 "YYYY-MM-DD"，只有日期按当天 00:00 计）或字面值"无明确截止时间"。
3. 四象限分类只能是四个词之一："重要紧急"、"重要不紧急"、"不重要紧急"、"不重要不紧急"。分类由用户判断、你辅助：可以给建议，但必须等用户对分类做出明确回答后，才能把分类与时间、内容一起提交给程序。
4. 用户没表述清楚、或你无法从上下文确切判断（尤其分类与时间）时，必须追问，不得代答或猜测。
5. 登记入口分流：用户直接要求记入待办列表的，直接进入属性收集；用户没有明确要求时，先主动询问"是否要记入待办列表"，同意后才收集属性。
6. 删除约束：必须是用户明确要求删除的才能调用 delete_task，禁止自行判断清理。
7. 数据漂移对齐：若待办列表/已完成列表的个数与内容同你记忆中的对不上，说明用户在界面上手动修改过（编辑/勾完成/删除都是常态），无需纠结，以 quadrant-todo_list_tasks 返回的列表最新内容为准。
8. 反悔流程：完成态任务用户说"没做完"时，不存在原地改回——删除旧任务 + 重走新建流程：内容按旧任务信息预填，新截止时间由用户定，分类沿用也必须用户明确确认。
完成状态：用户明确告知"这项任务已完成"时调用 complete_task 标记为已完成；有截止时间的任务到点仍无人处理会由程序自动转"默认完成"，两类完成都进入已完成列表。`;

export function buildPromptProvider(deps: { store: TaskStore }): PluginPromptProvider {
  return {
    id: "quadrant-todo-rules",
    // 缺省 modes/sources：全部会话模式 × conversation+scheduler（§9.1 常驻注入）
    provide() {
      const tasks = deps.store.list();
      const pending = tasks.filter((t) => t.status === "pending");
      const counts = { red: 0, green: 0, yellow: 0, blue: 0 };
      for (const t of pending) counts[t.quadrant] += 1;
      const overview =
        pending.length === 0
          ? "当前待办概览：列表为空。"
          : `当前待办概览：未完成 ${pending.length} 条（重要紧急 ${counts.red}、重要不紧急 ${counts.green}、不重要紧急 ${counts.yellow}、不重要不紧急 ${counts.blue}），已完成保存 ${tasks.length - pending.length} 条。具体内容与 id 以 quadrant-todo_list_tasks 查询为准。`;
      return `${RULES}\n\n${overview}`;
    },
  };
}
