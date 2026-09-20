/**
 * 把「零基础就能用」的语言服务打成随应用分发的单文件包。
 *
 * 为什么是单文件：这些服务在 npm 上**都不带自己的依赖**（tarball 里没有 node_modules，
 * 这是 npm 的惯例），所以没法像 pyright 那样"下载即用"；直接塞进 dependencies 又会让
 * 安装包多出十几 MB、两千多个文件（实测 yaml 单独 18.3 MB / 2092 文件）。esbuild 把依赖
 * 内联成一个 .cjs 之后是 2.3 MB，安装包只多几 MB。
 *
 * 产物落在 `vendor/lsp-servers/<serverId>/`（**不进 git**，打包/开发前重新生成，
 * 与 mpv / mingit 同款约定）：
 *   - `<serverId>.cjs` 入口，交给 node 跑（client.ts 的 resolveLaunchTarget 认裸 .cjs）
 *   - `l10n/`          上游按 `__dirname` 相对路径找翻译文件，打完包这个相对位置就废了，
 *                      由 client.ts 在 initialize 时用 `initializationOptions.l10nPath` 告诉它
 *
 * 三处名字约定必须一致：本文件的 `<serverId>.cjs`、server-catalog.ts 的第二条命令、
 * default-dependencies.ts 里加进搜索目录的 `vendor/lsp-servers/*`。
 */
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const outRoot = path.join(repoRoot, "vendor", "lsp-servers");
const require = createRequire(path.join(repoRoot, "package.json"));

const SERVERS = [
  {
    /** 与 server-catalog.ts 的服务 id 一致：决定目录名与入口文件名 */
    serverId: "yaml-language-server",
    packageName: "yaml-language-server",
    /** esbuild 入口：npm 包里真正起服务的那份（`bin/` 下那个壳只是转手 require 它） */
    entry: "out/server/src/server.js",
    /** 要一起带上的运行时目录（上游按相对路径读，见文件头说明） */
    assets: ["l10n"],
    /** npm 的 bin 壳会设这个环境变量（服务端据此报版本），我们绕过了壳，自己补上 */
    versionEnvVar: "YAML_LANGUAGE_SERVER_VERSION",
  },
  {
    serverId: "dockerfile-language-server",
    packageName: "dockerfile-language-server-nodejs",
    // 这个包的 `bin` 是 `./bin/docker-langserver`，但真正起服务的是 lib/server.js
    entry: "lib/server.js",
    assets: [],
  },
];

function resolvePackageDir(packageName) {
  try {
    return path.dirname(require.resolve(`${packageName}/package.json`));
  } catch {
    const fallback = path.join(repoRoot, "node_modules", packageName);
    if (existsSync(path.join(fallback, "package.json"))) return fallback;
    throw new Error(`找不到 ${packageName}：先跑 npm install 再打包语言服务`);
  }
}

async function directorySize(directory) {
  let total = 0;
  let files = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = await directorySize(target);
      total += nested.total;
      files += nested.files;
    } else {
      total += (await stat(target)).size;
      files += 1;
    }
  }
  return { total, files };
}

async function buildServer(server) {
  const packageDir = resolvePackageDir(server.packageName);
  const packageJson = JSON.parse(await readFile(path.join(packageDir, "package.json"), "utf8"));
  const outDir = path.join(outRoot, server.serverId);
  const outfile = path.join(outDir, `${server.serverId}.cjs`);
  const entryPoint = path.join(packageDir, server.entry);
  if (!existsSync(entryPoint)) {
    throw new Error(`${server.packageName} 的入口变了：找不到 ${server.entry}`);
  }

  // 每次都从干净目录重建，避免上一版的残留文件混进产物
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  await build({
    entryPoints: [entryPoint],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    // ⚠️ 必须 module 优先。默认（node 平台）是 main 优先，会命中 jsonc-parser 的 UMD 分支，
    // 它内部的 require("./impl/format") 在打包产物里变成运行期解析 → 直接 Cannot find module。
    mainFields: ["module", "main"],
    ...(server.versionEnvVar
      ? { banner: { js: `process.env.${server.versionEnvVar} = process.env.${server.versionEnvVar} || "${packageJson.version}";` } }
      : {}),
    logLevel: "warning",
  });

  for (const asset of server.assets) {
    const from = path.join(packageDir, asset);
    if (!existsSync(from)) continue;
    await cp(from, path.join(outDir, asset), { recursive: true });
  }

  const size = await directorySize(outDir);
  console.log(
    `[lsp-servers] ${server.serverId}@${packageJson.version} → ${path.relative(repoRoot, outDir)}`
    + `（${(size.total / 1024 / 1024).toFixed(2)} MB / ${size.files} 个文件）`,
  );
}

// 只清自己产出的目录：vendor/ 下还有 srt-win 这些必须跟踪的东西
for (const server of SERVERS) {
  await rm(path.join(outRoot, server.serverId), { recursive: true, force: true });
}
await mkdir(outRoot, { recursive: true });
for (const server of SERVERS) {
  await buildServer(server);
}
