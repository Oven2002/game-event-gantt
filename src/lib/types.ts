export type TimelineStatus = "upcoming" | "ongoing" | "ended";
export type TimeCertainty = "confirmed" | "inferred" | "estimated" | "unknown";
export type EventSubtype =
  | "main_event" | "login_reward" | "web_event" | "collaboration" | "story"
  | "shop" | "exchange" | "challenge" | "season" | "competition"
  | "creator_campaign" | "permanent_content"
  | "character" | "weapon" | "standard" | "outfit" | "mixed"
  | "scheduled" | "hotfix" | "non_downtime" | "preload"
  | "special_program" | "livestream" | "pv" | "announcement";

export interface NamedId {
  id: string;
  name: string;
}

// All timestamps are Unix milliseconds. Intervals are half-open: a period
// includes its start and excludes its end, matching maintenance/release
// boundaries (e.g. "until 04:00" means 03:59 is still active).
export interface TimelineItem {
  key: string;
  id: string;
  kind: "version" | "event";
  name: string;
  typeId: string;
  typeName: string;
  start: number;
  end?: number;
  periods: Array<{ start: number; end: number }>;
  lifecycle?: "limited" | "permanent";
  cadence?: "one_off" | "rotating" | "recurring";
  subtype?: EventSubtype;
  timeCertainty?: { start: TimeCertainty; end?: TimeCertainty };
  related: string[];
  url?: string;
  sources: string[];
  note?: string;
  priority?: number;
  sourceFile: string;
}

export interface TimelineGroup {
  key: string;
  game: NamedId & { priority?: number };
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

// Status is derived per-period when the item has multiple periods: active
// inside any period, upcoming while a future period exists (including gaps
// between periods), and ended only after the last period. Without explicit
// periods, the single start/end window is treated as the only period.
export function statusAt(item: Pick<TimelineItem, "start" | "end"> & { periods?: Array<{ start: number; end: number }> }, now: number): TimelineStatus {
  if (item.periods?.length) {
    if (item.periods.some((period) => now >= period.start && now < period.end)) return "ongoing";
    if (item.periods.some((period) => now < period.start)) return "upcoming";
    return "ended";
  }
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
