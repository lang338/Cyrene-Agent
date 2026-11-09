import { describe, expect, it, vi } from "vitest";
import { buildTools } from "../src/tools";
import { TaskStore } from "../src/store";
import type { Task } from "../src/types";
import { NOW, fmt, makeStorage } from "./helpers";

const IN_71H = fmt(NOW + 71 * 3_600_000);
const IN_50H = fmt(NOW + 50 * 3_600_000);
const IN_7D = fmt(NOW + 7 * 24 * 3_600_000);

function makeHarness() {
  const storage = makeStorage();
  const store = new TaskStore(storage);
  const events: Array<{ task: Task; events: string[] }> = [];
  const tools = buildTools({
    store,
    now: () => NOW,
    onSettleEvents: (task, evts) => events.push({ task, events: evts }),
  });
  const byId = (id: string) => {
    const tool = tools.find((t) => t.id === `quadrant-todo_${id}`);
    if (!tool) throw new Error(`工具不存在: ${id}`);
    return tool;
  };
  const call = async (id: string, args: Record<string, unknown>): Promise<string> =>
    byId(id).execute(args);
  return { storage, store, events, tools, byId, call };
}

describe("工具注册元数据", () => {
  it("五个工具都带 chatBuiltin: true（chat 会话白名单，缺字段则昔涟对话看不到工具）", () => {
    const h = makeHarness();
    expect(h.tools).toHaveLength(5);
    for (const tool of h.tools) {
      expect((tool as { chatBuiltin?: boolean }).chatBuiltin).toBe(true);
    }
  });
});

describe("数据变更钩子（onStoreChanged → 提醒计时器重排，§8.2）", () => {
  it("登记成功即调 onStoreChanged；删除也调", async () => {
    const storage = makeStorage();
    const store = new TaskStore(storage);
    const onStoreChanged = vi.fn();
    const tools = buildTools({ store, now: () => NOW, onStoreChanged });
    const call = async (id: string, args: Record<string, unknown>): Promise<string> => {
      const tool = tools.find((t) => t.id === `quadrant-todo_${id}`);
      if (!tool) throw new Error(`工具不存在: ${id}`);
      return tool.execute(args);
    };
    await call("add_task", { content: "数学作业", deadline: IN_7D, quadrant: "重要不紧急", quadrantConfirmed: true });
    expect(onStoreChanged).toHaveBeenCalledTimes(1);
    const id = store.list()[0]!.id;
    await call("delete_task", { id });
    expect(onStoreChanged).toHaveBeenCalledTimes(2);
  });

  it("修改属性与标记完成也调 onStoreChanged", async () => {
    const storage = makeStorage();
    const store = new TaskStore(storage);
    const onStoreChanged = vi.fn();
    const tools = buildTools({ store, now: () => NOW, onStoreChanged });
    const call = async (id: string, args: Record<string, unknown>): Promise<string> => {
      const tool = tools.find((t) => t.id === `quadrant-todo_${id}`);
      if (!tool) throw new Error(`工具不存在: ${id}`);
      return tool.execute(args);
    };
    await call("add_task", { content: "数学作业", deadline: IN_7D, quadrant: "重要不紧急", quadrantConfirmed: true });
    const id = store.list()[0]!.id;
    onStoreChanged.mockClear();
    await call("update_task", { id, content: "改内容" });
    await call("complete_task", { id });
    expect(onStoreChanged).toHaveBeenCalledTimes(2);
  });
});

