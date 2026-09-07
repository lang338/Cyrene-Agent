import { afterEach, describe, expect, it, vi } from "vitest";
import { synthesize } from "./custom-cloud-engine";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("custom-cloud-engine synthesize", () => {
  it("rejects missing endpointUrl", async () => {
    await expect(synthesize({ endpointUrl: "", text: "hello" })).rejects.toThrow(/自定义云端 TTS 地址/);
  });

  it("rejects missing text", async () => {
    await expect(synthesize({ endpointUrl: "https://tts.example.com", text: "" })).rejects.toThrow(/合成文本/);
  });

  it("rejects non-https endpointUrl before any request is made", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(synthesize({
      endpointUrl: "http://tts.example.com/api",
      apiKey: "secret-key",
      text: "hi",
    })).rejects.toThrow(/https/);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects invalid endpointUrl", async () => {
    await expect(synthesize({
      endpointUrl: "not-a-valid-url",
      text: "hi",
    })).rejects.toThrow(/地址无效/);
  });

  it("aborts when the final response URL downgraded to http", async () => {
    // 模拟 fetch 自动跟随重定向后的终态：响应本身 200，但最终 URL 已降级为 http
    const response = new Response(Buffer.from("ID3fake"), {
      status: 200,
      headers: { "Content-Type": "audio/mpeg" },
    });
    Object.defineProperty(response, "url", { value: "http://cdn.example.com/audio.mp3" });
    vi.stubGlobal("fetch", vi.fn(async () => response));

    await expect(synthesize({
      endpointUrl: "https://tts.example.com",
      apiKey: "secret-key",
      text: "hi",
    })).rejects.toThrow(/降级/);
  });

  it("passes redirect: \"error\" so redirects are rejected before the body can be replayed", async () => {
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) =>
      new Response(Buffer.from("ID3fake"), { status: 200, headers: { "Content-Type": "audio/mpeg" } }));
    vi.stubGlobal("fetch", fetchMock);

    await synthesize({ endpointUrl: "https://tts.example.com", apiKey: "secret-key", text: "hi" });

    // 307/308 会把请求体（播报文本）重放到重定向目标；必须让运行时拒绝跟随重定向
    expect(fetchMock).toHaveBeenCalledWith(
      "https://tts.example.com",
      expect.objectContaining({ redirect: "error" }),
    );
  });

  it("parses binary audio responses", async () => {
    const audio = Buffer.from("ID3fake");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(audio, {
      status: 200,
      headers: { "Content-Type": "audio/mpeg" },
    })));

    const result = await synthesize({
      endpointUrl: "https://tts.example.com",
      apiKey: "k",
      text: "hi",
      format: "mp3",
    });

    expect(result.audio.equals(audio)).toBe(true);
    expect(result.format).toBe("mp3");
  });

  it("sends voiceId in the standard request body", async () => {
    const fetchMock = vi.fn(async (_input: unknown, _init?: RequestInit) => new Response(Buffer.from("ID3fake"), {
      status: 200,
      headers: { "Content-Type": "audio/mpeg" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await synthesize({
      endpointUrl: "https://tts.example.com",
      text: "hi",
      voiceId: "cyrene-voice",
      format: "mp3",
    });

    const request = fetchMock.mock.calls[0]?.[1];
    if (!request) throw new Error("missing fetch request init");
    expect(JSON.parse(String(request.body))).toMatchObject({
      text: "hi",
      voiceId: "cyrene-voice",
      format: "mp3",
    });
  });

  it("parses JSON base64 responses", async () => {
    const audio = Buffer.from("RIFFfake");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      audioBase64: audio.toString("base64"),
      format: "wav",
    })));

    const result = await synthesize({
      endpointUrl: "https://tts.example.com",
      text: "hi",
      format: "mp3",
    });

    expect(result.audio.equals(audio)).toBe(true);
    expect(result.format).toBe("wav");
  });

  it("reports HTTP errors with response preview", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad request", { status: 400 })));

    await expect(synthesize({
      endpointUrl: "https://tts.example.com",
      text: "hi",
    })).rejects.toThrow(/400 bad request/);
  });
});
