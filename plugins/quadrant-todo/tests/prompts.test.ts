import { describe, expect, it } from "vitest";
import { buildPromptProvider } from "../src/prompts";
import { TaskStore } from "../src/store";
import { NOW, fmt, makeStorage } from "./helpers";

describe("prompt provider", () => {
  it("注入十条规范的关键内容", () => {
    const provider = buildPromptProvider({ store: new TaskStore(makeStorage()) });
    const text = provider.provide({
      source: "conversation",
      mode: "chat",
      userText: "测试",
      signal: new AbortController().signal,
    }) as string;
    expect(text).toContain("缺时间/缺内容/缺分类");
    expect(text).toContain("无明确截止时间");
    expect(text).toContain("重要紧急");
    // 体验约束：术语转译 + 卡片优先（自然口语选项）+ 聊天式追问
    expect(text).toContain("重不重要、急不着急");
    expect(text).toContain("禁止把\"象限/分类/四象限/属性\"这类插件术语直接抛给用户");
    expect(text).toContain("优先使用宿主的提问卡片");
    expect(text).toContain("又要紧又着急 / 要紧但不急 / 着急但不要紧 / 都还好");
    expect(text).toContain("别让用户有填表的感觉");
    expect(text).toContain("必须追问");
    expect(text).toContain("是否要记入待办列表");
    expect(text).toContain("明确要求删除");
    expect(text).toContain("以 quadrant-todo_list_tasks 返回的列表最新内容为准");
    expect(text).toContain("删除旧任务 + 重走新建流程");
    expect(text).toContain("complete_task");
  });

  it("功能二规范注入：拆解流程与风险节点（§3.28）", () => {
    const storage = makeStorage();
    const store = new TaskStore(storage);
    const provider = buildPromptProvider({ store });
    const text = provider.provide({
      source: "conversation" as const,
      mode: "chat" as const,
      userText: "测试",
      signal: new AbortController().signal,
    }) as string;
    expect(text).toContain("大目标拆解（功能二）规范");
    expect(text).toContain("拆解成有明确时限的小目标");
    expect(text).toContain("小目标的内容由用户自己决定");
    expect(text).toContain("分类不用问（自动随大目标）");
    expect(text).toContain("这个小目标要提醒吗");
    expect(text).toContain("到了时限且小目标全部完成");
    expect(text).toContain("操作前先向用户确认连带范围");
    // Learn 模式协同（§3.21/§3.28 流程第 5 步）
    expect(text).toContain("Learn 模式协同");
    expect(text).toContain("顺势提议一次");
    // 子目标确认门豁免说明
    expect(text).toContain("无需询问也无需确认门");
  });

  it("概览随数据变化：空列表与有数据时不同", () => {
    const storage = makeStorage();
    const store = new TaskStore(storage);
    const provider = buildPromptProvider({ store });
    const signal = new AbortController().signal;
    const input = {
      source: "conversation" as const,
      mode: "chat" as const,
      userText: "测试",
      signal,
    };

    const empty = provider.provide(input) as string;
    expect(empty).toContain("列表为空");

    store.add({
      id: "t1",
      content: "写周报",
      deadline: fmt(NOW + 71 * 3_600_000), // 72h 内，滑动后会变红
      quadrant: "green",
      status: "pending",
      createdAt: NOW,
    });
    const withTask = provider.provide(input) as string;
    expect(withTask).toContain("未完成 1 条");
    expect(withTask).toContain("重要不紧急 1");
  });

  it("全部完成时概览仍报已完成计数（CodeRabbit 评审）", () => {
    const storage = makeStorage();
    const store = new TaskStore(storage);
    store.add({
      id: "t1",
      content: "写周报",
      deadline: fmt(NOW + 71 * 3_600_000),
      quadrant: "green",
      status: "done",
      createdAt: NOW,
      completedAt: NOW,
    });
    const provider = buildPromptProvider({ store });
    const text = provider.provide({
      source: "conversation",
      mode: "chat",
      userText: "测试",
      signal: new AbortController().signal,
    }) as string;
    expect(text).toContain("未完成 0 条");
    expect(text).toContain("已完成保存 1 条");
    expect(text).not.toContain("列表为空");
  });
});