describe("add_task 三要素硬校验", () => {
  it("缺内容 → 拒写并报“缺内容”", async () => {
    const h = makeHarness();
    const out = await h.call("add_task", { content: "", deadline: "2026-11-01", quadrant: "重要紧急" });
    expect(out).toContain("缺内容");
    expect(h.storage.dump()).toHaveLength(0);
  });

  it("缺时间（字段缺失）→ 拒写并报“缺时间”", async () => {
    const h = makeHarness();
    const out = await h.call("add_task", { content: "写周报", quadrant: "重要紧急" });
    expect(out).toContain("缺时间");
    expect(h.storage.dump()).toHaveLength(0);
  });

  it("时间非法（“明天”）→ 拒写并报“缺时间”", async () => {
    const h = makeHarness();
    const out = await h.call("add_task", { content: "写周报", deadline: "明天", quadrant: "重要紧急" });
    expect(out).toContain("缺时间");
  });

  it("缺分类（字段缺失，确认门已放行）→ 拒写并报“缺分类”", async () => {
    const h = makeHarness();
    const out = await h.call("add_task", { content: "写周报", deadline: "2026-11-01", quadrantConfirmed: true });
    expect(out).toContain("缺分类");
  });

  it("分类确认门：quadrantConfirmed 缺省 → 拒写并报“分类未获用户确认”", async () => {
    const h = makeHarness();
    const out = await h.call("add_task", { content: "写周报", deadline: "2026-11-01", quadrant: "重要紧急" });
    expect(out).toContain("分类未获用户确认");
    expect(h.storage.dump()).toHaveLength(0);
  });

  it("分类确认门：quadrantConfirmed=false → 拒写", async () => {
    const h = makeHarness();
    const out = await h.call("add_task", { content: "写周报", deadline: "2026-11-01", quadrant: "重要紧急", quadrantConfirmed: false });
    expect(out).toContain("分类未获用户确认");
    expect(h.storage.dump()).toHaveLength(0);
  });

  it("分类确认门：quadrantConfirmed=true 放行登记", async () => {
    const h = makeHarness();
    const out = await h.call("add_task", { content: "写周报", deadline: IN_7D, quadrant: "重要紧急", quadrantConfirmed: true });
    expect(out).toContain("已登记");
    expect(h.storage.dump()).toHaveLength(1);
  });

  it("分类非四词 → 拒写并报“缺分类”", async () => {
    const h = makeHarness();
    const out = await h.call("add_task", { content: "写周报", deadline: "2026-11-01", quadrant: "比较紧急", quadrantConfirmed: true });
    expect(out).toContain("缺分类");
  });

  it("分类传入原型链键（constructor）→ 不得绕过硬校验（CodeRabbit 评审）", async () => {
    const h = makeHarness();
    const out = await h.call("add_task", { content: "写周报", deadline: "2026-11-01", quadrant: "constructor", quadrantConfirmed: true });
    expect(out).toContain("缺分类");
    expect(h.storage.dump()).toHaveLength(0);
  });

  it("“无明确截止时间”合法录入，deadline=null", async () => {
    const h = makeHarness();
    const out = await h.call("add_task", {
      content: "整理硬盘",
      deadline: "无明确截止时间",
      quadrant: "重要不紧急",
      quadrantConfirmed: true,
    });
    expect(out).toContain("已登记");
    expect(out).toContain("无明确截止时间");
    expect(h.storage.dump()[0]?.deadline).toBeNull();
  });

  it("正常录入四属性齐全的任务", async () => {
    const h = makeHarness();
    const out = await h.call("add_task", {
      content: "交房租",
      deadline: IN_7D,
      quadrant: "重要紧急",
      quadrantConfirmed: true,
    });
    expect(out).toContain("已登记");
    expect(out).toContain("重要紧急");
    const saved = h.storage.dump()[0];
    expect(saved?.content).toBe("交房租");
    expect(saved?.status).toBe("pending");
  });

  it("登记已过期事项 → 写时结算直接默认完成", async () => {
    const h = makeHarness();
    const out = await h.call("add_task", {
      content: "过期的事",
      deadline: fmt(NOW - 3_600_000),
      quadrant: "不重要紧急",
      quadrantConfirmed: true,
    });
    expect(out).toContain("默认完成");
    expect(h.storage.dump()[0]?.status).toBe("auto-done");
  });
});

