/**
 * 四象限待办——昔涟帮你处理待办事项
 *
 * 入口装配：register 注册工具面 + prompt 注入 + 结算编排（§8.1：写时结算
 * + 开机补检 + 每小时兜底扫描）+ 提醒通道（§8.2 插件自建：Electron 原生
 * 系统通知 + 自管精确计时器，不经宿主定时任务、零授权），open 创建独立
 * 工作台窗口（自绘标题栏），unregister 停扫描与计时、关窗清理。
 * 关闭窗口不卸载插件。
 */
import { app, BrowserWindow, nativeTheme, Notification, ipcMain } from "electron";
import * as path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import type { CyrenePlugin, PluginContext } from "../../../src/plugins/api";
import { createUiBridge } from "./bridge";
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
// 数据变更广播：对话工具登记/后台结算改动数据时，通知打开中的工作台重载快照
// （CodeRabbit 评审——工作台开着时不刷新会看不到新任务/完成态变化）
const CH_STORE_CHANGED = "plugin:quadrant-todo:store-changed";

/**
 * Windows 原生通知要求进程身份（AUMID）可被系统解析。宿主自身从不设置 AUMID
 * （全仓库无 setAppUserModelId 调用），身份背书取决于分发形态：
 * - NSIS 安装版：开始菜单快捷方式以 electron-builder 的 appId
 *   `com.cyrene.live2d` 作为 AUMID 背书（有 Uninstall Cyrene.exe 可探测）；
 * - 免安装 --dir 目录运行：无任何背书，须用 exe 完整路径（Windows 可直接
 *   解析到进程本身）。
 * 探测卸载器区分两种形态，不能用 app.isPackaged（两者都是打包产物）
 * （CodeRabbit 评审）。register 只调一次。
 */
function ensureAppUserModelId(): void {
  try {
    if (process.platform !== "win32") return;
    const installed = existsSync(path.join(path.dirname(process.execPath), "Uninstall Cyrene.exe"));
    app.setAppUserModelId(installed ? "com.cyrene.live2d" : process.execPath);
  } catch {
    // 设置失败忽略——通知失败时发送路再兜
  }
}

export type WorkbenchTheme = "charcoal-pink" | "pearl-white";

/** 读宿主当前 UI 主题：app-settings.json 的 uiTheme（pearl-white/charcoal-pink/system）。
 * "system" 与缺省按 nativeTheme 深浅解析；读不到时同样落 nativeTheme。
 * 只在打开工作台时读取——宿主内切换主题后重开窗口即同步。 */
function readHostUiTheme(): WorkbenchTheme {
  let choice: string | undefined;
  try {
    const raw = JSON.parse(readFileSync(path.join(app.getPath("userData"), "app-settings.json"), "utf8")) as Record<string, unknown>;
    choice = typeof raw.uiTheme === "string" ? raw.uiTheme : undefined;
  } catch {
    // 缺文件/解析失败按系统深浅走
  }
  if (choice === "charcoal-pink") return "charcoal-pink";
  if (choice === "pearl-white") return "pearl-white";
  return nativeTheme.shouldUseDarkColors ? "charcoal-pink" : "pearl-white";
}

