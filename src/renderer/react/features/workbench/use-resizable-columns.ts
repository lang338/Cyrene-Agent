// 工作台三栏布局：左右两栏是可拖拽的像素宽度，中栏 flex 撑满剩余空间。
//
// 为什么让中栏吃剩余、而不是右栏（旧实现）：
// 旧实现里右栏是 flex:1，中栏是像素宽度且只有下限没有上限，向右拖能把中栏拖得
// 比窗口还宽 —— 右栏被挤成 0 宽、分隔条被推出可视区域，于是再也拖不回来
// （宽度还写进了 localStorage，重启也回不来）。
// 现在左右两栏共用一份预算：left + right ≤ 容器宽 − 中栏最小宽 − 分隔条，
// 中栏永远至少保留 minMiddle，分隔条永远留在屏内。
// 任一栏拖到低于 collapseAt 就吸附为收起（宽度记忆保留），收起后由边缘箭头展开。

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

export type ColumnSide = "left" | "right";

export interface ResizableColumnsOptions {
  storageKey: string;
  /** 首次进入的宽度（px）；记忆值不可用时用它兜底 */
  initial: { left: number; right: number };
  /** 拖到低于此宽度即收起；展开态的宽度下限等于它 */
  collapseAt?: { left: number; right: number };
  /** 中栏最小宽度：决定左右两栏的可用预算 */
  minMiddle?: number;
}

export interface ResizableColumns {
  /** 实际渲染宽度（px），0 表示该栏当前不可见 */
  left: number;
  right: number;
  /** 该栏当前不可见（主动收起，或被窄窗口挤没了）：此时显示边缘展开箭头 */
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  /** 挂在三栏容器上，用于测量左右两栏的可用宽度 */
  bodyRef: React.RefObject<HTMLDivElement | null>;
  beginDrag: (side: ColumnSide, event: React.PointerEvent) => void;
  /** 收起后点边缘箭头：恢复折叠前的宽度 */
  reveal: (side: ColumnSide) => void;
  /**
   * 键盘调整：delta 为像素增量（正 = 变宽）。
   * 返回的 collapsed 表示这次操作把该栏收起了——调用方据此交接焦点
   * （收起后分隔条会被卸载，焦点必须交给边缘的展开箭头，否则掉回 body）。
   */
  step: (side: ColumnSide, delta: number) => { collapsed: boolean };
  /** 该栏当前的宽度边界，供 aria-valuemin/max 如实播报 */
  boundsFor: (side: ColumnSide) => { min: number; max: number };
}

/** 两条分隔条的像素占宽 */
const RESIZER_TOTAL = 10;
const DEFAULT_COLLAPSE_AT: { left: number; right: number } = { left: 120, right: 160 };
export const DEFAULT_MIN_MIDDLE = 320;

export interface ColumnLayout {
  left: number;
  right: number;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
}

/**
 * 记忆宽度 → 本次实际渲染宽度。收起的一侧为 0；两侧合计超出预算时先压缩右栏
 * 再压缩左栏，保证中栏的最小宽度永远不被侵占（也保证分隔条不会跑出窗口）。
 */
export function resolveColumnWidths(
  layout: ColumnLayout,
  containerWidth: number,
  minMiddle: number = DEFAULT_MIN_MIDDLE,
): { left: number; right: number } {
  const budget = Math.max(0, containerWidth - RESIZER_TOTAL - minMiddle);
  const left = layout.leftCollapsed ? 0 : Math.max(0, layout.left);
  let right = layout.rightCollapsed ? 0 : Math.max(0, layout.right);
  if (left + right <= budget) return { left, right };
  right = Math.max(0, budget - left);
  return { left: Math.min(left, Math.max(0, budget - right)), right };
}

/** 某一侧能占的最大宽度：容器去掉分隔条与中栏最小宽，再减掉另一侧当前宽度 */
export function maxColumnWidth(
  containerWidth: number,
  minMiddle: number,
  otherWidth: number,
): number {
  return Math.max(0, containerWidth - RESIZER_TOTAL - minMiddle - otherWidth);
}

/** 键盘步进一次改变多少像素 */
export const KEYBOARD_STEP = 20;

/**
 * 键盘按键 → 宽度增量。返回 null 表示这个键不归分隔条管（不吞事件）。
 * 语义按"向外 = 变宽"：左栏 ArrowRight 变宽、右栏 ArrowLeft 变宽。
 * Home/End 用 ±Infinity 表达"直接到两端"，由 resolveStep 的夹取落地。
 */
