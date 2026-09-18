// 与真实 typescript-language-server 的联调测试（不是替身）。
//
// 为什么需要它：替换/假件只能证明"我们按协议发了消息"，证明不了真的能拿到诊断。
// 这条用例用真实语言服务跑完整链路（spawn → initialize → didOpen → 诊断回调），
// 任何一环断了都会在这里暴露。找不到语言服务时整组跳过，不阻塞 CI。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { LspClient } from "./client";
import { BUILTIN_LSP_SERVERS } from "./server-catalog";
import { resolveLspServer } from "./server-discovery";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // 语言服务进程可能还握着目录句柄，清理失败不影响结论
    }
  }
});

function createTsProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-lsp-live-"));
  roots.push(root);
  fs.writeFileSync(
    path.join(root, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { strict: true, target: "ES2022", module: "ESNext", moduleResolution: "bundler" } }, null, 2),
    "utf8",
  );
  return root;
}

const definition = BUILTIN_LSP_SERVERS.find((item) => item.id === "typescript-language-server");
const bundledBin = path.join(process.cwd(), "node_modules", ".bin");

// 应用自带目录这一档正是新加的 extraBinDirs，顺带一起验证
const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-lsp-probe-"));
const available = definition
  ? resolveLspServer(definition, probeRoot, { extraBinDirs: [bundledBin] })
  : null;
fs.rmSync(probeRoot, { recursive: true, force: true });

describe.skipIf(!available)("LspClient + 真实 typescript-language-server", () => {
  it("把编辑器内容同步过去后能收到诊断", async () => {
    const workspaceRoot = createTsProject();
    const file = path.join(workspaceRoot, "probe.ts");
    fs.writeFileSync(file, "export const ok = 1;\n", "utf8");

    const client = new LspClient({ server: available!, workspaceRoot });
    const seen: Array<{ filePath: string; messages: string[] }> = [];
    client.onDiagnostics((filePath, diagnostics) => {
      seen.push({ filePath, messages: diagnostics.map((item) => item.message) });
    });

    try {
      await client.syncFromEditor(file, "typescript", 'export const ok = 1;\nconst bad: number = "nope";\n');

      const deadline = Date.now() + 40_000;
      // 服务端在 didOpen 阶段可能先推一条**空**诊断，别据此就断定"没有诊断"——
      // 要等的是真正带内容的那条
      while (Date.now() < deadline && !seen.some((item) => item.messages.length > 0)) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      const withMessages = seen.find((item) => item.messages.length > 0);
      expect(withMessages, "语言服务没有推回任何诊断").toBeDefined();
      // Windows 上 fileURLToPath 会把盘符转成小写，比较时忽略大小写
      expect(withMessages!.filePath.toLowerCase()).toBe(path.normalize(file).toLowerCase());
      expect(withMessages!.messages.join("\n")).toContain("not assignable");
    } finally {
      await client.dispose();
    }
  }, 60_000);

  it("同步编辑器内容后能拿到补全项，且包含跨文件的类型成员", async () => {
    const workspaceRoot = createTsProject();
    // 造一个必须跨文件才能答对的场景：接口在 types.ts，使用点在 main.ts
    fs.writeFileSync(
      path.join(workspaceRoot, "types.ts"),
      "export interface Probe { alpha: number; beta: string }\n",
      "utf8",
    );
    const mainFile = path.join(workspaceRoot, "main.ts");
    const content = [
      'import type { Probe } from "./types";',
      'const probe: Probe = { alpha: 1, beta: "x" };',
      "probe.",
      "",
    ].join("\n");
    fs.writeFileSync(mainFile, content, "utf8");

    const client = new LspClient({ server: available!, workspaceRoot });
    try {
      // 必须先把内容同步过去（didOpen），否则语言服务手里没有这份文档，补全必然为空
      await client.syncFromEditor(mainFile, "typescript", content);
      // 语言服务刚起来时项目还没索引完，补全会先返回空——就像诊断那条用例一样，
      // 要等的是"非空且包含跨文件成员"的那一刻，而不是第一次的返回值
      const deadline = Date.now() + 40_000;
      let labels: string[] = [];
      while (Date.now() < deadline) {
        const raw = await client.request<unknown>(
          "textDocument/completion",
          {
            textDocument: { uri: pathToFileURL(mainFile).toString() },
            position: { line: 2, character: "probe.".length },
          },
          30_000,
        );
        const container = raw as { items?: Array<{ label: string }> } | Array<{ label: string }> | null;
        const items = Array.isArray(container) ? container : (container?.items ?? []);
        labels = items.map((item) => item.label);
        if (labels.includes("alpha") && labels.includes("beta")) break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      expect(labels, "语言服务没有返回任何补全项").not.toHaveLength(0);
      // 关键：跨文件的类型成员必须出现——这正是内置 TS 服务做不到、所以要换外部服务的原因
      expect(labels).toContain("alpha");
      expect(labels).toContain("beta");
    } finally {
      await client.dispose();
    }
  }, 60_000);

  /**
   * 真机踩过的坑：工作台有两条同步路径（提问前一次、防抖一次），落后那条曾把新内容覆盖成旧的，
   * 于是补全按旧内容算——表现是"刚敲的那行拿不到成员补全，而悬停却是对的"。
   * 这条用例盯住的就是"迟到的旧同步不能污染补全结果"。
   */
  it("迟到的旧同步不能把内容拉回旧版（否则补全按旧内容算）", async () => {
    const workspaceRoot = createTsProject();
    fs.writeFileSync(
      path.join(workspaceRoot, "types.ts"),
      "export interface Probe { alpha: number; beta: string }\n",
      "utf8",
    );
    const mainFile = path.join(workspaceRoot, "main.ts");
    const withDot = ['import type { Probe } from "./types";', 'const probe: Probe = { alpha: 1, beta: "x" };', "probe.", ""].join("\n");
    const withoutDot = ['import type { Probe } from "./types";', 'const probe: Probe = { alpha: 1, beta: "x" };', "probe", ""].join("\n");
    fs.writeFileSync(mainFile, withDot, "utf8");

    const client = new LspClient({ server: available!, workspaceRoot });
    const ask = async (): Promise<string[]> => {
      const raw = await client.request<unknown>(
        "textDocument/completion",
        { textDocument: { uri: pathToFileURL(mainFile).toString() }, position: { line: 2, character: "probe.".length } },
        30_000,
      );
      const container = raw as { items?: Array<{ label: string }> } | Array<{ label: string }> | null;
      const items = Array.isArray(container) ? container : (container?.items ?? []);
      return items.map((item) => item.label);
    };
    try {
      // 修订号 2 = 最新内容；先等索引建好（首次补全可能为空）
      await client.syncFromEditor(mainFile, "typescript", withDot, 2);
      const deadline = Date.now() + 40_000;
      let ready = false;
      while (Date.now() < deadline) {
        if ((await ask()).includes("alpha")) {
          ready = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      expect(ready, "语言服务始终没有给出跨文件成员").toBe(true);

      // 迟到的旧同步（修订号更小）：必须被丢弃，补全结果不受影响
      await client.syncFromEditor(mainFile, "typescript", withoutDot, 1);
      expect(await ask()).toContain("alpha");
    } finally {
      await client.dispose();
    }
  }, 90_000);
});