function createWorkbenchWindow(): void {
  const theme = readHostUiTheme();
  win = new BrowserWindow({
    width: 960,
    height: 640,
    minWidth: 520,
    minHeight: 420,
    frame: false, // 无系统边框，标题栏由页面自绘
    resizable: true,
    autoHideMenuBar: true,
    backgroundColor: theme === "pearl-white" ? "#ECECEE" : "#141414",
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

  void win.loadFile(path.join(__dirname, "workbench", "workbench.html"), {
    query: { theme },
  });
}

/** 打开（或聚焦）工作台窗口；宿主 open() 钩子与通知点击共用 */
function openWorkbench(): void {
  if (win && !win.isDestroyed()) {
    // focus 对最小化窗口无效，先还原（CodeRabbit 评审）
    if (win.isMinimized()) win.restore();
    win.focus();
    return;
  }
  createWorkbenchWindow();
}

/** 未关闭的 Notification 引用：Windows 上对象被过早 GC 会让 click 事件失效（CodeRabbit 评审） */
const liveNotifications = new Set<Notification>();

/** 系统通知发送（Electron 胶水）：环境不支持时记日志跳过，点击通知打开工作台 */
function makeNotifier(log: (...args: unknown[]) => void): (notice: { title: string; body: string }) => void {
  return (notice) => {
    try {
      if (!Notification.isSupported()) {
        log("四象限待办：当前环境不支持系统通知，提醒跳过");
        return;
      }
      const n = new Notification({ title: notice.title, body: notice.body });
      liveNotifications.add(n);
      const drop = () => liveNotifications.delete(n);
      n.on("click", () => {
        drop();
        openWorkbench();
      });
      n.on("close", drop);
      n.on("failed", drop);
      n.show();
    } catch (err) {
      log(`四象限待办：系统通知发送失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };
}

/** 数据变更的统一出口：重排提醒计时器 + 通知打开中的工作台重载快照。
 * 对话工具与 UI 桥（onStoreChanged）两条写路径共用；扫描路（runPass）有变更时也走这里 */
function onStoreChanged(): void {
  timers?.rearm();
  if (win && !win.isDestroyed()) {
    try {
      win.webContents.send(CH_STORE_CHANGED);
    } catch {
      // 推送失败不影响数据面，下次渲染自会取最新
    }
  }
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
      // 数据变更统一出口：计时器重排 + 工作台快照推送（§8.2）
      onStoreChanged,
      log,
    })) {
      ctx.registerTool(tool);
    }
    ctx.registerPromptProvider(buildPromptProvider({ store }));

    // 工作台数据桥（§3.36）：UI 操作与对话操作共享同一条"结算→落库→抛事件"
    // 编排与提醒重排；通道经 ctx.registerIpc（invoke 语义，自动加
    // plugin:quadrant-todo: 前缀，卸载随资源跟踪器统一清理）。
    // handler 抛错由 Electron invoke 回传渲染页，不让异常炸主进程回调。
    const uiBridge = createUiBridge({
      store,
      storage: context.storage,
      onSettleEvents: settleDeps.onSettleEvents,
      onStoreChanged,
      log,
    });
    const uiCall = <T>(fn: () => T): T => {
      try {
        return fn();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log(`四象限待办：工作台操作失败：${message}`);
        throw err;
      }
    };
    // 宿主 registerIpc 的 handler 约定是纯业务参数（event 已在宿主装配层剥除，
    // 见 ipc-router.ts invokeRegistered 的 handler(...args)），不按 ipcMain.handle
    // 的 (event, ...args) 签名写——否则首参错位，全部带参通道静默失败。
    ctx.registerIpc("data-load", () => uiCall(() => uiBridge.load()));
    ctx.registerIpc("task-add", (input) => uiCall(() => uiBridge.addTask(input)));
    ctx.registerIpc("task-update", (id, patch) => uiCall(() => uiBridge.updateTask(id, patch)));
    ctx.registerIpc("task-complete", (id) => uiCall(() => uiBridge.completeTask(id, "done")));
    ctx.registerIpc("task-remove", (id) => uiCall(() => uiBridge.removeTask(id)));
    ctx.registerIpc("settings-save", (input) => uiCall(() => uiBridge.saveSettings(input)));

    // 单轮：扫描结算 → 重排计时器；开机补检（register 即先跑一轮）与
    // 兜底扫描（每小时）共用，到点触发的计时器也走它（§8.1/§8.2）。
    // 结算含同步 IO，出错（磁盘/权限）不能炸主进程回调，且重排必须在
    // finally 里执行——否则一次失败就让提醒窗口失守（CodeRabbit 评审）。
    const runPass = (): void => {
      try {
        // 有变更才走统一出口（推送工作台快照）；无变更的整点扫描只重排计时器
        if (scanAndSettle(settleDeps) > 0) onStoreChanged();
      } catch (err) {
        log(`四象限待办：结算扫描失败：${err instanceof Error ? err.message : String(err)}`);
      } finally {
        timers?.rearm();
      }
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
