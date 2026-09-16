// 工作台"跟随昔涟"：从消息里的工具变更证据（ToolFileChange）挑出昔涟刚改动的文件，
// 供左栏文件树刷新与中栏编辑器自动跳转使用。
//
// 为什么从消息里取，而不是另开一路事件：工作台复用 ChatPage 的 run 控制器
// （单一事实来源），工具变更证据已经随 TOOL_CALL_RESULT 写进消息记录；
// 再订阅一份等于同一事实存两处，迟早对不上。
//
// 路径为什么要解析：changes[].file 是工具收到的原始参数——可能是绝对路径，
// 也可能是相对路径，还可能指向工作区外（fs 工具不做沙箱）。只有能解析回
// 工作区内的文件才跟随，否则会跳到一个文件树里根本不存在的路径。

import type { ToolFileChange } from "../../../../shared/chat-types";
import type { ChatMessageItem } from "../chat/components/ChatMessageList";

export interface AiFileChange {
  /** 去重键：消息 id + 工具调用 id；一次工具调用改多个文件时共用同一个键 */
  key: string;
  /** 工作区相对路径（正斜杠，与文件树/编辑器的 activePath 同形态） */
  path: string;
  kind: ToolFileChange["kind"];
}

interface AiFileChangeScan {
  /** 本次新出现、且落在工作区内的改动，按消息与工具出现顺序 */
  fresh: AiFileChange[];
  /** 已登记过的工具调用键；下次扫描原样传回 */
  seen: Set<string>;
}

/** 扫描基线按会话维护：换会话要重新建立，否则新会话的历史会被当成"刚发生" */
export interface AiFileChangeBaseline {
  sessionId: string;
  keys: Set<string>;
}

/**
 * 按会话推进跟随基线，返回本次真正要跟随的改动。
 *
 * - 换会话：重新建立基线（新会话的历史改动不重放）；
 * - 消息为空：不建立也不产出——历史是异步到位的，拿空列表当基线会把随后到达的历史
 *   误判成新改动，进工作台就被连续抢焦点；
 * - 首次扫描：只登记已有事实、不产出。
 */
export function advanceAiFileChangeBaseline(
  baseline: AiFileChangeBaseline | null,
  sessionId: string,
  messages: readonly Pick<ChatMessageItem, "id" | "toolExecutions">[],
  workspaceRoot: string | undefined,
): { baseline: AiFileChangeBaseline | null; fresh: AiFileChange[] } {
  const sameSession = baseline?.sessionId === sessionId;
  if (!sameSession && messages.length === 0) return { baseline, fresh: [] };
  const scan = scanAiFileChanges(messages, sameSession ? baseline.keys : null, workspaceRoot);
  return { baseline: { sessionId, keys: scan.seen }, fresh: scan.fresh };
}

/**
 * 扫描消息里的工具变更证据，挑出工作区内的改动。
 * seen 传 null 表示"首次扫描"：只登记当前已有的事实、不产生 fresh。
 */
function scanAiFileChanges(
  messages: readonly Pick<ChatMessageItem, "id" | "toolExecutions">[],
  seen: Set<string> | null,
  workspaceRoot: string | undefined,
): AiFileChangeScan {
  const initialized = seen !== null;
  const nextSeen = new Set(seen ?? []);
  const fresh: AiFileChange[] = [];

  for (const message of messages) {
    for (const tool of message.toolExecutions ?? []) {
      // running 阶段证据还没写完，只在工具落定后取
      if (tool.status === "running" || !tool.changes?.length) continue;
      const key = `${message.id}:${tool.id}`;
      if (nextSeen.has(key)) continue;
      nextSeen.add(key);
      if (!initialized) continue;
      for (const change of tool.changes) {
        const path = resolveWorkspaceRelative(change.file, workspaceRoot);
        if (path) fresh.push({ key, path, kind: change.kind });
      }
    }
  }

  return { fresh, seen: nextSeen };
}

/**
 * 把工具给的路径解析成工作区相对路径；不是工作区内的文件时返回 null。
 * 相对路径按"工作区相对"理解——提示词要求昔涟用这个口径，解析不出来时
 * 调用方会静默跳过，不会跳出工作区。
 */
export function resolveWorkspaceRelative(file: string, workspaceRoot: string | undefined): string | null {
  const raw = file.trim();
  if (!raw || raw.includes("\0")) return null;
  const normalized = raw.replace(/\\/g, "/");

  if (!isAbsolutePath(normalized)) {
    const stripped = normalized.replace(/^\.\//, "").replace(/^\/+/, "");
    return isSafeRelative(stripped) ? stripped : null;
  }

  if (!workspaceRoot) return null;
  const root = workspaceRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!root) return null;
  // Windows 盘符路径大小写不敏感；POSIX 路径保持敏感，避免误判同名前缀
  const caseInsensitive = /^[a-z]:/i.test(root);
  const comparedRoot = caseInsensitive ? root.toLowerCase() : root;
  const comparedFile = caseInsensitive ? normalized.toLowerCase() : normalized;
  if (comparedFile === comparedRoot) return null; // 工作区根本身不是文件
  if (!comparedFile.startsWith(comparedRoot + "/")) return null;
  const rest = normalized.slice(root.length + 1);
  return isSafeRelative(rest) ? rest : null;
}

/** 目标文件的各级父目录，供文件树逐级展开；根层文件返回空数组 */
export function ancestorDirs(filePath: string): string[] {
  const parts = filePath.replace(/\\/g, "/").split("/").filter(Boolean);
  const dirs: string[] = [];
  for (let index = 0; index < parts.length - 1; index += 1) {
    dirs.push(parts.slice(0, index + 1).join("/"));
  }
  return dirs;
}

function isAbsolutePath(value: string): boolean {
  return /^[a-z]:/i.test(value) || value.startsWith("/");
}

function isSafeRelative(value: string): boolean {
  if (!value || value === ".") return false;
  return !value.split("/").some((part) => part === "..");
}
