export const FILTER_NAMES = ["game", "region", "type", "status"] as const;

export type FilterName = typeof FILTER_NAMES[number];

export interface TimelinePreferences {
  filters: Partial<Record<FilterName, Record<string, boolean>>>;
  groupOpen: Record<string, boolean>;
}

export function emptyTimelinePreferences(): TimelinePreferences {
  return { filters: {}, groupOpen: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function booleanEntries(value: unknown): Record<string, boolean> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"),
  );
}

export function parseTimelinePreferences(raw: string | null): TimelinePreferences {
  if (!raw) return emptyTimelinePreferences();
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value)) return emptyTimelinePreferences();
    const rawFilters = isRecord(value.filters) ? value.filters : {};
    const filters: TimelinePreferences["filters"] = {};
    for (const name of FILTER_NAMES) {
      const entries = booleanEntries(rawFilters[name]);
      if (Object.keys(entries).length) filters[name] = entries;
    }
    return {
      filters,
      groupOpen: booleanEntries(value.groupOpen),
    };
  } catch {
    return emptyTimelinePreferences();
  }
}

export function preferenceValue(
  values: Record<string, boolean> | undefined,
  key: string,
  fallback: boolean,
): boolean {
  return values?.[key] ?? fallback;
}

export function defaultExpandedGameIds(
  groups: Array<{ game: { id: string } }>,
  limit = 3,
): Set<string> {
  const gameIds = new Set<string>();
  for (const group of groups) {
    gameIds.add(group.game.id);
    if (gameIds.size >= limit) break;
  }
  return gameIds;
}
