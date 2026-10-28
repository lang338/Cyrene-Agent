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

describe("提醒任务同步钩子（v0.3 预建口径）", () => {
  it("登记成功即调 syncReminders；删除即调 onTaskRemoved", async () => {
    const storage = makeStorage();
    const store = new TaskStore(storage);
    const syncReminders = vi.fn();
    const onTaskRemoved = vi.fn();
    const tools = buildTools({ store, now: () => NOW, syncReminders, onTaskRemoved });
    const call = async (id: string, args: Record<string, unknown>): Promise<string> => {
      const tool = tools.find((t) => t.id === `quadrant-todo_${id}`);
      if (!tool) throw new Error(`工具不存在: ${id}`);
      return tool.execute(args);
    };
    await call("add_task", { content: "数学作业", deadline: IN_7D, quadrant: "重要不紧急" });
    expect(syncReminders).toHaveBeenCalledTimes(1);
    expect(syncReminders.mock.calls[0]?.[0]).toMatchObject({ content: "数学作业", quadrant: "green" });
    const id = store.list()[0]!.id;
    await call("delete_task", { id });
    expect(onTaskRemoved).toHaveBeenCalledWith(id);
  });

  it("标记完成即以完成态调 syncReminders（预建任务应随之清除）", async () => {
    const storage = makeStorage();
    const store = new TaskStore(storage);
    const syncReminders = vi.fn();
    const tools = buildTools({ store, now: () => NOW, syncReminders });
    const call = async (id: string, args: Record<string, unknown>): Promise<string> => {
      const tool = tools.find((t) => t.id === `quadrant-todo_${id}`);
      if (!tool) throw new Error(`工具不存在: ${id}`);
      return tool.execute(args);
    };
    await call("add_task", { content: "数学作业", deadline: IN_7D, quadrant: "重要不紧急" });
    const id = store.list()[0]!.id;
    syncReminders.mockClear();
    await call("complete_task", { id });
    expect(syncReminders).toHaveBeenCalledTimes(1);
    expect(syncReminders.mock.calls[0]?.[0]).toMatchObject({ status: "done" });
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

  it("缺分类（字段缺失）→ 拒写并报“缺分类”", async () => {
    const h = makeHarness();
    const out = await h.call("add_task", { content: "写周报", deadline: "2026-11-01" });
    expect(out).toContain("缺分类");
  });

  it("分类非四词 → 拒写并报“缺分类”", async () => {
    const h = makeHarness();
    const out = await h.call("add_task", { content: "写周报", deadline: "2026-11-01", quadrant: "比较紧急" });
    expect(out).toContain("缺分类");
  });

  it("“无明确截止时间”合法录入，deadline=null", async () => {
    const h = makeHarness();
    const out = await h.call("add_task", {
      content: "整理硬盘",
      deadline: "无明确截止时间",
      quadrant: "重要不紧急",
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
    });
    expect(out).toContain("默认完成");
    expect(h.storage.dump()[0]?.status).toBe("auto-done");
  });
});

describe("滑动与滑回（工具路径写时结算）", () => {
  async function addSlidRed(h: ReturnType<typeof makeHarness>) {
    const out = await h.call("add_task", { content: "写周报", deadline: IN_71H, quadrant: "重要不紧急" });
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
    await h.call("add_task", { content: "写周报", deadline: IN_7D, quadrant: "重要不紧急" });
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
    await h.call("add_task", { content: "写周报", deadline: IN_7D, quadrant: "重要紧急" });
    const task = h.storage.dump()[0];
    const out = await h.call("update_task", { id: task?.id });
    expect(out).toContain("至少");
  });

  it("status=done → 记 completedAt；status=auto-done → 拒绝", async () => {
    const h = makeHarness();
    await h.call("add_task", { content: "写周报", deadline: IN_7D, quadrant: "重要紧急" });
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
    await h.call("add_task", { content: "写周报", deadline: IN_7D, quadrant: "重要紧急" });
    const task = h.storage.dump()[0];
    await h.call("complete_task", { id: task?.id });
    const out = await h.call("update_task", { id: task?.id, content: "改内容" });
    expect(out).toContain("完成态");
  });
});

describe("complete_task / delete_task", () => {
  it("标记完成 → 已完成；重复标记 → 提示已完成", async () => {
    const h = makeHarness();
    await h.call("add_task", { content: "写周报", deadline: IN_7D, quadrant: "重要紧急" });
    const task = h.storage.dump()[0];
    const first = await h.call("complete_task", { id: task?.id });
    expect(first).toContain("已完成");
    const second = await h.call("complete_task", { id: task?.id });
    expect(second).toContain("已被标记为已完成");
  });

  it("对默认完成任务标记完成 → 提示无需再标记", async () => {
    const h = makeHarness();
    await h.call("add_task", { content: "过期的事", deadline: fmt(NOW - 1000), quadrant: "不重要紧急" });
    const task = h.storage.dump()[0];
    const out = await h.call("complete_task", { id: task?.id });
    expect(out).toContain("默认完成");
  });

  it("纯删除 → 从列表移除；不存在 → 提示未找到", async () => {
    const h = makeHarness();
    await h.call("add_task", { content: "写周报", deadline: IN_7D, quadrant: "重要紧急" });
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
    await h.call("add_task", { content: "任务A", deadline: IN_7D, quadrant: "重要紧急" });
    await h.call("add_task", { content: "过期B", deadline: fmt(NOW - 1000), quadrant: "不重要紧急" });
    const out = await h.call("list_tasks", {});
    expect(out).toContain("任务A");
    expect(out).not.toContain("过期B");
  });

  it("completed 列已完成与默认完成", async () => {
    const h = makeHarness();
    await h.call("add_task", { content: "任务A", deadline: IN_7D, quadrant: "重要紧急" });
    await h.call("add_task", { content: "过期B", deadline: fmt(NOW - 1000), quadrant: "不重要紧急" });
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
    await h.call("add_task", { content: "任务A", deadline: IN_7D, quadrant: "重要紧急" });
    const taskA = h.storage.dump()[0];
    await h.call("complete_task", { id: taskA?.id });
    await h.call("add_task", { content: "任务C", deadline: "无明确截止时间", quadrant: "不重要不紧急" });
    const out = await h.call("list_tasks", { scope: "all" });
    expect(out).toContain("【未完成】");
    expect(out).toContain("【已完成】");
    expect(out.indexOf("【未完成】")).toBeLessThan(out.indexOf("任务C"));
    expect(out.indexOf("【已完成】")).toBeLessThan(out.indexOf("任务A"));
  });
});
