// 工作台左侧文件树 + 中栏编辑器的文件读写服务。
// 全部操作限定在会话绑定的工作区内：路径穿越（..、绝对路径、\0）一律拒绝。

import * as fs from "node:fs";
import * as path from "node:path";
import type { ChatSession } from "../../shared/chat-types";
import type {
  WorkbenchFileContent,
  WorkbenchFileEntry,
} from "../../shared/code-workbench-types";

/** 单文件读取上限：超过则截断（编辑器打开超大文件无意义，diff 才是看大改动的入口） */
const MAX_FILE_BYTES = 1_000_000;
/** 目录列表里永远隐藏的条目 */
const HIDDEN_ROOTS = new Set([".git"]);

export interface WorkspaceFileServiceDeps {
  getSession: (sessionId: string) => ChatSession | null;
}

export interface WorkspaceFileService {
  /** 列一层目录；relPath 传 "" 表示工作区根。目录在前、名称排序。 */
  listDir(sessionId: string, relPath: string): Promise<WorkbenchFileEntry[]>;
  readFile(sessionId: string, relPath: string): Promise<WorkbenchFileContent>;
  /** 编辑器保存。父目录不存在时自动创建（支持"新建文件"）。 */
  writeFile(sessionId: string, relPath: string, content: string): Promise<void>;
}

export function createWorkspaceFileService(deps: WorkspaceFileServiceDeps): WorkspaceFileService {
  async function resolveInsideWorkspace(sessionId: string, relPath: string): Promise<string> {
    const session = deps.getSession(sessionId);
    if (!session) throw new Error("找不到当前对话");
    if (session.mode !== "code") throw new Error("工作台只在 Code 模式可用");
    const workspaceRoot = session.workspaceBinding?.workspaceRoot;
    if (!workspaceRoot) throw new Error("尚未绑定代码目录");
    if (relPath.includes("\0")) throw new Error("路径不合法");
    const normalized = normalizeRelPath(relPath);
    const absolute = path.resolve(workspaceRoot, normalized);
    if (absolute !== path.resolve(workspaceRoot) && !absolute.startsWith(path.resolve(workspaceRoot) + path.sep)) {
      throw new Error("路径越出了工作区");
    }
    return absolute;
  }

  return {
    async listDir(sessionId, relPath) {
      const absolute = await resolveInsideWorkspace(sessionId, relPath);
      const dirents = await fs.promises.readdir(absolute, { withFileTypes: true });
      const prefix = normalizeRelPath(relPath);
      const entries = dirents
        .filter((dirent) => !(prefix === "" && HIDDEN_ROOTS.has(dirent.name)))
        .map<WorkbenchFileEntry>((dirent) => ({
          name: dirent.name,
          path: prefix ? `${prefix}/${dirent.name}` : dirent.name,
          type: dirent.isDirectory() ? "dir" : "file",
        }))
        .sort((a, b) => {
          if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
          return a.name.localeCompare(b.name, "zh-Hans-CN");
        });
      return entries;
    },

    async readFile(sessionId, relPath) {
      const absolute = await resolveInsideWorkspace(sessionId, relPath);
      const stat = await fs.promises.stat(absolute);
      if (stat.isDirectory()) throw new Error("这是一个目录");
      const handle = await fs.promises.open(absolute, "r");
      try {
        const length = Math.min(stat.size, MAX_FILE_BYTES);
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, 0);
        const binary = isBinaryBuffer(buffer);
        return {
          path: normalizeRelPath(relPath),
          content: binary ? "" : buffer.toString("utf8"),
          binary,
          truncated: stat.size > MAX_FILE_BYTES,
        };
      } finally {
        await handle.close();
      }
    },

    async writeFile(sessionId, relPath, content) {
      if (typeof content !== "string") throw new Error("文件内容必须是文本");
      const absolute = await resolveInsideWorkspace(sessionId, relPath);
      await fs.promises.mkdir(path.dirname(absolute), { recursive: true });
      await fs.promises.writeFile(absolute, content, "utf8");
    },
  };
}

/** 统一成正斜杠相对路径；拒绝绝对路径与 .. 段 */
function normalizeRelPath(relPath: string): string {
  const value = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (path.isAbsolute(relPath)) throw new Error("路径必须是工作区内相对路径");
  if (value.split("/").some((part) => part === "..")) throw new Error("路径越出了工作区");
  return value;
}

/** 简单二进制嗅探：前 8KB 出现 NUL 字节视为二进制 */
function isBinaryBuffer(buffer: Buffer): boolean {
  const scanLength = Math.min(buffer.length, 8192);
  for (let index = 0; index < scanLength; index += 1) {
    if (buffer[index] === 0) return true;
  }
  return false;
}
