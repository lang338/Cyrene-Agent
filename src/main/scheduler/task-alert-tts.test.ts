import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GeneralSettings } from "../settings/general-settings";
import {
  buildTaskAlertTtsRequest,
  TASK_ALERT_MAX_TTS_TEXT,
  synthesizeTaskAlertTts,
} from "./task-alert-tts";
import {
  buildCustomCloudCacheKey,
  buildGptsovitsCacheKey,
  buildMimoCacheKey,
  buildMosslandCacheKey,
  buildTtsCacheKey,
} from "../tts/tts-cache";

const ttsMocks = vi.hoisted(() => ({
  settings: {} as GeneralSettings,
  cached: null as { audio: Buffer; format: "mp3" | "wav" | "pcm" } | null,
  synthResult: { audio: Buffer.from("synthesized"), format: "mp3" as "mp3" | "wav" | "pcm" },
  synthError: undefined as Error | undefined,
  cacheDir: "",
}));

vi.mock("../settings/settings-facade", () => ({
  loadGeneralSettings: () => ttsMocks.settings,
}));

vi.mock("../tts/tts-dispatcher", () => ({
  synthesizeByEngine: vi.fn(async () => {
    if (ttsMocks.synthError) throw ttsMocks.synthError;
    return ttsMocks.synthResult;
  }),
}));

vi.mock("../tts/tts-cache", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readTtsCacheByKey: vi.fn(() => ttsMocks.cached),
  getTtsCachePath: vi.fn((cacheKey: string, format: string) =>
    path.join(ttsMocks.cacheDir, `${cacheKey}.${format}`),
  ),
}));

function makeSettings(overrides: Partial<GeneralSettings> = {}): GeneralSettings {
  return {
    ttsEngine: "minimax",
    ttsSpeed: 1.1,
    ttsVolume: 0.9,
    ttsMinimaxKey: "mm-key",
    ttsMinimaxVoiceId: "mm-voice",
    ttsMinimaxModel: "speech-2.8-turbo",
    ttsGptsovitsFormat: "wav",
    ttsGptsovitsBaseUrl: "http://gs.local",
    ttsGptsovitsRefAudioPath: "ref.wav",
    ttsGptsovitsPromptText: "提示文本",
    ttsGptsovitsTimeoutMs: 30_000,
    ttsCustomCloudFormat: "mp3",
    ttsCustomCloudEndpointUrl: "http://cc.local",
    ttsCustomCloudApiKey: "cc-key",
    ttsCustomCloudVoiceId: "cc-voice",
    ttsCustomCloudTimeoutMs: 20_000,
    ttsMimoKey: "mimo-key",
    ttsMimoVoiceAudioPath: "mimo.wav",
    ttsMimoStylePrompt: "轻快",
    ttsMosslandKey: "ml-key",
    ttsMosslandVoiceId: "ml-voice",
    ttsMosslandModel: "ml-model",
    ttsMosslandFormat: "mp3",
    ...overrides,
  } as GeneralSettings;
}