describe("滑动与滑回（工具路径写时结算）", () => {
  async function addSlidRed(h: ReturnType<typeof makeHarness>) {
    const out = await h.call("add_task", { content: "写周报", deadline: IN_71H, quadrant: "重要不紧急", quadrantConfirmed: true });
    const task = h.storage.dump()[0];
    expect(task?.quadrant).toBe("red");
    expect(task?.slidFrom).toBe("green");
    return { out, task };
  }

  it("绿任务 72h 内 → 真实滑红 + 滑红提醒事件", async () => {
    const h = makeHarness();
    const { task } = await addSlidRed(h);
    expect(h.events.some((e) => e.events.includes("remind-slide") && e.task.id === task?.id)).toBe(true);
  });

  it("改期退出窗口 → 自动滑回绿 + 提醒新一轮", async () => {
    const h = makeHarness();
    const { task } = await addSlidRed(h);
    await h.call("update_task", { id: task?.id, deadline: IN_7D });
    const after = h.storage.dump()[0];
    expect(after?.quadrant).toBe("green");
    expect(after?.slidFrom).toBeUndefined();
    expect(after?.reminded).toEqual({});
  });

  it("改期仍在窗口内 → 滑回后再滑红（净效果保持红）", async () => {
    const h = makeHarness();
    const { task } = await addSlidRed(h);
    await h.call("update_task", { id: task?.id, deadline: IN_50H });
    const after = h.storage.dump()[0];
    expect(after?.quadrant).toBe("red");
    expect(after?.slidFrom).toBe("green");
  });

  it("72h 窗口内手动把分类改回绿 → 滑动条件仍满足会被再次滑红", async () => {
    const h = makeHarness();
    const { task } = await addSlidRed(h);
    const out = await h.call("update_task", { id: task?.id, quadrant: "重要不紧急" });
    expect(out).toContain("重要紧急"); // 结算后仍被滑红
    const after = h.storage.dump()[0];
    expect(after?.quadrant).toBe("red");
    expect(after?.slidFrom).toBe("green");
  });

  it("窗口外手动改分类 → 保持用户指定分类（手动修改不属于滑动）", async () => {
    const h = makeHarness();
    await h.call("add_task", { content: "写周报", deadline: IN_7D, quadrant: "重要不紧急", quadrantConfirmed: true });
    const task = h.storage.dump()[0];
    await h.call("update_task", { id: task?.id, quadrant: "不重要紧急" });
    const after = h.storage.dump()[0];
    expect(after?.quadrant).toBe("yellow");
    expect(after?.slidFrom).toBeUndefined();
  });
});

