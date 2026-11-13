import { describe, expect, it } from "vitest";
import {
  evaluateGoalCompletion,
  msRemaining,
  parseDeadline,
  settleAll,
  settleTask,
} from "../src/quadrant";
import type { Task } from "../src/types";
import { NOW, fmt } from "./helpers";

function hoursFromNow(h: number): string {
  return fmt(NOW + h * 3_600_000);
}

function makeTask(patch: Partial<Task> = {}): Task {
  return {
    id: "t1",
    content: "写周报",
    deadline: null,
    quadrant: "green",
    status: "pending",
    createdAt: NOW,
    ...patch,
  };
}

describe("parseDeadline", () => {
  it("解析到分钟的时间", () => {
    const d = parseDeadline("2026-11-01 08:30");
    expect(d?.getTime()).toBe(new Date(2026, 10, 1, 8, 30).getTime());
  });

  it("只有日期按当日 00:00 计", () => {
    const d = parseDeadline("2026-11-01");
    expect(d?.getTime()).toBe(new Date(2026, 10, 1, 0, 0).getTime());
  });

  it("拒绝非法格式与滚动溢出日期", () => {
    expect(parseDeadline("明天")).toBeNull();
    expect(parseDeadline("2026/11/01")).toBeNull();
    expect(parseDeadline("2026-13-01")).toBeNull();
    expect(parseDeadline("2026-02-30")).toBeNull(); // 2 月没有 30 日
    expect(parseDeadline("2026-11-01 25:00")).toBeNull();
    expect(parseDeadline("")).toBeNull();
  });
});

describe("settleTask 象限滑动", () => {
  it("绿 + 剩余 71h → 滑红并触发滑红提醒", () => {
    const r = settleTask(makeTask({ quadrant: "green", deadline: hoursFromNow(71) }), NOW);
    expect(r.task.quadrant).toBe("red");
    expect(r.task.slidFrom).toBe("green");
    expect(r.task.reminded?.slide).toBe(hoursFromNow(71));
    expect(r.events).toContain("slide-red");
    expect(r.events).toContain("remind-slide");
  });

  it("蓝 + 剩余 71h → 滑黄且不提醒（蓝滑黄静默）", () => {
    const r = settleTask(makeTask({ quadrant: "blue", deadline: hoursFromNow(71) }), NOW);
    expect(r.task.quadrant).toBe("yellow");
    expect(r.task.slidFrom).toBe("blue");
    expect(r.events).toContain("slide-yellow");
    expect(r.events).not.toContain("remind-slide");
  });

  it("剩余恰好 72h 属窗口内（≤72h）", () => {
    const r = settleTask(makeTask({ quadrant: "green", deadline: hoursFromNow(72) }), NOW);
    expect(r.task.quadrant).toBe("red");
  });

  it("剩余超过 72h 不滑", () => {
    const r = settleTask(makeTask({ quadrant: "green", deadline: hoursFromNow(73) }), NOW);
    expect(r.task.quadrant).toBe("green");
    expect(r.events).toHaveLength(0);
  });

  it("红与黄是终点，不再滑动", () => {
    const red = settleTask(makeTask({ quadrant: "red", deadline: hoursFromNow(71) }), NOW);
    expect(red.task.quadrant).toBe("red");
    expect(red.events).not.toContain("slide-red");
    const yellow = settleTask(makeTask({ quadrant: "yellow", deadline: hoursFromNow(71) }), NOW);
    expect(yellow.task.quadrant).toBe("yellow");
  });

  it("无截止时间永不滑动", () => {
    const r = settleTask(makeTask({ quadrant: "green", deadline: null }), NOW);
    expect(r.task.quadrant).toBe("green");
    expect(msRemaining(r.task, NOW)).toBeNull();
  });

  it("完成态任务不结算", () => {
    const base = makeTask({ quadrant: "green", deadline: hoursFromNow(1), status: "done" });
    const r = settleTask(base, NOW);
    expect(r.task).toBe(base);
    expect(r.events).toHaveLength(0);
  });
});

describe("settleTask 默认完成", () => {
  it("过截止时刻仍未完成 → 自动转默认完成", () => {
    const r = settleTask(makeTask({ deadline: hoursFromNow(-0.5) }), NOW);
    expect(r.task.status).toBe("auto-done");
    expect(r.task.completedAt).toBe(NOW);
    expect(r.events).toContain("auto-done");
  });

  it("无截止时间永不自动完成", () => {
    const r = settleTask(makeTask({ deadline: null, createdAt: NOW - 30 * 24 * 3_600_000 }), NOW);
    expect(r.task.status).toBe("pending");
  });
});

