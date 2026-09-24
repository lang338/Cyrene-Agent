// 定时任务到点提醒的语音（"昔涟说话"那一路）。
//
// 来源说明：本模块原属 PR #1 的"独立提醒窗口"方案（`task-alert-window.ts`）。后来上游自己
// 用 toast 通知做完了到点提醒（且 toast 窗口本来就有一条音频通道），所以我们只把**语音**
// 这一层接回上游的 toast 通路上，不再保留独立窗口——本文件因此从 scheduler 目录挪到
// toast 目录，只有合成与缓存逻辑原样保留。
//
// 分工：
//   - 本模块：按当前 TTS 设置组装请求、合成、读写 cyrene-tts-cache
//   - ToastService：决定"要不要提醒"（成功态 + 焦点抑制），之后才调到这里
//   - toast 渲染页：拿到音频就播（见 src/renderer/toast/toast.ts）
//
// 任何一个环节失败都只记日志，绝不影响弹窗本身。

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
 * 按当前 TTS 设置组装播报语音的引擎请求：超长截断、cacheKey、payload。
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
  // mossland：format 跟随 ttsMosslandFormat（dispatcher 实际用 payload.mosslandFormat
  // 决定合成格式），缓存键必须与真实音频格式一致——否则 mp3/wav 切换后同键串缓存。
  const format = settings.ttsMosslandFormat;
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
 * 任务完成播报：按当前 TTS 设置合成，写入 cyrene-tts-cache（同文本自动命中缓存，
 * 同一个任务反复跑不会重复花钱）。
 * 任何失败都以 { error } 返回，由调用方决定怎么处理，不影响弹窗展示。
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

/**
 * 播报文案：一句话报完成 + 任务输出预览。
 * 预览是任务的原始输出（可能很长），截断交给 buildTaskAlertTtsRequest 的字符上限。
 */
export function buildTaskAlertText(taskTitle: string, outputPreview?: string): string {
  const title = taskTitle.trim();
  const preview = (outputPreview ?? "").trim();
  if (!title) return preview;
  const head = `「${title}」跑完啦。`;
  return preview ? `${head}${preview}` : head;
}

/**
 * 合成一条任务完成播报；未启用（门控）或合成失败时返回 null，调用方静默跳过。
 *
 * 门控刻意复用已有开关，不另设"任务播报"开关：
 *   - `toastSoundEnabled`：提醒音效总开关，关掉即彻底静音（含语音）
 *   - `ttsEngine !== "off"`：没配 TTS 引擎就没有声音，不必让它走到合成报错
 * 若以后需要"提示音开、语音关"，再把它拆成独立开关。
 */
export async function synthesizeTaskAnnouncement(input: {
  taskTitle: string;
  outputPreview?: string;
}): Promise<{ base64: string; format: string } | null> {
  const settings = loadGeneralSettings();
  if (!settings.toastSoundEnabled) return null;
  if (settings.ttsEngine === "off") return null;
  const text = buildTaskAlertText(input.taskTitle, input.outputPreview);
  if (!text) return null;
  const audio = await synthesizeTaskAlertTts(text);
  if ("error" in audio) {
    console.warn("[Toast] 任务完成播报合成失败（不影响弹窗）:", audio.error);
    return null;
  }
  return { base64: audio.base64, format: audio.format };
}