export function resizerKeyDelta(key: string, side: ColumnSide): number | null {
  if (key === "Home") return Number.NEGATIVE_INFINITY;
  if (key === "End") return Number.POSITIVE_INFINITY;
  if (key === (side === "left" ? "ArrowRight" : "ArrowLeft")) return KEYBOARD_STEP;
  if (key === (side === "left" ? "ArrowLeft" : "ArrowRight")) return -KEYBOARD_STEP;
  return null;
}

/**
 * 键盘调整后的宽度：先夹到 [0, max]，低于收起阈值则吸附为收起，
 * 并保留调整前的宽度作为"展开时回到哪"的记忆值——和拖动时的语义完全一致。
 */
export function resolveStep(input: {
  current: number;
  delta: number;
  max: number;
  collapseAt: number;
}): { width: number; collapsed: boolean } {
  const clamped = Math.max(0, Math.min(input.current + input.delta, input.max));
  // 窗口窄到放不下展开宽度时也吸附收起：与拖动路径的判断保持一致
  const collapsed = clamped < input.collapseAt || input.max < input.collapseAt;
  return { width: collapsed ? input.current : clamped, collapsed };
}

function applySide(
  layout: ColumnLayout,
  side: ColumnSide,
  next: { width: number; collapsed: boolean },
): ColumnLayout {
  return side === "left"
    ? { ...layout, left: next.width, leftCollapsed: next.collapsed }
    : { ...layout, right: next.width, rightCollapsed: next.collapsed };
}

/** 展开某一侧时把另一侧压到预算内，避免"点了箭头却没反应"（窄窗口下的死路） */
function fitOtherSide(layout: ColumnLayout, side: ColumnSide, otherMax: number): ColumnLayout {
  if (side === "left") {
    return { ...layout, right: layout.rightCollapsed ? layout.right : Math.min(layout.right, otherMax) };
  }
  return { ...layout, left: layout.leftCollapsed ? layout.left : Math.min(layout.left, otherMax) };
}

function persistLayout(storageKey: string, layout: ColumnLayout): void {
  try {
    localStorage.setItem(storageKey, JSON.stringify(layout));
  } catch {
    // 存不进就算了，体验退化为本会话内记忆
  }
}

function readLayout(storageKey: string, initial: { left: number; right: number }): ColumnLayout {
  const fallback: ColumnLayout = {
    left: initial.left,
    right: initial.right,
    leftCollapsed: false,
    rightCollapsed: false,
  };
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return fallback;
    const parsed: unknown = JSON.parse(raw);
    // 旧版本存的是 [左, 中] 数组，语义已变（中栏现在吃剩余），不兼容解读
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return fallback;
    const record = parsed as Record<string, unknown>;
    const width = (value: unknown, fallbackValue: number) =>
      typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallbackValue;
    return {
      left: width(record.left, initial.left),
      right: width(record.right, initial.right),
      leftCollapsed: record.leftCollapsed === true,
      rightCollapsed: record.rightCollapsed === true,
    };
  } catch {
    return fallback;
  }
}

