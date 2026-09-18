// 与真实 typescript-language-server 的联调测试（不是替身）。
//
// 为什么需要它：替换/假件只能证明"我们按协议发了消息"，证明不了真的能拿到诊断。
// 这条用例用真实语言服务跑完整链路（spawn → initialize → didOpen → 诊断回调），
// 任何一环断了都会在这里暴露。找不到语言服务时整组跳过，不阻塞 CI。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
});
