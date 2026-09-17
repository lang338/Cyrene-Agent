import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ChatSession } from "../../shared/chat-types";
import { createWorkspaceFileService } from "./workspace-files";

let workspaceRoot: string;
let outsideRoot: string;
let session: ChatSession;

beforeAll(async () => {
  workspaceRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "cyrene-ws-"));
  outsideRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "cyrene-out-"));
  await fs.promises.mkdir(path.join(workspaceRoot, ".git"));
  await fs.promises.writeFile(path.join(workspaceRoot, ".git", "HEAD"), "ref");
  await fs.promises.mkdir(path.join(workspaceRoot, "src"));
  await fs.promises.writeFile(path.join(workspaceRoot, "src", "main.ts"), "console.log(1);\n");
  await fs.promises.writeFile(path.join(workspaceRoot, "README.md"), "# hello\n");
  await fs.promises.writeFile(path.join(outsideRoot, "secret.txt"), "outside");
  session = {
    mode: "code",
    workspaceBinding: { workspaceRoot, displayName: "ws" },
  } as unknown as ChatSession;
});

afterAll(async () => {
  await fs.promises.rm(workspaceRoot, { recursive: true, force: true });
  await fs.promises.rm(outsideRoot, { recursive: true, force: true });
});

function createService(overrides: Partial<ChatSession> = {}) {
  return createWorkspaceFileService({
    getSession: vi.fn(() => ({ ...session, ...overrides }) as ChatSession),
  });
}

describe("workspace-files listDir", () => {
  it("根目录：隐藏 .git，目录排在文件前", async () => {
    const service = createService();
    const entries = await service.listDir("s1", "");
    expect(entries.map((entry) => entry.name)).toEqual(["src", "README.md"]);
    expect(entries[0]).toMatchObject({ path: "src", type: "dir" });
    expect(entries[1]).toMatchObject({ path: "README.md", type: "file" });
  });

  it("子目录：路径为正斜杠拼接", async () => {
    const service = createService();
    const entries = await service.listDir("s1", "src");
    expect(entries).toEqual([{ name: "main.ts", path: "src/main.ts", type: "file" }]);
  });

  it("路径穿越拒绝", async () => {
    const service = createService();
    await expect(service.listDir("s1", "..")).rejects.toThrow("越出");
    await expect(service.listDir("s1", "src/../../x")).rejects.toThrow("越出");
    await expect(service.listDir("s1", "C:/Windows")).rejects.toThrow();
  });

  it("非 code 模式拒绝", async () => {
    const service = createService({ mode: "chat" } as Partial<ChatSession>);
    await expect(service.listDir("s1", "")).rejects.toThrow("Code 模式");
  });
});

describe("workspace-files readFile", () => {
  it("读取文本文件", async () => {
    const service = createService();
    const content = await service.readFile("s1", "src/main.ts");
    expect(content).toMatchObject({ path: "src/main.ts", content: "console.log(1);\n", binary: false, truncated: false });
  });

  it("NUL 字节判定为二进制，content 为空", async () => {
    await fs.promises.writeFile(path.join(workspaceRoot, "blob.bin"), Buffer.from([0x61, 0x00, 0x62]));
    const service = createService();
    const content = await service.readFile("s1", "blob.bin");
    expect(content.binary).toBe(true);
    expect(content.content).toBe("");
  });

  it("超过 1MB 截断", async () => {
    await fs.promises.writeFile(path.join(workspaceRoot, "big.txt"), "a".repeat(1_000_001));
    const service = createService();
    const content = await service.readFile("s1", "big.txt");
    expect(content.truncated).toBe(true);
    expect(content.content.length).toBe(1_000_000);
  });

  it("目录拒绝读取", async () => {
    const service = createService();
    await expect(service.readFile("s1", "src")).rejects.toThrow("目录");
  });
});

describe("workspace-files writeFile", () => {
  it("覆盖已有文件", async () => {
    const service = createService();
    await service.writeFile("s1", "src/main.ts", "console.log(2);\n");
    expect(await fs.promises.readFile(path.join(workspaceRoot, "src", "main.ts"), "utf8")).toBe("console.log(2);\n");
  });

  it("新建文件自动创建父目录", async () => {
    const service = createService();
    await service.writeFile("s1", "deep/nested/new.ts", "export {};\n");
    expect(await fs.promises.readFile(path.join(workspaceRoot, "deep", "nested", "new.ts"), "utf8")).toBe("export {};\n");
  });

  it("写入越出工作区拒绝", async () => {
    const service = createService();
    await expect(service.writeFile("s1", "../escaped.ts", "nope")).rejects.toThrow("越出");
  });

  it("非字符串内容拒绝", async () => {
    const service = createService();
    await expect(service.writeFile("s1", "x.ts", undefined as unknown as string)).rejects.toThrow("文本");
  });
});

describe("workspace-files 工作区外（路径栏手输的全盘绝对路径）", () => {
  it("按绝对路径读取，回传的 path 是解析后的正斜杠绝对路径（作标签键）", async () => {
    const service = createService();
    const target = path.join(outsideRoot, "secret.txt");
    const content = await service.readOutsideFile(target);
    expect(content.content).toBe("outside");
    expect(content.path).toBe(target.replace(/\\/g, "/"));
  });

  it("相对路径拒绝：工作区外没有参照物", async () => {
    const service = createService();
    await expect(service.readOutsideFile("secret.txt")).rejects.toThrow("绝对路径");
  });

  it("文件不存在给中文提示，不漏 errno", async () => {
    const service = createService();
    await expect(service.readOutsideFile(path.join(outsideRoot, "nope.txt"))).rejects.toThrow("文件不存在");
  });

  it("目录拒绝读取", async () => {
    const service = createService();
    await expect(service.readOutsideFile(outsideRoot)).rejects.toThrow("目录");
  });

  it("反斜杠与 .. 归一成同一条路径", async () => {
    const service = createService();
    const messy = path.join(outsideRoot, "sub", "..", "secret.txt");
    expect(messy).toContain("\\"); // Windows 临时目录：确认这条用例真的覆盖了反斜杠写法
    const content = await service.readOutsideFile(messy);
    expect(content.path).toBe(path.join(outsideRoot, "secret.txt").replace(/\\/g, "/"));
  });

  it("可以写工作区外已存在的文件", async () => {
    const service = createService();
    const target = path.join(outsideRoot, "secret.txt");
    await service.writeOutsideFile(target, "edited");
    expect(await fs.promises.readFile(target, "utf8")).toBe("edited");
  });

  it("不为工作区外凭空建文件", async () => {
    const service = createService();
    await expect(service.writeOutsideFile(path.join(outsideRoot, "brand-new.txt"), "x")).rejects.toThrow("文件不存在");
  });
});
