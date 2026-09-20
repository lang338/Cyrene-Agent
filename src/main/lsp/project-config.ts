import fs from "node:fs";
import path from "node:path";

/**
 * 找"当前文件属于哪个 TS 项目"。
 *
 * 语言服务靠 `tsconfig.json` / `jsconfig.json` 判断项目归属：从文件所在目录一层层往上找，
 * 找到就把这文件当项目成员（依赖、路径别名、JSX 设置全部按项目来），找不到就退回"散客"模式——
 * 依赖类型大多解析不出来，语义能力只剩"作用域 + 全局"那一级。
 *
 * 工作台需要这个信息做两件事：
 * 1. **说明原因**：找不到配置时把原因摆出来，别让用户以为"补全做得很烂"；
 * 2. **一键配置**：找不到时给一个"生成推荐配置"的动作，写到项目根。
 *
 * ⚠️ 只在**工作区内**往上找：越过工作区根去读用户别的目录，既没道理也没授权。
 * 而且按**真实路径**判（工作区里的符号链接完全可能指着外面，词法路径看不出来）。
 */

const PROJECT_CONFIG_FILENAMES = ["tsconfig.json", "jsconfig.json"];

export interface ProjectConfigLookup {
  /** 找到的配置文件绝对路径；没有则为 null */
  configFile: string | null;
  /** 建议写入配置的位置：最近的带 package.json 的祖先目录，都没有就用工作区根 */
  projectRoot: string;
}

export function findProjectConfig(startDir: string, workspaceRoot: string): ProjectConfigLookup {
  const stop = canonicalize(path.resolve(workspaceRoot));
  const start = canonicalize(path.resolve(startDir));
  // 词法检查看不出"工作区里的符号链接指到外面"：/ws/link -> /elsewhere 时
  // 路径看着还在 /ws 里，实际每次 statSync 都在戳外面的目录。所以按**真实路径**
  // 再判一次——扫描本身是只读的，但也没理由越过用户交给我们的那棵树。
  if (!isInsideWorkspace(start, stop)) {
    return { configFile: null, projectRoot: stop };
  }
  let current = start;
  let packageRoot: string | null = null;

  for (;;) {
    for (const name of PROJECT_CONFIG_FILENAMES) {
      const candidate = path.join(current, name);
      if (isFile(candidate)) {
        return { configFile: candidate, projectRoot: current };
      }
    }
    if (!packageRoot && isFile(path.join(current, "package.json"))) {
      packageRoot = current;
    }
    if (current === stop) break;
    const parent = path.dirname(current);
    // 到头了，或者再往上就出了工作区：停下，绝不越界
    if (parent === current || !isInsideWorkspace(parent, stop)) break;
    current = parent;
  }

  return { configFile: null, projectRoot: packageRoot ?? stop };
}

/** 目录是否落在工作区内（含工作区根本身） */
function isInsideWorkspace(dir: string, workspaceRoot: string): boolean {
  const relative = path.relative(workspaceRoot, dir);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * 取真实路径（解掉符号链接）。
 *
 * ⚠️ 传进来的路径**可能还不存在**（刚被删掉、或指向一个不存在的子目录），这时不能直接
 * 退回词法路径：`link/missing`（link 是工作区里指向外面的软链、missing 不存在）在词法上
 * 看着还在工作区里，可紧接着的 `statSync` 会顺着 link 去读工作区外那棵树——越界检查被绕过。
 * 所以往上找**最近的已存在祖先**取真实路径，再把剩下解析不出来的部分拼回去。
 */
function canonicalize(target: string): string {
  let current = target;
  const unresolved: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...unresolved);
    } catch {
      const parent = path.dirname(current);
      // 一路退到根还解析不出来（例如整盘不可访问）：只能退回词法路径
      if (parent === current) return target;
      unresolved.unshift(path.basename(current));
      current = parent;
    }
  }
}

function isFile(target: string): boolean {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

/**
 * 生成一份推荐的项目配置（tsconfig.json）。
 *
 * 刻意选**宽松**设置：目的是让语言服务正确解析项目（依赖、JSX），而不是给用户的项目
 * 引入一堆类型报错——渲染端本来也不做类型检查，拿 strict 去卡他毫无意义。
 *
 * 但它落在项目根上，用户的构建/打包工具**也可能读到**（tsc、vite、vitest 都会去找 tsconfig），
 * 所以不能承诺"不影响构建"：渲染端要如实说明，写入前必须让用户看到内容并确认。
 */
export function buildRecommendedTsconfig(): string {
  return `${JSON.stringify(
    {
      $schema: "https://json.schemastore.org/tsconfig",
      compilerOptions: {
        target: "ES2022",
        lib: ["ES2022", "DOM", "DOM.Iterable"],
        module: "ESNext",
        moduleResolution: "bundler",
        jsx: "react-jsx",
        allowJs: true,
        resolveJsonModule: true,
        isolatedModules: true,
        skipLibCheck: true,
        noEmit: true,
      },
      include: ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx"],
      exclude: ["node_modules", "dist", "build", "out"],
    },
    null,
    2,
  )}\n`;
}
