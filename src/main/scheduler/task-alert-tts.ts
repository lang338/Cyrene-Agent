import * as fs from "fs";
import * as path from "path";
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

const MAX_TTS_TEXT = 1000;

/**
 * 定时任务弹窗语音：按当前 TTS 设置合成，写入 cyrene-tts-cache（同文本自动命中缓存）。
 * payload 组装与 tts-synthesis-service 的 synthesizeChannelTts 保持一致。
 * 任何失败都以 { error } 返回，不影响弹窗展示。
 */
export async function synthesizeTaskAlertTts(text: string): Promise<TaskAlertAudio> {
  try {
    const settings = loadGeneralSettings();
    const engine = settings.ttsEngine;
    if (engine === "off") return { error: "未启用 TTS 引擎" };
    const ttsText = text.length > MAX_TTS_TEXT ? text.slice(0, MAX_TTS_TEXT) + "…" : text;
    const speed = settings.ttsSpeed;
    const volume = settings.ttsVolume;

    let cacheKey: string;
    let payload: SynthesizeByEnginePayload;
    if (engine === "minimax") {
      const format = "mp3" as const;
      cacheKey = buildTtsCacheKey({
        voiceId: settings.ttsMinimaxVoiceId ?? "",
        text: ttsText,
        speed,
        volume,
        model: settings.ttsMinimaxModel,
        format,
      });
      payload = {
        text: ttsText,
        speed,
        volume,
        apiKey: settings.ttsMinimaxKey,
        voiceId: settings.ttsMinimaxVoiceId,
        model: settings.ttsMinimaxModel,
        format,
      };
    } else if (engine === "gptsovits") {
      const format = settings.ttsGptsovitsFormat;
      cacheKey = buildGptsovitsCacheKey({
        baseUrl: settings.ttsGptsovitsBaseUrl ?? "",
        refAudioPath: settings.ttsGptsovitsRefAudioPath ?? "",
        promptText: settings.ttsGptsovitsPromptText ?? "",
        text: ttsText,
        speed,
        format,
      });
      payload = {
        text: ttsText,
        speed,
        baseUrl: settings.ttsGptsovitsBaseUrl,
        refAudioPath: settings.ttsGptsovitsRefAudioPath,
        promptText: settings.ttsGptsovitsPromptText,
        format,
        timeoutMs: settings.ttsGptsovitsTimeoutMs,
      };
    } else if (engine === "custom-cloud") {
      const format = settings.ttsCustomCloudFormat;
      cacheKey = buildCustomCloudCacheKey({
        endpointUrl: settings.ttsCustomCloudEndpointUrl ?? "",
        voiceId: settings.ttsCustomCloudVoiceId,
        text: ttsText,
        speed,
        volume,
        format,
      });
      payload = {
        text: ttsText,
        speed,
        volume,
        apiKey: settings.ttsCustomCloudApiKey,
        voiceId: settings.ttsCustomCloudVoiceId,
        endpointUrl: settings.ttsCustomCloudEndpointUrl,
        format,
        timeoutMs: settings.ttsCustomCloudTimeoutMs,
      };
    } else if (engine === "mimo") {
      cacheKey = buildMimoCacheKey({
        voiceAudioPath: settings.ttsMimoVoiceAudioPath,
        text: ttsText,
        stylePrompt: settings.ttsMimoStylePrompt,
      });
      payload = {
        text: ttsText,
        speed,
        apiKey: settings.ttsMimoKey,
        voiceAudioPath: settings.ttsMimoVoiceAudioPath,
        stylePrompt: settings.ttsMimoStylePrompt,
        format: "wav",
      };
    } else {
      const format = "mp3" as const;
      cacheKey = buildMosslandCacheKey({
        voiceId: settings.ttsMosslandVoiceId,
        text: ttsText,
        model: settings.ttsMosslandModel,
        format,
      });
      payload = {
        text: ttsText,
        speed,
        volume,
        apiKey: settings.ttsMosslandKey,
        voiceId: settings.ttsMosslandVoiceId,
        model: settings.ttsMosslandModel,
        format,
        mosslandFormat: settings.ttsMosslandFormat,
      };
    }

    const cached = readTtsCacheByKey(cacheKey);
    if (cached) {
      return { base64: cached.audio.toString("base64"), format: cached.format };
    }

    const result = await synthesizeByEngine(engine, payload);
    const cachePath = getTtsCachePath(cacheKey, result.format);
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, result.audio);
    return { base64: result.audio.toString("base64"), format: result.format };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