describe("update_task 其余校验", () => {
  it("不存在的 id → 提示未找到", async () => {
    const h = makeHarness();
    const out = await h.call("update_task", { id: "nope", content: "x" });
    expect(out).toContain("未找到");
  });

  it("一项都没给 → 提示至少一项", async () => {
    const h = makeHarness();
    await h.call("add_task", { content: "写周报", deadline: IN_7D, quadrant: "重要紧急", quadrantConfirmed: true });
    const task = h.storage.dump()[0];
    const out = await h.call("update_task", { id: task?.id });
    expect(out).toContain("至少");
  });

  it("status=done → 记 completedAt；status=auto-done → 拒绝", async () => {
    const h = makeHarness();
    await h.call("add_task", { content: "写周报", deadline: IN_7D, quadrant: "重要紧急", quadrantConfirmed: true });
    const task = h.storage.dump()[0];
    await h.call("update_task", { id: task?.id, status: "auto-done" });
    expect(h.storage.dump()[0]?.status).toBe("pending");
    await h.call("update_task", { id: task?.id, status: "done" });
    const after = h.storage.dump()[0];
    expect(after?.status).toBe("done");
    expect(after?.completedAt).toBe(NOW);
  });

  it("完成态任务不支持修改属性", async () => {
    const h = makeHarness();
    await h.call("add_task", { content: "写周报", deadline: IN_7D, quadrant: "重要紧急", quadrantConfirmed: true });
    const task = h.storage.dump()[0];
    await h.call("complete_task", { id: task?.id });
    const out = await h.call("update_task", { id: task?.id, content: "改内容" });
    expect(out).toContain("完成态");
  });

  it("同值回传分类不清滑动记录（CodeRabbit 评审）", async () => {
    const h = makeHarness();
    await h.call("add_task", { content: "写周报", deadline: IN_50H, quadrant: "重要不紧急", quadrantConfirmed: true });
    const slid = h.storage.dump()[0]!;
    expect(slid.quadrant).toBe("red");
    expect(slid.slidFrom).toBe("green");
    const eventsBefore = h.events.length;
    const out = await h.call("update_task", { id: slid.id, content: "改个名", quadrant: "重要紧急" });
    expect(out).toContain("已修改");
    expect(h.storage.dump()[0]?.slidFrom).toBe("green");
    expect(h.events.slice(eventsBefore).some((e) => e.events.includes("slide-back"))).toBe(false);
  });

  it("等值时刻 deadline 不重置提醒（日期型被补全场景，CodeRabbit 评审）", async () => {
    const h = makeHarness();
    const dayStr = fmt(NOW + 12 * 3_600_000).slice(0, 10);
    await h.call("add_task", { content: "写周报", deadline: dayStr, quadrant: "重要紧急", quadrantConfirmed: true });
    const seeded = h.storage.dump()[0]!;
    expect(seeded.reminded?.due24).toBe(dayStr);
    const eventsBefore = h.events.length;
    const out = await h.call("update_task", { id: seeded.id, content: seeded.content, deadline: `${dayStr} 00:00` });
    expect(out).toContain("已修改");
    const after = h.storage.dump()[0]!;
    expect(after.deadline).toBe(dayStr);
    expect(after.reminded?.due24).toBe(dayStr);
    expect(h.events.slice(eventsBefore).some((e) => e.events.includes("remind-24h"))).toBe(false);
  });

  it("过期未结算的 pending 任务：先结算转默认完成，再拒绝修改/完成（CodeRabbit 评审）", async () => {
    const h = makeHarness();
    // 绕过 add_task 的写时结算，直接造"过期但仍是 pending"的存储态
    h.store.add({ id: "expired-1", content: "过期的事", deadline: fmt(NOW - 1000), quadrant: "red", status: "pending", createdAt: NOW - 2000 });
    const out = await h.call("complete_task", { id: "expired-1" });
    expect(out).toContain("默认完成");
    expect(h.storage.dump()[0]?.status).toBe("auto-done");
    const out2 = await h.call("update_task", { id: "expired-1", content: "改" });
    expect(out2).toContain("完成态");
  });

  it("小目标录入：传 parentId 挂入大目标，分类继承免问免确认门", async () => {
    const h = makeHarness();
    await h.call("add_task", { content: "过四级", deadline: "2026-12-20", quadrant: "重要不紧急", quadrantConfirmed: true });
    const goal = h.storage.dump()[0]!;
    const out = await h.call("add_task", { content: "背单词", deadline: fmt(NOW + 24 * 3_600_000), parentId: goal.id });
    expect(out).toContain("小目标");
    const child = h.storage.dump().find((t) => t.parentId === goal.id)!;
    expect(child.content).toBe("背单词");
    expect(child.quadrant).toBe("green");
    expect(child.reminded).toBeUndefined();
  });

  it("小目标校验：date-only 拒绝、父级不存在/完成态拒绝、不支持嵌套", async () => {
    const h = makeHarness();
    await h.call("add_task", { content: "过四级", deadline: "2026-12-20", quadrant: "重要不紧急", quadrantConfirmed: true });
    const goal = h.storage.dump()[0]!;
    expect(await h.call("add_task", { content: "背单词", deadline: "2026-12-20", parentId: goal.id })).toContain("须精确到时分");
    expect(await h.call("add_task", { content: "背单词", deadline: fmt(NOW + 3_600_000), parentId: "missing" })).toContain("未找到该大目标");
    await h.call("complete_task", { id: goal.id });
    expect(await h.call("add_task", { content: "背单词", deadline: fmt(NOW + 3_600_000), parentId: goal.id })).toContain("完成态");
  });

  it("小目标自定义提醒：宽容别名拒绝并报错（CodeRabbit 评审），合法时刻存储生效", async () => {
    const h = makeHarness();
    await h.call("add_task", { content: "过四级", deadline: "2026-12-20", quadrant: "重要不紧急", quadrantConfirmed: true });
    const goal = h.storage.dump()[0]!;
    const dl = fmt(NOW + 24 * 3_600_000);
    // 宽容别名（parseDeadlineInput 会放行的值）必须被 parseDeadline 拒绝，且登记整体失败
    const bad = await h.call("add_task", { content: "背单词", deadline: dl, parentId: goal.id, reminder: { type: "once", at: "none" } });
    expect(bad).toContain("提醒时刻无效");
    expect(h.storage.dump().find((t) => t.content === "背单词")).toBeUndefined();
    // 合法时刻 → 存储生效
    const ok = await h.call("add_task", { content: "背单词", deadline: dl, parentId: goal.id, reminder: { type: "once", at: fmt(NOW + 2 * 3_600_000) } });
    expect(ok).toContain("已登记");
    expect(h.storage.dump().find((t) => t.content === "背单词")?.reminder).toEqual({ type: "once", at: fmt(NOW + 2 * 3_600_000) });
  });

  it("小目标自定义提醒：纯日期时刻被拒（CodeRabbit 评审）", async () => {
    const h = makeHarness();
    await h.call("add_task", { content: "过四级", deadline: "2026-12-20", quadrant: "重要不紧急", quadrantConfirmed: true });
    const goal = h.storage.dump()[0]!;
    const dl = fmt(NOW + 48 * 3_600_000);
    // parseDeadline 宽容接受纯日期（按 00:00 计），提醒须为完整到分的时刻
    const dateOnly = await h.call("add_task", { content: "背单词", deadline: dl, parentId: goal.id, reminder: { type: "once", at: fmt(NOW + 2 * 3_600_000).slice(0, 10) } });
    expect(dateOnly).toContain("提醒时刻无效");
    expect(h.storage.dump().find((t) => t.content === "背单词")).toBeUndefined();
  });

  it("小目标自定义提醒：晚于/等于截止时间被拒（CodeRabbit 评审）", async () => {
    const h = makeHarness();
    await h.call("add_task", { content: "过四级", deadline: "2026-12-20", quadrant: "重要不紧急", quadrantConfirmed: true });
    const goal = h.storage.dump()[0]!;
    const dl = fmt(NOW + 24 * 3_600_000);
    // 晚于截止：到点任务先转默认完成，提醒永不触发
    const late = await h.call("add_task", { content: "背单词", deadline: dl, parentId: goal.id, reminder: { type: "once", at: fmt(NOW + 25 * 3_600_000) } });
    expect(late).toContain("提醒时刻须早于小目标的截止时间");
    // 等于截止：同样拒绝
    const same = await h.call("add_task", { content: "背单词", deadline: dl, parentId: goal.id, reminder: { type: "once", at: dl } });
    expect(same).toContain("提醒时刻须早于小目标的截止时间");
    expect(h.storage.dump().find((t) => t.content === "背单词")).toBeUndefined();
    // 早于截止的正常通过
    const ok = await h.call("add_task", { content: "背单词", deadline: dl, parentId: goal.id, reminder: { type: "once", at: fmt(NOW + 2 * 3_600_000) } });
    expect(ok).toContain("已登记");
  });

  it("改大目标分类 → 小目标跟随；改小目标分类 → 拒绝并指引改父级", async () => {
    const h = makeHarness();
    await h.call("add_task", { content: "过四级", deadline: "2026-12-20", quadrant: "重要不紧急", quadrantConfirmed: true });
    const goal = h.storage.dump()[0]!;
    await h.call("add_task", { content: "背单词", deadline: fmt(NOW + 24 * 3_600_000), parentId: goal.id });
    await h.call("update_task", { id: goal.id, quadrant: "重要紧急" });
    const after = h.storage.dump();
    expect(after.find((t) => t.id === goal.id)?.quadrant).toBe("red");
    expect(after.find((t) => t.parentId === goal.id)?.quadrant).toBe("red");
    const child = after.find((t) => t.parentId === goal.id)!;
    const out = await h.call("update_task", { id: child.id, quadrant: "重要不紧急" });
    expect(out).toContain("随大目标");
  });

  it("大目标手动标完成 → 未完成小目标连带标已完成；删除大目标 → 连带删除小目标", async () => {
    const h = makeHarness();
    await h.call("add_task", { content: "过四级", deadline: "2026-12-20", quadrant: "重要不紧急", quadrantConfirmed: true });
    const goal = h.storage.dump()[0]!;
    await h.call("add_task", { content: "背单词", deadline: fmt(NOW + 24 * 3_600_000), parentId: goal.id });
    const done = await h.call("complete_task", { id: goal.id });
    expect(done).toContain("连带标为已完成");
    expect(h.storage.dump().find((t) => t.parentId === goal.id)?.status).toBe("done");
    const del = await h.call("delete_task", { id: goal.id });
    expect(del).toContain("连带删除其下 1 条小目标");
    expect(h.storage.dump()).toHaveLength(0);
  });

  it("完成最后一个小目标 → 大目标联动转默认完成（已到时限时）", async () => {
    const h = makeHarness();
    // 直接种一个"时限已过但仍 pending"的大目标（跳过登记时的普通结算）
    h.store.add({ id: "g1", content: "过四级", deadline: fmt(NOW - 1000), quadrant: "green", status: "pending", createdAt: NOW - 2000 });
    await h.call("add_task", { content: "背单词", deadline: fmt(NOW + 24 * 3_600_000), parentId: "g1" });
    const child = h.storage.dump().find((t) => t.parentId === "g1")!;
    expect(child.status).toBe("pending");
    await h.call("complete_task", { id: child.id });
    expect(h.storage.dump().find((t) => t.id === "g1")?.status).toBe("auto-done");
  });

  it("list_tasks 小目标标注隶属", async () => {
    const h = makeHarness();
    await h.call("add_task", { content: "过四级", deadline: "2026-12-20", quadrant: "重要不紧急", quadrantConfirmed: true });
    const goal = h.storage.dump()[0]!;
    await h.call("add_task", { content: "背单词", deadline: fmt(NOW + 24 * 3_600_000), parentId: goal.id });
    const out = await h.call("list_tasks", {});
    expect(out).toContain("隶属「过四级」");
  });
});