describe("buildTaskAlertTtsRequest（纯函数契约）", () => {
  it("engine 为 off 时返回 error", () => {
    const request = buildTaskAlertTtsRequest(makeSettings({ ttsEngine: "off" }), "文本");
    expect(request).toEqual({ error: "未启用 TTS 引擎" });
  });

  it("minimax：payload 与 cacheKey 使用同一份字段，format 固定 mp3", () => {
    const settings = makeSettings();
    const request = buildTaskAlertTtsRequest(settings, "到点提醒");
    if ("error" in request) throw new Error("不应返回 error");
    expect(request.payload).toEqual({
      text: "到点提醒",
      speed: 1.1,
      volume: 0.9,
      apiKey: "mm-key",
      voiceId: "mm-voice",
      model: "speech-2.8-turbo",
      format: "mp3",
    });
    expect(request.cacheKey).toBe(
      buildTtsCacheKey({
        voiceId: "mm-voice",
        text: "到点提醒",
        speed: 1.1,
        volume: 0.9,
        model: "speech-2.8-turbo",
        format: "mp3",
      }),
    );
  });

  it("gptsovits：format 来自设置而非固定值", () => {
    const request = buildTaskAlertTtsRequest(makeSettings({ ttsEngine: "gptsovits" }), "文本");
    if ("error" in request) throw new Error("不应返回 error");
    expect(request.payload.format).toBe("wav");
    expect(request.payload.timeoutMs).toBe(30_000);
    expect(request.cacheKey).toBe(
      buildGptsovitsCacheKey({
        baseUrl: "http://gs.local",
        refAudioPath: "ref.wav",
        promptText: "提示文本",
        text: "文本",
        speed: 1.1,
        format: "wav",
      }),
    );
  });

  it("custom-cloud：端点与鉴权字段完整传入", () => {
    const request = buildTaskAlertTtsRequest(makeSettings({ ttsEngine: "custom-cloud" }), "文本");
    if ("error" in request) throw new Error("不应返回 error");
    expect(request.payload).toMatchObject({
      apiKey: "cc-key",
      voiceId: "cc-voice",
      endpointUrl: "http://cc.local",
      format: "mp3",
      timeoutMs: 20_000,
    });
    expect(request.cacheKey).toBe(
      buildCustomCloudCacheKey({
        endpointUrl: "http://cc.local",
        voiceId: "cc-voice",
        text: "文本",
        speed: 1.1,
        volume: 0.9,
        format: "mp3",
      }),
    );
  });

  it("mimo：format 固定 wav，不带 volume", () => {
    const request = buildTaskAlertTtsRequest(makeSettings({ ttsEngine: "mimo" }), "文本");
    if ("error" in request) throw new Error("不应返回 error");
    expect(request.payload).toMatchObject({
      apiKey: "mimo-key",
      voiceAudioPath: "mimo.wav",
      stylePrompt: "轻快",
      format: "wav",
    });
    expect("volume" in request.payload).toBe(false);
    expect(request.cacheKey).toBe(
      buildMimoCacheKey({
        voiceAudioPath: "mimo.wav",
        text: "文本",
        stylePrompt: "轻快",
      }),
    );
  });

  it("mossland：携带 mosslandFormat 与独立鉴权", () => {
    const request = buildTaskAlertTtsRequest(makeSettings({ ttsEngine: "mossland" }), "文本");
    if ("error" in request) throw new Error("不应返回 error");
    expect(request.payload).toMatchObject({
      apiKey: "ml-key",
      voiceId: "ml-voice",
      model: "ml-model",
      format: "mp3",
      mosslandFormat: "mp3",
    });
    expect(request.cacheKey).toBe(
      buildMosslandCacheKey({
        voiceId: "ml-voice",
        text: "文本",
        model: "ml-model",
        format: "mp3",
      }),
    );
  });

  it(`超过 ${TASK_ALERT_MAX_TTS_TEXT} 字截断并追加省略号`, () => {
    const longText = "啊".repeat(TASK_ALERT_MAX_TTS_TEXT + 50);
    const request = buildTaskAlertTtsRequest(makeSettings(), longText);
    if ("error" in request) throw new Error("不应返回 error");
    const expected = "啊".repeat(TASK_ALERT_MAX_TTS_TEXT) + "…";
    expect(request.payload.text).toBe(expected);
    expect(request.payload.text.length).toBe(TASK_ALERT_MAX_TTS_TEXT + 1);
    // cacheKey 必须对截断后的文本计算，保证到点同文本命中缓存
    expect(request.cacheKey).toBe(
      buildTtsCacheKey({
        voiceId: "mm-voice",
        text: expected,
        speed: 1.1,
        volume: 0.9,
        model: "speech-2.8-turbo",
        format: "mp3",
      }),
    );
  });

  it("恰好等于上限的文本不截断", () => {
    const exact = "好".repeat(TASK_ALERT_MAX_TTS_TEXT);
    const request = buildTaskAlertTtsRequest(makeSettings(), exact);
    if ("error" in request) throw new Error("不应返回 error");
    expect(request.payload.text).toBe(exact);
  });
});

describe("synthesizeTaskAlertTts", () => {
  beforeEach(() => {
    ttsMocks.cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-task-alert-tts-"));
    ttsMocks.settings = makeSettings();
    ttsMocks.cached = null;
    ttsMocks.synthError = undefined;
  });

  afterEach(() => {
    fs.rmSync(ttsMocks.cacheDir, { recursive: true, force: true });
  });

  it("缓存命中时直接返回缓存音频，不调用引擎", async () => {
    ttsMocks.cached = { audio: Buffer.from("cached"), format: "mp3" };
    const audio = await synthesizeTaskAlertTts("提醒内容");
    expect(audio).toEqual({ base64: Buffer.from("cached").toString("base64"), format: "mp3" });
    const { synthesizeByEngine } = await import("../tts/tts-dispatcher");
    expect(vi.mocked(synthesizeByEngine)).not.toHaveBeenCalled();
  });

  it("缓存未命中时调用引擎并把结果写入缓存目录", async () => {
    const audio = await synthesizeTaskAlertTts("提醒内容");
    expect(audio).toEqual({
      base64: Buffer.from("synthesized").toString("base64"),
      format: "mp3",
    });
    const written = fs.readdirSync(ttsMocks.cacheDir);
    expect(written).toHaveLength(1);
    expect(written[0].endsWith(".mp3")).toBe(true);
    expect(fs.readFileSync(path.join(ttsMocks.cacheDir, written[0])).toString()).toBe("synthesized");
  });

  it("引擎抛错时返回 error 而不抛出", async () => {
    ttsMocks.synthError = new Error("网络超时");
    const audio = await synthesizeTaskAlertTts("提醒内容");
    expect(audio).toEqual({ error: "网络超时" });
  });
});
