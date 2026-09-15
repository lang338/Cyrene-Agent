import { describe, expect, it } from "vitest";
import {
  maxColumnWidth,
  resolveColumnWidths,
  type ColumnLayout,
} from "./use-resizable-columns";

const MIN_MIDDLE = 320;
const RESIZER_TOTAL = 10;

function layout(partial: Partial<ColumnLayout> = {}): ColumnLayout {
  return { left: 260, right: 360, leftCollapsed: false, rightCollapsed: false, ...partial };
}

describe("resolveColumnWidths（左右两栏预算分配）", () => {
  it("预算够用：两侧按记忆宽度原样渲染", () => {
    // 1280 − 10 − 320 = 950，260 + 360 = 620 放得下
    expect(resolveColumnWidths(layout(), 1280, MIN_MIDDLE)).toEqual({ left: 260, right: 360 });
  });

  it("收起的一侧渲染为 0，另一侧不受影响", () => {
    expect(resolveColumnWidths(layout({ leftCollapsed: true }), 1280, MIN_MIDDLE))
      .toEqual({ left: 0, right: 360 });
    expect(resolveColumnWidths(layout({ rightCollapsed: true }), 1280, MIN_MIDDLE))
      .toEqual({ left: 260, right: 0 });
  });

  it("窗口变窄放不下：先压右栏再压左栏，中栏最小宽始终保住", () => {
    // 容器 700 → 预算 370，而 260 + 360 = 620 超了
    const applied = resolveColumnWidths(layout(), 700, MIN_MIDDLE);
    expect(applied).toEqual({ left: 260, right: 110 });
    expect(applied.left + applied.right).toBeLessThanOrEqual(700 - RESIZER_TOTAL - MIN_MIDDLE);
  });

  it("一侧超出预算：另一侧让到 0，该侧恰好等于预算", () => {
    const applied = resolveColumnWidths(layout({ left: 5000, right: 300 }), 1280, MIN_MIDDLE);
    expect(applied).toEqual({ left: 950, right: 0 });
  });

  it("无论记住多宽的宽度，合计都不会挤占中栏最小宽（回归：右栏曾被挤到拖不回来）", () => {
    const containers = [960, 1280, 1920];
    const memories: Array<[number, number]> = [[260, 360], [800, 800], [5000, 5000], [0, 0]];
    for (const width of containers) {
      for (const [left, right] of memories) {
        const applied = resolveColumnWidths(layout({ left, right }), width, MIN_MIDDLE);
        const budget = width - RESIZER_TOTAL - MIN_MIDDLE;
        // 这一条是整个修复的核心：中栏永远至少 minMiddle，分隔条因此不会被挤出可视区域
        expect(applied.left + applied.right).toBeLessThanOrEqual(budget);
        expect(applied.left).toBeGreaterThanOrEqual(0);
        expect(applied.right).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe("maxColumnWidth（拖动时的单侧上限）", () => {
  it("上限 = 容器 − 分隔条 − 中栏最小宽 − 另一侧宽度", () => {
    expect(maxColumnWidth(1280, MIN_MIDDLE, 360)).toBe(1280 - 10 - 320 - 360);
  });

  it("容器太窄时返回 0 而不是负数", () => {
    expect(maxColumnWidth(300, MIN_MIDDLE, 360)).toBe(0);
  });
});
