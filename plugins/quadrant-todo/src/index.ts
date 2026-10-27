/**
 * 四象限待办——昔涟帮你处理待办事项
 *
 * 里程碑 M0：工程骨架。
 * register 装配工具/结算器/prompt（后续里程碑逐步填入），open 创建
 * 独立工作台窗口（自绘标题栏先例：%APPDATA%\Cyrene\plugins\system-status），
 * unregister 关窗清理。关闭窗口不卸载插件。
 */
import { BrowserWindow, ipcMain } from "electron";
import * as path from "node:path";
import type { CyrenePlugin, PluginContext } from "../../../src/plugins/api";

let ctx: PluginContext | null = null;
let win: BrowserWindow | null = null;

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
    // M0：仅验证加载链路；工具面 / 结算器 / prompt 注入在 M1-M3 装配
    ctx.log("四象限待办已注册（M0 骨架）");
  },

  async open(): Promise<void> {
    if (win && !win.isDestroyed()) {
      win.focus();
      return;
    }
    createWorkbenchWindow();
  },

  unregister(): void {
    if (win && !win.isDestroyed()) win.close();
    win = null;
    ctx?.log("四象限待办已卸载");
  },
};

export default plugin;
