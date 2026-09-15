// 工作台"当前打开的文件" → 本轮模型上下文。
//
// 为什么需要它：昔涟本身有 read_file，但不知道用户此刻在看哪个文件；
// 中栏的 activePath/buffers 是纯渲染端状态，没有任何通往 AI 的通路。
//
// 为什么不能只给路径：
// 工作台允许编辑且不保存，而 read_file 读的是磁盘 —— 对未保存的文件，
// 模型自己去读会读到旧内容。因此 dirty 时必须把缓冲区内容一并带上。
//
// 注入通道：AguiRunInput.attachments（{name,text}[]）→ 主进程渲染成
// "【本轮附件内容】" 进每轮尾部上下文，不落历史、不破坏提示词缓存。

/** 注入上限：超过则截断，避免大文件挤爆上下文（粗估 3.2 万字符约 8k token） */
export const MAX_ACTIVE_FILE_CHARS = 32_000;

export interface ActiveFileSelection {
  startLine: number;
  endLine: number;
  text: string;
}

export interface ActiveFileContextInput {
  /** 工作区相对路径（中栏 activePath 的形态，已是相对路径） */
  relativePath: string;
  /** 编辑器缓冲区内容（可能与磁盘不一致） */
  content: string;
  /** 是否有未保存改动 */
  dirty: boolean;
  /** 二进制或被截断的大文件：内容不可信，只给路径 */
  readOnly?: boolean;
  /** 文件尚未加载完成或读取失败：内容未知，只给路径，不能声称"已保存" */
  pending?: boolean;
  selection?: ActiveFileSelection | null;
}

export interface ActiveFileContextAttachment {
  name: string;
  text: string;
}

/**
 * 生成本轮注入的当前文件上下文；没有打开文件时返回 null。
 * 已保存且无选区时只给路径（几乎零成本），让模型按需自行读取。
 */
export function buildActiveFileContext(
  input: ActiveFileContextInput,
): ActiveFileContextAttachment | null {
  const relativePath = input.relativePath.trim();
  if (!relativePath) return null;

  const selectionText = input.selection?.text.trim() ?? "";
  const hasSelection = selectionText.length > 0;
  const injectContent = input.dirty && !input.readOnly && !input.pending;

  const lines = ["[工作台当前打开的文件]", `路径（相对工作区根）：${relativePath}`];
  if (input.pending) {
    lines.push("状态：文件尚未加载完成或读取失败，内容未知，需要时请自行用工具读取该文件");
  } else if (input.readOnly) {
    lines.push("状态：二进制或过大文件，内容未注入，需要时请自行用工具读取该文件");
  } else if (input.dirty) {
    lines.push("状态：有未保存的修改。下面的内容来自编辑器，与磁盘不一致，请以此为准");
  } else if (hasSelection) {
    lines.push("状态：已保存（磁盘与编辑器一致）");
  } else {
    lines.push("状态：已保存（磁盘与编辑器一致），需要时请自行用工具读取该文件");
  }

  if (hasSelection && input.selection) {
    lines.push(`用户在编辑器中选中的片段（第 ${input.selection.startLine}-${input.selection.endLine} 行）：`);
    lines.push(selectionText);
  }
  if (injectContent) {
    if (hasSelection) lines.push("文件完整内容：");
    lines.push(input.content);
  }

  let text = lines.join("\n");
  if (text.length > MAX_ACTIVE_FILE_CHARS) {
    text = `${text.slice(0, MAX_ACTIVE_FILE_CHARS)}\n…（内容已截断，剩余部分请自行用工具读取该文件）`;
  }
  return { name: relativePath, text };
}
