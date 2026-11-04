/**
 * 四象限待办——昔涟帮你处理待办事项
 *
 * 入口装配：register 注册工具面 + prompt 注入 + 结算编排（§8.1：写时结算
 * + 开机补检 + 每小时兜底扫描）+ 提醒通道（§8.2 插件自建：Electron 原生
 * 系统通知 + 自管精确计时器，不经宿主定时任务、零授权），open 创建独立
 * 工作台窗口（自绘标题栏），unregister 停扫描与计时、关窗清理。
 * 关闭窗口不卸载插件。
 */
import { app, BrowserWindow, Notification, ipcMain } from "electron";
import * as path from "node:path";
import type { CyrenePlugin, PluginContext } from "../../../src/plugins/api";
import { buildPromptProvider } from "./prompts";
import { notifySettleEvents, ReminderTimers } from "./reminders";
import { SCAN_INTERVAL_MS, scanAndSettle, type SettleDeps } from "./settle";
import { TaskStore } from "./store";
import { buildTools } from "./tools";

let ctx: PluginContext | null = null;
let win: BrowserWindow | null = null;
let scanTimer: ReturnType<typeof setInterval> | null = null;
let timers: ReminderTimers | null = null;

// 自绘标题栏的窗口控制通道；与先例一致直接挂 ipcMain，前缀足够唯一
const CH_MIN = "plugin:quadrant-todo:win-minimize";
const CH_MAX = "plugin:quadrant-todo:win-maximize";
const CH_CLOSE = "plugin:quadrant-todo:win-close";

/**
 * Windows 原生通知要求进程身份（AUMID）可被系统解析。宿主是免安装目录运行
 * （无开始菜单快捷方式背书，系统亦未注册任何 Cyrene AUMID），任意自定义
 * AUMID 的弹窗会被系统静默丢弃（2026-11-04 实测）。通行解法：用 exe 完整
 * 路径作为 AUMID，Windows 可直接解析到进程本身。register 只调一次。
 */
function ensureAppUserModelId(): void {
  try {
    if (process.platform === "win32") app.setAppUserModelId(process.execPath);
  } catch {
    // 设置失败忽略——通知失败时发送路再兜
  }
}

function createWorkbenchWindow(): void {
  win = new BrowserWindow({
    width: 960,
    height: 640,
    minWidth: 520,
    minHeight: 420,
    frame: false, // 无系统边框，标题栏由页面自绘
    resizable: true,
    autoHideMenuBar: true,
    backgroundColor: "#fff9fc",
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  const onMin = () => {
    if (win && !win.isDestroyed()) win.minimize();
  };
  const onMax = () => {
    if (!win || win.isDestroyed()) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  };
  const onClose = () => {
    if (win && !win.isDestroyed()) win.close();
  };
  ipcMain.on(CH_MIN, onMin);
  ipcMain.on(CH_MAX, onMax);
  ipcMain.on(CH_CLOSE, onClose);

  win.on("closed", () => {
    ipcMain.removeListener(CH_MIN, onMin);
    ipcMain.removeListener(CH_MAX, onMax);
    ipcMain.removeListener(CH_CLOSE, onClose);
    win = null;
  });

  void win.loadFile(path.join(__dirname, "workbench", "workbench.html"));
}

/** 打开（或聚焦）工作台窗口；宿主 open() 钩子与通知点击共用 */
function openWorkbench(): void {
  if (win && !win.isDestroyed()) {
    win.focus();
    return;
  }
  createWorkbenchWindow();
}

function ensureAppUserModelId(): void {
  try {
    // register 只调一次；重复设置同值无害，无需读回（宿主 Electron 类型未暴露 getter）
    app.setAppUserModelId(AUMID);
  } catch {
    // 个别环境设置 AUMID 可能失败：忽略——通知仍可能可用，失败时发送路再兜
  }
}

/** 系统通知发送（Electron 胶水）：环境不支持时记日志跳过，点击通知打开工作台 */
function makeNotifier(log: (...args: unknown[]) => void): (notice: { title: string; body: string }) => void {
  return (notice) => {
    try {
      if (!Notification.isSupported()) {
        log("四象限待办：当前环境不支持系统通知，提醒跳过");
        return;
      }
      const n = new Notification({ title: notice.title, body: notice.body });
      n.on("click", () => openWorkbench());
      n.show();
    } catch (err) {
      log(`四象限待办：系统通知发送失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };
}

const plugin: CyrenePlugin = {
  register(context: PluginContext): void {
    ctx = context;
    ensureAppUserModelId();
    const log = (...args: unknown[]) => ctx?.log(...args);
    const store = new TaskStore(ctx.storage);
    const notify = makeNotifier(log);

    // 结算事件唯一出口：remind-* → 系统通知（§8.2）
    const settleDeps: SettleDeps = {
      store,
      log,
      onSettleEvents: (task, events) => notifySettleEvents({ notify, log }, task, events),
    };
    for (const tool of buildTools({
      store,
      onSettleEvents: settleDeps.onSettleEvents,
      // 提醒计时器随任何数据变更重排（§8.2）
      onStoreChanged: () => timers?.rearm(),
      log,
    })) {
      ctx.registerTool(tool);
    }
    ctx.registerPromptProvider(buildPromptProvider({ store }));

    // 单轮：扫描结算 → 重排计时器；开机补检（register 即先跑一轮）与
    // 兜底扫描（每小时）共用，到点触发的计时器也走它（§8.1/§8.2）
    const runPass = (): void => {
      scanAndSettle(settleDeps);
      timers?.rearm();
    };
    timers = new ReminderTimers({ store, onFire: runPass, log });

    void runPass();
    scanTimer = setInterval(runPass, SCAN_INTERVAL_MS);

    ctx.log("四象限待办已注册：5 个工具 + prompt 注入 + 结算扫描 + 自建提醒通道已装配");
  },

  async open(): Promise<void> {
    openWorkbench();
  },

  unregister(): void {
    if (scanTimer) {
      clearInterval(scanTimer);
      scanTimer = null;
    }
    timers?.dispose();
    timers = null;
    if (win && !win.isDestroyed()) win.close();
    win = null;
    ctx?.log("四象限待办已卸载");
  },
};

export default plugin;
