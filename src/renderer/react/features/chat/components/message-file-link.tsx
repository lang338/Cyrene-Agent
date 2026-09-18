// 消息正文里的文件路径 → 可点击打开。
//
// 为什么用 context 注入能力：markdown 渲染器拿不到外层组件的 props（同 MessageStreamingContext 的处理方式），
// 而"点开文件"只有工作台做得到——那里有中栏代码区。主聊天页不提供这个上下文，
// 路径就还是普通文本，同一份 ChatMessageList 在两处表现不同，但主链路一行都不用改。
//
// 两条识别通道共用同一个判定函数，保证"点击行为"和"看起来像链接"永远一致：
//   - 行内代码（`src/a.ts`）：边界明确，允许路径里带空格
//   - 正文裸文本（我改了 src/a.ts:42）：靠分隔符切分，必须不含空格，否则切不出边界

import { Fragment, createContext, createElement, useContext, type ReactNode } from "react";

export interface MessageFileOpenTarget {
  /** 原样的路径文本（工作区相对路径或全盘绝对路径都可能是） */
  path: string;
  /** 路径后带的行号（`src/a.ts:42` 里的 42） */
  line?: number;
}

export type MessageFileOpenHandler = (target: MessageFileOpenTarget) => void;

/** null 表示当前场景没人能打开文件（主聊天页），路径保持纯文本 */
export const MessageFileLinkContext = createContext<MessageFileOpenHandler | null>(null);

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
 * 一行文本 → 节点数组：认得的路径替换成可点击元素，其余原样保留。
 * 只在"整段 token 就是路径"时替换，不做子串替换，避免把句子里的片段切碎。
 */
export function linkifyFilePaths(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  TOKEN_RE.lastIndex = 0;
  for (const match of text.matchAll(TOKEN_RE)) {
    const token = match[0];
    const target = parseMessageFilePath(token);
    if (!target) continue;
    const start = match.index ?? 0;
    if (start > lastIndex) nodes.push(text.slice(lastIndex, start));
    nodes.push(createElement(FilePathLink, { key: `${start}-${token}`, target, label: token }));
    lastIndex = start + token.length;
  }
  if (nodes.length === 0) return [text];
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

/**
 * 递归处理子节点：字符串切分，数组逐个处理，其它 React 元素原样透传。
 * 不透传进元素内部是有意的——那会把代码块、加粗里的内容也改写，成本高且容易出错。
 */
export function linkifyNode(node: ReactNode): ReactNode {
  if (typeof node === "string") return linkifyFilePaths(node);
  // 用 Fragment 而不是 span 包裹：列表项里可能是块级内容（松散列表的 li 内含 p），
  // 套一层 span 会造出非法嵌套，浏览器纠正 DOM 时会打乱原有结构
  if (Array.isArray(node)) return node.map((child, index) => createElement(Fragment, { key: index }, linkifyNode(child)));
  return node;
}

/** 可点击的文件路径。没有上下文提供方时退化成普通文本（主聊天页走这条路） */
export function FilePathLink({ target, label }: { target: MessageFileOpenTarget; label: string }) {
  const onOpen = useContext(MessageFileLinkContext);
  if (!onOpen) return label;
  return createElement(
    "button",
    {
      type: "button",
      className: "cy-file-link",
      // 显示原文（含行号）而不是解析后的 path，避免"点之前和点之后长得不一样"
      title: label,
      onClick: () => onOpen(target),
    },
    label,
  );
}
