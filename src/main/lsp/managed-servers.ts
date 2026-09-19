// 应用内可"一键下载"的语言服务清单（冻结版）。
//
// 为什么要有这份清单，而不是运行时去问 npm "最新版是多少"：
// 语言服务是我们替用户装到本机、并且随后要**当子进程跑起来**的东西，等于是把一串
// 陌生人给的代码请进屋。所以版本必须是我们实测过的**白名单**，哈希必须**钉死**在代码里——
// 远程"取最新版"意味着任何一次上游发版都会直接改变用户机器上被执行的内容。
//
// 与 catalog 的分工：
// - `server-catalog.ts` 管"这个扩展名该用哪台服务、怎么启动、没装时提示什么"；
// - 这里管"那台服务可以从哪下、下的必须是什么字节、下完怎么跑起来"。
// 两边用 `serverId` 对齐，`managed-servers.test.ts` 会校验 id 在 catalog 里真实存在。
//
// 只收**零前置运行时**的包：pyright 是纯 JS（自包含，本机没有 Python 也能做类型分析），
// 下完重启服务即可用。gopls / rust-analyzer 这类原生二进制要按平台选资产（M2），
// jdtls / OmniSharp 还要 JDK / .NET（不做托管，只保留 PATH 检测）。

export interface ManagedServerPackage {
  /** 对应 server-catalog.ts 里的服务 id */
  serverId: string;
  /** npm 包名（仅用于展示与报错信息） */
  packageName: string;
  /** 钉死的版本；升级必须先在本机跑通再改这里 */
  version: string;
  /** npm 分发的 sha512 integrity（形如 `sha512-...`），下载后必须逐字节对上 */
  integrity: string;
  /**
   * 下载地址（按顺序尝试）。
   * 第一个是国内镜像（同一份 tarball，只是 CDN 不同），最后兜官方 registry。
   * 校验失败**不会**继续试下一个地址——那意味着拿到的字节不对，属于要立刻停下来的事。
   */
  urls: readonly string[];
  /** npm tarball 都套了一层 `package/`，解包时剥掉 */
  stripComponents: number;
  /** 相对解包根的启动入口（交给 node 跑；见 client.ts 的 resolveLaunchTarget） */
  entry: string;
  /** 语言服务启动参数（与 catalog 里那条保持一致） */
  args: readonly string[];
  /** 安装后占用空间（字节，取自 npm 的 unpackedSize）；用于按钮上"约 xx MB" */
  installBytes: number;
  /**
   * 要下载的 tarball 的**压缩后**字节数（取自 registry 的 Content-Length）。
   * 下载时按它硬卡上限：镜像被换掉/挂掉时可能吐一个无底洞般的响应，
   * 光等哈希校验来不及——那要等整个响应体落盘。注意别拿 installBytes 当上限，那是解包后的大小。
   */
  distBytes: number;
}

export const MANAGED_SERVER_PACKAGES: readonly ManagedServerPackage[] = [
  {
    serverId: "python-pyright",
    packageName: "pyright",
    version: "1.1.414",
    integrity: "sha512-FPZZb51jepDX4eP7TEYDeNFtmE3WgwkkEcJpvH3/QmUSsj0EAy3LXu+xB4T/FWDejtsXlCfFr/rbWFjwuwuXww==",
    urls: [
      "https://registry.npmmirror.com/pyright/-/pyright-1.1.414.tgz",
      "https://registry.npmjs.org/pyright/-/pyright-1.1.414.tgz",
    ],
    stripComponents: 1,
    entry: "langserver.index.js",
    args: ["--stdio"],
    // npm 报的 unpackedSize（19.45 MB），解包后 5400+ 个文件
    installBytes: 19_457_120,
    // tarball 本体（npmmirror 与 npmjs 是同一份字节，故两边同一个上限）
    distBytes: 4_226_827,
  },
];

export function findManagedPackage(serverId: string): ManagedServerPackage | null {
  return MANAGED_SERVER_PACKAGES.find((item) => item.serverId === serverId) ?? null;
}
