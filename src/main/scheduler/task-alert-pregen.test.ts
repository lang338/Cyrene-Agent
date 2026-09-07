import { describe, expect, it, vi } from "vitest";
import type { ScheduledTask } from "./types";
import { pregenerateTaskAlert } from "./task-alert-pregen";

const pregenMocks = vi.hoisted(() => ({
  ttsResult: { base64: "aGVsbG8=", format: "mp3" } as
    | { base64: string; format: string }
    | { error: string },
}));

vi.mock("./task-alert-tts", () => ({
  synthesizeTaskAlertTts: vi.fn(async () => pregenMocks.ttsResult),
}));

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "task-1",
    title: "每日整理",
    prompt: "整理资料",
    enabled: true,
    schedule: { kind: "daily", at: "08:00" } as ScheduledTask["schedule"],
    nextFireAt: null,
    toolMode: "allow-list",
    allowedToolIds: [],
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
    ...overrides,
  };
}

async function run(task: ScheduledTask, generate: (task: ScheduledTask) => Promise<string>) {
  const { synthesizeTaskAlertTts } = await import("./task-alert-tts");
  const tts = vi.mocked(synthesizeTaskAlertTts);
  tts.mockClear();
  const result = await pregenerateTaskAlert(task, generate);
  return { result, tts };
}

describe("pregenerateTaskAlert", () => {
  it("生成成功 → 内容 trim 后返回，并按当前 TTS 设置暖缓存语音", async () => {
    const { result, tts } = await run(makeTask(), async () => "  播报内容  ");
    expect(result).toEqual({ content: "播报内容" });
    expect(tts).toHaveBeenCalledWith("播报内容");
  });

  it("生成内容 trim 后为空 → 返回 error，且不触发 TTS", async () => {
    const { result, tts } = await run(makeTask(), async () => "   \n  ");
    expect(result).toEqual({ error: "预生成内容为空" });
    expect(tts).not.toHaveBeenCalled();
  });

  it("TTS 暖缓存失败不影响内容预生成（到点会再尝试）", async () => {
    pregenMocks.ttsResult = { error: "TTS 未配置" };
    const { result, tts } = await run(makeTask(), async () => "播报内容");
    expect(result).toEqual({ content: "播报内容" });
    expect(tts).toHaveBeenCalledTimes(1);
  });

  it("内容生成抛错 → 返回 error 消息且不触发 TTS", async () => {
    const { result, tts } = await run(makeTask(), async () => {
      throw new Error("模型请求失败");
    });
    expect(result).toEqual({ error: "模型请求失败" });
    expect(tts).not.toHaveBeenCalled();
  });

  it("非 Error 异常也能转成字符串消息", async () => {
    const { result, tts } = await run(makeTask(), async () => {
      throw "字符串异常";
    });
    expect(result).toEqual({ error: "字符串异常" });
    expect(tts).not.toHaveBeenCalled();
  });
});
