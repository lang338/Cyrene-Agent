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
 *
 * ⚠️ 解析不出来时返回 `null`，**绝不退回词法路径**：`link/missing/...`（link 是工作区内
 * 指向外面的符号链接）在词法上看着还在工作区里，一退回词法路径就会被判成"界内"，
 * 而随后落盘时操作系统会顺着 link 写到工作区外面去。宁可拒绝。
 *
 * ⚠️ 这里**不设层数上限**：一旦"到了某层就放弃"，就等于给了"再深一层就绕过"的口子
 * （旧实现是 64 层，超过就退回词法路径）。
 */
export function resolveRealPath(target: string): string | null {
  const absolute = path.resolve(target);
  let current = absolute;
  const trailing: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync(current);
      return trailing.length === 0 ? real : path.join(real, ...trailing.reverse());
    } catch {
      const parent = path.dirname(current);
      // 一路退到根（或盘符）仍解析不出来：交给调用方按"界外"处理
      if (parent === current) return null;
      trailing.push(path.basename(current));
      current = parent;
    }
  }
}

/** target 是否落在 root 之内（两侧都已归一化） */
export function isInsideWorkspace(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/**
 * 写入前的边界断言：不在允许的根目录内就抛错。
 *
 * 允许的根目录按优先级取：会话绑定的工作区 → 调用方给的兜底根（通常是桌面）。
 * 没绑工作区时退回桌面是**有意保留**的行为：learn 模式记笔记就是写"笔记.md"这种
 * 相对路径落到桌面；这条路上工具调用仍然有边界，只是范围放宽到桌面。
 * 两个根都没有（既没绑工作区、也取不到桌面）才拒绝。
 *
 * @returns 归一后的真实路径，调用方可以直接用它落盘
 */
export function assertWritableInsideWorkspace(
  target: string,
  workspaceRoot: string | undefined,
  fallbackRoot?: string,
): string {
  const boundRoot = workspaceRoot && workspaceRoot.trim() ? workspaceRoot : undefined;
  const root = boundRoot ?? (fallbackRoot && fallbackRoot.trim() ? fallbackRoot : undefined);
  if (!root) {
    throw new WorkspaceBoundaryError(
      `当前会话没有绑定工作区，也没有可用的备用写入目录，拒绝写入：${target}。请先在工作台里选择工作区目录。`,
    );
  }
  const resolvedRoot = resolveRealPath(root);
  const resolved = resolveRealPath(target);
  // 解析不出来（root 或 target 任一）同样按"界外"处理：证不出它在允许范围内，就不能放行
  if (!resolvedRoot || !resolved || !isInsideWorkspace(resolvedRoot, resolved)) {
    throw new WorkspaceBoundaryError(
      boundRoot
        ? `拒绝写入工作区之外的文件：${target}（工作区：${boundRoot}）。` +
          `如需改动工作区外的文件，请在工作台里手动编辑，或把该目录设为工作区。`
        : `未绑定工作区时只能写入桌面：${target}（桌面：${root}）。` +
          `如需写入别处，请先把该目录设为工作区。`,
    );
  }
  return resolved;
}
