import type { ScheduledTask } from "./types";
import { synthesizeTaskAlertTts } from "./task-alert-tts";

export type TaskAlertPregenResult = { content: string } | { error: string };

/**
 * 新建/编辑定时任务时预生成到点播报内容，并立刻按当前 TTS 设置合成语音写入
 * cyrene-tts-cache（到点时 synthesizeTaskAlertTts 同文本命中缓存，即取即播）。
 * TTS 暖缓存失败不影响内容预生成（到点时还会再尝试合成）。
 */
export async function pregenerateTaskAlert(
  task: ScheduledTask,
  generateContent: (task: ScheduledTask) => Promise<string>,
): Promise<TaskAlertPregenResult> {
  try {
    const content = (await generateContent(task)).trim();
    if (!content) return { error: "预生成内容为空" };
    const audio = await synthesizeTaskAlertTts(content);
    if ("error" in audio) {
      console.warn("[TaskAlert] 预生成语音失败（到点会再尝试）:", audio.error);
    }
    return { content };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn("[TaskAlert] 预生成提醒内容失败:", message);
    return { error: message };
  }
}