describe("settleTask 主动提醒", () => {
  it("原生重要紧急剩 23h → 24h 提醒一次，重复结算不重复提醒", () => {
    const deadline = hoursFromNow(23);
    const first = settleTask(makeTask({ quadrant: "red", deadline }), NOW);
    expect(first.events).toContain("remind-24h");
    expect(first.task.reminded?.due24).toBe(deadline);
    const second = settleTask(first.task, NOW);
    expect(second.events).not.toContain("remind-24h");
  });

  it("重要紧急剩余超过 24h 不提醒", () => {
    const r = settleTask(makeTask({ quadrant: "red", deadline: hoursFromNow(25) }), NOW);
    expect(r.events).not.toContain("remind-24h");
  });

  it("滑红与 24h 窗口同时满足时两个提醒都只发生一次", () => {
    // 剩余 20h：滑动（72h 窗口）与 24h 窗口同时命中
    const r = settleTask(makeTask({ quadrant: "green", deadline: hoursFromNow(20) }), NOW);
    expect(r.events.filter((e) => e === "remind-slide")).toHaveLength(1);
    expect(r.events.filter((e) => e === "remind-24h")).toHaveLength(1);
  });
});

describe("settleTask 截止时间变更（deadlineChanged）", () => {
  it("滑红后改期退出 72h 窗口 → 自动滑回原分类并清理滑动记录", () => {
    const slid = settleTask(makeTask({ quadrant: "green", deadline: hoursFromNow(71) }), NOW).task;
    const r = settleTask({ ...slid, deadline: hoursFromNow(24 * 7) }, NOW, { deadlineChanged: true });
    expect(r.events).toContain("slide-back");
    expect(r.task.quadrant).toBe("green");
    expect(r.task.slidFrom).toBeUndefined();
    expect(r.task.reminded?.slide).toBeUndefined(); // 提醒新一轮
  });

  it("改期仍在 72h 窗口内 → 滑回后按正常规则再次滑红（§5.4 推论）", () => {
    const slid = settleTask(makeTask({ quadrant: "green", deadline: hoursFromNow(71) }), NOW).task;
    const r = settleTask({ ...slid, deadline: hoursFromNow(50) }, NOW, { deadlineChanged: true });
    expect(r.events).toContain("slide-back");
    expect(r.events).toContain("slide-red");
    expect(r.task.quadrant).toBe("red");
    expect(r.task.slidFrom).toBe("green");
  });

  it("原生红改期到 24h 内 → 提醒标记重置后可再次提醒（一轮重置）", () => {
    const deadline = hoursFromNow(23);
    const reminded = settleTask(makeTask({ quadrant: "red", deadline }), NOW).task;
    const newDeadline = hoursFromNow(10);
    const r = settleTask({ ...reminded, deadline: newDeadline }, NOW, { deadlineChanged: true });
    expect(r.events).toContain("remind-24h");
    expect(r.task.reminded?.due24).toBe(newDeadline);
  });

  it("改期到已过期 → 先滑回再默认完成", () => {
    const slid = settleTask(makeTask({ quadrant: "green", deadline: hoursFromNow(71) }), NOW).task;
    const r = settleTask({ ...slid, deadline: hoursFromNow(-1) }, NOW, { deadlineChanged: true });
    expect(r.events).toContain("slide-back");
    expect(r.task.quadrant).toBe("green");
    expect(r.task.status).toBe("auto-done");
  });
});

describe("settleAll", () => {
  it("只返回发生变更的任务", () => {
    const a = makeTask({ id: "a", quadrant: "green", deadline: hoursFromNow(71) });
    const b = makeTask({ id: "b", quadrant: "green", deadline: hoursFromNow(200) });
    const changed = settleAll([a, b], NOW);
    expect(changed).toHaveLength(1);
    expect(changed[0]?.task.id).toBe("a");
  });

  it("树内资格：带 parentId 的小目标不滑动，被引用的顶层任务（大目标）不默认完成", () => {
    const goal = makeTask({ id: "goal", quadrant: "green", deadline: hoursFromNow(71) });
    const child = makeTask({ id: "child", parentId: "goal", quadrant: "green", deadline: hoursFromNow(71) });
    const changed = settleAll([goal, child], NOW, {}, [goal, child]);
    expect(changed).toHaveLength(0);
  });

  it("持久化 goal 身份：删光小目标后仍按大目标豁免，不滑动不默认完成（CodeRabbit 评审）", () => {
    // 同样 72h 窗口内 + 已过期两种情况：无标记的会被滑红/默认完成，有 goal 标记的豁免
    const withMarker = makeTask({ id: "g1", quadrant: "green", deadline: hoursFromNow(50), goal: true });
    const withoutMarker = makeTask({ id: "g2", quadrant: "green", deadline: hoursFromNow(50) });
    const expiredWithMarker = makeTask({ id: "g3", quadrant: "green", deadline: hoursFromNow(-1), goal: true });
    const changed = settleAll([withMarker, withoutMarker, expiredWithMarker], NOW);
    expect(changed.map((r) => r.task.id)).toEqual(["g2"]);
    expect(changed[0]?.events).toContain("slide-red");
    expect(withMarker.goal).toBe(true);
  });
});