describe("complete_task / delete_task", () => {
  it("标记完成 → 已完成；重复标记 → 提示已完成", async () => {
    const h = makeHarness();
    await h.call("add_task", { content: "写周报", deadline: IN_7D, quadrant: "重要紧急", quadrantConfirmed: true });
    const task = h.storage.dump()[0];
    const first = await h.call("complete_task", { id: task?.id });
    expect(first).toContain("已完成");
    const second = await h.call("complete_task", { id: task?.id });
    expect(second).toContain("已被标记为已完成");
  });

  it("对默认完成任务标记完成 → 提示无需再标记", async () => {
    const h = makeHarness();
    await h.call("add_task", { content: "过期的事", deadline: fmt(NOW - 1000), quadrant: "不重要紧急", quadrantConfirmed: true });
    const task = h.storage.dump()[0];
    const out = await h.call("complete_task", { id: task?.id });
    expect(out).toContain("默认完成");
  });

  it("纯删除 → 从列表移除；不存在 → 提示未找到", async () => {
    const h = makeHarness();
    await h.call("add_task", { content: "写周报", deadline: IN_7D, quadrant: "重要紧急", quadrantConfirmed: true });
    const task = h.storage.dump()[0];
    const out = await h.call("delete_task", { id: task?.id });
    expect(out).toContain("已删除");
    expect(h.storage.dump()).toHaveLength(0);
    const again = await h.call("delete_task", { id: task?.id });
    expect(again).toContain("未找到");
  });
});

