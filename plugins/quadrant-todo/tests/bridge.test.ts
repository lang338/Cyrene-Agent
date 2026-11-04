import { describe, expect, it, vi } from "vitest";
import { createUiBridge } from "../src/bridge";
import { TaskStore } from "../src/store";
import type { Task } from "../src/types";
import { NOW, fmt, makeStorage } from "./helpers";

const IN_50H = fmt(NOW + 50 * 3_600_000);
const IN_7D = fmt(NOW + 7 * 24 * 3_600_000);

function makeHarness() {
  const storage = makeStorage();
  const store = new TaskStore(storage);
  const events: Array<{ task: Task; events: string[] }> = [];
  const onStoreChanged = vi.fn();
  const bridge = createUiBridge({
    store,
    storage,
    now: () => NOW,
    onSettleEvents: (task, evts) => events.push({ task, events: evts }),
    onStoreChanged,
  });
  return { storage, store, events, onStoreChanged, bridge };
}

describe("load：全量数据 + 设置", () => {
  it("返回全部任务与当前设置；空存储为空数组/空对象", () => {
    const h = makeHarness();
    expect(h.bridge.load()).toEqual({ tasks: [], settings: {} });
  });

  it("settings 形态守卫：非对象值一律按空配置处理", () => {
    const h = makeHarness();
    h.storage.set("settings", "garbage" as unknown);
    expect(h.bridge.getSettings()).toEqual({});
    h.storage.set("settings", [1, 2] as unknown);
    expect(h.bridge.getSettings()).toEqual({});
  });
});

describe("addTask：UI 新建（反请新建半步）", () => {
  it("三要素齐备 → 登记 + 写时结算 + onStoreChanged", () => {
    const h = makeHarness();
    const r = h.bridge.addTask({ content: "写周报", deadline: IN_7D, quadrant: "重要不紧急" });
    expect(r.ok).toBe(true);
    expect(h.storage.dump()).toHaveLength(1);
    expect(h.onStoreChanged).toHaveBeenCalledTimes(1);
  });

  it("缺内容/时间无效/分类无效 → 拒写并返回中文错误", () => {
    const h = makeHarness();
    expect(h.bridge.addTask({ content: "  ", deadline: IN_7D, quadrant: "重要不紧急" })).toMatchObject({ ok: false });
    expect(h.bridge.addTask({ content: "写周报", deadline: "明天", quadrant: "重要不紧急" })).toMatchObject({ ok: false });
    expect(h.bridge.addTask({ content: "写周报", deadline: IN_7D, quadrant: "比较紧急" })).toMatchObject({ ok: false });
    expect(h.storage.dump()).toHaveLength(0);
  });

  it("登记已过期事项 → 写时结算直接默认完成", () => {
    const h = makeHarness();
    const r = h.bridge.addTask({ content: "过期的事", deadline: fmt(NOW - 1000), quadrant: "不重要紧急" });
    expect(r.ok).toBe(true);
    expect(h.storage.dump()[0]?.status).toBe("auto-done");
  });

  it("绿任务 72h 内登记 → 滑红 + 滑红提醒事件（与对话路径同源）", () => {
    const h = makeHarness();
    const r = h.bridge.addTask({ content: "写周报", deadline: IN_50H, quadrant: "重要不紧急" });
    expect(r.ok).toBe(true);
    expect(h.storage.dump()[0]?.quadrant).toBe("red");
    expect(h.events.some((e) => e.events.includes("slide-red"))).toBe(true);
    expect(h.events.some((e) => e.events.includes("remind-slide"))).toBe(true);
  });

  it("入参非对象/缺字段 → 拒写不炸", () => {
    const h = makeHarness();
    expect(h.bridge.addTask(null)).toMatchObject({ ok: false });
    expect(h.bridge.addTask(undefined)).toMatchObject({ ok: false });
    expect(h.bridge.addTask("junk" as unknown)).toMatchObject({ ok: false });
  });
});

