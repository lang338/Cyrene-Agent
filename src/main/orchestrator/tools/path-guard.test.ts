import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceBoundaryError, assertWritableInsideWorkspace } from "./path-guard";

const roots: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-path-guard-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // 清理失败不影响结论
    }
  }
});

describe("写入路径的工作区边界", () => {
  it("工作区内的路径放行，尚不存在的新文件也放行", () => {
    const root = makeRoot();
    const existing = path.join(root, "src", "a.ts");
    fs.mkdirSync(path.dirname(existing), { recursive: true });
    fs.writeFileSync(existing, "export {};\n", "utf8");

    expect(() => assertWritableInsideWorkspace(existing, root)).not.toThrow();
    // 新建文件时 target 还不存在：要对最近的已存在祖先取 realpath，不能因此误拒
    expect(() => assertWritableInsideWorkspace(path.join(root, "src", "new.ts"), root)).not.toThrow();
    // 工作区根本身也算在界内
    expect(() => assertWritableInsideWorkspace(root, root)).not.toThrow();
  });

  it("越界路径与未绑定工作区一律拒绝", () => {
    const root = makeRoot();
    const outside = path.join(makeRoot(), "other.ts");

    expect(() => assertWritableInsideWorkspace(outside, root)).toThrow(WorkspaceBoundaryError);
    expect(() => assertWritableInsideWorkspace(path.join(root, "..", "evil.ts"), root)).toThrow(WorkspaceBoundaryError);
    // 既没绑工作区、调用方也没给兜底根：拒绝（没有可写范围，不能放行）
    expect(() => assertWritableInsideWorkspace(path.join(root, "a.ts"), undefined)).toThrow(WorkspaceBoundaryError);
    expect(() => assertWritableInsideWorkspace(path.join(root, "a.ts"), "   ")).toThrow(WorkspaceBoundaryError);
  });

  it("未绑工作区时退回兜底根（桌面）：界内放行，界外仍拒绝", () => {
    const desktop = makeRoot();
    // learn 模式记笔记：没绑工作区，相对文件名由调用方解析到桌面下
    expect(() => assertWritableInsideWorkspace(path.join(desktop, "笔记.md"), undefined, desktop)).not.toThrow();

    // 放宽的是范围而不是取消边界：桌面之外的绝对路径照样拦下
    expect(() => assertWritableInsideWorkspace(path.join(makeRoot(), "elsewhere.ts"), undefined, desktop))
      .toThrow(WorkspaceBoundaryError);

    // 绑了工作区时以工作区为准，兜底根不参与判定
    expect(() => assertWritableInsideWorkspace(path.join(desktop, "a.ts"), makeRoot(), desktop))
      .toThrow(WorkspaceBoundaryError);
  });

  it("工作区内指向外部的符号链接会被 realpath 识破", () => {
    const root = makeRoot();
    const victim = makeRoot();
    const link = path.join(root, "link");
    try {
      // Windows 下用 junction 免管理员权限；其他平台走普通目录链接
      fs.symlinkSync(victim, link, process.platform === "win32" ? "junction" : "dir");
    } catch {
      return; // 环境不支持符号链接时跳过，不伪装成通过
    }

    expect(() => assertWritableInsideWorkspace(path.join(link, "escaped.ts"), root)).toThrow(WorkspaceBoundaryError);
  });

  it("符号链接下面挂一长串不存在的子目录也要拒绝（解析层数不设上限、也绝不退回词法路径）", () => {
    const root = makeRoot();
    const victim = makeRoot();
    const link = path.join(root, "link");
    try {
      fs.symlinkSync(victim, link, process.platform === "win32" ? "junction" : "dir");
    } catch {
      return; // 环境不支持符号链接时跳过，不伪装成通过
    }

    // 80 层：旧实现的上限是 64 层，一到上限就退回词法路径 → 这条会被误判成"界内"而放行
    const deep = path.join(link, ...Array.from({ length: 80 }, (_, index) => `d${index}`), "escaped.ts");
    expect(() => assertWritableInsideWorkspace(deep, root)).toThrow(WorkspaceBoundaryError);

    // 同样深度但落在工作区内（不经过符号链接）仍然要放行，别把上限一去掉就误伤
    const deepInside = path.join(root, ...Array.from({ length: 80 }, (_, index) => `d${index}`), "ok.ts");
    expect(() => assertWritableInsideWorkspace(deepInside, root)).not.toThrow();
  });
});