describe("list_tasks 查询", () => {
  it("active 默认只列未完成", async () => {
    const h = makeHarness();
    await h.call("add_task", { content: "任务A", deadline: IN_7D, quadrant: "重要紧急", quadrantConfirmed: true });
    await h.call("add_task", { content: "过期B", deadline: fmt(NOW - 1000), quadrant: "不重要紧急", quadrantConfirmed: true });
    const out = await h.call("list_tasks", {});
    expect(out).toContain("任务A");
    expect(out).not.toContain("过期B");
  });

  it("completed 列已完成与默认完成", async () => {
    const h = makeHarness();
    await h.call("add_task", { content: "任务A", deadline: IN_7D, quadrant: "重要紧急", quadrantConfirmed: true });
    await h.call("add_task", { content: "过期B", deadline: fmt(NOW - 1000), quadrant: "不重要紧急", quadrantConfirmed: true });
    const taskA = h.storage.dump().find((t) => t.content === "任务A");
    await h.call("complete_task", { id: taskA?.id });
    const out = await h.call("list_tasks", { scope: "completed" });
    expect(out).toContain("任务A");
    expect(out).toContain("过期B");
    expect(out).toContain("已完成");
    expect(out).toContain("默认完成");
  });

  it("空列表提示", async () => {
    const h = makeHarness();
    const out = await h.call("list_tasks", {});
    expect(out).toContain("没有未完成的待办");
  });

  it("all 分未完成/已完成两段", async () => {
    const h = makeHarness();
    await h.call("add_task", { content: "任务A", deadline: IN_7D, quadrant: "重要紧急", quadrantConfirmed: true });
    const taskA = h.storage.dump()[0];
    await h.call("complete_task", { id: taskA?.id });
    await h.call("add_task", { content: "任务C", deadline: "无明确截止时间", quadrant: "不重要不紧急", quadrantConfirmed: true });
    const out = await h.call("list_tasks", { scope: "all" });
    expect(out).toContain("【未完成】");
    expect(out).toContain("【已完成】");
    expect(out.indexOf("【未完成】")).toBeLessThan(out.indexOf("任务C"));
    expect(out.indexOf("【已完成】")).toBeLessThan(out.indexOf("任务A"));
  });
});
