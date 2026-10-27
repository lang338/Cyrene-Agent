/**
 * Electron 运行时由宿主主进程提供，不作为依赖安装。
 * 这里只声明插件实际用到的最小面，避免拉取完整的 electron 类型。
 */

declare module "electron" {
  export interface WebPreferences {
    nodeIntegration?: boolean;
    contextIsolation?: boolean;
  }

  export interface BrowserWindowConstructorOptions {
    width?: number;
    height?: number;
    minWidth?: number;
    minHeight?: number;
    frame?: boolean;
    resizable?: boolean;
    autoHideMenuBar?: boolean;
    backgroundColor?: string;
    webPreferences?: WebPreferences;
  }

  export class BrowserWindow {
    constructor(options?: BrowserWindowConstructorOptions);
    isDestroyed(): boolean;
    focus(): void;
    minimize(): void;
    maximize(): void;
    unmaximize(): void;
    isMaximized(): boolean;
    close(): void;
    loadFile(filePath: string): Promise<void>;
    on(event: "closed", listener: () => void): this;
    once(event: "closed", listener: () => void): this;
  }

  export interface IpcMainEvent {
    readonly sender: unknown;
  }

  export interface IpcMain {
    on(channel: string, listener: (event: IpcMainEvent, ...args: unknown[]) => void): void;
    removeListener(channel: string, listener: (event: IpcMainEvent, ...args: unknown[]) => void): void;
  }

  export const ipcMain: IpcMain;
}
