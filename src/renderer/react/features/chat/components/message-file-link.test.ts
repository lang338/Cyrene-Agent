import { describe, expect, it } from "vitest";
import {
  findMessageFilePaths,
  parseMessageFilePath,
  rewriteBareFilePaths,
  toAbsoluteFilePath,
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

describe("findMessageFilePaths", () => {
  it("只认整段是路径的 token，下标落在剥掉包裹字符之后", () => {
    const text = "我改了 (src/a.ts:12) 和 README.md，其它没动";
    const matches = findMessageFilePaths(text);

    expect(matches).toHaveLength(2);
    // 切出来的正是路径本身（不含括号与句末标点），改写时不会吃掉它们
    expect(text.slice(matches[0].start, matches[0].end)).toBe("src/a.ts:12");
    expect(matches[0].target).toEqual({ path: "src/a.ts", line: 12 });
    expect(text.slice(matches[1].start, matches[1].end)).toBe("README.md");
  });

  it("普通词与点号常见的写法不误标", () => {
    expect(findMessageFilePaths("今天天气不错")).toHaveLength(0);
    expect(findMessageFilePaths("看看 user.name 这个字段")).toHaveLength(0);
    expect(findMessageFilePaths("版本是 v1.2.3")).toHaveLength(0);
  });
});

describe("toAbsoluteFilePath", () => {
  it("绝对路径原样（统一正斜杠），相对路径挂到工作区根下", () => {
    expect(toAbsoluteFilePath("D:\\proj\\a.ts")).toBe("D:/proj/a.ts");
    expect(toAbsoluteFilePath("/home/x/a.py")).toBe("/home/x/a.py");
    expect(toAbsoluteFilePath("src/a.ts", "E:\\ws")).toBe("E:/ws/src/a.ts");
    expect(toAbsoluteFilePath("./src/a.ts", "E:/ws/")).toBe("E:/ws/src/a.ts");
  });

  it("相对路径但不知道工作区根时无法定位", () => {
    expect(toAbsoluteFilePath("src/a.ts")).toBeNull();
    expect(toAbsoluteFilePath("src/a.ts", "")).toBeNull();
  });
});

/** 造一棵最小 hast 树，只包含本模块会改写的形状。 */
function paragraphTree(text: string) {
  return {
    type: "root",
    children: [{ type: "element", tagName: "p", children: [{ type: "text", value: text }] }],
  };
}

type RewrittenNode = {
  type?: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: RewrittenNode[];
};

describe("rewriteBareFilePaths", () => {
  it("把裸写路径包成 file 链接，其余文本原样保留", () => {
    const tree = paragraphTree("我改了 src/a.ts:12，其它没动");
    rewriteBareFilePaths(tree, "E:/ws");

    const children = (tree.children[0] as unknown as RewrittenNode).children ?? [];
    const anchor = children.find((child) => child.tagName === "a");
    expect(anchor).toBeDefined();
    expect(anchor?.properties).toEqual({ href: "file:///E:/ws/src/a.ts#L12" });
    expect(anchor?.children?.[0]?.value).toBe("src/a.ts:12");
    // 前后文本都还在，句子没被切碎
    expect(children.map((child) => child.value ?? "").join("")).toBe("我改了 ，其它没动");
  });

  it("代码块与既有链接里的文本不改写", () => {
    const fenced = {
      type: "root",
      children: [{ type: "element", tagName: "pre", children: [{ type: "element", tagName: "code", children: [{ type: "text", value: "src/a.ts" }] }] }],
    };
    rewriteBareFilePaths(fenced, "E:/ws");
    expect(JSON.stringify(fenced)).not.toContain("href");

    const existingLink = {
      type: "root",
      children: [{ type: "element", tagName: "a", properties: { href: "https://x" }, children: [{ type: "text", value: "src/a.ts" }] }],
    };
    rewriteBareFilePaths(existingLink, "E:/ws");
    expect(JSON.stringify(existingLink)).not.toContain("file:///");
  });

  it("行内代码整段是路径时也变成链接（放行空格）", () => {
    const inline = {
      type: "root",
      children: [{ type: "element", tagName: "p", children: [{ type: "element", tagName: "code", children: [{ type: "text", value: "src/my file.ts" }] }] }],
    };
    rewriteBareFilePaths(inline, "E:/ws");

    const code = ((inline.children[0] as unknown as RewrittenNode).children ?? [])[0];
    expect(code.children?.[0]?.tagName).toBe("a");
    expect(code.children?.[0]?.properties).toEqual({ href: "file:///E:/ws/src/my file.ts" });
  });

  it("没有工作区根时什么都不改（纯文本）", () => {
    const tree = paragraphTree("我改了 src/a.ts");
    rewriteBareFilePaths(tree);
    expect(JSON.stringify(tree)).not.toContain("file:///");
  });
});
