// 消息正文里的文件路径 → 可点开。
//
// 两道识别通道共用同一个判定函数，保证"看起来像链接"和"点得开"永远一致：
//   - 行内代码（`src/a.ts`）：边界明确，允许路径里带空格
//   - 正文裸文本（我改了 src/a.ts:42）：靠分隔符切分，必须不含空格，否则切不出边界
//
// 正文那条由一个 rehype 插件在**解析之后**改写文本节点：代码块天然被排除，
// 且不去碰 streamdown 自己的元素渲染器（列表缩进、表格节奏、data-streamdown 属性都靠它）。
// 插件只把路径包成 file:/// 链接，怎么显示、能不能点仍由 StreamdownMessageContent 的
// anchor 渲染器按"是否在工作区内"决定，与模型主动写的 file:/// 链接走同一条路。

import type { Plugin } from "unified";

export interface MessageFileOpenTarget {
  /** 原样的路径文本（工作区相对路径或全盘绝对路径都可能是） */
  path: string;
  /** 路径后带的行号（`src/a.ts:42` 里的 42） */
  line?: number;
}

/** 一段文本里认出的路径：start/end 是**落在原文里的下标**，供改写时精确定位。 */
export interface MessageFilePathMatch {
  start: number;
  end: number;
  target: MessageFileOpenTarget;
}

/**
 * 认得的文件扩展名。
 * 用白名单而不是"有点就算路径"：正文里 `user.name`、`v1.2.3`、`模块.功能` 这类点号太常见，
 * 宁可漏几个冷门后缀（用户还能用路径栏打开），也不要把普通词标成链接。
 */
const FILE_EXTENSIONS = new Set([
  // 前端 / 脚本
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "vue", "svelte", "html", "htm", "css", "scss", "less",
  // 配置 / 数据
  "json", "jsonc", "yaml", "yml", "toml", "ini", "cfg", "conf", "env", "lock", "xml", "csv",
  // 文档
  "md", "mdx", "txt", "rst",
  // 后端 / 系统
  "py", "rb", "go", "rs", "java", "kt", "kts", "swift", "c", "h", "cc", "cpp", "hpp", "cs", "php",
  "lua", "dart", "scala", "pl", "r", "jl",
  // 脚本 / 数据库 / 协议
  "sh", "bash", "zsh", "fish", "ps1", "bat", "cmd", "sql", "graphql", "gql", "proto",
  // 图形 / 其它
  "svg", "mmd",
]);

/** 切分裸文本用：连续的非空白、非中文标点串（中文标点也当边界，模型中英混排时很常见） */
const TOKEN_RE = /[^\s，。；：、！？（）【】《》“”‘’…]+/g;

