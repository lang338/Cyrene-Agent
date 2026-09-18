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
  // 语言智能（补全/悬停/跳转/引用）同样交给外部语言服务，见 ./lsp-providers.ts：
  // 内置服务看不到别的文件和依赖（补全只剩"同文件词汇"），且两套都开会让补全菜单出现重复项。
  // 只关这四项，其余（签名帮助、格式化、重命名等）保持默认，编辑器基本能力不受影响。
  for (const defaults of [monaco.typescript.typescriptDefaults, monaco.typescript.javascriptDefaults]) {
    defaults.setModeConfiguration({
      ...defaults.modeConfiguration,
      completionItems: false,
      hovers: false,
      definitions: false,
      references: false,
    });
  }
  monaco.json.jsonDefaults.setDiagnosticsOptions({ validate: false, allowComments: true });
  loader.config({ monaco });
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
