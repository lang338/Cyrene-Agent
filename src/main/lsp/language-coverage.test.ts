/**
 * 语言覆盖一致性测试。
 *
 * 渲染端（注册 provider、决定要不要提示"缺语言服务"）看的是 shared/workbench-languages，
 * 主进程（真正启动哪台语言服务）看的是 server-catalog。两张表一旦漂移，症状都很隐蔽：
 * - 表里有、catalog 里没有 → provider 白注册，用户装了服务也拿不到补全；
 * - catalog 里有、表里没有 → 用户明明装了服务，工作台却一个字都不说（或提示他去装一个用不上的）。
 * 所以这里把两个方向都钉死。
 */

import { describe, expect, it } from "vitest";
import { LANGUAGE_BY_EXTENSION, LSP_LANGUAGES } from "../../shared/workbench-languages";
import { BUILTIN_LSP_SERVERS, findServerCandidates } from "./server-catalog";

/**
 * 刻意不接语义补全的扩展名（理由见 shared/workbench-languages.ts 的注释）：
 * json/jsonc 交给 Monaco 自带的 json 服务，vue 需要虚拟文档支持、还没做。
 */
const EXCLUDED_EXTENSIONS = new Set([".json", ".jsonc", ".vue"]);

describe("语言覆盖一致性", () => {
  it("声明接语义补全的每个扩展名，catalog 里都有对应语言服务", () => {
    const orphans: string[] = [];
    for (const { extensions } of LSP_LANGUAGES) {
      for (const extension of extensions) {
        if (findServerCandidates(`probe${extension}`).length === 0) orphans.push(extension);
      }
    }
    expect(orphans).toEqual([]);
  });

  it("catalog 里除刻意排除外的每个扩展名，都在语义补全声明里", () => {
    const uncovered: string[] = [];
    for (const server of BUILTIN_LSP_SERVERS) {
      for (const extension of server.extensions) {
        if (EXCLUDED_EXTENSIONS.has(extension)) continue;
        const covered = LSP_LANGUAGES.some((language) => language.extensions.includes(extension));
        if (!covered) uncovered.push(`${server.id}${extension}`);
      }
    }
    expect(uncovered).toEqual([]);
  });

  it("声明的每个扩展名都能被编辑器识别成同一个 languageId（否则 provider 永不触发）", () => {
    for (const { languageId, extensions } of LSP_LANGUAGES) {
      for (const extension of extensions) {
        expect(LANGUAGE_BY_EXTENSION[extension.slice(1)], extension).toBe(languageId);
      }
    }
  });

  it("同一扩展名不会被两个语言声明（catalog 只取第一个候选，重叠会让人以为都能用）", () => {
    const seen = new Map<string, string>();
    const duplicated: string[] = [];
    for (const { languageId, extensions } of LSP_LANGUAGES) {
      for (const extension of extensions) {
        const previous = seen.get(extension);
        if (previous) duplicated.push(`${extension}: ${previous} / ${languageId}`);
        seen.set(extension, languageId);
      }
    }
    expect(duplicated).toEqual([]);
  });
});
