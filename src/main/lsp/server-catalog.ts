import path from "node:path";
import type { LspServerCommand, LspServerDefinition, LspServerOverride } from "./types";

/**
 * 随应用打包的语言服务入口名（放在 `vendor/lsp-servers/<id>/` 下，见
 * `scripts/build/lsp-servers.mjs`；目录由 default-dependencies 加进搜索目录）。
 * 命名约定就是 `<服务 id>.cjs`，打的是裸 .cjs，交给 client.ts 的 resolveLaunchTarget 用 node 跑。
 */
const BUNDLED_YAML_SERVER_ENTRY = "yaml-language-server.cjs";
const BUNDLED_DOCKERFILE_SERVER_ENTRY = "dockerfile-language-server.cjs";

interface ServerExtras {
  /** 随应用打包的兜底入口（顺序排在"用户自己装的那份"之后） */
  bundledCommand?: LspServerCommand;
  /** 靠文件名识别（`Dockerfile` 这类没有扩展名的文件） */
  filenames?: readonly string[];
}

/**
 * `commands` 按顺序尝试：先试用户自己装的那份（工作区/全局），都没有才回落到应用自带的副本。
 * 用户装的服务版本跟项目更贴，也更可能是他要的；自带那份只是"没有也能用"的兜底。
 */
function server(
  id: string,
  extensions: string[],
  command: string,
  args: string[],
  rootMarkers: string[],
  installHint: string,
  extras: ServerExtras = {},
): LspServerDefinition {
  return {
    id,
    extensions,
    commands: [{ command, args }, ...(extras.bundledCommand ? [extras.bundledCommand] : [])],
    rootMarkers,
    installHint,
    ...(extras.filenames ? { filenames: [...extras.filenames] } : {}),
  };
}

export const BUILTIN_LSP_SERVERS: readonly LspServerDefinition[] = [
  server("typescript-language-server", [".ts", ".mts", ".cts", ".tsx", ".js", ".mjs", ".cjs", ".jsx", ".json", ".jsonc"], "typescript-language-server", ["--stdio"], ["tsconfig.json", "jsconfig.json", "package.json", ".git"], "安装 typescript-language-server 与 typescript，并确保 typescript-language-server 位于 PATH。"),
  server("python-pyright", [".py", ".pyi"], "pyright-langserver", ["--stdio"], ["pyproject.toml", "requirements.txt", "setup.py", ".git"], "安装 pyright，并确保 pyright-langserver 位于 PATH。"),
  server("gopls", [".go"], "gopls", [], ["go.mod", ".git"], "需要先装 Go：官方只发布源码，用 go install golang.org/x/tools/gopls@latest 安装；本机没有 Go 时它无法解析模块，补全与跳转不可用。"),
  server("rust-analyzer", [".rs"], "rust-analyzer", [], ["Cargo.toml", ".git"], "需要先装 Rust：语言服务靠 cargo 加载项目，本机没有 Rust 工具链时补全与跳转不可用。装好 Rust 后执行 rustup component add rust-analyzer。"),
  server("clangd", [".c", ".h", ".cc", ".cp", ".cpp", ".cxx", ".hpp", ".hh", ".hxx"], "clangd", [], ["compile_commands.json", "CMakeLists.txt", ".git"], "安装 clangd，并确保 clangd 位于 PATH。"),
  server("jdtls", [".java"], "jdtls", [], ["pom.xml", "build.gradle", "settings.gradle", ".git"], "需要先装 JDK 17+：jdtls 本身是 Java 程序，项目能力还依赖 pom.xml / build.gradle。装好后把 jdtls 加入 PATH。"),
  server("omnisharp", [".cs", ".csx"], "OmniSharp", ["-lsp"], ["*.sln", "*.csproj", ".git"], "需要先装 .NET SDK：OmniSharp 依赖 .NET 运行时，完整能力还要 .sln / .csproj。装好后把 OmniSharp 加入 PATH。"),
  server("intelephense", [".php"], "intelephense", ["--stdio"], ["composer.json", ".git"], "安装 intelephense，并确保 intelephense 位于 PATH。"),
  server("ruby-lsp", [".rb", ".rake", ".gemspec"], "ruby-lsp", [], ["Gemfile", ".ruby-version", ".git"], "需要先装 Ruby：用 gem install ruby-lsp 安装，项目能力还依赖 Gemfile。"),
  server("kotlin-language-server", [".kt", ".kts"], "kotlin-language-server", [], ["build.gradle", "settings.gradle", ".git"], "需要先装 JVM（Java 17+）：该服务是 JVM 程序。装好后把它的可执行文件加入 PATH。"),
  server("lua-language-server", [".lua"], "lua-language-server", [], [".luarc.json", ".git"], "安装 lua-language-server，并确保它位于 PATH。"),
  server("vue-language-server", [".vue"], "vue-language-server", ["--stdio"], ["package.json", "vite.config.ts", ".git"], "安装 @vue/language-server，并确保 vue-language-server 位于 PATH。"),
  server("yaml-language-server", [".yaml", ".yml"], "yaml-language-server", ["--stdio"], [".git"], "应用自带的 YAML 语言服务没能启动，可自己装一份：npm i -g yaml-language-server。", { bundledCommand: { command: BUNDLED_YAML_SERVER_ENTRY, args: ["--stdio"] } }),
  server(
    "dockerfile-language-server",
    [".dockerfile"],
    // npm 包名与它的 bin 名不一样：包是 dockerfile-language-server-nodejs，可执行文件叫 docker-langserver
    "docker-langserver",
    ["--stdio"],
    [".git"],
    "应用自带的 Dockerfile 语言服务没能启动，可自己装一份：npm i -g dockerfile-language-server-nodejs。",
    { bundledCommand: { command: BUNDLED_DOCKERFILE_SERVER_ENTRY, args: ["--stdio"] }, filenames: ["Dockerfile", "Containerfile"] },
  ),
];

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isValidOverride(value: LspServerOverride, serverId: string): boolean {
  return value.id === serverId
    && (!value.command || isNonBlankString(value.command))
    && (!value.args || value.args.every(isNonBlankString))
    && (!value.extensions || value.extensions.every((extension) => isNonBlankString(extension) && extension.startsWith(".")));
}

