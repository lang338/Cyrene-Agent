import { app, BrowserWindow, screen } from "electron";
import * as path from "path";
import { IPC } from "../../shared/ipc-channels";
import { isDev } from "../env";
import {
  getCurrentAppIconPath,
  getTaskAlertWindow,
  setTaskAlertWindow,
} from "../windows/window-state";
import { synthesizeTaskAlertTts } from "./task-alert-tts";

export interface TaskAlertPayload {
  historyId: string;
  taskId: string;
  taskTitle: string;
  /** 昔涟回复文本；失败时为 errorMessage */
  content: string;
  isError: boolean;
}

/** did-finish-load 时点与渲染端订阅之间可能存在竞态，先暂存待发数据 */
let pendingData: TaskAlertPayload | null = null;
/** 同理暂存 TTS 语音（缓存命中时 sendTaskAlertAudio 可能早于 did-finish-load） */
let pendingAudio: { base64: string; format: string } | { error: string } | null = null;

/**
 * 创建/复用定时任务提醒弹窗（右下角置顶，手动关闭）。
 * 若已有弹窗开着则先关再建，保证单窗口、数据不串台。
 */
export function showTaskAlertWindow(payload: TaskAlertPayload): void {
  const existing = getTaskAlertWindow();
  if (existing && !existing.isDestroyed()) {
    existing.close();
  }
  pendingData = payload;

  const display = screen.getPrimaryDisplay();
  const { x: dx, y: dy, width: dw, height: dh } = display.workArea;
  const width = 380;
  const height = 520;
  const margin = 24;
  const window = new BrowserWindow({
    x: dx + dw - width - margin,
    y: dy + dh - height - margin,
    width,
    height,
    title: "昔涟 · 定时任务提醒",
    icon: getCurrentAppIconPath(),
    backgroundColor: "#00000000",
    autoHideMenuBar: true,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: false,
    webPreferences: {
      preload: path.join(app.getAppPath(), "dist", "preload", "preload", "index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  setTaskAlertWindow(window);

  window.webContents.on("did-finish-load", () => {
    if (window.isDestroyed()) return;
    if (pendingData) {
      console.log("[TaskAlert] did-finish-load → 推送 TASK_ALERT_DATA");
      window.webContents.send(IPC.TASK_ALERT_DATA, pendingData);
      pendingData = null;
    }
    if (pendingAudio) {
      console.log("[TaskAlert] did-finish-load → 推送缓存 TASK_ALERT_AUDIO",
        "error" in pendingAudio ? `error=${pendingAudio.error}` : `format=${pendingAudio.format}`);
      window.webContents.send(IPC.TASK_ALERT_AUDIO, pendingAudio);
      pendingAudio = null;
    }
  });

  window.on("closed", () => {
    // guard：只有被关闭的确实是当前活跃窗口才清空引用
    if (getTaskAlertWindow() === window) {
      setTaskAlertWindow(null);
    }
  });

  if (isDev) {
    void window.loadURL("http://localhost:5173/task-alert/");
  } else {
    void window.loadFile(
      path.join(app.getAppPath(), "dist", "renderer", "task-alert", "index.html"),
    );
  }

  window.once("ready-to-show", () => {
    window.show();
    window.focus();
    window.moveTop();
  });
}

/** TTS 就绪后推送语音；弹窗已被用户关掉则静默丢弃。 */
export function sendTaskAlertAudio(
  audio: { base64: string; format: string } | { error: string },
): void {
  const win = getTaskAlertWindow();
  if (!win || win.isDestroyed()) {
    console.warn("[TaskAlert] sendTaskAlertAudio: 窗口不存在，丢弃语音");
    return;
  }
  // 页面还没加载完（did-finish-load 未触发），先暂存等 did-finish-load 时一起推。
  if (!win.webContents.isLoading()) {
    console.log("[TaskAlert] 直接推送 TASK_ALERT_AUDIO",
      "error" in audio ? `error=${audio.error}` : `format=${audio.format}, bytes=${audio.base64.length}`);
    win.webContents.send(IPC.TASK_ALERT_AUDIO, audio);
  } else {
    console.log("[TaskAlert] 页面仍在加载，暂存 TASK_ALERT_AUDIO");
    pendingAudio = audio;
  }
}

/**
 * 任务结果 → 弹窗 + TTS 播报。fire-and-forget，任何异常都不影响任务主流程。
 * 失败任务只弹窗展示原因，不合成语音。
 */
export function notifyTaskResult(payload: TaskAlertPayload): void {
  console.log("[TaskAlert] notifyTaskResult", JSON.stringify({
    taskId: payload.taskId,
    taskTitle: payload.taskTitle,
    isError: payload.isError,
    contentLen: payload.content.length,
  }));
  try {
    showTaskAlertWindow(payload);
  } catch (err) {
    console.warn("[TaskAlert] 打开弹窗失败:", err);
    return;
  }
  if (payload.isError || !payload.content.trim()) {
    console.log("[TaskAlert] 跳过 TTS：isError=", payload.isError, "content为空=", !payload.content.trim());
    return;
  }
  void synthesizeTaskAlertTts(payload.content)
    .then((audio) => {
      if ("error" in audio) {
        console.warn("[TaskAlert] TTS 合成返回 error:", audio.error);
      } else {
        console.log("[TaskAlert] TTS 合成成功 format=", audio.format, "bytes=", audio.base64.length);
      }
      sendTaskAlertAudio(audio);
    })
    .catch((err) => {
      console.warn("[TaskAlert] 语音合成异常:", err);
      sendTaskAlertAudio({ error: err instanceof Error ? err.message : String(err) });
    });
}