describe("updateTask：编辑未完成待办", () => {
  function seed(h: ReturnType<typeof makeHarness>) {
    const r = h.bridge.addTask({ content: "写周报", deadline: IN_7D, quadrant: "重要不紧急" });
    const task = h.storage.dump()[0]!;
    return { id: task.id, task };
  }

  it("改内容/分类生效；手动改分类清除滑动记录", () => {
    const h = makeHarness();
    const { id } = seed(h);
    const r = h.bridge.updateTask(id, { content: "写月报", quadrant: "重要紧急" });
    expect(r.ok).toBe(true);
    const after = h.storage.dump()[0];
    expect(after?.content).toBe("写月报");
    expect(after?.quadrant).toBe("red");
    expect(after?.slidFrom).toBeUndefined();
  });

  it("改期退出 72h 窗口 → 自动滑回原分类 + 提醒新一轮", () => {
    const h = makeHarness();
    const r1 = h.bridge.addTask({ content: "写周报", deadline: IN_50H, quadrant: "重要不紧急" });
    expect(r1.ok).toBe(true);
    const id = h.storage.dump()[0]!.id;
    expect(h.storage.dump()[0]?.quadrant).toBe("red");
    const r2 = h.bridge.updateTask(id, { deadline: IN_7D });
    expect(r2.ok).toBe(true);
    const after = h.storage.dump()[0];
    expect(after?.quadrant).toBe("green");
    expect(after?.slidFrom).toBeUndefined();
    expect(after?.reminded ?? {}).toEqual({});
  });

  it("完成态拒改；不存在的 id 拒改；无变更拒改", () => {
    const h = makeHarness();
    const { id } = seed(h);
    h.bridge.completeTask(id);
    expect(h.bridge.updateTask(id, { content: "x" })).toMatchObject({ ok: false });
    expect(h.bridge.updateTask("missing", { content: "x" })).toMatchObject({ ok: false });
    expect(h.bridge.updateTask(id, {})).toMatchObject({ ok: false });
  });

  it("onStoreChanged 在成功修改后调用", () => {
    const h = makeHarness();
    const { id } = seed(h);
    h.onStoreChanged.mockClear();
    h.bridge.updateTask(id, { content: "新内容" });
    expect(h.onStoreChanged).toHaveBeenCalledTimes(1);
  });
});

describe("completeTask / removeTask", () => {
  it("标记完成 → 记 completedAt；重复完成拒绝；默认完成不可手动", () => {
    const h = makeHarness();
    h.bridge.addTask({ content: "写周报", deadline: IN_7D, quadrant: "重要紧急" });
    const id = h.storage.dump()[0]!.id;
    expect(h.bridge.completeTask(id)).toMatchObject({ ok: true });
    expect(h.storage.dump()[0]).toMatchObject({ status: "done", completedAt: NOW });
    expect(h.bridge.completeTask(id)).toMatchObject({ ok: false });
  });

  it("纯删除移除条目；不存在的 id 报错", () => {
    const h = makeHarness();
    h.bridge.addTask({ content: "写周报", deadline: IN_7D, quadrant: "重要紧急" });
    const id = h.storage.dump()[0]!.id;
    h.onStoreChanged.mockClear();
    expect(h.bridge.removeTask(id)).toMatchObject({ ok: true });
    expect(h.storage.dump()).toHaveLength(0);
    expect(h.bridge.removeTask(id)).toMatchObject({ ok: false });
    expect(h.onStoreChanged).toHaveBeenCalledTimes(1);
  });
});

describe("settings：NapCat 配置面（§3.43）", () => {
  it("保存后可读回；空串字段视为清空", () => {
    const h = makeHarness();
    const r = h.bridge.saveSettings({ url: "http://127.0.0.1:3000", token: " abc ", targetQq: "123456" });
    expect(r).toMatchObject({ ok: true });
    expect(h.bridge.getSettings()).toEqual({
      url: "http://127.0.0.1:3000",
      token: "abc",
      targetQq: "123456",
    });
    h.bridge.saveSettings({ url: "", token: "", targetQq: "" });
    expect(h.bridge.getSettings()).toEqual({});
  });

  it("tasks 与 settings 存储键互不干扰", () => {
    const h = makeHarness();
    h.bridge.addTask({ content: "写周报", deadline: IN_7D, quadrant: "重要紧急" });
    h.bridge.saveSettings({ url: "http://x" });
    expect(h.storage.dump()).toHaveLength(1);
    expect(h.bridge.getSettings()).toEqual({ url: "http://x" });
  });
});
