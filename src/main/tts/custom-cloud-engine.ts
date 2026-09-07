// 自定义云端 TTS 引擎
// 固定 HTTP 合约：POST endpointUrl，返回音频二进制或 JSON base64。

import { resolveTimeoutPolicy } from "../runtime-policy";

export interface CustomCloudSynthesizeOptions {
  endpointUrl: string;
  apiKey?: string;
  voiceId?: string;
  text: string;
  speed?: number;
  volume?: number;
  format?: "wav" | "mp3";
  timeoutMs?: number;
  debugLog?: (entry: Record<string, unknown>) => void;
}

export interface CustomCloudSynthesizeResult {
  audio: Buffer;
  format: "wav" | "mp3";
}

const DEFAULT_TIMEOUT_MS = resolveTimeoutPolicy({ stage: "tts-custom-cloud" }).totalMs;

function normalizeFormat(value: unknown, fallback: "wav" | "mp3"): "wav" | "mp3" {
  return value === "wav" || value === "mp3" ? value : fallback;
}

function isJsonContentType(contentType: string): boolean {
  return contentType.toLowerCase().includes("application/json");
}

function guessFormatFromContentType(contentType: string, fallback: "wav" | "mp3"): "wav" | "mp3" {
  const lower = contentType.toLowerCase();
  if (lower.includes("wav") || lower.includes("wave")) return "wav";
  if (lower.includes("mpeg") || lower.includes("mp3")) return "mp3";
  return fallback;
}

export async function synthesize(opts: CustomCloudSynthesizeOptions): Promise<CustomCloudSynthesizeResult> {
  const endpointUrl = opts.endpointUrl?.trim();
  const text = opts.text?.trim();
  const format = opts.format ?? "mp3";
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const requestId = `custom-cloud-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const startedAt = Date.now();

  const log = (entry: Record<string, unknown>) => {
    try { opts.debugLog?.({ requestId, ts: new Date().toISOString(), ...entry }); } catch { /* ignore */ }
  };

  if (!endpointUrl) throw new Error("缺少自定义云端 TTS 地址");
  if (!text) throw new Error("缺少合成文本");

  // 凭据安全（CWE-319）：apiKey 走 Authorization 头传输，端点必须 https——
  // 明文 http 下网络观察者可直接读取凭据。
  let requestUrl: URL;
  try {
    requestUrl = new URL(endpointUrl);
  } catch {
    throw new Error(`自定义云端 TTS 地址无效: ${endpointUrl}`);
  }
  if (requestUrl.protocol !== "https:") {
    throw new Error("自定义云端 TTS 地址必须使用 https（避免 API key 明文传输）");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const apiKey = opts.apiKey?.trim();
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  log({
    phase: "request.begin",
    endpoint: endpointUrl,
    textChars: Array.from(text).length,
    format,
    timeoutMs,
  });

  let resp: Response;
  try {
    resp = await fetch(endpointUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        text,
        voiceId: opts.voiceId?.trim() || undefined,
        speed: opts.speed ?? 1,
        volume: opts.volume ?? 1,
        format,
      }),
      signal: controller.signal,
      // 不跟随重定向：307/308 会把请求体（含播报文本）重放到目标地址，
      // 若目标降级为 http 则明文外泄（Authorization 会被 fetch 剥离，但 body 不会）。
      redirect: "error",
    });
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      log({ phase: "error", error: `合成超时（${timeoutMs}ms）`, durationMs: Date.now() - startedAt });
      throw new Error(`自定义云端 TTS 合成超时（${timeoutMs}ms）`);
    }
    log({ phase: "error", error: err instanceof Error ? err.message : String(err), durationMs: Date.now() - startedAt });
    throw new Error(`自定义云端 TTS 请求失败: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }

  // 防降级重定向：fetch 会自动跟随重定向，若终态 URL 降级为 http 则中止——
  // 不向明文连接发送凭据，也不读取其响应。（https→http 必为跨源，fetch 规范
  // 本就会剥离 Authorization，此处为显式防御 + 阻断明文响应内容。）
  // 构造的 Response（测试桩等）可能没有 url，回退到已校验 https 的请求地址。
  const finalUrl = resp.url || requestUrl.href;
  if (new URL(finalUrl).protocol !== "https:") {
    log({ phase: "error", error: "redirect downgraded to http", finalUrl, durationMs: Date.now() - startedAt });
    throw new Error("自定义云端 TTS 重定向降级到 http，已中止以保护 API key");
  }

  if (!resp.ok) {
    const preview = (await resp.text().catch(() => "")).slice(0, 200);
    log({ phase: "error", status: resp.status, bodyPreview: preview, durationMs: Date.now() - startedAt });
    throw new Error(`自定义云端 TTS 合成失败: ${resp.status} ${preview}`.trim());
  }

  const contentType = resp.headers.get("Content-Type") ?? "";
  let audio: Buffer;
  let resultFormat = guessFormatFromContentType(contentType, format);

  if (isJsonContentType(contentType)) {
    const data = (await resp.json()) as {
      audioBase64?: unknown;
      format?: unknown;
    };
    if (typeof data.audioBase64 !== "string" || !data.audioBase64.trim()) {
      throw new Error("自定义云端 TTS 响应缺少 audioBase64");
    }
    audio = Buffer.from(data.audioBase64, "base64");
    resultFormat = normalizeFormat(data.format, format);
  } else {
    audio = Buffer.from(await resp.arrayBuffer());
  }

  if (audio.length === 0) {
    throw new Error("自定义云端 TTS 返回空音频");
  }

  log({
    phase: "response.final",
    durationMs: Date.now() - startedAt,
    audioBytes: audio.length,
    format: resultFormat,
  });

  return { audio, format: resultFormat };
}
