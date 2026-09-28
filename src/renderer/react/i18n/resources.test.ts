import { describe, expect, it } from "vitest";
import en from "./en.json";
import jaJP from "./ja-JP.json";
import zhCN from "./zh-CN.json";

/**
 * 资源完整性护栏：新增文案时必须三份语言一起补，漏翻在这里就报出来。
 * 以中文为基准——它是回退语言（fallbackLng），key 最全。
 */

type Resource = Record<string, unknown>;

const BASE_LOCALE = "zh-CN";

const RESOURCES: Record<string, Resource> = {
  en: en as Resource,
  "ja-JP": jaJP as Resource,
  "zh-CN": zhCN as Resource,
};

/** 展平成 "a.b.c" 叶子路径；数组与空对象按叶子整体看待 */
function flattenKeys(value: unknown, prefix = ""): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [prefix];
  const entries = Object.entries(value as Resource);
  if (entries.length === 0) return [prefix];
  return entries.flatMap(([key, child]) => flattenKeys(child, prefix ? `${prefix}.${key}` : key));
}

describe("i18n 资源完整性", () => {
  const baseKeys = flattenKeys(RESOURCES[BASE_LOCALE]);

  it("基准语言资源非空", () => {
    expect(baseKeys.length).toBeGreaterThan(0);
  });

  it.each(Object.keys(RESOURCES).filter((locale) => locale !== BASE_LOCALE))(
    "%s 与基准语言的 key 完全一致",
    (locale) => {
      const keys = flattenKeys(RESOURCES[locale]);
      const own = new Set(keys);
      const base = new Set(baseKeys);
      // 分开断言，失败时能直接看出是漏翻还是多翻
      expect(keys.filter((key) => !base.has(key))).toEqual([]);
      expect(baseKeys.filter((key) => !own.has(key))).toEqual([]);
    },
  );

  it("角色名在每种语言里都齐全且无遗留中文", () => {
    const baseNames = Object.keys(RESOURCES[BASE_LOCALE].characterNames as Record<string, string>);
    expect(baseNames.length).toBeGreaterThan(0);

    for (const [locale, resource] of Object.entries(RESOURCES)) {
      const names = resource.characterNames as Record<string, string>;
      expect(Object.keys(names).sort(), `${locale} 的角色名 key`).toEqual([...baseNames].sort());
      // 中文 key 是运行时昵称，值不该留空
      for (const [nickname, display] of Object.entries(names)) {
        expect(display.trim(), `${locale} 的 ${nickname}`).not.toBe("");
      }
    }
  });
});