import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  MessageFileLinkContext,
  linkifyFilePaths,
  linkifyNode,
  parseMessageFilePath,
} from "./message-file-link";

describe("parseMessageFilePath", () => {
  it("认得常见的相对路径与绝对路径", () => {
    expect(parseMessageFilePath("src/main/foo.ts")).toEqual({ path: "src/main/foo.ts" });
    expect(parseMessageFilePath("./src/a.tsx")).toEqual({ path: "./src/a.tsx" });
    expect(parseMessageFilePath("README.md")).toEqual({ path: "README.md" });
    expect(parseMessageFilePath("D:\\proj\\src\\a.ts")).toEqual({ path: "D:\\proj\\src\\a.ts" });
    expect(parseMessageFilePath("/home/x/a.py")).toEqual({ path: "/home/x/a.py" });
  });

  it("行号两种写法都收：path:42 与 path:42:10（取行号）", () => {
    expect(parseMessageFilePath("src/a.ts:42")).toEqual({ path: "src/a.ts", line: 42 });
    expect(parseMessageFilePath("src/a.ts:42:10")).toEqual({ path: "src/a.ts", line: 42 });
    // 行号必须在末尾，中间的冒号属于路径本身（如盘符）
    expect(parseMessageFilePath("D:\\a.ts")).toEqual({ path: "D:\\a.ts" });
  });

  it("不像文件路径的一律拒绝（宁可漏，不可错标）", () => {
    expect(parseMessageFilePath("https://example.com/a.ts")).toBeNull(); // URL 归锚点管
    expect(parseMessageFilePath("user.name")).toBeNull(); // 扩展名不在白名单
    expect(parseMessageFilePath("v1.2.3")).toBeNull();
    expect(parseMessageFilePath("src/app")).toBeNull(); // 无扩展名
    expect(parseMessageFilePath(".env")).toBeNull(); // 点开头的隐藏文件太易误判
    expect(parseMessageFilePath("src/")).toBeNull();
    expect(parseMessageFilePath("42")).toBeNull();
    expect(parseMessageFilePath("   ")).toBeNull();
    expect(parseMessageFilePath("src/a.ts:0")).toBeNull(); // 行号从 1 起
  });

  it("裸文本里带空格的不是路径；行内代码（边界明确）才放行空格", () => {
    expect(parseMessageFilePath("src/my file.ts")).toBeNull();
    expect(parseMessageFilePath("src/my file.ts", { allowSpaces: true })).toEqual({ path: "src/my file.ts" });
  });

  it("剥掉连着写的包裹字符与句末标点", () => {
    expect(parseMessageFilePath("(src/a.ts)")).toEqual({ path: "src/a.ts" });
    expect(parseMessageFilePath("`src/a.ts`")).toEqual({ path: "src/a.ts" });
    expect(parseMessageFilePath("src/a.ts.")).toEqual({ path: "src/a.ts" });
    expect(parseMessageFilePath("\"src/a.ts\",")).toEqual({ path: "src/a.ts" });
  });
});

describe("linkifyFilePaths", () => {
  it("只替换完整的路径 token，句子其余部分原样", () => {
    const nodes = linkifyFilePaths("我改了 src/a.ts:12 和 README.md，其它没动");
    const html = renderToStaticMarkup(
      React.createElement(MessageFileLinkContext.Provider, { value: () => {} }, React.createElement("p", null, ...nodes)),
    );

    expect(html).toContain("我改了 ");
    expect(html).toContain("其它没动");
    // 两个路径各成为一个可点元素，且显示的是原文（含行号）
    const links = html.match(/class="cy-file-link"/g) ?? [];
    expect(links).toHaveLength(2);
    expect(html).toContain("src/a.ts:12");
    expect(html).toContain("README.md");
  });

  it("没有可替换内容时原样返回，不制造多余节点", () => {
    expect(linkifyFilePaths("今天天气不错")).toEqual(["今天天气不错"]);
    expect(linkifyFilePaths("看看 user.name 这个字段")).toEqual(["看看 user.name 这个字段"]);
  });

  it("没有提供方（主聊天页）时退化成纯文本，不出现可点元素", () => {
    const nodes = linkifyFilePaths("改了 src/a.ts");
    const html = renderToStaticMarkup(React.createElement("p", null, ...nodes));
    expect(html).not.toContain("cy-file-link");
    expect(html).toContain("src/a.ts");
  });

  it("有提供方时点击回调拿到解析后的路径与行号", () => {
    const onOpen = vi.fn();
    const nodes = linkifyFilePaths("改了 src/a.ts:12");
    const html = renderToStaticMarkup(
      React.createElement(MessageFileLinkContext.Provider, { value: onOpen }, React.createElement("p", null, ...nodes)),
    );
    expect(html).toContain("cy-file-link");
    expect(parseMessageFilePath("src/a.ts:12")).toEqual({ path: "src/a.ts", line: 12 });
  });
});

describe("linkifyNode", () => {
  it("字符串切分、数组逐个处理、其它元素原样透传（不动代码块与加粗内部）", () => {
    expect(linkifyNode(undefined)).toBeUndefined();
    expect(linkifyNode(42)).toBe(42);

    const element = React.createElement("code", null, "src/a.ts");
    expect(linkifyNode(element)).toBe(element); // 同一个引用，说明没被改写

    const rendered = linkifyNode(["看 src/a.ts", React.createElement("strong", { key: "s" }, "重点")]);
    const html = renderToStaticMarkup(React.createElement("p", null, ...(rendered as React.ReactNode[])));
    expect(html).toContain("src/a.ts");
    expect(html).toContain("<strong>重点</strong>");
  });
});
