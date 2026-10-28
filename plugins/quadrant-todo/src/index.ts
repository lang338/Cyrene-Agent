/**
 * 四象限待办——昔涟帮你处理待办事项
 *
 * 入口装配：register 注册工具面（M1）+ prompt 注入（M2）+ 结算编排
 * （M3：开机补检 + 定时扫描 + 提醒经 scheduler 派发，见 settle.ts），
 * open 创建独立工作台窗口（自绘标题栏先例：%APPDATA%\Cyrene\plugins
 * \system-status），unregister 停扫描、关窗清理。关闭窗口不卸载插件。
 */
import { BrowserWindow, ipcMain } from "electron";
import * as path from "node:path";
import type { CyrenePlugin, PluginContext } from "../../../src/plugins/api";
import { buildPromptProvider } from "./prompts";
import { TaskStore } from "./store";
import {
  cleanupReminders,
  ReminderRegistry,
  SCAN_INTERVAL_MS,
  scanAndSettle,
  deliverReminders,
  type SettleDeps,
} from "./settle";
import { buildTools } from "./tools";

let ctx: PluginContext | null = null;
let win: BrowserWindow | null = null;
let scanTimer: ReturnType<typeof setInterval> | null = null;

// 自绘标题栏的窗口控制通道；与先例一致直接挂 ipcMain，前缀足够唯一
const CH_MIN = "plugin:quadrant-todo:win-minimize";
const CH_MAX = "plugin:quadrant-todo:win-maximize";
const CH_CLOSE = "plugin:quadrant-todo:win-close";

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

const plugin: CyrenePlugin = {
  register(context: PluginContext): void {
    ctx = context;
    // 数据层 + 提醒登记簿；结算事件唯一出口（扫描路与写时结算共用）
    const store = new TaskStore(ctx.storage);
    const settleDeps: SettleDeps = {
      store,
      registry: new ReminderRegistry(ctx.storage),
      scheduler: ctx.deps.scheduler,
      log: (...args: unknown[]) => ctx?.log(...args),
      onSettleEvents: (task, events) => {
        // remind-* → scheduler 一次性提醒任务（§9.2）；异步派发不阻断结算
        void deliverReminders(settleDeps, task, events);
      },
    };
    for (const tool of buildTools({
      store,
      onSettleEvents: settleDeps.onSettleEvents,
      log: (...args: unknown[]) => ctx?.log(...args),
    })) {
      ctx.registerTool(tool);
    }
    ctx.registerPromptProvider(buildPromptProvider({ store }));

    // 定时扫描（§9.2，每小时）+ 开机补检（§9.3：register 即先跑一轮，
    // 离线期间跨过滑动/默认完成/提醒时刻的任务在这里按正常流程补结算补提醒）
    const runPass = async (): Promise<void> => {
      await cleanupReminders(settleDeps);
      scanAndSettle(settleDeps);
    };
    void runPass();
    scanTimer = setInterval(() => void runPass(), SCAN_INTERVAL_MS);

    ctx.log("四象限待办已注册：5 个工具 + prompt 注入 + 结算扫描/提醒派发已装配");
  },

  async open(): Promise<void> {
    if (win && !win.isDestroyed()) {
      win.focus();
      return;
    }
    createWorkbenchWindow();
  },

  unregister(): void {
    if (scanTimer) {
      clearInterval(scanTimer);
      scanTimer = null;
    }
    if (win && !win.isDestroyed()) win.close();
    win = null;
    ctx?.log("四象限待办已卸载");
  },
};

export default plugin;
