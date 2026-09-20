import { describe, expect, it } from "vitest";
import { SNAPSHOT_ROUND_INTERVAL, bumpWorkbenchRound, shouldTakeCadenceSnapshot } from "./snapshot-cadence";

function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => {
      map.delete(key);
    },
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  } as Storage;
}

function brokenStorage(): Storage {
  return {
    getItem: () => {
      throw new Error("storage unavailable");
    },
    setItem: () => {
      throw new Error("storage unavailable");
    },
  } as unknown as Storage;
}

describe("工作区快照节奏", () => {
  it("按会话累计轮数，重开也接着数", () => {
    const storage = fakeStorage();
    expect(bumpWorkbenchRound("s1", storage)).toBe(1);
    expect(bumpWorkbenchRound("s1", storage)).toBe(2);
    expect(bumpWorkbenchRound("s1", storage)).toBe(3);
    // 另一个会话各数各的，互不影响
    expect(bumpWorkbenchRound("s2", storage)).toBe(1);
    expect(bumpWorkbenchRound("s1", storage)).toBe(4);
  });

  it("只有到整倍数才打保底快照", () => {
    expect(SNAPSHOT_ROUND_INTERVAL).toBe(10);
    expect(shouldTakeCadenceSnapshot(0)).toBe(false);
    expect(shouldTakeCadenceSnapshot(1)).toBe(false);
    expect(shouldTakeCadenceSnapshot(9)).toBe(false);
    expect(shouldTakeCadenceSnapshot(10)).toBe(true);
    expect(shouldTakeCadenceSnapshot(20)).toBe(true);
  });

  it("localStorage 不可用时退化成内存计数，而不是永远不拍快照", () => {
    const broken = brokenStorage();
    const first = bumpWorkbenchRound("s9", broken);
    const second = bumpWorkbenchRound("s9", broken);
    expect(second).toBe(first + 1);
  });
});
