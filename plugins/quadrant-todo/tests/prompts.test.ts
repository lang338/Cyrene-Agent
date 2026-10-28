import { describe, expect, it } from "vitest";
import { buildPromptProvider } from "../src/prompts";
import { TaskStore } from "../src/store";
import { NOW, fmt, makeStorage } from "./helpers";

describe("prompt provider", () => {
  it("注入八条规范的关键内容", () => {
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
    // 体验约束（v0.2 验收补强）：术语转译 + 聊天式追问
    expect(text).toContain("重不重要、急不着急");
    expect(text).toContain("禁止把\"象限/分类/四象限/属性\"这类插件术语直接抛给用户");
    expect(text).toContain("像聊天不像表单");
    expect(text).toContain("必须追问");
    expect(text).toContain("是否要记入待办列表");
    expect(text).toContain("明确要求删除");
    expect(text).toContain("以 quadrant-todo_list_tasks 返回的列表最新内容为准");
    expect(text).toContain("删除旧任务 + 重走新建流程");
    expect(text).toContain("complete_task");
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
});
