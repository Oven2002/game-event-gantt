import { describe, expect, it } from "vitest";
import type { TimelineItem } from "../src/lib/types";
import { buildRotationRows } from "../src/lib/rotation";

function event(overrides: Partial<TimelineItem>): TimelineItem {
  return {
    key: `demo/cn/event/${overrides.id ?? "event"}`,
    id: overrides.id ?? "event",
    kind: "event",
    name: overrides.name ?? "轮换期",
    typeId: "event",
    typeName: "活动",
    start: overrides.start ?? 10,
    end: overrides.end ?? 20,
    periods: overrides.periods ?? [{ start: overrides.start ?? 10, end: overrides.end ?? 20 }],
    related: [],
    sources: ["https://example.com/event"],
    sourceFile: "demo/cn.yaml",
    ...overrides,
  };
}

describe("常驻轮换行", () => {
  it("将同一 rotation group 的周期和阶段合并成一行", () => {
    const rows = buildRotationRows([
      event({ id: "cycle-1", rotationGroup: "abyss", rotationLabel: "深境螺旋", lifecycle: "permanent", cadence: "rotating" }),
      event({ id: "cycle-2", start: 30, end: 40, rotationGroup: "abyss", rotationLabel: "深境螺旋", lifecycle: "permanent", cadence: "rotating" }),
      event({ id: "burst", start: 12, end: 15, rotationGroup: "abyss", name: "爆发期" }),
      event({ id: "ordinary", rotationGroup: undefined, name: "普通活动" }),
    ], 35);

    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe("深境螺旋");
    expect(rows[0].items.map((item) => item.kind)).toEqual(["event", "event", "event"]);
  });

  it("最后一个常驻轮换结束且没有未来期时生成一个占位", () => {
    const rows = buildRotationRows([
      event({ id: "cycle", end: 20, rotationGroup: "abyss", rotationLabel: "深境螺旋", lifecycle: "permanent", cadence: "rotating" }),
    ], 20);

    expect(rows[0].items).toHaveLength(2);
    expect(rows[0].items[1]).toMatchObject({
      kind: "rotation-placeholder",
      rotationGroup: "abyss",
      rotationLabel: "深境螺旋",
      start: 20,
    });
  });

  it("存在进行中或未来周期时不生成占位", () => {
    const rows = buildRotationRows([
      event({ id: "cycle", end: 20, rotationGroup: "abyss", rotationLabel: "深境螺旋", lifecycle: "permanent", cadence: "rotating" }),
      event({
        id: "next",
        start: 30,
        end: undefined,
        periods: [],
        rotationGroup: "abyss",
        rotationLabel: "深境螺旋",
        lifecycle: "permanent",
        cadence: "rotating",
      }),
    ], 21);

    expect(rows[0].items).toHaveLength(2);
    expect(rows[0].items.every((item) => item.kind === "event")).toBe(true);
  });

  it("使用最后一个实际 period 结束点", () => {
    const rows = buildRotationRows([
      event({
        id: "multi-period",
        start: 10,
        end: 100,
        periods: [{ start: 10, end: 20 }, { start: 80, end: 90 }],
        rotationGroup: "abyss",
        rotationLabel: "深境螺旋",
        lifecycle: "permanent",
        cadence: "rotating",
      }),
    ], 95);

    expect(rows[0].items.at(-1)).toMatchObject({ kind: "rotation-placeholder", start: 90 });
  });

  it("没有已知结束时间时不生成占位", () => {
    const rows = buildRotationRows([
      event({
        id: "open-ended",
        end: undefined,
        periods: [],
        rotationGroup: "integrated-strategy",
        rotationLabel: "集成战略",
        lifecycle: "permanent",
        cadence: "rotating",
      }),
    ], 100);

    expect(rows[0].items).toHaveLength(1);
  });
});
