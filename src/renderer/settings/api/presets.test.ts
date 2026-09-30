import { describe, expect, it } from "vitest";
import { MODEL_PRESETS, presetTransportUrl } from "./presets";

describe("provider preset transport endpoints", () => {
  it("uses MiniMax's official Responses endpoint and retains its existing defaults", () => {
    const minimax = MODEL_PRESETS.find((preset) => preset.providerId === "minimax");
    expect(minimax).toBeDefined();
    expect(presetTransportUrl(minimax!, "responses")).toBe("https://api.minimax.cn/v1");
    expect(presetTransportUrl(minimax!, "anthropic")).toBe("https://api.minimaxi.com/anthropic");
    expect(presetTransportUrl(minimax!, "openai")).toBe("https://api.minimaxi.com/v1");
  });
});
