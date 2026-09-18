// Monaco 本地装配：把 monaco-editor 以 npm 包形式喂给 @monaco-editor/react。
// 默认 loader 会从 CDN 拉 monaco——离线的 Electron 环境不能依赖外网，
// 这里 import 本地包并配置 worker，vite 用 ?worker 语法产出真实 worker 文件。
/// <reference types="vite/client" />

import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
// 注意：monaco-editor 0.56 的 package.json exports 只暴露 esm/vs 下的短路径
// （"./*": "./esm/vs/*.js"）。写 monaco-editor/esm/vs/... 会被映射成
// esm/vs/esm/vs/... 导致 vite dev 解析 500；生产构建恰好绕过 exports 才掩盖了问题。
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/language/json/json.worker?worker";
import CssWorker from "monaco-editor/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/language/html/html.worker?worker";
import TsWorker from "monaco-editor/language/typescript/ts.worker?worker";

let configured = false;
/** Monaco 的 TS 语言智能开关对象（从 setter 参数反推类型，避免依赖具体命名空间路径） */
type TsModeConfiguration = Parameters<typeof monaco.typescript.typescriptDefaults.setModeConfiguration>[0];
/** setupMonaco 时抓一份默认开关，之后反复切换都要能原样还原 */
let builtinModeConfiguration: TsModeConfiguration | null = null;
/** null = 还没设置过；与 setupMonaco 留下的默认状态（全开）保持一致 */
let builtinIntelligenceEnabled: boolean | null = null;

export function setupMonaco(): void {
  if (configured) return;
  configured = true;
  self.MonacoEnvironment = {
    getWorker(_workerId: string, label: string): Worker {
      switch (label) {
        case "json":
          return new JsonWorker();
        case "css":
        case "scss":
        case "less":
          return new CssWorker();
        case "html":
        case "handlebars":
        case "razor":
          return new HtmlWorker();
        case "typescript":
        case "javascript":
          return new TsWorker();
        default:
          return new EditorWorker();
      }
    },
  };
  // 内置 TS 服务的诊断保持关闭：它没有项目上下文（不读 tsconfig、不解析依赖），
  // 打开会大面积误报"找不到模块 xx"。工作台的诊断改由主进程里的外部语言服务提供
  // （见 lsp/editor-bridge.ts，渲染端在 WorkbenchPage 里画成 marker）——
  // 两套诊断同时开只会互相打架。
  // monaco-editor 0.56+：语言服务命名空间挂在根导出（monaco.typescript / monaco.json）。
  const noDiagnostics = { noSemanticValidation: true, noSyntaxValidation: true, noSuggestionDiagnostics: true } as const;
  monaco.typescript.typescriptDefaults.setDiagnosticsOptions(noDiagnostics);
  monaco.typescript.javascriptDefaults.setDiagnosticsOptions(noDiagnostics);
  // 语言智能（补全/悬停/跳转/引用）默认**保持内建开启**，等外部语言服务被证实
  // 对这个工作区可用之后，再由 lsp-providers.ts 关掉（见下面的 setBuiltinTsIntelligence）。
  // 顺序很重要：先关后开要靠"运行期切换"，一旦那个信号永远不来（没装服务、工作区
  // 没绑定、语言不支持），用户就会连改动前就有的"同文件补全"都失去——那比不加这个
  // 功能还差。这里只抓一份默认开关，切换时用它还原（签名帮助/格式化/重命名等其余项不动）。
  builtinModeConfiguration = { ...monaco.typescript.typescriptDefaults.modeConfiguration };
  monaco.json.jsonDefaults.setDiagnosticsOptions({ validate: false, allowComments: true });
  loader.config({ monaco });
}

/**
 * 开关 Monaco 内建的 TS/JS 语言智能（补全/悬停/跳转/引用四项）。
 *
 * 为什么必须能来回切：主进程里的外部语言服务读得到 tsconfig 和 node_modules，
 * 它**可用**时要关掉内建——两套同开会让补全菜单出现重复项，而内建那套没有项目上下文；
 * 它**不可用**时必须把内建打开兜底，理由见上面 setupMonaco 里的说明。
 *
 * 已知边界：它只反映"语言服务在不在"，不反映"这个项目的配置好不好"。服务活着但项目
 * 没有任何 TS 配置时，两边解析依赖的能力都有限，差别不大，就不再单独判断了。
 */
export function setBuiltinTsIntelligence(enabled: boolean): void {
  if (!builtinModeConfiguration || builtinIntelligenceEnabled === enabled) return;
  builtinIntelligenceEnabled = enabled;
  const mode: TsModeConfiguration = {
    ...builtinModeConfiguration,
    completionItems: enabled,
    hovers: enabled,
    definitions: enabled,
    references: enabled,
  };
  monaco.typescript.typescriptDefaults.setModeConfiguration(mode);
  monaco.typescript.javascriptDefaults.setModeConfiguration(mode);
}

/** 按文件扩展名猜 monaco 语言（猜不出就是 plaintext） */
export function monacoLanguageFor(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  const table: Record<string, string> = {
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
    rs: "rust",
    go: "go",
    java: "java",
    c: "c",
    h: "c",
    cpp: "cpp",
    hpp: "cpp",
    cs: "csharp",
    rb: "ruby",
    php: "php",
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
  return table[extension] ?? "plaintext";
}

// 模块加载即完成装配。
// 为什么不能只在组件里调用：子组件（<Editor>）的 effect 先于父组件执行，首次挂载时
// Editor 可能抢在 MonacoEnvironment / loader.config 之前初始化，语言服务（补全、诊断）
// 会就此失效——表现为编辑器能显示、语法高亮正常，但补全只剩"同文件词汇"建议。
setupMonaco();
