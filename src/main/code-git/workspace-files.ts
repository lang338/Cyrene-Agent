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
  /**
   * 工作区外的文件：按绝对路径读写。
   * 用户可以在路径栏里明确输入全盘路径查看/修改任意文件，所以这里不做工作区限定；
   * 但只认绝对路径（相对路径有歧义），且写入要求目标已存在——不允许凭空在工作区外造文件。
   */
  readOutsideFile(absolutePath: string): Promise<WorkbenchFileContent>;
  writeOutsideFile(absolutePath: string, content: string): Promise<void>;
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
    const root = path.resolve(workspaceRoot);
    if (absolute !== root && !absolute.startsWith(root + path.sep)) {
      throw new Error("路径越出了工作区");
    }
    // 词法校验挡不住符号链接：工作区里放一个指向外部的软链，相对路径就能穿过它
    // 落到工作区外（读、写、建目录都一样）。再按真实路径校验一次。
    return await canonicalizeInsideWorkspace(absolute, root);
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
      return readFileAt(absolute, normalizeRelPath(relPath), stat);
    },

    async writeFile(sessionId, relPath, content) {
      if (typeof content !== "string") throw new Error("文件内容必须是文本");
      const absolute = await resolveInsideWorkspace(sessionId, relPath);
      await fs.promises.mkdir(path.dirname(absolute), { recursive: true });
      await fs.promises.writeFile(absolute, content, "utf8");
    },

    async readOutsideFile(absolutePath) {
      const absolute = resolveAbsolutePath(absolutePath);
      const stat = await statForUser(absolute);
      if (stat.isDirectory()) throw new Error("这是一个目录");
      // 回给渲染端的 path 是解析后的绝对路径（正斜杠）：渲染端拿它当标签键，
      // 这样 C:\a\..\b 与 C:/b 会收敛成同一个键，不会开出两个标签
      return readFileAt(absolute, toKeyPath(absolute), stat);
    },

    async writeOutsideFile(absolutePath, content) {
      if (typeof content !== "string") throw new Error("文件内容必须是文本");
      const absolute = resolveAbsolutePath(absolutePath);
      const stat = await statForUser(absolute);
      if (stat.isDirectory()) throw new Error("这是一个目录");
      // 不建父目录：工作区外的新建走"编辑器另存"这条路没意义，只允许改已存在的文件
      await fs.promises.writeFile(absolute, content, "utf8");
    },
  };
}

/** 读盘：大小上限截断 + 二进制嗅探；工作区内外的文件共用这一段逻辑 */
async function readFileAt(absolute: string, reportPath: string, stat: fs.Stats): Promise<WorkbenchFileContent> {
  const handle = await fs.promises.open(absolute, "r");
  try {
    const length = Math.min(stat.size, MAX_FILE_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, 0);
    const binary = isBinaryBuffer(buffer);
    return {
      path: reportPath,
      content: binary ? "" : buffer.toString("utf8"),
      binary,
      truncated: stat.size > MAX_FILE_BYTES,
    };
  } finally {
    await handle.close();
  }
}

/** 工作区外的路径：只接受绝对路径，其余一律拒绝（相对路径在这里没有参照物） */
function resolveAbsolutePath(value: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("缺少文件路径");
  if (value.includes("\0")) throw new Error("路径不合法");
  if (!path.isAbsolute(value)) throw new Error("工作区外只能按绝对路径打开");
  return path.resolve(value);
}

/** 内部键形态：正斜杠。渲染端各处以正斜杠相对路径为键，工作区外沿用同一形态便于比较 */
function toKeyPath(absolute: string): string {
  return absolute.replace(/\\/g, "/");
}

/** stat 的用户可读失败：ENOENT / 权限错误转成中文提示，其余原样抛出 */
async function statForUser(target: string): Promise<fs.Stats> {
  try {
    return await fs.promises.stat(target);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new Error("文件不存在");
    if (code === "EACCES" || code === "EPERM") throw new Error("没有权限访问这个文件");
    if (code === "EISDIR") throw new Error("这是一个目录");
    throw err;
  }
}

/**
 * 把目标路径解析成真实路径，并确认解析后仍在工作区内。
 * 只对"已存在的最深祖先"做 realpath（新建文件的父目录可能还不存在），
 * 再把剩余路径段原样接回去：既能穿透符号链接，又不要求目标已存在。
 */
async function canonicalizeInsideWorkspace(target: string, root: string): Promise<string> {
  const realRoot = await fs.promises.realpath(root);
  let current = target;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = await fs.promises.realpath(current);
      const canonical = tail.length > 0 ? path.join(real, ...tail) : real;
      if (canonical !== realRoot && !canonical.startsWith(realRoot + path.sep)) {
        throw new Error("路径越出了工作区");
      }
      return canonical;
    } catch (err) {
      // 只有"不存在"才继续往上找祖先；权限等其他错误原样抛出，不要静默放行
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      const parent = path.dirname(current);
      if (parent === current) throw new Error("路径越出了工作区");
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
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
