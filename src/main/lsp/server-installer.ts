// 语言服务的"应用内安装"（M1：先支持 pyright）。
//
// 目标：用户在编辑器里点一下就把语言服务装好——不用开终端、不用知道 npm 是什么，
// 同时不给"执行陌生人代码"开后门：下载物必须逐字节对上代码里钉死的 sha512。
//
// 落盘布局（`rootDir` = userData/lsp-servers）：
//   <serverId>/installed.json          装了什么版本、入口在哪、什么时候装的（"指针"）
//   <serverId>/<version>-<rand>/…      解包后的包内容（入口 = installed.json.entryPath）
//   <serverId>/.staging-<rand>/        下载与解包的临时区，成功或失败都会被清掉
//
// 原子性（顺序不能反）：只往 .staging 里写 → 解包结果 rename 成**唯一名字**的版本目录 →
// 元数据先写 .tmp 再 rename 覆盖（这一步才算"提交"）→ 最后才删旧的版本目录。
// 于是任何一步失败甚至中途断电，installed.json 指向的那份副本都还在、并且是完整的；
// 换指针之前绝不先删旧目录——那样一旦后面失败，用户就一份能用的都没有了。
//
// 安全边界（每条都有测试）：
// 1. 地址白名单：只下清单里写死的 URL，不接受渲染端传地址；
// 2. 哈希钉死：对不上就整包丢弃，且**不**换镜像重试（那意味着拿到的字节不对）；
// 3. 解包拒绝符号链接/硬链接：我们只要普通文件，链接是给"越出目录"留的口子；
// 4. 版本、入口都来自清单，路径全程用 path.join 拼、不接受任何外部路径片段；
// 5. 体积上限（distBytes）：哈希校验要等整包落盘，镜像吐无底洞时那道闸来得太晚，所以边下边卡。

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as tar from "tar";
import { MANAGED_SERVER_PACKAGES, type ManagedServerPackage } from "./managed-servers";

const METADATA_FILE = "installed.json";

export type LspInstallPhase = "download" | "extract";

export interface LspInstallProgress {
  serverId: string;
  phase: LspInstallPhase;
  receivedBytes: number;
  /** 服务端没给 Content-Length 时为 0，界面按"不确定进度"展示 */
  totalBytes: number;
}

export interface InstalledServerInfo {
  serverId: string;
  version: string;
  /** 入口绝对路径（可直接交给 node 跑） */
  entryPath: string;
  args: string[];
  installedAt: string;
}

/** 用户在下载途中点了"取消"——不是失败，界面不该报错 */
export class LspInstallCancelledError extends Error {
  constructor() {
    super("已取消下载");
    this.name = "LspInstallCancelledError";
  }
}

export interface DownloadInput {
  url: string;
  destPath: string;
  signal: AbortSignal;
  onBytes: (receivedBytes: number, totalBytes: number) => void;
  /** 压缩包体积上限（清单里钉死的 distBytes）：超过就立刻中止，别等哈希校验才拦 */
  maxBytes: number;
}

export interface ExtractInput {
  file: string;
  cwd: string;
  stripComponents: number;
}

export type DownloadFn = (input: DownloadInput) => Promise<void>;
export type ExtractFn = (input: ExtractInput) => Promise<void>;

export interface LspServerInstallerOptions {
  /** 托管根目录；正式运行传 userData/lsp-servers */
  rootDir: string;
  packages?: readonly ManagedServerPackage[];
  onProgress?: (progress: LspInstallProgress) => void;
  /** 测试注入点：默认走 fetch + node-tar */
  download?: DownloadFn;
  extract?: ExtractFn;
}

/**
 * 默认下载实现：走全局 fetch（与 music 的缓存下载同一套写法），边下边报进度。
 * 不用 Electron 的 net 模块是为了能注入替换、单测里跑得动。
 *
 * 体积上限是**硬闸**：哈希校验要等整个包落盘，镜像变成无底洞时那道闸来得太晚
 * （用户的盘先被写满）。所以 Content-Length 超标就直接不接，流式过程中一超标就断。
 */
