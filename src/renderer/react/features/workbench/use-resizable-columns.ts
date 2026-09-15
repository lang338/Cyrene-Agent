// 工作台三栏布局：可拖拽分隔条 + 宽度记忆（localStorage）。
// 左/中两栏是像素宽度，右栏吃剩余空间。

import { useCallback, useEffect, useRef, useState } from "react";

export interface ResizableColumnsOptions {
  storageKey: string;
  /** [左栏, 中栏] 初始宽度（px），右栏自动占余 */
  initial: [number, number];
  min?: [number, number];
}

export interface ResizableColumns {
  left: number;
  middle: number;
  beginDrag: (index: 0 | 1, event: React.PointerEvent) => void;
}

const DEFAULT_MIN: [number, number] = [180, 320];

export function useResizableColumns(options: ResizableColumnsOptions): ResizableColumns {
  const { storageKey } = options;
  const min = options.min ?? DEFAULT_MIN;
  const [sizes, setSizes] = useState<[number, number]>(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) {
        const parsed = JSON.parse(raw) as [number, number];
        // 恢复值按各自配置的最小宽度校验，不用硬编码阈值
        if (
          Array.isArray(parsed)
          && parsed.length === 2
          && typeof parsed[0] === "number" && parsed[0] >= min[0]
          && typeof parsed[1] === "number" && parsed[1] >= min[1]
        ) {
          return parsed;
        }
      }
    } catch {
      // 坏数据按初始值来
    }
    return options.initial;
  });
  const dragState = useRef<{ index: 0 | 1; startX: number; startWidth: number } | null>(null);

  const beginDrag = useCallback((index: 0 | 1, event: React.PointerEvent) => {
    event.preventDefault();
    dragState.current = { index, startX: event.clientX, startWidth: sizes[index] };
    document.body.classList.add("cy-workbench--column-resizing");
  }, [sizes]);

  useEffect(() => {
    function onMove(event: PointerEvent) {
      const drag = dragState.current;
      if (!drag) return;
      const delta = event.clientX - drag.startX;
      const nextWidth = Math.max(min[drag.index], drag.startWidth + delta);
      setSizes((current) => {
        const next: [number, number] = [...current] as [number, number];
        next[drag.index] = nextWidth;
        return next;
      });
    }
    // persist=false 用于 pointercancel：复位拖拽态但本次宽度不落 localStorage
    function endDrag(persist: boolean) {
      if (!dragState.current) return;
      dragState.current = null;
      document.body.classList.remove("cy-workbench--column-resizing");
      if (!persist) return;
      setSizes((current) => {
        try {
          localStorage.setItem(storageKey, JSON.stringify(current));
        } catch {
          // 存不进就算了，体验退化为本会话内记忆
        }
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
  }, [min, storageKey]);

  return { left: sizes[0], middle: sizes[1], beginDrag };
}
