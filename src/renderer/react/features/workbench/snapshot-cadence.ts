// 工作区快照的节奏控制。
//
// 用户拍板：快照不该每个回合都打——"由用户自己决定要保留哪个版本，最多加个保底"。
// 于是触发点收敛为三个：手动按钮、回退前的保底、以及这里负责的"每 N 轮 AI 对话打一条"。
// 计数按会话持久化，重开工作台接着数，不会每次都从头开始。

/** 每隔多少轮 AI 对话打一条保底快照 */
export const SNAPSHOT_ROUND_INTERVAL = 10;

const memoryRounds = new Map<string, number>();

function storageKey(sessionId: string): string {
  return `cy-workbench-snapshot-round:${sessionId}`;
}

/**
 * 累加该会话的 AI 回合计数并返回新值。
 * localStorage 读写失败（隐私模式等）时退化成内存计数——绝不能退化成"永远返回 1"，
 * 否则取模判断永远不成立，保底快照一次都不会有。
 */
export function bumpWorkbenchRound(sessionId: string, storage?: Storage): number {
  const key = storageKey(sessionId);
  const fallback = (memoryRounds.get(key) ?? 0) + 1;
  memoryRounds.set(key, fallback);

  const target = storage ?? (typeof window === "undefined" ? undefined : window.localStorage);
  if (!target) return fallback;

  try {
    const raw = target.getItem(key);
    const parsed = raw === null ? 0 : Number.parseInt(raw, 10);
    const current = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
    const next = current + 1;
    target.setItem(key, String(next));
    memoryRounds.set(key, next);
    return next;
  } catch {
    return fallback;
  }
}

/** 到整倍数才打保底快照（第 0 轮不打） */
export function shouldTakeCadenceSnapshot(round: number, interval: number = SNAPSHOT_ROUND_INTERVAL): boolean {
  return round > 0 && interval > 0 && round % interval === 0;
}
