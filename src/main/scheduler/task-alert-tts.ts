import * as fs from "fs";
import * as path from "path";
import type { GeneralSettings } from "../settings/general-settings";
import { loadGeneralSettings } from "../settings/settings-facade";
import { synthesizeByEngine, type SynthesizeByEnginePayload } from "../tts/tts-dispatcher";
import {
  buildCustomCloudCacheKey,
  buildGptsovitsCacheKey,
  buildMimoCacheKey,
  buildMosslandCacheKey,
  buildTtsCacheKey,
  getTtsCachePath,
  readTtsCacheByKey,
} from "../tts/tts-cache";

export type TaskAlertAudio = { base64: string; format: string } | { error: string };

export const TASK_ALERT_MAX_TTS_TEXT = 1000;

export type TaskAlertTtsRequest =
  | { cacheKey: string; payload: SynthesizeByEnginePayload }
  | { error: string };

/**
 * 按当前 TTS 设置组装弹窗语音的引擎请求：超长截断、cacheKey、payload。
 * 纯函数（无 IO），测试用它锁定与 tts-synthesis-service 的字段映射契约。
 * 注意：format 语义与渠道版不同——这里是引擎默认格式，渠道版由目标渠道决定。
 */
export function buildTaskAlertTtsRequest(
  settings: GeneralSettings,
  text: string,
): TaskAlertTtsRequest {
  const engine = settings.ttsEngine;
  if (engine === "off") return { error: "未启用 TTS 引擎" };
  const ttsText =
    text.length > TASK_ALERT_MAX_TTS_TEXT
      ? text.slice(0, TASK_ALERT_MAX_TTS_TEXT) + "…"
      : text;
  const speed = settings.ttsSpeed;
  const volume = settings.ttsVolume;

  if (engine === "minimax") {
    const format = "mp3" as const;
    return {
      cacheKey: buildTtsCacheKey({
        voiceId: settings.ttsMinimaxVoiceId ?? "",
        text: ttsText,
        speed,
        volume,
        model: settings.ttsMinimaxModel,
        format,
      }),
      payload: {
        text: ttsText,
        speed,
        volume,
        apiKey: settings.ttsMinimaxKey,
        voiceId: settings.ttsMinimaxVoiceId,
        model: settings.ttsMinimaxModel,
        format,
      },
    };
  }
  if (engine === "gptsovits") {
    const format = settings.ttsGptsovitsFormat;
    return {
      cacheKey: buildGptsovitsCacheKey({
        baseUrl: settings.ttsGptsovitsBaseUrl ?? "",
        refAudioPath: settings.ttsGptsovitsRefAudioPath ?? "",
        promptText: settings.ttsGptsovitsPromptText ?? "",
        text: ttsText,
        speed,
        format,
      }),
      payload: {
        text: ttsText,
        speed,
        baseUrl: settings.ttsGptsovitsBaseUrl,
        refAudioPath: settings.ttsGptsovitsRefAudioPath,
        promptText: settings.ttsGptsovitsPromptText,
        format,
        timeoutMs: settings.ttsGptsovitsTimeoutMs,
      },
    };
  }
  if (engine === "custom-cloud") {
    const format = settings.ttsCustomCloudFormat;
    return {
      cacheKey: buildCustomCloudCacheKey({
        endpointUrl: settings.ttsCustomCloudEndpointUrl ?? "",
        voiceId: settings.ttsCustomCloudVoiceId,
        text: ttsText,
        speed,
        volume,
        format,
      }),
      payload: {
        text: ttsText,
        speed,
        volume,
        apiKey: settings.ttsCustomCloudApiKey,
        voiceId: settings.ttsCustomCloudVoiceId,
        endpointUrl: settings.ttsCustomCloudEndpointUrl,
        format,
        timeoutMs: settings.ttsCustomCloudTimeoutMs,
      },
    };
  }
  if (engine === "mimo") {
    return {
      cacheKey: buildMimoCacheKey({
        voiceAudioPath: settings.ttsMimoVoiceAudioPath,
        text: ttsText,
        stylePrompt: settings.ttsMimoStylePrompt,
      }),
      payload: {
        text: ttsText,
        speed,
        apiKey: settings.ttsMimoKey,
        voiceAudioPath: settings.ttsMimoVoiceAudioPath,
        stylePrompt: settings.ttsMimoStylePrompt,
        format: "wav",
      },
    };
  }
  const format = "mp3" as const;
  return {
    cacheKey: buildMosslandCacheKey({
      voiceId: settings.ttsMosslandVoiceId,
      text: ttsText,
      model: settings.ttsMosslandModel,
      format,
    }),
    payload: {
      text: ttsText,
      speed,
      volume,
      apiKey: settings.ttsMosslandKey,
      voiceId: settings.ttsMosslandVoiceId,
      model: settings.ttsMosslandModel,
      format,
      mosslandFormat: settings.ttsMosslandFormat,
    },
  };
}

/**
 * 定时任务弹窗语音：按当前 TTS 设置合成，写入 cyrene-tts-cache（同文本自动命中缓存）。
 * 任何失败都以 { error } 返回，不影响弹窗展示。
 */
export async function synthesizeTaskAlertTts(text: string): Promise<TaskAlertAudio> {
  try {
    const settings = loadGeneralSettings();
    const request = buildTaskAlertTtsRequest(settings, text);
    if ("error" in request) return request;

    const cached = readTtsCacheByKey(request.cacheKey);
    if (cached) {
      return { base64: cached.audio.toString("base64"), format: cached.format };
    }

    const result = await synthesizeByEngine(settings.ttsEngine, request.payload);
    const cachePath = getTtsCachePath(request.cacheKey, result.format);
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, result.audio);
    return { base64: result.audio.toString("base64"), format: result.format };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
