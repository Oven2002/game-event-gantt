import type { TimelineItem } from "./types";

export interface RotationPlaceholder {
  kind: "rotation-placeholder";
  key: string;
  rotationGroup: string;
  rotationLabel: string;
  start: number;
}

export type RotationChartItem = TimelineItem | RotationPlaceholder;

export interface RotationRow {
  key: string;
  label: string;
  items: RotationChartItem[];
  priority: number;
  start: number;
}

function realPeriods(item: TimelineItem): Array<{ start: number; end: number }> {
  if (item.periods.length) return item.periods;
  if (item.end !== undefined) return [{ start: item.start, end: item.end }];
  return [];
}

function isRotationCycle(item: TimelineItem): boolean {
  return item.lifecycle === "permanent" && item.cadence === "rotating";
}

function itemEnd(item: TimelineItem): number | undefined {
  const periods = realPeriods(item);
  return periods.length ? Math.max(...periods.map((period) => period.end)) : undefined;
}

export function buildRotationRows(events: TimelineItem[], now: number): RotationRow[] {
  const groups = new Map<string, TimelineItem[]>();
  for (const event of events) {
    if (!event.rotationGroup) continue;
    const group = groups.get(event.rotationGroup) ?? [];
    group.push(event);
    groups.set(event.rotationGroup, group);
  }

  return [...groups.entries()].flatMap(([rotationGroup, groupEvents]) => {
    const cycles = groupEvents.filter(isRotationCycle);
    if (!cycles.length) return [];

    const label = cycles.find((item) => item.rotationLabel)?.rotationLabel ?? rotationGroup;
    const items: RotationChartItem[] = [...groupEvents].sort((a, b) => {
      const aEnd = itemEnd(a) ?? a.start;
      const bEnd = itemEnd(b) ?? b.start;
      return a.start - b.start || aEnd - bEnd || a.id.localeCompare(b.id);
    });
    const latestEnds = cycles.map(itemEnd).filter((end): end is number => end !== undefined);
    const hasUnknownEnd = cycles.some((item) => itemEnd(item) === undefined);
    if (latestEnds.length && !hasUnknownEnd) {
      const latestEnd = Math.max(...latestEnds);
      if (latestEnd <= now) {
        items.push({
          kind: "rotation-placeholder",
          key: `${rotationGroup}/placeholder`,
          rotationGroup,
          rotationLabel: label,
          start: latestEnd,
        });
      }
    }

    return [{
      key: `rotation/${rotationGroup}`,
      label,
      items,
      priority: Math.max(...groupEvents.map((item) => item.priority ?? 0)),
      start: Math.min(...groupEvents.map((item) => item.start)),
    }];
  });
}
