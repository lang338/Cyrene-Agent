// 定时任务完成语音播报（#82 增强层）：订阅 scheduler-finished 事件，
// 用用户已配置的 TTS 引擎把任务输出摘要合成为语音，下发给 toast 渲染页播放。
//
// 设计边界：
// - 独立开关（taskTtsEnabled，默认关）：与聊天自动朗读（ttsAutoRead）、toast 音效互不影响；
//   任务结果不插聊天流，ttsAutoRead 永远够不着任务输出，toast 是唯一挂点。
// - 听到=看到：播报文本就是 toast summary 用的 outputPreview，不额外调 LLM 改写。
// - 提醒仍有效才播：合成是异步的（云端秒级、本地引擎可能更久），完成后先确认
//   对应 toast 仍在屏上再下发；toast 已消隐（超时/关闭/抑制未弹）则丢弃，
//   避免一个幽灵语音追着已消失的提醒播放。
// - 丢弃优于排队：不缓存不重试，失败静默（console.warn），提醒本身不受影响。

import { IPC } from "../../shared/ipc-channels";
import type { SchedulerFinishedEvent, ToastEventBus } from "./toast-events";

export interface TaskTtsSynthesisResult {
  audio: Buffer;
  mime: string;
}

export interface TaskTtsServiceDeps {
  bus: ToastEventBus;
  /** 任务完成语音独立开关（设置页，默认关） */
  isEnabled: () => boolean;
  /** TTS 合成（组合根注入宿主合成服务；返回 null = 引擎关闭或配置不全） */
  synthesize: (text: string) => Promise<TaskTtsSynthesisResult | null>;
  /**
   * 对应 run 的 task-finished toast 存活判定：仍在屏返回其 toast id，
   * 已消隐/未弹出（超时/关闭/焦点抑制）返回 null。
   */
  findActiveTaskToastId: (schedulerRunId: string) => string | null;
  /** 向 toast 渲染页投递（toast 窗口控制器 send：页面未就绪静默丢弃） */
  send: (channel: string, payload: unknown) => void;
}

export function createTaskTtsService(deps: TaskTtsServiceDeps) {
  /** 同一 runId 合成中去重：事件重放或极短间隔重复完成时不重复合成 */
  const inFlight = new Set<string>();

  async function handleSchedulerFinished(event: SchedulerFinishedEvent): Promise<void> {
    if (!deps.isEnabled()) return;
    // 与 ToastService 同一边界：只有成功完成才播报
    if (event.status !== "success") return;
    const text = event.outputPreview?.trim();
    if (!text) return;
    if (inFlight.has(event.schedulerRunId)) return;

    inFlight.add(event.schedulerRunId);
    try {
      const result = await deps.synthesize(text);
      if (!result) return;
      // 合成完成后再判存活：toast 可能已在合成期间超时/被关闭/被点击
      const toastId = deps.findActiveTaskToastId(event.schedulerRunId);
      if (!toastId) return;
      deps.send(IPC.TOAST_TASK_TTS_PLAY, {
        toastId,
        base64: result.audio.toString("base64"),
        mime: result.mime,
      });
    } catch (err) {
      console.warn("[TaskTts] 任务语音合成失败:", err instanceof Error ? err.message : err);
    } finally {
      inFlight.delete(event.schedulerRunId);
    }
  }

  const unsubscribe = deps.bus.onSchedulerFinished((event) => {
    void handleSchedulerFinished(event);
  });

  return {
    dispose(): void {
      unsubscribe();
      inFlight.clear();
    },
  };
}

export type TaskTtsService = ReturnType<typeof createTaskTtsService>;
