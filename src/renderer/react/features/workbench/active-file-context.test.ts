import { describe, expect, it } from "vitest";
import {
  MAX_ACTIVE_FILE_CHARS,
  buildActiveFileContext,
} from "./active-file-context";

describe("buildActiveFileContext（工作台当前文件 → 模型上下文）", () => {
  it("没有打开文件时返回 null", () => {
    expect(buildActiveFileContext({ relativePath: "", content: "", dirty: false })).toBeNull();
    expect(buildActiveFileContext({ relativePath: "   ", content: "", dirty: false })).toBeNull();
  });

  it("已保存且无选区：只给路径，不注入内容（省 token）", () => {
    const context = buildActiveFileContext({
      relativePath: "src/main/foo.ts",
      content: "console.log(1)\n",
      dirty: false,
    });
    expect(context?.name).toBe("src/main/foo.ts");
    expect(context?.text).toContain("src/main/foo.ts");
    expect(context?.text).toContain("已保存");
    // 关键：内容不注入，交给模型按需自行读取
    expect(context?.text).not.toContain("console.log(1)");
  });

  it("有未保存改动：必须注入缓冲区内容（磁盘是旧的，模型自读会读到错内容）", () => {
    const context = buildActiveFileContext({
      relativePath: "src/a.ts",
      content: "const edited = true;",
      dirty: true,
    });
    expect(context?.text).toContain("未保存");
    expect(context?.text).toContain("与磁盘不一致");
    expect(context?.text).toContain("const edited = true;");
  });

  it("有选区：带上行范围与选中内容", () => {
    const context = buildActiveFileContext({
      relativePath: "src/b.ts",
      content: "line1\nline2\nline3\n",
      dirty: false,
      selection: { startLine: 2, endLine: 3, text: "line2\nline3" },
    });
    expect(context?.text).toContain("第 2-3 行");
    expect(context?.text).toContain("line2\nline3");
  });

  it("空白选区等同于没有选区", () => {
    const context = buildActiveFileContext({
      relativePath: "src/c.ts",
      content: "x",
      dirty: false,
      selection: { startLine: 1, endLine: 1, text: "   \n  " },
    });
    expect(context?.text).not.toContain("选中");
  });

  it("二进制或被截断的文件：只给路径，不注入不可信内容", () => {
    const context = buildActiveFileContext({
      relativePath: "assets/logo.png",
      content: "binary-ish",
      dirty: true,
      readOnly: true,
    });
    expect(context?.text).toContain("二进制或过大文件");
    expect(context?.text).not.toContain("binary-ish");
  });

  it("文件尚在加载或读取失败：不声称已保存，也不注入空内容", () => {
    const context = buildActiveFileContext({
      relativePath: "src/loading.ts",
      content: "",
      dirty: false,
      pending: true,
    });
    expect(context?.text).toContain("尚未加载完成");
    // 关键：不能对模型谎称"磁盘与编辑器一致"
    expect(context?.text).not.toContain("已保存");
  });

  it("工作区外的文件：路径标注为绝对路径，不让模型按相对路径理解", () => {
    const context = buildActiveFileContext({
      relativePath: "C:/Users/me/AppData/Roaming/live2d-cyrene/cyrene-chats/index.json",
      content: "[]",
      dirty: false,
      outsideWorkspace: true,
    });
    expect(context?.text).toContain("工作区外，绝对路径");
    expect(context?.text).not.toContain("相对工作区根");
  });

  it("超长内容截断到上限并给出提示", () => {
    const context = buildActiveFileContext({
      relativePath: "src/huge.ts",
      content: "x".repeat(MAX_ACTIVE_FILE_CHARS * 2),
      dirty: true,
    });
    expect(context!.text.length).toBeLessThanOrEqual(MAX_ACTIVE_FILE_CHARS + 120);
    expect(context?.text).toContain("已截断");
  });
});
