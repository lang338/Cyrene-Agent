import { describe, expect, it } from "vitest";
import { BUILTIN_LSP_SERVERS, findServerCandidates } from "./server-catalog";

describe("built-in LSP server catalog", () => {
  it("covers the supported language families without guessing unknown extensions", () => {
    expect(findServerCandidates("src/app.ts").map((server) => server.id)).toContain("typescript-language-server");
    expect(findServerCandidates("src/app.py").map((server) => server.id)).toContain("python-pyright");
    expect(findServerCandidates("src/main.go").map((server) => server.id)).toContain("gopls");
    expect(findServerCandidates("src/main.rs").map((server) => server.id)).toContain("rust-analyzer");
    expect(findServerCandidates("src/main.cpp").map((server) => server.id)).toContain("clangd");
    expect(findServerCandidates("src/Main.java").map((server) => server.id)).toContain("jdtls");
    expect(findServerCandidates("src/Main.cs").map((server) => server.id)).toContain("omnisharp");
    expect(findServerCandidates("src/index.php").map((server) => server.id)).toContain("intelephense");
    expect(findServerCandidates("src/app.rb").map((server) => server.id)).toContain("ruby-lsp");
    expect(findServerCandidates("src/Main.kt").map((server) => server.id)).toContain("kotlin-language-server");
    expect(findServerCandidates("src/init.lua").map((server) => server.id)).toContain("lua-language-server");
    expect(findServerCandidates("src/App.vue").map((server) => server.id)).toContain("vue-language-server");
    expect(findServerCandidates("config/app.yaml").map((server) => server.id)).toContain("yaml-language-server");
    expect(findServerCandidates("notes/readme.unknown")).toEqual([]);
  });

  it("lets a validated user override replace a built-in command before discovery", () => {
    const [server] = findServerCandidates("src/app.py", [{
      id: "python-pyright",
      command: "basedpyright-langserver",
      args: ["--stdio"],
      initializationOptions: { disableOrganizeImports: true },
    }]);

    expect(server).toMatchObject({
      id: "python-pyright",
      commands: [{ command: "basedpyright-langserver", args: ["--stdio"] }],
      initializationOptions: { disableOrganizeImports: true },
    });
  });

  it("keeps every built-in definition declarative and actionable", () => {
    expect(BUILTIN_LSP_SERVERS).not.toHaveLength(0);
    for (const server of BUILTIN_LSP_SERVERS) {
      expect(server.extensions.length).toBeGreaterThan(0);
      expect(server.commands.length).toBeGreaterThan(0);
      expect(server.installHint).not.toBe("");
    }
  });

  it("自带副本的入口名必须是 <服务 id>.cjs：这是 scripts/build/lsp-servers.mjs 的产出约定", () => {
    // 约定：多出来的那条命令就是随应用打包的单文件入口（见 lsp-servers.mjs 的产物布局）。
    // 两边名字对不上时不会有任何报错，只会静默回落成"没有语言服务可用"，所以这里钉住。
    const withBundledCopy = BUILTIN_LSP_SERVERS.filter((server) => server.commands.length > 1);
    expect(withBundledCopy.map((server) => server.id)).toContain("yaml-language-server");
    for (const server of withBundledCopy) {
      expect(server.commands[1].command).toBe(`${server.id}.cjs`);
    }
  });

  it("没有扩展名的文件靠文件名匹配（Dockerfile 这类）", () => {
    expect(findServerCandidates("Dockerfile").map((server) => server.id)).toEqual(["dockerfile-language-server"]);
    expect(findServerCandidates("deploy/Containerfile").map((server) => server.id)).toEqual(["dockerfile-language-server"]);
    // 大小写不敏感（Windows 上常见 DockerFile / dockerfile）
    expect(findServerCandidates("build/dockerfile").map((server) => server.id)).toEqual(["dockerfile-language-server"]);
    // 带扩展名的写法照旧走扩展名那条路
    expect(findServerCandidates("ops/app.dockerfile").map((server) => server.id)).toEqual(["dockerfile-language-server"]);
    // 别的无扩展名文件不能被认成 Dockerfile
    expect(findServerCandidates("Makefile")).toEqual([]);
    expect(findServerCandidates("LICENSE")).toEqual([]);
  });
});