const defaultDownload: DownloadFn = async ({ url, destPath, signal, onBytes, maxBytes }) => {
  const response = await fetch(url, { signal, redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
  const totalBytes = Number(response.headers.get("content-length") ?? "") || 0;
  if (totalBytes > maxBytes) {
    await response.body.cancel().catch(() => undefined);
    throw new Error(`安装包体积超过上限（服务端称 ${totalBytes} 字节 > ${maxBytes} 字节），已中止下载`);
  }
  let receivedBytes = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      receivedBytes += chunk.length;
      if (receivedBytes > maxBytes) {
        callback(new Error(`安装包体积超过上限（已收 ${receivedBytes} 字节 > ${maxBytes} 字节），已中止下载`));
        return;
      }
      onBytes(receivedBytes, totalBytes);
      callback(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(response.body as never), counter, fs.createWriteStream(destPath));
};

/** 默认解包实现：拒绝链接条目（见文件头的安全边界第 3 条） */
const defaultExtract: ExtractFn = async ({ file, cwd, stripComponents }) => {
  await tar.x({
    file,
    cwd,
    strip: stripComponents,
    strict: true,
    preservePaths: false,
    filter: (_entryPath, entry) => {
      // node-tar 把 entry 标成 Stats | ReadEntry，只有 ReadEntry 带 type；这里按需取一次
      const type = (entry as { type?: string }).type;
      if (type === "SymbolicLink" || type === "Link") {
        throw new Error(`安装包里有链接条目（${type}），出于安全考虑拒绝解包`);
      }
      return true;
    },
  });
};

export class LspServerInstaller {
  private readonly rootDir: string;
  private readonly packages: readonly ManagedServerPackage[];
  private readonly onProgress: (progress: LspInstallProgress) => void;
  private readonly download: DownloadFn;
  private readonly extract: ExtractFn;
  /** 同一服务的并发安装请求收敛成一次（用户连点两下不该下两份） */
  private readonly inFlight = new Map<string, Promise<InstalledServerInfo>>();
  private readonly aborts = new Map<string, AbortController>();
  /**
   * 已安装入口的缓存：`installedEntry` 站在语言服务解析的热路径上（每次补全请求都会问一次），
   * 每次都读盘 + stat 太浪费。装完/装失败时由这里自己失效，值只在进程内有效。
   */
  private readonly entryCache = new Map<string, string | null>();

  constructor(options: LspServerInstallerOptions) {
    this.rootDir = options.rootDir;
    this.packages = options.packages ?? MANAGED_SERVER_PACKAGES;
    this.onProgress = options.onProgress ?? (() => undefined);
    this.download = options.download ?? defaultDownload;
    this.extract = options.extract ?? defaultExtract;
  }

  /** 这个服务能不能应用内安装（清单里没有 = 只能用户自己装到 PATH） */
  getPackage(serverId: string): ManagedServerPackage | null {
    return this.packages.find((item) => item.serverId === serverId) ?? null;
  }

  /**
   * 已安装副本的入口绝对路径；没装（或文件被删了）返回 null。
   * 语言服务解析层用它决定"有没有托管副本可用"，所以这里必须真去磁盘上确认入口还在。
   */
  installedEntry(serverId: string): string | null {
    const cached = this.entryCache.get(serverId);
    if (cached !== undefined) return cached;
    const info = this.readInstalled(serverId);
    const entry = info && fs.existsSync(info.entryPath) ? info.entryPath : null;
    this.entryCache.set(serverId, entry);
    return entry;
  }

  /** 正在装的话界面要显示进度 而不是再给你一个按钮 */
  isInstalling(serverId: string): boolean {
    return this.inFlight.has(serverId);
  }

  install(serverId: string): Promise<InstalledServerInfo> {
    const running = this.inFlight.get(serverId);
    if (running) return running;
    const pkg = this.getPackage(serverId);
    if (!pkg) return Promise.reject(new Error(`这个语言服务不支持应用内安装：${serverId}`));
    const controller = new AbortController();
    const task = this.runInstall(pkg, controller.signal).finally(() => {
      this.inFlight.delete(serverId);
      this.aborts.delete(serverId);
    });
    this.inFlight.set(serverId, task);
    this.aborts.set(serverId, controller);
    return task;
  }

  /** 取消下载中/解包中的安装；返回 false 表示当前没有这个服务的安装在进行 */
  cancel(serverId: string): boolean {
    const controller = this.aborts.get(serverId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  /**
   * 版本目录名。后缀是刻意的：同一版本重装两次也要拿到两个不同的名字，
   * 否则"新的先落位、再换指针、最后删旧的"这套顺序根本排不出来（固定名字只能先删后摆）。
   */
  private versionDir(serverId: string, version: string, suffix: string): string {
    return path.join(this.rootDir, serverId, `${version}-${suffix}`);
  }

  private readInstalled(serverId: string): InstalledServerInfo | null {
    try {
      const raw = fs.readFileSync(path.join(this.rootDir, serverId, METADATA_FILE), "utf8");
      const parsed = JSON.parse(raw) as Partial<InstalledServerInfo>;
      if (typeof parsed.entryPath !== "string" || !parsed.entryPath) return null;
      return {
        serverId,
        version: typeof parsed.version === "string" ? parsed.version : "",
        entryPath: parsed.entryPath,
        args: Array.isArray(parsed.args) ? parsed.args.filter((arg): arg is string => typeof arg === "string") : [],
        installedAt: typeof parsed.installedAt === "string" ? parsed.installedAt : "",
      };
    } catch {
      return null;
    }
  }

  private async runInstall(pkg: ManagedServerPackage, signal: AbortSignal): Promise<InstalledServerInfo> {
    const serverDir = path.join(this.rootDir, pkg.serverId);
    const staging = path.join(serverDir, `.staging-${process.pid.toString(36)}-${Date.now().toString(36)}`);
    const tarball = path.join(staging, "package.tgz");
    const unpacked = path.join(staging, "unpacked");
    await fsp.mkdir(unpacked, { recursive: true });
    try {
      await this.downloadFromMirrors(pkg, tarball, signal);
      throwIfAborted(signal);
      await verifyIntegrity(tarball, pkg.integrity);
      this.onProgress({ serverId: pkg.serverId, phase: "extract", receivedBytes: 0, totalBytes: 0 });
      await this.extract({ file: tarball, cwd: unpacked, stripComponents: pkg.stripComponents });
      throwIfAborted(signal);

      const entryRelative = pkg.entry.split("/").filter(Boolean).join(path.sep);
      if (!fs.existsSync(path.join(unpacked, entryRelative))) {
        throw new Error(`安装包结构不对：解包后找不到入口 ${pkg.entry}`);
      }
      // 压缩包不再需要：留着等于把同一份内容在盘上存两遍
      await fsp.rm(tarball, { force: true });
      // 新副本先落到**唯一名字**的目录里：不重名才能让新旧两份同时存在，
      // 也才谈得上"指针没换成功之前旧的那份一直可用"（见 commitMetadata 的注释）
      const suffix = randomSuffix();
      const versionDir = this.versionDir(pkg.serverId, pkg.version, suffix);
      await fsp.rename(unpacked, versionDir);

      const info: InstalledServerInfo = {
        serverId: pkg.serverId,
        version: pkg.version,
        entryPath: path.join(versionDir, entryRelative),
        args: [...pkg.args],
        installedAt: new Date().toISOString(),
      };
      try {
        await this.commitMetadata(serverDir, suffix, info);
      } catch (error) {
        // 指针没换过去：这份新副本没人指向它，留着只是垃圾（旧副本和旧元数据都原样还在）
        await fsp.rm(versionDir, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
      // 指针换好之后，旧版本目录才可以删——在那之前它一直是"万一失败还能用"的那份
      await this.pruneOtherVersions(serverDir, path.basename(versionDir));
      // 装完立刻让解析层看得见（否则要等下次冷启动才用得上）
      this.entryCache.set(pkg.serverId, info.entryPath);
      return info;
    } finally {
      // 成功时 staging 里只剩空壳；失败时这里是唯一需要清理的地方。
      // 顺手让入口缓存失效：重装可能已经把旧的版本目录删掉了，缓存里那条路径未必还有效。
      this.entryCache.delete(pkg.serverId);
      await fsp.rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /**
   * 元数据先写临时文件、再原子替换成正式文件。
   *
   * 这就是"提交换指针"那一步：installed.json 要么整份是旧的、要么整份是新的，
   * 不会出现半截 JSON。它落定之前，磁盘上的旧版本目录一直没动过，所以任何一步失败
   * 用户都还有一份能用的副本——不能反过来（先删旧的再写新的），那样中途断掉就什么都用不了了。
   */
  private async commitMetadata(serverDir: string, suffix: string, info: InstalledServerInfo): Promise<void> {
    const target = path.join(serverDir, METADATA_FILE);
    const temp = path.join(serverDir, `${METADATA_FILE}.${suffix}.tmp`);
    try {
      await fsp.writeFile(temp, JSON.stringify(info, null, 2), "utf8");
      await fsp.rename(temp, target);
    } catch (error) {
      await fsp.rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  /** 删掉这次安装之外的版本目录。删不掉也不影响可用性，只是多占点空间，所以失败就忽略 */
  private async pruneOtherVersions(serverDir: string, keepName: string): Promise<void> {
    const names = await fsp.readdir(serverDir).catch(() => [] as string[]);
    for (const name of names) {
      if (name === keepName || name.startsWith(".staging") || name.startsWith(METADATA_FILE)) continue;
      await fsp.rm(path.join(serverDir, name), { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async downloadFromMirrors(pkg: ManagedServerPackage, destPath: string, signal: AbortSignal): Promise<void> {
    let lastError: unknown;
    for (const url of pkg.urls) {
      throwIfAborted(signal);
      try {
        await this.download({
          url,
          destPath,
          signal,
          maxBytes: pkg.distBytes,
          onBytes: (receivedBytes, totalBytes) =>
            this.onProgress({ serverId: pkg.serverId, phase: "download", receivedBytes, totalBytes }),
        });
        return;
      } catch (error) {
        if (signal.aborted) throw new LspInstallCancelledError();
        lastError = error;
        await fsp.rm(destPath, { force: true }).catch(() => undefined);
      }
    }
    throw new Error(`下载失败（已尝试 ${pkg.urls.length} 个地址）：${messageOf(lastError)}`);
  }
}

export function createLspServerInstaller(options: LspServerInstallerOptions): LspServerInstaller {
  return new LspServerInstaller(options);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 版本目录/临时文件名的后缀：同一版本重装两次也不能撞名 */
function randomSuffix(): string {
  return randomBytes(4).toString("hex");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new LspInstallCancelledError();
}

/**
 * 校验下载物与清单里的 `sha512-<base64>` 一致。
 * 对不上就是"字节不对"——可能是下载被截断，也可能是中间人换了包，两种都不该继续。
 */
export async function verifyIntegrity(filePath: string, integrity: string): Promise<void> {
  const separator = integrity.indexOf("-");
  if (separator <= 0) throw new Error(`清单里的 integrity 格式不对：${integrity}`);
  const algorithm = integrity.slice(0, separator);
  const expected = integrity.slice(separator + 1);
  const hash = createHash(algorithm);
  await pipeline(fs.createReadStream(filePath), hash);
  const actual = hash.digest("base64");
  if (actual !== expected) {
    throw new Error("下载到的语言服务与清单里的哈希不一致，已丢弃（下载不完整或被篡改）");
  }
}
