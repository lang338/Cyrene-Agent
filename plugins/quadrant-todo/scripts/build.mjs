/**
 * 构建脚本：esbuild 打包 src/index.ts -> 插件根 index.cjs（宿主 manifest.entry
 * 要求裸文件名，不能写 dist/index.cjs），workbench 页面原样拷入 workbench/。
 * 产物（index.cjs、workbench/）不进 git，发布时从产物打包 ZIP。
 *
 * 依赖策略：本工程不单独 install，开发依赖（esbuild/typescript/vitest/@types/node）
 * 由宿主仓库根提供——仓库根 pnpm install 一次后，在本目录 pnpm run build 即可
 * （Node 模块解析与 pnpm run 的祖先 .bin PATH 均可借到根依赖）。
 *
 * esbuild 走 CLI 而非 JS API：esbuild 0.28 的 JS API（含 buildSync）在本机
 * Windows 上进程收尾必崩（0xC0000409）并跳过后续代码；CLI 是独立 Go 二进制，
 * 退出干净。
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

rmSync(join(root, "index.cjs"), { force: true });
rmSync(join(root, "workbench"), { recursive: true, force: true });

const require = createRequire(import.meta.url);
const esbuildBin = require.resolve("esbuild/bin/esbuild");
const result = spawnSync(
  process.execPath,
  [
    esbuildBin,
    "--bundle",
    join(root, "src", "index.ts"),
    `--outfile=${join(root, "index.cjs")}`,
    "--platform=node",
    "--format=cjs",
    "--target=node20",
    "--external:electron",
    "--charset=utf8",
    "--log-level=info",
  ],
  { stdio: "inherit" },
);
if (result.status !== 0) {
  console.error(`esbuild 打包失败，退出码 ${result.status}`);
  process.exit(result.status ?? 1);
}

// node v24.11 本机 cpSync 递归拷贝目录稳定崩溃（0xC0000409），改手写递归
function copyDir(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, entry.name);
    const d = join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else copyFileSync(s, d);
  }
}
copyDir(join(root, "src", "workbench"), join(root, "workbench"));

console.log("构建完成: index.cjs + workbench/");
