// 工作台的语言识别表：扩展名 → Monaco languageId，以及"哪些语言接了外部语言服务"。
//
// 为什么放在 shared：渲染端要它（编辑器挑高亮语言、按语言注册补全 provider），主进程也要它
// （AI 工具链 touchFile 时得告诉语言服务这是哪种文件）。两边各维护一份迟早会漂移，
// 比如渲染端把 .pyi 当 python、主进程当 pyi，语言服务就会收到不认识的 languageId。
//
// 与主进程 catalog 的一致性由测试兜底：src/main/lsp/language-coverage.test.ts 会校验
// "这里声明接语义补全的扩展名" 与 "catalog 里登记的语言服务" 互相对得上。

/** 扩展名（小写、不含点）→ Monaco languageId；查不到就是 plaintext */
export const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "typescript",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  json: "json",
  jsonc: "json",
  css: "css",
  scss: "scss",
  less: "less",
  html: "html",
  htm: "html",
  md: "markdown",
  markdown: "markdown",
  py: "python",
  pyi: "python",
  rs: "rust",
  go: "go",
  java: "java",
  c: "c",
  h: "c",
  cc: "cpp",
  cp: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  hxx: "cpp",
  cs: "csharp",
  csx: "csharp",
  rb: "ruby",
  rake: "ruby",
  gemspec: "ruby",
  php: "php",
  kt: "kotlin",
  kts: "kotlin",
  lua: "lua",
  sh: "shell",
  bash: "shell",
  yml: "yaml",
  yaml: "yaml",
  sql: "sql",
  xml: "xml",
  toml: "ini",
  ini: "ini",
  bat: "bat",
  ps1: "powershell",
};

export interface LspLanguage {
  /** Monaco languageId：渲染端按它注册补全/悬停/跳转/查引用 provider */
  languageId: string;
  /** 该语言参与语义补全的扩展名（小写、含点），必须与主进程 catalog 完全对应 */
  extensions: readonly string[];
}

/**
 * 会接外部语言服务的语言。
 *
 * 注册了 provider 就意味着"这类文件的内容会被同步给主进程"，所以有两个**刻意**不在这里的语言：
 * - json/jsonc：Monaco 自带的 json 服务已经在提供补全与校验，再挂一层会让补全菜单出现两套
 *   重复建议（TS 那套还读不到项目配置）；主进程的 tsserver 仍照常服务 json（AI 工具链要用）；
 * - vue：语言服务返回的是 .vue 内部的虚拟文档 URI，通用桥还没支持（见多语言拓展计划 M4）。
 *
 * 顺序无关，但保持"最常用在前"便于阅读。
 */
export const LSP_LANGUAGES: readonly LspLanguage[] = [
  { languageId: "typescript", extensions: [".ts", ".tsx", ".mts", ".cts"] },
  { languageId: "javascript", extensions: [".js", ".jsx", ".mjs", ".cjs"] },
  { languageId: "python", extensions: [".py", ".pyi"] },
  { languageId: "go", extensions: [".go"] },
  { languageId: "rust", extensions: [".rs"] },
  { languageId: "java", extensions: [".java"] },
  { languageId: "c", extensions: [".c", ".h"] },
  { languageId: "cpp", extensions: [".cc", ".cp", ".cpp", ".cxx", ".hpp", ".hh", ".hxx"] },
  { languageId: "csharp", extensions: [".cs", ".csx"] },
  { languageId: "php", extensions: [".php"] },
  { languageId: "ruby", extensions: [".rb", ".rake", ".gemspec"] },
  { languageId: "kotlin", extensions: [".kt", ".kts"] },
  { languageId: "lua", extensions: [".lua"] },
  { languageId: "yaml", extensions: [".yaml", ".yml"] },
];

const LSP_LANGUAGE_IDS = new Set(LSP_LANGUAGES.map((language) => language.languageId));

/**
 * 这个 Monaco languageId 上有没有注册语义补全 provider。
 * 界面上的"缺语言服务"提示要跟着它走，而不是跟着主进程 catalog 走：
 * catalog 里有 vue-language-server 但我们没注册 .vue（见上），提示用户去装一个装了也没用的服务
 * 比不提示更糟。
 */
export function isLspLanguage(languageId: string | null): boolean {
  return languageId !== null && LSP_LANGUAGE_IDS.has(languageId);
}

/**
 * 从文件路径推 Monaco languageId（猜不出就是 plaintext）。
 * 大小写不敏感：用户在 Windows 上常见 `Main.PY` 这种扩展名。
 */
export function languageIdForPath(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  return LANGUAGE_BY_EXTENSION[extension] ?? "plaintext";
}
