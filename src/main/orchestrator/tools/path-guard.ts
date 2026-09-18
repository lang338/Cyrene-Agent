// 文件写入的工作区边界校验。
//
// 为什么需要它：AI 的文件写入工具是主进程**直接调用 Node 的 fs**，没有子进程——
// 而 Sandbox Runtime 只约束子进程，对它们完全无效。于是"完全访问"档位下既不弹审批、
// 也没有任何路径检查，等于可以往磁盘上任意绝对路径写入（包括别的项目、启动目录）。
// 这里补上代码级的边界：realpath 归一后必须落在会话绑定的工作区内。
//
// 注意：只拦 AI 的工具链。用户在工作台里手动编辑工作区外的文件走的是另一条通道
// （workbench:file-write-absolute），那条不受这里影响。

import fs from "node:fs";
import path from "node:path";

export class WorkspaceBoundaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceBoundaryError";
  }
}

/**
 * 解析真实路径。目标文件可能还不存在（新建），这时对"最近的已存在祖先"取 realpath，
 * 再把剩余段拼回去——这样"工作区内指向外部的符号链接"也能被识别出来。
 */
export function resolveRealPath(target: string): string {
  const absolute = path.resolve(target);
  let current = absolute;
  const trailing: string[] = [];
  for (let depth = 0; depth < 64; depth += 1) {
    try {
      const real = fs.realpathSync(current);
      return trailing.length === 0 ? real : path.join(real, ...trailing.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return absolute; // 一路到根都解析不出来，原样返回交给上层
      trailing.push(path.basename(current));
      current = parent;
    }
  }
  return absolute;
}

/** target 是否落在 root 之内（两侧都已归一化） */
export function isInsideWorkspace(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/**
 * 写入前的边界断言：不在工作区内就抛错。
 * 未绑定工作区时一律拒绝——宁可拒绝，也不要留下"无界写入"的口子。
 * @returns 归一后的真实路径，调用方可以直接用它落盘
 */
export function assertWritableInsideWorkspace(target: string, workspaceRoot: string | undefined): string {
  if (!workspaceRoot || !workspaceRoot.trim()) {
    throw new WorkspaceBoundaryError(
      `当前会话没有绑定工作区，拒绝写入：${target}。请先在工作台里选择工作区目录。`,
    );
  }
  const root = resolveRealPath(workspaceRoot);
  const resolved = resolveRealPath(target);
  if (!isInsideWorkspace(root, resolved)) {
    throw new WorkspaceBoundaryError(
      `拒绝写入工作区之外的文件：${target}（工作区：${root}）。` +
        `如需改动工作区外的文件，请在工作台里手动编辑，或把该目录设为工作区。`,
    );
  }
  return resolved;
}
