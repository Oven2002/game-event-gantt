export type TimelineStatus = "upcoming" | "ongoing" | "ended";

export interface NamedId {
  id: string;
  name: string;
}

export interface TimelineItem {
  key: string;
  id: string;
  kind: "version" | "event";
  name: string;
  typeId: string;
  typeName: string;
  start: number;
  end?: number;
  related: string[];
  url?: string;
  sources: string[];
  note?: string;
  sourceFile: string;
}

export interface TimelineGroup {
  key: string;
  game: NamedId;
  region: NamedId;
  versions: TimelineItem[];
  events: TimelineItem[];
}

export interface TimelinePayload {
  generatedAt: number;
  eventTypes: NamedId[];
  groups: TimelineGroup[];
  bounds: { start: number; end: number };
}

export function statusAt(item: Pick<TimelineItem, "start" | "end">, now: number): TimelineStatus {
  if (now < item.start) return "upcoming";
  if (item.end === undefined || now >= item.end) return "ended";
  return "ongoing";
}

export function packIntoLanes<T extends Pick<TimelineItem, "start" | "end">>(items: T[]): T[][] {
  const lanes: T[][] = [];
  const laneEnds: number[] = [];
  const sorted = [...items].sort((a, b) => a.start - b.start || (a.end ?? a.start) - (b.end ?? b.start));

  for (const item of sorted) {
    const itemEnd = item.end ?? item.start + 1;
    const availableLane = laneEnds.findIndex((end) => end <= item.start);
    const laneIndex = availableLane === -1 ? lanes.length : availableLane;
    if (!lanes[laneIndex]) lanes[laneIndex] = [];
    lanes[laneIndex].push(item);
    laneEnds[laneIndex] = itemEnd;
  }

  return lanes;
}
