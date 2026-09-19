/**
 * 语言服务"应用内安装"的测试。
 *
 * 覆盖的都是会**伤到用户**的路径，而不是覆盖率：
 * - 哈希对不上必须整包丢弃（这是"执行陌生人代码"的唯一防线）；
 * - 中途取消不能留下半成品目录（否则下次启动会拿一个缺文件的副本去跑）；
 * - 连点两下不能下两份；镜像挂了要能换下一个地址。
 *
 * 下载用替身（不打真网络），但**解包是真跑**：fixture 是现打的 tgz，走真实的 node-tar 解包路径。
 * rootDir 用系统临时目录（不是仓库内），因为仓库目录在本机开发环境里禁止删除，
 * 会连带把"清理 staging"这类断言弄假。
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BUILTIN_LSP_SERVERS } from "./server-catalog";
import { MANAGED_SERVER_PACKAGES, type ManagedServerPackage } from "./managed-servers";
import {
  createLspServerInstaller,
  LspInstallCancelledError,
  type DownloadFn,
  type LspInstallProgress,
} from "./server-installer";

const ENTRY_CONTENT = "// 被下载安装的语言服务入口\nconsole.log('ok');\n";
const TEST_VERSION = "9.9.9-test";

let workspace: string;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-installer-"));
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

/** 造一个和 npm tarball 同形状的包：外面套一层 package/，入口在包根 */
async function makeFixturePackage(): Promise<Buffer> {
  const packageDir = path.join(workspace, "fixture", "package");
  fs.mkdirSync(path.join(packageDir, "dist"), { recursive: true });
  fs.writeFileSync(path.join(packageDir, "langserver.index.js"), ENTRY_CONTENT, "utf8");
  fs.writeFileSync(path.join(packageDir, "dist", "analyzer.js"), "module.exports = 1;\n", "utf8");
  const tarballPath = path.join(workspace, "fixture.tgz");
  await tar.c({ file: tarballPath, gzip: true, cwd: path.dirname(packageDir) }, ["package"]);
  return fs.readFileSync(tarballPath);
}

function integrityOf(buffer: Buffer): string {
  return `sha512-${createHash("sha512").update(buffer).digest("base64")}`;
}

function packageFor(tarball: Buffer, overrides: Partial<ManagedServerPackage> = {}): ManagedServerPackage {
  return {
    serverId: "python-pyright",
    packageName: "pyright",
    version: TEST_VERSION,
    integrity: integrityOf(tarball),
    urls: ["https://mirror.invalid/pyright.tgz"],
    stripComponents: 1,
    entry: "langserver.index.js",
    args: ["--stdio"],
    installBytes: tarball.length,
    ...overrides,
  };
}

