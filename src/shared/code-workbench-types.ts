// 工作台（Code Workbench）共享类型：checkpoint 时间线 + 工作区文件服务。
//
// checkpoint 是"隐形安全网"：每份快照以独立提交存放在 refs/cyrene-checkpoints/head
// 这条链上，不占用用户分支、不污染 git log、不动用户的暂存区与 HEAD。

/** 快照来源：auto=工作区变化防抖自动快照；pre-restore=回退前的保底快照；manual=用户手动快照 */
export type CheckpointKind = "auto" | "pre-restore" | "manual";

/** 时间线上的一条快照。files/insertions/deletions 是相对上一条快照的变化统计。 */
export interface CheckpointEntry {
  hash: string;
  kind: CheckpointKind;
  /** 归因会话（可能为 null：无法归因时仍保留快照） */
  sessionId: string | null;
  /** ISO 时间 */
  timestamp: string;
  files: number;
  insertions: number;
  deletions: number;
}

/** 某条快照相对其上一条的 diff（首条快照相对空树）。 */
export interface CheckpointDiff {
  fromHash: string | null;
  toHash: string;
  perFile: Array<{ file: string; insertions: number; deletions: number }>;
  insertions: number;
  deletions: number;
  truncated: boolean;
  patch: string;
}

export interface CheckpointRestoreResult {
  /** 回退前自动保底快照的 hash（时间线上可继续回到"回退前"） */
  preRestoreHash: string;
  restoredHash: string;
}

/** 工作区文件树条目（懒加载：一次一层目录）。 */
export interface WorkbenchFileEntry {
  name: string;
  /** 相对 workspaceRoot 的路径，统一正斜杠 */
  path: string;
  type: "file" | "dir";
}

export interface WorkbenchFileContent {
  path: string;
  /** binary=true 时为空串 */
  content: string;
  binary: boolean;
  /** 超过大小上限被截断 */
  truncated: boolean;
}
