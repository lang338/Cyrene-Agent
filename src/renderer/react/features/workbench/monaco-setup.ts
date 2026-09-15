// Monaco 本地装配：把 monaco-editor 以 npm 包形式喂给 @monaco-editor/react。
// 默认 loader 会从 CDN 拉 monaco——离线的 Electron 环境不能依赖外网，
// 这里 import 本地包并配置 worker，vite 用 ?worker 语法产出真实 worker 文件。
/// <reference types="vite/client" />

import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import CssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import TsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

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
  // 定位是"微调编辑器"：AI 负责写码，人只做小改动。
  // 补全与诊断全部关掉——省掉 worker 往返，也避免满屏红线干扰。
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