/** 假下载：把 fixture 字节分块写进目标文件，形状与真实下载一致（含进度回调） */
function fakeDownload(tarball: Buffer, options: { failFirst?: boolean } = {}) {
  let calls = 0;
  const download: DownloadFn = async ({ destPath, signal, onBytes }) => {
    calls += 1;
    if (options.failFirst && calls === 1) throw new Error("HTTP 502");
    const chunkSize = Math.max(1, Math.ceil(tarball.length / 4));
    let written = 0;
    while (written < tarball.length) {
      if (signal.aborted) throw new Error("aborted");
      const chunk = tarball.subarray(written, written + chunkSize);
      fs.appendFileSync(destPath, chunk);
      written += chunk.length;
      onBytes(written, tarball.length);
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  };
  return { download, calls: () => calls };
}

/** 列出残留的 staging 目录：它们必须永远是空的，否则就是没清干净 */
function stagingLeftovers(serverId: string): string[] {
  const serverDir = path.join(workspace, serverId);
  if (!fs.existsSync(serverDir)) return [];
  return fs.readdirSync(serverDir).filter((name) => name.startsWith(".staging"));
}

describe("语言服务应用内安装", () => {
  it("装完能拿到入口，进度报出下载与解包两个阶段", async () => {
    const tarball = await makeFixturePackage();
    const { download } = fakeDownload(tarball);
    const progress: LspInstallProgress[] = [];
    const installer = createLspServerInstaller({
      rootDir: workspace,
      packages: [packageFor(tarball)],
      download,
      onProgress: (event) => progress.push(event),
    });

    expect(installer.installedEntry("python-pyright")).toBeNull();
    const info = await installer.install("python-pyright");

    expect(fs.readFileSync(info.entryPath, "utf8")).toBe(ENTRY_CONTENT);
    expect(installer.installedEntry("python-pyright")).toBe(info.entryPath);
    expect(info.args).toEqual(["--stdio"]);
    expect(progress.some((event) => event.phase === "download" && event.receivedBytes > 0)).toBe(true);
    expect(progress.some((event) => event.phase === "extract")).toBe(true);
    // staging 目录必须清干净：否则每次安装都会在用户机器上留一份垃圾
    expect(stagingLeftovers("python-pyright")).toEqual([]);
  });

  it("重装时旧版本目录被换掉，不会新旧文件混在一起", async () => {
    const tarball = await makeFixturePackage();
    const { download } = fakeDownload(tarball);
    const installer = createLspServerInstaller({ rootDir: workspace, packages: [packageFor(tarball)], download });

    const first = await installer.install("python-pyright");
    // 塞一个"上一版残留"的文件进去，重装后应该消失
    fs.writeFileSync(path.join(path.dirname(first.entryPath), "stale.js"), "old\n", "utf8");
    const second = await installer.install("python-pyright");

    expect(second.entryPath).toBe(first.entryPath);
    expect(fs.existsSync(path.join(path.dirname(second.entryPath), "stale.js"))).toBe(false);
  });

  it("哈希对不上时整包丢弃：不落版本目录、入口仍不可用", async () => {
    const tarball = await makeFixturePackage();
    const { download } = fakeDownload(tarball);
    const installer = createLspServerInstaller({
      rootDir: workspace,
      packages: [packageFor(tarball, { integrity: integrityOf(Buffer.from("别的东西")) })],
      download,
    });

    await expect(installer.install("python-pyright")).rejects.toThrow(/哈希不一致/);
    expect(installer.installedEntry("python-pyright")).toBeNull();
    expect(fs.existsSync(path.join(workspace, "python-pyright", TEST_VERSION))).toBe(false);
    expect(stagingLeftovers("python-pyright")).toEqual([]);
  });

  it("取消下载：抛取消错误、不留半成品", async () => {
    const tarball = await makeFixturePackage();
    const download: DownloadFn = ({ destPath, signal, onBytes }) =>
      new Promise<never>((_resolve, reject) => {
        fs.writeFileSync(destPath, tarball.subarray(0, 8));
        onBytes(8, tarball.length);
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const installer = createLspServerInstaller({ rootDir: workspace, packages: [packageFor(tarball)], download });

    const task = installer.install("python-pyright");
    // 让 download 先跑起来，再取消
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(installer.isInstalling("python-pyright")).toBe(true);
    expect(installer.cancel("python-pyright")).toBe(true);

    await expect(task).rejects.toBeInstanceOf(LspInstallCancelledError);
    expect(installer.installedEntry("python-pyright")).toBeNull();
    expect(stagingLeftovers("python-pyright")).toEqual([]);
    // 取消后再调一次应当无事发生（没有进行中的安装）
    expect(installer.cancel("python-pyright")).toBe(false);
  });

  it("连点两次只下一份（并发请求收敛成同一次安装）", async () => {
    const tarball = await makeFixturePackage();
    const { download, calls } = fakeDownload(tarball);
    const installer = createLspServerInstaller({ rootDir: workspace, packages: [packageFor(tarball)], download });

    const [first, second] = await Promise.all([
      installer.install("python-pyright"),
      installer.install("python-pyright"),
    ]);

    expect(calls()).toBe(1);
    expect(first.entryPath).toBe(second.entryPath);
  });

  it("第一个地址挂了会换下一个镜像，最终装成功", async () => {
    const tarball = await makeFixturePackage();
    const { download, calls } = fakeDownload(tarball, { failFirst: true });
    const installer = createLspServerInstaller({
      rootDir: workspace,
      packages: [packageFor(tarball, { urls: ["https://mirror.invalid/a.tgz", "https://registry.invalid/b.tgz"] })],
      download,
    });

    const info = await installer.install("python-pyright");
    expect(calls()).toBe(2);
    expect(fs.existsSync(info.entryPath)).toBe(true);
  });

  it("所有地址都挂了：报错里说清试过几个地址", async () => {
    const tarball = await makeFixturePackage();
    const download: DownloadFn = async () => {
      throw new Error("ENOTFOUND");
    };
    const installer = createLspServerInstaller({
      rootDir: workspace,
      packages: [packageFor(tarball, { urls: ["https://a.invalid/x.tgz", "https://b.invalid/x.tgz"] })],
      download,
    });

    await expect(installer.install("python-pyright")).rejects.toThrow(/已尝试 2 个地址/);
    expect(stagingLeftovers("python-pyright")).toEqual([]);
  });

  it("清单没写的服务不给装（只保留 PATH 自装那条路）", async () => {
    const installer = createLspServerInstaller({ rootDir: workspace, packages: [] });
    expect(installer.getPackage("gopls")).toBeNull();
    await expect(installer.install("gopls")).rejects.toThrow(/不支持应用内安装/);
  });

  it("托管清单里的服务 id 必须在 catalog 里真实存在（否则装了也用不上）", () => {
    const known = new Set(BUILTIN_LSP_SERVERS.map((server) => server.id));
    const unknown = MANAGED_SERVER_PACKAGES.filter((pkg) => !known.has(pkg.serverId)).map((pkg) => pkg.serverId);
    expect(unknown).toEqual([]);
  });

  it("托管包的启动参数与 catalog 里那条保持一致", () => {
    const mismatched = MANAGED_SERVER_PACKAGES.filter((pkg) => {
      const definition = BUILTIN_LSP_SERVERS.find((server) => server.id === pkg.serverId);
      return !definition || JSON.stringify(definition.commands[0]?.args ?? []) !== JSON.stringify([...pkg.args]);
    }).map((pkg) => pkg.serverId);
    expect(mismatched).toEqual([]);
  });
});
