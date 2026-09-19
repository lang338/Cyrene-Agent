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

/** 一次改动的来源：ai=昔涟用写文件工具改的；user=你在工作台代码区保存的；restore=你把文件回退到某一轮之前 */
export type LedgerSource = "ai" | "user" | "restore";

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

// ── 语言服务（LSP）诊断 ────────────────────────────────────
//
// 只挑编辑器画红线需要的字段：渲染端不该为了几个字段去依赖整个 LSP 类型包。

/** LSP 位置（行、列都是从 0 开始） */
export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

/** LSP 约定：1=Error、2=Warning、3=Information、4=Hint */
export type LspSeverity = 1 | 2 | 3 | 4;

export interface WorkbenchLspDiagnostic {
  message: string;
  severity?: LspSeverity;
  range: LspRange;
  source?: string;
  code?: string | number;
}

/**
 * "这个语言服务能不能在工作台里一键装"。
 *
 * 只有零前置运行时的语言服务才支持（清单见 main/lsp/managed-servers.ts）：
 * 装了要能在本机跑起来，所以拖 JDK/.NET/Ruby 的那些一律不给这个入口，只提示去 PATH 里装。
 */
export interface WorkbenchLspInstallState {
  /** 正在下载/解包：界面显示进度与取消，而不是再给一个按钮 */
  installing: boolean;
  /** 要装的版本（展示用） */
  version: string;
  /** 安装后占用空间（字节），按钮上换算成"约 xx MB" */
  sizeBytes: number;
}

/**
 * 编辑器问"这个文件的语言服务环境"。
 *
 * 用来把"为什么补全很弱"说明白（而不是让用户以为功能做得很烂），
 * 并给"一键生成配置 / 一键安装语言服务"一个落点。四种结果：这类文件本来就不在覆盖范围内
 * （不提示）/ 有对应语言服务但本机没装（能托管就报下载按钮，否则给安装指引）/
 * 有服务但缺项目配置（精度受限）/ 一切正常。
 */
export interface WorkbenchLspEnv {
  /** 这个工作区能不能拿到语言服务；拿不到就只能退化成文本级建议 */
  hasService: boolean;
  /**
   * 这个文件类型对应的语言服务 id（catalog 里的 id，如 python-pyright）；
   * null = 这类文件本来就没有语言服务（.md/.css 等），界面上不提示任何东西。
   */
  serverId: string | null;
  /** 该服务在 catalog 里的安装指引（中文，作为本地化文案缺失时的兜底） */
  installHint: string | null;
  /** 能应用内一键装时给界面的参数；null = 只能用户自己装到 PATH */
  install: WorkbenchLspInstallState | null;
  /** 往上找到的项目配置（tsconfig.json / jsconfig.json）；没有则为 null */
  configFile: string | null;
  /** 建议把配置写在哪（绝对路径，始终落在工作区内） */
  projectRoot: string;
  /** 写配置用的工作区相对路径（复用 workbench:file-write） */
  configRelativePath: string;
  /** 推荐配置的内容（主进程生成，渲染端只负责显示与确认后写入） */
  recommendedConfig: string;
}

/** 安装进度推送（主进程 → 渲染端）：下载按字节算百分比，解包只报阶段 */
export interface WorkbenchLspInstallProgress {
  serverId: string;
  phase: "download" | "extract";
  receivedBytes: number;
  /** 0 = 服务端没给 Content-Length，界面按"不确定进度"展示 */
  totalBytes: number;
}

/**
 * 一次安装请求的结果。
 * 取消不算失败（用户自己的选择，界面不该弹错），所以单列一支而不是复用 error。
 */
export type WorkbenchLspInstallResult =
  | { ok: true; serverId: string; version: string }
  | { ok: false; cancelled: true }
  | { ok: false; cancelled: false; error: string };

// ── 语言服务（LSP）请求：编辑器主动提问 ────────────────────
//
// 诊断是"服务端推"，这里是"编辑器问"，方向相反，所以要带上问谁、问哪里。
// 服务端返回的是各种花样的 LSP 原始结构，主进程负责拍平成下面这几个简单形状，
// 渲染端因此不必依赖整个 LSP 类型包。

export type WorkbenchLspRequestMethod = "completion" | "hover" | "definition" | "implementation" | "references" | "signatureHelp";

export interface WorkbenchLspRequestInput {
  sessionId: string;
  /** 工作区相对路径；工作区外的文件不属于任何项目，不参与语言服务 */
  path: string;
  method: WorkbenchLspRequestMethod;
  /** LSP 位置（行列都从 0 开始）——渲染端把 Monaco 的 1-based 减 1 后传进来 */
  position: LspPosition;
  /** 查引用时是否把声明本身也算进去（默认算） */
  includeDeclaration?: boolean;
}

/** 补全项：只保留渲染 Monaco 补全菜单需要的字段 */
export interface WorkbenchLspCompletionItem {
  label: string;
  /** LSP CompletionItemKind（1=Text…25=TypeParameter），渲染端映射成 Monaco 图标 */
  kind?: number;
  detail?: string;
  /** 已拍平成纯文本的文档说明 */
  documentation?: string;
  insertText?: string;
  sortText?: string;
  filterText?: string;
  /** 补全要替换的范围（LSP 0 起编码）；缺省表示按当前词的默认范围 */
  textEditRange?: LspRange;
}

export interface WorkbenchLspHover {
  /** 已拍平成多行纯文本：渲染端不需要懂 markdown 结构 */
  contents: string;
  range?: LspRange;
}

export interface WorkbenchLspLocation {
  /** 工作区相对路径；定义落在工作区外（依赖里）时为 null */
  path: string | null;
  /** 工作区外时的绝对路径，用来告诉用户"这个定义在依赖里" */
  externalPath?: string;
  range: LspRange;
}

export interface WorkbenchLspRequestResult {
  method: WorkbenchLspRequestMethod;
  completions?: WorkbenchLspCompletionItem[];
  hover?: WorkbenchLspHover | null;
  locations?: WorkbenchLspLocation[];
  signatureHelp?: WorkbenchLspSignatureHelp | null;
}

/**
 * 一个参数：标签可以是字符串，也可以是相对签名文本的 [起, 止] 偏移。
 * 两种写法 LSP 都允许（偏移省得把签名拆开），Monaco 也认，所以原样透传不再拆解。
 */
export interface WorkbenchLspSignatureParameter {
  label: string | [number, number];
}

export interface WorkbenchLspSignature {
  /** 完整签名文本，如 `writeFile(sessionId: string, path: string): Promise<void>` */
  label: string;
  /** 已拍平成纯文本的文档说明 */
  documentation?: string;
  parameters?: WorkbenchLspSignatureParameter[];
}

/**
 * 参数提示：光标停在括号里时告诉用户"这个函数要什么参数、现在填的是第几个"。
 * 两个下标都保证是**有效下标**（不是可选值）：渲染端不用再判空/夹取。
 */
export interface WorkbenchLspSignatureHelp {
  signatures: WorkbenchLspSignature[];
  activeSignature: number;
  activeParameter: number;
}