/** 头部/尾部常被连同路径一起写进来的包裹字符（括号、引号、句末标点） */
const LEADING_WRAPPERS = /^[([{"'`《【]+/;
const TRAILING_WRAPPERS = /[)\]}",;.!?'`》】]+$/;

/**
 * 文本 → 文件路径（含可选行号）。不像文件路径就返回 null。
 *
 * 行号写法两种都收：`src/a.ts:42` 与 `src/a.ts:42:10`（后者取行号、忽略列号）。
 */
export function parseMessageFilePath(raw: string, options: { allowSpaces?: boolean } = {}): MessageFileOpenTarget | null {
  const stripped = raw.trim().replace(LEADING_WRAPPERS, "").replace(TRAILING_WRAPPERS, "");
  if (!stripped) return null;
  if (!options.allowSpaces && /\s/.test(stripped)) return null;

  // 行号在最后：`路径:行[:列]`。不贪婪的 `.*?` 让 Windows 盘符里的冒号不受影响
  let body = stripped;
  let line: number | undefined;
  const withLine = /^(.*?):(\d+)(?::\d+)?$/.exec(stripped);
  if (withLine) {
    body = withLine[1];
    line = Number(withLine[2]);
  }

  if (!body) return null;
  if (body.includes("\0")) return null;
  // URL 不归这条通道管（消息里的链接由 markdown 自己的锚点渲染）
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(body)) return null;
  // 纯数字/纯符号不成路径；至少要有一个字母
  if (!/[a-z]/i.test(body)) return null;

  const base = body.replace(/\\/g, "/").split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return null; // 无扩展名，或以点开头（.env 之类太容易误判，宁可不认）
  const extension = base.slice(dot + 1).toLowerCase();
  if (!FILE_EXTENSIONS.has(extension)) return null;
  if (line !== undefined && line < 1) return null;

  return line === undefined ? { path: body } : { path: body, line };
}

/**
 * 一行文本里认得的全部路径。只认"整段 token 就是一个路径"，不做子串替换，
 * 避免把句子里的片段切碎；下标已剥掉首尾包裹字符，改写时不会吃掉括号和句末标点。
 */
export function findMessageFilePaths(text: string): MessageFilePathMatch[] {
  const matches: MessageFilePathMatch[] = [];
  TOKEN_RE.lastIndex = 0;
  for (const match of text.matchAll(TOKEN_RE)) {
    const token = match[0];
    const target = parseMessageFilePath(token);
    if (!target) continue;
    const afterLeading = token.replace(LEADING_WRAPPERS, "");
    const leading = token.length - afterLeading.length;
    const inner = afterLeading.replace(TRAILING_WRAPPERS, "");
    const start = (match.index ?? 0) + leading;
    matches.push({ start, end: start + inner.length, target });
  }
  return matches;
}

/** hast 节点的最小形状：只用到遍历与改写真正需要的字段。 */
interface HastNode {
  type?: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

/** 这些子树里的文本一律不改写：代码、既有链接、脚本样式。 */
const SKIPPED_SUBTREES = new Set(["pre", "a", "script", "style"]);

/**
 * 相对路径 → 绝对路径（正斜杠）。已经是绝对路径就原样返回；
 * 相对路径但不知道工作区根时返回 null（无法定位，保持纯文本）。
 */
export function toAbsoluteFilePath(filePath: string, workspaceRoot?: string): string | null {
  const normalized = filePath.replace(/\\/g, "/");
  if (/^[A-Za-z]:\//.test(normalized) || normalized.startsWith("/")) return normalized;
  if (!workspaceRoot) return null;
  const root = workspaceRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!root) return null;
  return `${root}/${normalized.replace(/^\.\//, "")}`;
}

/** 绝对路径 → 与 StreamdownAnchor 约定一致的 file 链接（Windows 盘符不加前导斜杠）。 */
function fileHref(absPath: string, line?: number): string {
  const body = absPath.startsWith("/") ? `file://${absPath}` : `file:///${absPath}`;
  return line === undefined ? body : `${body}#L${line}`;
}

/** 把一个路径文本包成锚点；无法定位为绝对路径时返回 null（调用方保持纯文本）。 */
function makeFileAnchor(text: string, target: MessageFileOpenTarget, workspaceRoot?: string): HastNode | null {
  const absPath = toAbsoluteFilePath(target.path, workspaceRoot);
  if (!absPath) return null;
  return {
    type: "element",
    tagName: "a",
    properties: { href: fileHref(absPath, target.line) },
    children: [{ type: "text", value: text }],
  };
}

/** 文本节点 → 文本/锚点混合节点；没有可改写的返回 null，调用方保留原节点。 */
function rewriteTextNode(value: string, workspaceRoot: string): HastNode[] | null {
  // 路径至少要有个扩展名分隔点，先做一次廉价判断
  if (!value.includes(".")) return null;
  const matches = findMessageFilePaths(value);
  if (matches.length === 0) return null;
  const nodes: HastNode[] = [];
  let cursor = 0;
  for (const match of matches) {
    const anchor = makeFileAnchor(value.slice(match.start, match.end), match.target, workspaceRoot);
    if (!anchor) continue;
    if (match.start > cursor) nodes.push({ type: "text", value: value.slice(cursor, match.start) });
    nodes.push(anchor);
    cursor = match.end;
  }
  if (nodes.length === 0) return null;
  if (cursor < value.length) nodes.push({ type: "text", value: value.slice(cursor) });
  return nodes;
}

/** 行内代码：整段内容就是一个路径时才包成锚点（边界明确，放行空格）。 */
function rewriteInlineCode(node: HastNode, workspaceRoot: string): void {
  const children = node.children;
  if (!children || children.length !== 1) return;
  const only = children[0];
  if (only.type !== "text" || typeof only.value !== "string") return;
  const target = parseMessageFilePath(only.value, { allowSpaces: true });
  if (!target) return;
  const anchor = makeFileAnchor(only.value, target, workspaceRoot);
  if (anchor) node.children = [anchor];
}

function rewriteSubtree(node: HastNode, workspaceRoot: string): void {
  const tagName = node.tagName ?? "";
  if (SKIPPED_SUBTREES.has(tagName)) return;
  if (tagName === "code") {
    rewriteInlineCode(node, workspaceRoot);
    return;
  }
  const children = node.children;
  if (children) {
    let changed = false;
    const next: HastNode[] = [];
    for (const child of children) {
      if (child.type === "text" && typeof child.value === "string") {
        const rewritten = rewriteTextNode(child.value, workspaceRoot);
        if (rewritten) {
          next.push(...rewritten);
          changed = true;
          continue;
        }
      }
      next.push(child);
    }
    if (changed) node.children = next;
  }
  for (const child of node.children ?? []) rewriteSubtree(child, workspaceRoot);
}

/**
 * 就地改写一棵 hast 树：正文里裸写的路径包成 file 链接。
 * 没有工作区根时不做任何事——定位不了目标文件，保持纯文本比给个点不动的链接好。
 */
export function rewriteBareFilePaths(tree: unknown, workspaceRoot?: string): void {
  if (!workspaceRoot) return;
  rewriteSubtree(tree as HastNode, workspaceRoot);
}

/** 供 streamdown 使用的插件形态：在 raw 解析之后、sanitize 之前运行。 */
export function linkifyBareFilePaths(options: { workspaceRoot?: string } = {}): Plugin {
  const workspaceRoot = options.workspaceRoot;
  return () => (tree: unknown) => {
    rewriteBareFilePaths(tree, workspaceRoot);
  };
}
