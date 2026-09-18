import { describe, expect, it } from "vitest";
import {
  KEYBOARD_STEP,
  maxColumnWidth,
  resizerKeyDelta,
  resolveColumnWidths,
  resolveStep,
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

describe("resizerKeyDelta（分隔条的键盘映射）", () => {
  it("向外 = 变宽：左栏用右方向键，右栏用左方向键", () => {
    expect(resizerKeyDelta("ArrowRight", "left")).toBe(KEYBOARD_STEP);
    expect(resizerKeyDelta("ArrowLeft", "right")).toBe(KEYBOARD_STEP);
  });

  it("向内 = 变窄", () => {
    expect(resizerKeyDelta("ArrowLeft", "left")).toBe(-KEYBOARD_STEP);
    expect(resizerKeyDelta("ArrowRight", "right")).toBe(-KEYBOARD_STEP);
  });

  it("Home/End 直达两端（用 ±Infinity 表达，由夹取落地）", () => {
    expect(resizerKeyDelta("Home", "left")).toBe(Number.NEGATIVE_INFINITY);
    expect(resizerKeyDelta("End", "right")).toBe(Number.POSITIVE_INFINITY);
  });

  it("不认识的键返回 null，调用方原样放行（不能吞掉事件）", () => {
    expect(resizerKeyDelta("ArrowUp", "left")).toBeNull();
    expect(resizerKeyDelta("ArrowDown", "right")).toBeNull();
    expect(resizerKeyDelta("Enter", "left")).toBeNull();
    expect(resizerKeyDelta("a", "right")).toBeNull();
  });
});

describe("resolveStep（键盘步进的夹取与收起）", () => {
  // 左栏默认场景：当前 260，受窗口限制最多 950，低于 120 吸附收起
  const base = { current: 260, max: 950, collapseAt: 120 };

  it("正常步进：按增量变化，不收起", () => {
    expect(resolveStep({ ...base, delta: KEYBOARD_STEP })).toEqual({ width: 280, collapsed: false });
    expect(resolveStep({ ...base, delta: -KEYBOARD_STEP })).toEqual({ width: 240, collapsed: false });
  });

  it("超过上限：夹到上限（End 键的 +Infinity 同理）", () => {
    expect(resolveStep({ ...base, current: 940, delta: KEYBOARD_STEP })).toEqual({ width: 950, collapsed: false });
    expect(resolveStep({ ...base, delta: Number.POSITIVE_INFINITY })).toEqual({ width: 950, collapsed: false });
  });

  it("低于收起阈值：吸附收起，并保留调整前的宽度作为展开时的记忆值", () => {
    expect(resolveStep({ ...base, current: 130, delta: -KEYBOARD_STEP })).toEqual({ width: 130, collapsed: true });
    // Home 键的 −Infinity 一路走到 0，同样收起
    expect(resolveStep({ ...base, delta: Number.NEGATIVE_INFINITY })).toEqual({ width: 260, collapsed: true });
  });

  it("恰好落在阈值上不算收起（阈值是展开态下限，不是收起线）", () => {
    expect(resolveStep({ ...base, current: 140, delta: -KEYBOARD_STEP })).toEqual({ width: 120, collapsed: false });
  });

  it("窗口窄到放不下展开宽度时也收起（与拖动路径同一判断）", () => {
    expect(resolveStep({ current: 260, delta: KEYBOARD_STEP, max: 100, collapseAt: 120 }))
      .toEqual({ width: 260, collapsed: true });
  });
});
