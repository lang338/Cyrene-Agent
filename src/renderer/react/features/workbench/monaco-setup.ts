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
  // 诊断关闭：Monaco 的 TS 服务没有项目上下文（不读 tsconfig、不解析依赖），
  // 打开会大面积误报"找不到模块 xx"——要开得先解决喂项目上下文的问题。
  // 注意：补全不在这里控制（由 WorkbenchPage 的编辑器选项打开），两者互不影响。
  // monaco-editor 0.56+：语言服务命名空间挂在根导出（monaco.typescript / monaco.json）。
  const noDiagnostics = { noSemanticValidation: true, noSyntaxValidation: true, noSuggestionDiagnostics: true } as const;
  monaco.typescript.typescriptDefaults.setDiagnosticsOptions(noDiagnostics);
  monaco.typescript.javascriptDefaults.setDiagnosticsOptions(noDiagnostics);
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