describe("功能二：树内机制资格与大目标联动（§3.24/§3.25）", () => {
  it("小目标（child）到点自动转默认完成，但不滑动", () => {
    const child = makeTask({ id: "c1", parentId: "g1", quadrant: "green", deadline: hoursFromNow(-1) });
    const r = settleTask(child, NOW, {}, "child");
    expect(r.task.status).toBe("auto-done");
    expect(r.task.quadrant).toBe("green");
    expect(r.events).toEqual(["auto-done"]);
  });

  it("小目标剩余 50h 不滑动、不做滑红/24h 提醒", () => {
    const child = makeTask({ id: "c1", parentId: "g1", quadrant: "green", deadline: hoursFromNow(50) });
    const r = settleTask(child, NOW, {}, "child");
    expect(r.task.quadrant).toBe("green");
    expect(r.events).toEqual([]);
  });

  it("小目标自定义单次提醒：到点触发一次并标记，重复结算不再触发", () => {
    const child = makeTask({
      id: "c1",
      parentId: "g1",
      deadline: hoursFromNow(48),
      reminder: { type: "once", at: hoursFromNow(-1) },
    });
    const r1 = settleTask(child, NOW, {}, "child");
    expect(r1.events).toEqual(["remind-custom"]);
    expect(r1.task.reminded?.custom).toBe(hoursFromNow(-1));
    const r2 = settleTask(r1.task, NOW, {}, "child");
    expect(r2.events).toEqual([]);
  });

  it("小目标自定义提醒未到点不触发", () => {
    const child = makeTask({
      id: "c1",
      parentId: "g1",
      deadline: hoursFromNow(48),
      reminder: { type: "once", at: hoursFromNow(1) },
    });
    const r = settleTask(child, NOW, {}, "child");
    expect(r.events).toEqual([]);
  });

  it("大目标（goal）全机制豁免：即使过期也不单点默认完成", () => {
    const goal = makeTask({ id: "g1", deadline: hoursFromNow(-1) });
    const r = settleTask(goal, NOW, {}, "goal");
    expect(r.task.status).toBe("pending");
    expect(r.events).toEqual([]);
  });

  it("大目标改期（deadlineChanged）不产生滑回与提醒标记清理", () => {
    const goal = makeTask({ id: "g1", quadrant: "green", deadline: hoursFromNow(71) });
    const r = settleTask(goal, NOW, { deadlineChanged: true }, "goal");
    expect(r.events).toEqual([]);
    expect(r.task).toBe(goal);
  });

  it("evaluateGoalCompletion：已到时限 且 所有小目标完成 → 默认完成", () => {
    const goal = makeTask({ id: "g1", deadline: hoursFromNow(-1) });
    const children = [
      makeTask({ id: "c1", parentId: "g1", status: "done", completedAt: NOW - 1000 }),
      makeTask({ id: "c2", parentId: "g1", status: "auto-done", completedAt: NOW - 2000 }),
    ];
    const r = evaluateGoalCompletion(goal, children, NOW);
    expect(r?.task.status).toBe("auto-done");
    expect(r?.events).toEqual(["auto-done"]);
  });

  it("evaluateGoalCompletion：小目标未全完成 / 尚无小目标 / 未到时限 / 无时限 → 均不转", () => {
    const goal = makeTask({ id: "g1", deadline: hoursFromNow(-1) });
    const pendingChild = makeTask({ id: "c1", parentId: "g1", deadline: hoursFromNow(48) });
    expect(evaluateGoalCompletion(goal, [pendingChild], NOW)).toBeNull();
    expect(evaluateGoalCompletion(goal, [], NOW)).toBeNull();
    const futureGoal = makeTask({ id: "g2", deadline: hoursFromNow(48) });
    const doneChild = makeTask({ id: "c2", parentId: "g2", status: "done", completedAt: NOW });
    expect(evaluateGoalCompletion(futureGoal, [doneChild], NOW)).toBeNull();
    const noDeadlineGoal = makeTask({ id: "g3", deadline: null });
    expect(evaluateGoalCompletion(noDeadlineGoal, [doneChild], NOW)).toBeNull();
  });

  it("evaluateGoalCompletion：完成态大目标不再结算，小目标（带 parentId）传入直接拒绝", () => {
    const doneGoal = makeTask({ id: "g1", deadline: hoursFromNow(-1), status: "done", completedAt: NOW });
    const doneChild = makeTask({ id: "c1", parentId: "g1", status: "done", completedAt: NOW });
    expect(evaluateGoalCompletion(doneGoal, [doneChild], NOW)).toBeNull();
    const childAsGoal = makeTask({ id: "c9", parentId: "g9", deadline: hoursFromNow(-1) });
    expect(evaluateGoalCompletion(childAsGoal, [], NOW)).toBeNull();
  });
});
