import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildRecommendedTsconfig, findProjectConfig } from "./project-config";

const roots: string[] = [];

function makeTree(...entries: string[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-project-config-"));
  roots.push(root);
  for (const entry of entries) {
    const target = path.join(root, entry);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entry.endsWith(".json") ? "{}" : "", "utf8");
  }
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("findProjectConfig", () => {
  it("向上找到 tsconfig.json，并把它所在目录当项目根", () => {
    const workspace = makeTree("pkg/package.json", "pkg/tsconfig.json", "pkg/src/a.ts");
    const found = findProjectConfig(path.join(workspace, "pkg/src"), workspace);
    expect(found.configFile).toBe(path.join(workspace, "pkg/tsconfig.json"));
    expect(found.projectRoot).toBe(path.join(workspace, "pkg"));
  });

  it("jsconfig.json 同样算配置（JS 项目用它）", () => {
    const workspace = makeTree("jsconfig.json", "src/a.ts");
    const found = findProjectConfig(path.join(workspace, "src"), workspace);
    expect(found.configFile).toBe(path.join(workspace, "jsconfig.json"));
  });

  it("都没有时：项目根取最近的带 package.json 的祖先目录", () => {
    const workspace = makeTree("pkg/package.json", "pkg/src/a.ts");
    const found = findProjectConfig(path.join(workspace, "pkg/src"), workspace);
    expect(found.configFile).toBeNull();
    expect(found.projectRoot).toBe(path.join(workspace, "pkg"));
  });

  it("连 package.json 都没有时：项目根退回工作区根", () => {
    const workspace = makeTree("src/a.ts");
    const found = findProjectConfig(path.join(workspace, "src"), workspace);
    expect(found.configFile).toBeNull();
    expect(found.projectRoot).toBe(workspace);
  });

  it("绝不越过工作区根去找配置：工作区外有 tsconfig 也不认", () => {
    const outer = makeTree("tsconfig.json", "workspace/src/a.ts");
    const workspace = path.join(outer, "workspace");
    const found = findProjectConfig(path.join(workspace, "src"), workspace);
    expect(found.configFile).toBeNull();
    expect(found.projectRoot).toBe(workspace);
  });

  it("工作区里的符号链接指向外面时不去扫（词法看着还在工作区里）", () => {
    const outside = makeTree("tsconfig.json", "src/a.ts");
    const workspace = makeTree("src/a.ts");
    const link = path.join(workspace, "link");
    try {
      // junction 在 Windows 上不需要管理员权限；其它平台就是普通目录符号链接
      fs.symlinkSync(outside, link, "junction");
    } catch {
      return; // 建不出链接的环境（权限受限）跳过这条
    }
    const found = findProjectConfig(path.join(link, "src"), workspace);
    expect(found.configFile).toBeNull();
    expect(found.projectRoot).toBe(workspace);
  });

  it("符号链接下面还接着不存在的子目录时也不放行（realpath 失败不能退回词法路径）", () => {
    const outside = makeTree("tsconfig.json", "src/a.ts");
    const workspace = makeTree("src/a.ts");
    const link = path.join(workspace, "link");
    try {
      fs.symlinkSync(outside, link, "junction");
    } catch {
      return; // 建不出链接的环境（权限受限）跳过这条
    }
    // 关键在 missing：整条路径 realpath 不出来，一退回词法路径就会被当成"在工作区里"，
    // 紧接着的 statSync 却会顺着 link 读到工作区外的 tsconfig.json
    const found = findProjectConfig(path.join(link, "missing"), workspace);
    expect(found.configFile).toBeNull();
    expect(found.projectRoot).toBe(workspace);
  });
});

describe("buildRecommendedTsconfig", () => {
  it("是一份宽松配置：够解析依赖与 JSX，但不用 strict 去卡用户", () => {
    const text = buildRecommendedTsconfig();
    expect(() => JSON.parse(text)).not.toThrow();
    expect(text).toContain('"moduleResolution": "bundler"');
    expect(text).toContain('"jsx": "react-jsx"');
    expect(text).not.toContain('"strict": true');
  });
});