export function useResizableColumns(options: ResizableColumnsOptions): ResizableColumns {
  const { storageKey } = options;
  const collapseAt = options.collapseAt ?? DEFAULT_COLLAPSE_AT;
  const minMiddle = options.minMiddle ?? DEFAULT_MIN_MIDDLE;
  const [layout, setLayout] = useState<ColumnLayout>(() => readLayout(storageKey, options.initial));
  const bodyRef = useRef<HTMLDivElement | null>(null);
  // 初始值取窗口宽度：首帧就按当前窗口夹紧，不会闪一下"左右全宽"
  const [containerWidth, setContainerWidth] = useState(() => window.innerWidth);
  const widthRef = useRef(containerWidth);

  useLayoutEffect(() => {
    const element = bodyRef.current;
    if (!element) return;
    const measure = () => {
      widthRef.current = element.clientWidth;
      setContainerWidth(element.clientWidth);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return; // 测试环境无 ResizeObserver 时退化为首帧测量
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const applied = resolveColumnWidths(layout, containerWidth, minMiddle);
  const dragState = useRef<{
    side: ColumnSide;
    startX: number;
    startWidth: number;
    otherWidth: number;
  } | null>(null);

  const beginDrag = useCallback((side: ColumnSide, event: React.PointerEvent) => {
    event.preventDefault();
    dragState.current = {
      side,
      startX: event.clientX,
      startWidth: applied[side],
      // 拖动时按"另一侧此刻的宽度"算上限，这样拖一边不会把另一边挤没
      otherWidth: applied[side === "left" ? "right" : "left"],
    };
    document.body.classList.add("cy-workbench--column-resizing");
  }, [applied.left, applied.right]);

  useEffect(() => {
    function onMove(event: PointerEvent) {
      const drag = dragState.current;
      if (!drag) return;
      // 左栏向右、右栏向左都是变宽：用同一个位移量表达，符号在各自分支处理
      const raw = drag.side === "left"
        ? drag.startWidth + (event.clientX - drag.startX)
        : drag.startWidth - (event.clientX - drag.startX);
      const max = maxColumnWidth(widthRef.current, minMiddle, drag.otherWidth);
      // 拖到最窄、或窗口窄到放不下展开宽度：吸附为收起
      const collapsed = raw < collapseAt[drag.side] || max < collapseAt[drag.side];
      setLayout((current) => applySide(current, drag.side, {
        // 收起时记住进入拖动那一刻的宽度，展开时回到这个宽度
        width: collapsed ? drag.startWidth : Math.min(raw, max),
        collapsed,
      }));
    }
    // persist=false 用于 pointercancel：复位拖拽态但本次宽度不落 localStorage
    function endDrag(persist: boolean) {
      if (!dragState.current) return;
      dragState.current = null;
      document.body.classList.remove("cy-workbench--column-resizing");
      if (!persist) return;
      setLayout((current) => {
        persistLayout(storageKey, current);
        return current;
      });
    }
    const onUp = () => endDrag(true);
    const onCancel = () => endDrag(false);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      // 工作台在拖拽中途卸载：清掉残留的全局拖拽态与 body 样式
      dragState.current = null;
      document.body.classList.remove("cy-workbench--column-resizing");
    };
  }, [collapseAt.left, collapseAt.right, minMiddle, storageKey]);

  const reveal = useCallback((side: ColumnSide) => {
    setLayout((current) => {
      // 记忆值缺失（曾被挤成 0）时回落到初始宽度
      const memory = Math.max(collapseAt[side], current[side] || options.initial[side]);
      const expanded = applySide(current, side, { width: memory, collapsed: false });
      // 展开的那一侧优先，另一侧让位到预算内
      const next = fitOtherSide(expanded, side, maxColumnWidth(widthRef.current, minMiddle, memory));
      persistLayout(storageKey, next);
      return next;
    });
  }, [collapseAt.left, collapseAt.right, minMiddle, options.initial.left, options.initial.right, storageKey]);

  /**
   * 键盘步进：拿到该栏此刻的可用上限后走一步，走过头就吸附收起。
   * 判定与持久化都复用拖动路径的同一套逻辑，两条入口不会走出两种行为。
   */
  const step = useCallback((side: ColumnSide, delta: number): { collapsed: boolean } => {
    const other = applied[side === "left" ? "right" : "left"];
    const max = maxColumnWidth(widthRef.current, minMiddle, other);
    const result = resolveStep({ current: applied[side], delta, max, collapseAt: collapseAt[side] });
    setLayout((current) => {
      const next = applySide(current, side, { width: result.width, collapsed: result.collapsed });
      persistLayout(storageKey, next);
      return next;
    });
    return result;
  }, [applied.left, applied.right, collapseAt.left, collapseAt.right, minMiddle, storageKey]);

  const boundsFor = useCallback((side: ColumnSide) => {
    const other = applied[side === "left" ? "right" : "left"];
    return {
      min: collapseAt[side],
      max: maxColumnWidth(widthRef.current, minMiddle, other),
    };
  }, [applied.left, applied.right, collapseAt.left, collapseAt.right, minMiddle]);

  return {
    left: applied.left,
    right: applied.right,
    // 以"实际渲染宽度为 0"为准：主动收起和被窄窗口挤没都需要箭头才能回来
    leftCollapsed: applied.left === 0,
    rightCollapsed: applied.right === 0,
    bodyRef,
    beginDrag,
    reveal,
    step,
    boundsFor,
  };
}
