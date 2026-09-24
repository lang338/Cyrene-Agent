import { afterEach, describe, expect, it, vi } from "vitest";

/** 设置由用例逐个覆写：本模块的门控与引擎映射都只读这一份 */
const loadGeneralSettings = vi.fn();

vi.mock("../settings/settings-facade", () => ({
  loadGeneralSettings: () => loadGeneralSettings(),
}));

/** 缓存命中：避免测试真的落盘（这条路径下模块不碰 fs） */
vi.mock("../tts/tts-cache", () => ({
  buildTtsCacheKey: vi.fn(() => "key-minimax"),
  buildGptsovitsCacheKey: vi.fn(() => "key-gptsovits"),
  buildCustomCloudCacheKey: vi.fn(() => "key-custom-cloud"),
  buildMimoCacheKey: vi.fn(() => "key-mimo"),
  buildMosslandCacheKey: vi.fn((input: { format: string }) => `key-mossland-${input.format}`),
  getTtsCachePath: vi.fn(() => "/nonexistent/tts-cache"),
  readTtsCacheByKey: vi.fn(() => ({ audio: Buffer.from("cached-bytes"), format: "mp3" })),
}));

vi.mock("../tts/tts-dispatcher", () => ({
  synthesizeByEngine: vi.fn(async () => ({ audio: Buffer.from("synth-bytes"), format: "mp3" })),
}));

import { buildTaskAlertText, buildTaskAlertTtsRequest, synthesizeTaskAnnouncement } from "./task-alert-tts";

/** 一份最小可用的设置：只填本模块读到的字段 */
function settings(overrides: Record<string, unknown> = {}) {
  return {
    toastSoundEnabled: true,
    ttsEngine: "minimax",
    ttsSpeed: 1,
    ttsVolume: 1,
    ttsMinimaxVoiceId: "voice-1",
    ttsMinimaxModel: "model-1",
    ttsMinimaxKey: "secret",
    ...overrides,
  } as never;
}

afterEach(() => {
  loadGeneralSettings.mockReset();
});

describe("buildTaskAlertText", () => {
  it("标题 + 输出预览；没有预览时只报完成", () => {
    expect(buildTaskAlertText("每日报表", "今天新增 12 条")).toBe("「每日报表」跑完啦。今天新增 12 条");
    expect(buildTaskAlertText("每日报表")).toBe("「每日报表」跑完啦。");
    expect(buildTaskAlertText("每日报表", "   ")).toBe("「每日报表」跑完啦。");
  });

  it("标题为空时退回预览（不产生半截话）", () => {
    expect(buildTaskAlertText("   ", "只有内容")).toBe("只有内容");
  });
});

describe("buildTaskAlertTtsRequest", () => {
  it("引擎关闭时明确报错，调用方据此静默跳过", () => {
    expect(buildTaskAlertTtsRequest(settings({ ttsEngine: "off" }), "文本")).toEqual({ error: "未启用 TTS 引擎" });
  });

  it("超长文本截断到上限（避免把整篇输出念出来）", () => {
    const long = "字".repeat(1200);
    const request = buildTaskAlertTtsRequest(settings(), long);
    if ("error" in request) throw new Error("不应报错");
    expect(request.payload.text).toHaveLength(1001); // 1000 字 + 省略号
    expect(request.payload.text.endsWith("…")).toBe(true);
  });

  it("mossland 的缓存键必须带上真实输出格式（mp3/wav 不能串缓存）", () => {
    const mp3 = buildTaskAlertTtsRequest(settings({ ttsEngine: "mossland", ttsMosslandFormat: "mp3" }), "文本");
    const wav = buildTaskAlertTtsRequest(settings({ ttsEngine: "mossland", ttsMosslandFormat: "wav" }), "文本");
    if ("error" in mp3 || "error" in wav) throw new Error("不应报错");
    expect(mp3.cacheKey).toBe("key-mossland-mp3");
    expect(wav.cacheKey).toBe("key-mossland-wav");
  });
});

describe("synthesizeTaskAnnouncement 门控", () => {
  it("提醒音效总开关关闭 → 不出声（连合成都跳过）", async () => {
    loadGeneralSettings.mockReturnValue(settings({ toastSoundEnabled: false }));
    expect(await synthesizeTaskAnnouncement({ taskTitle: "任务" })).toBeNull();
  });

  it("未配置 TTS 引擎 → 不出声", async () => {
    loadGeneralSettings.mockReturnValue(settings({ ttsEngine: "off" }));
    expect(await synthesizeTaskAnnouncement({ taskTitle: "任务" })).toBeNull();
  });

  it("启用且命中缓存 → 返回音频（base64 + 格式）", async () => {
    loadGeneralSettings.mockReturnValue(settings());
    expect(await synthesizeTaskAnnouncement({ taskTitle: "任务", outputPreview: "预览" })).toEqual({
      base64: Buffer.from("cached-bytes").toString("base64"),
      format: "mp3",
    });
  });

  it("标题与预览都为空 → 没有可念的内容，返回 null", async () => {
    loadGeneralSettings.mockReturnValue(settings());
    expect(await synthesizeTaskAnnouncement({ taskTitle: "  ", outputPreview: " " })).toBeNull();
  });
});