/**
 * 对磁盘中的用户配置做白名单规范化。这里不接受任意对象，避免配置文件把
 * 原型键或不可执行的参数传到子进程启动路径。
 */
export function normalizeLspServerOverrides(input: unknown): LspServerOverride[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const knownIds = new Set(BUILTIN_LSP_SERVERS.map((definition) => definition.id));
  const result: LspServerOverride[] = [];
  for (const candidate of input) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const raw = candidate as Record<string, unknown>;
    if (!isNonBlankString(raw.id) || !knownIds.has(raw.id) || seen.has(raw.id)) continue;
    const command = raw.command === undefined ? undefined : isNonBlankString(raw.command) ? raw.command.trim() : undefined;
    const args = Array.isArray(raw.args) && raw.args.every(isNonBlankString) ? raw.args.map((arg) => arg.trim()) : undefined;
    const extensions = Array.isArray(raw.extensions)
      && raw.extensions.every((extension) => isNonBlankString(extension) && extension.startsWith("."))
      ? raw.extensions.map((extension) => extension.trim().toLowerCase())
      : undefined;
    const initializationOptions = raw.initializationOptions !== undefined && isPlainJsonValue(raw.initializationOptions)
      ? raw.initializationOptions
      : undefined;
    if (raw.command !== undefined && !command) continue;
    if (raw.args !== undefined && !args) continue;
    if (raw.extensions !== undefined && !extensions) continue;
    result.push({ id: raw.id, ...(command ? { command } : {}), ...(args ? { args } : {}), ...(extensions ? { extensions } : {}), ...(initializationOptions !== undefined ? { initializationOptions } : {}) });
    seen.add(raw.id);
  }
  return result;
}

function isPlainJsonValue(value: unknown): boolean {
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isPlainJsonValue);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).every(([key, nested]) =>
    key !== "__proto__" && key !== "prototype" && key !== "constructor" && isPlainJsonValue(nested));
}

function applyOverride(serverDefinition: LspServerDefinition, overrides: readonly LspServerOverride[]): LspServerDefinition {
  const override = overrides.find((candidate) => isValidOverride(candidate, serverDefinition.id));
  if (!override) return serverDefinition;
  return {
    ...serverDefinition,
    ...(override.extensions ? { extensions: [...override.extensions] } : {}),
    ...(override.command ? { commands: [{ command: override.command, args: override.args ? [...override.args] : [] }] } : {}),
    ...(override.initializationOptions !== undefined ? { initializationOptions: override.initializationOptions } : {}),
  };
}

/**
 * 按**扩展名**或**文件名**找候选服务。
 * 两个都要看：`Dockerfile` 没有扩展名（`path.extname` 返回空串），只看扩展名会让这类文件
 * 被判成"没有对应的语言服务"——表现就是编辑器里它既没有高亮、也没有诊断，还不给任何提示。
 */
export function findServerCandidates(
  filePath: string,
  overrides: readonly LspServerOverride[] = [],
): LspServerDefinition[] {
  const extension = path.extname(filePath).toLowerCase();
  const base = path.basename(filePath).toLowerCase();
  return BUILTIN_LSP_SERVERS
    .filter((definition) =>
      (extension !== "" && definition.extensions.includes(extension))
      || (definition.filenames ?? []).some((name) => name.toLowerCase() === base))
    .map((definition) => applyOverride(definition, overrides));
}
