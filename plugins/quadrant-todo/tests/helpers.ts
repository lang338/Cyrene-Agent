import type { PluginStorage } from "../../../src/plugins/api";
import type { Task } from "../src/types";

/** 内存版 PluginStorage（与宿主 PluginStorage 同形，同步读写） */
export function makeStorage(): PluginStorage & { dump(): Task[] } {
  const map = new Map<string, unknown>();
  return {
    get: <T,>(k: string) => map.get(k) as T | undefined,
    set: (k, v) => {
      map.set(k, v);
    },
    rootDir: () => "<mock>",
    dump: () => (map.get("tasks") as Task[] | undefined) ?? [],
  };
}

/** 固定测试时刻格式化："YYYY-MM-DD HH:mm" */
export function fmt(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 固定"当前时刻"：2026-10-28 12:00 本地时间 */
export const NOW = new Date(2026, 9, 28, 12, 0, 0, 0).getTime();
