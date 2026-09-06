import "../ui/theme";

// ── preload 桥接（由共享 preload 暴露） ─────────────────────
interface AlertData {
  historyId: string;
  taskId: string;
  taskTitle: string;
  content: string;
  isError: boolean;
}

type AlertAudio = { base64: string; format: string } | { error: string };

declare global {
  interface Window {
    taskAlert?: {
      minimize: () => void;
      close: () => void;
      onAlertData: (cb: (data: AlertData) => void) => () => void;
      onAlertAudio: (cb: (data: AlertAudio) => void) => () => void;
    };
  }
}

// 安全兜底：preload 未注入时不崩
if (!window.taskAlert) {
  (window as unknown as { taskAlert: unknown }).taskAlert = {
    minimize: () => {},
    close: () => {},
    onAlertData: () => () => {},
    onAlertAudio: () => () => {},
  };
}

// ── DOM ──────────────────────────────────────────────────────
const $ = <T extends HTMLElement = HTMLElement>(id: string): T | null =>
  document.getElementById(id) as T | null;

const minBtn = $("min-btn") as HTMLButtonElement;
const closeBtn = $("close-btn") as HTMLButtonElement;
const hint = $("alert-hint");
const taskTitle = $("task-title");
const contentEl = $("alert-content");
const loadingEl = $("alert-loading");
const audioStatus = $("audio-status");

minBtn?.addEventListener("click", () => window.taskAlert?.minimize());
closeBtn?.addEventListener("click", () => window.taskAlert?.close());

// ── 任务数据 ─────────────────────────────────────────────────
function renderData(data: AlertData): void {
  if (taskTitle) taskTitle.textContent = data.taskTitle || "定时任务";
  if (hint) {
    hint.textContent = data.isError ? "执行失败" : "已完成";
    hint.classList.toggle("task-alert__hint--error", data.isError);
  }
  if (contentEl) {
    contentEl.textContent = data.content || (data.isError ? "未知错误" : "（无内容）");
    contentEl.hidden = false;
  }
  if (loadingEl) loadingEl.hidden = true;
  if (!data.isError && audioStatus) {
    audioStatus.hidden = false;
    audioStatus.textContent = "语音合成中…";
  }
}

// ── 语音播放 ─────────────────────────────────────────────────
let currentAudio: HTMLAudioElement | null = null;

function renderAudio(audio: AlertAudio): void {
  if (!audioStatus) return;
  audioStatus.hidden = false;
  if ("error" in audio) {
    audioStatus.textContent = `语音不可用：${audio.error}`;
    audioStatus.classList.add("task-alert__audio-status--muted");
    return;
  }
  if (audio.format === "pcm") {
    audioStatus.textContent = "语音格式（pcm）无法在弹窗播放";
    audioStatus.classList.add("task-alert__audio-status--muted");
    return;
  }
  const mime = audio.format === "wav" ? "audio/wav" : "audio/mpeg";
  audioStatus.textContent = "播放中…";
  currentAudio?.pause();
  const player = new Audio(`data:${mime};base64,${audio.base64}`);
  currentAudio = player;
  player.addEventListener("ended", () => {
    audioStatus.hidden = true;
    audioStatus.classList.remove("task-alert__audio-status--muted");
  });
  player.addEventListener("error", () => {
    audioStatus.textContent = "语音播放失败";
    audioStatus.classList.add("task-alert__audio-status--muted");
  });
  void player.play().catch(() => {
    audioStatus.textContent = "语音播放失败";
    audioStatus.classList.add("task-alert__audio-status--muted");
  });
}

window.taskAlert?.onAlertData(renderData);
window.taskAlert?.onAlertAudio(renderAudio);
