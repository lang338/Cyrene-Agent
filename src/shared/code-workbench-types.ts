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

// ── 改动账本（时间线的数据源） ────────────────────────────────
//
// 与 checkpoint 的区别：checkpoint 存"整个工作区的一棵树"（要求工作区是 git 仓库、规模受限）；
// 账本只存"被改动过的文件的内容"，因此巨型目录、非 git 目录都能用。

/** 一次改动的来源：ai=昔涟用写文件工具改的；user=你在工作台代码区保存的 */
export type LedgerSource = "ai" | "user";

export type LedgerChangeKind = "create" | "modify" | "delete";

/** 内容未入库的原因（未入库时只记"被改过"，不能回退该文件内容） */
export type LedgerSkipReason = "binary" | "too-large" | "unreadable";

export interface LedgerFileChange {
  /** 工作区相对路径（正斜杠） */
  path: string;
  kind: LedgerChangeKind;
  source: LedgerSource;
  insertions: number;
  deletions: number;
  /**
   * 是否拿到了"改动前"的基线。
   * false = 这次改动之前我们没见过这个文件（例如它由命令行或外部工具产生），
   * 因此**无法回退它的内容**，界面上必须标明。
   */
  hasBaseline: boolean;
  contentSkipped?: LedgerSkipReason;
}

/** 时间线上的一条：一次 AI 回合（或一次你的保存） */
export interface LedgerRound {
  roundId: string;
  /** 归属会话 */
  conversationId: string;
  at: number;
  /** 展示用标签：发起这一轮的用户消息（截断） */
  label: string;
  files: LedgerFileChange[];
}

export interface LedgerUsage {
  totalBytes: number;
  maxBytes: number;
  /** 已超过提示线（默认 80%） */
  warn: boolean;
  roundCount: number;
}

export interface LedgerRestoreResult {
  restored: string[];
  deleted: string[];
  /** 未处理并给出原因的文件（无基线 / 期间被外部改过） */
  skipped: Array<{ path: string; reason: string }>;
}

/** 单个文件在某一轮前后的内容；null 表示当时不存在，undefined 表示内容未入库 */
export interface LedgerFileVersions {
  path: string;
  before: string | null | undefined;
  after: string | null | undefined;
}
