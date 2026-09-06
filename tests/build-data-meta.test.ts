import { describe, expect, it } from "vitest";
import type { TimelinePayload } from "../src/lib/types.ts";
import { buildSiteMeta } from "../scripts/build-data-meta.ts";

// A minimal payload with two groups; counts come from versions+events totals.
const samplePayload: TimelinePayload = {
  generatedAt: 0,
  eventTypes: [],
  groups: [
    {
      key: "game-a/cn",
      game: { id: "game-a", name: "游戏A" },
      region: { id: "cn", name: "国服" },
      versions: [{ start: 1, end: 2 } as never],
      events: [{ start: 3 } as never],
    },
    {
      key: "game-b/cn",
      game: { id: "game-b", name: "游戏B" },
      region: { id: "cn", name: "国服" },
      versions: [],
      events: [{ start: 4 } as never],
    },
  ],
  bounds: { start: 1, end: 4 },
};

describe("buildSiteMeta", () => {
  it("formats a Z-offset timestamp into a Beijing label", () => {
    const meta = { dataUpdatedAt: "2026-09-05T17:38:48Z", dataCommit: "cd24bed" };
    expect(buildSiteMeta(meta, samplePayload)).toEqual({
      dataUpdatedAtLabel: "2026/09/06 01:38",
      groups: 2,
      items: 3,
      dataCommit: "cd24bed",
    });
  });

  it("normalizes a +08:00 timestamp to the same Beijing label", () => {
    const meta = { dataUpdatedAt: "2026-09-06T01:38:48+08:00", dataCommit: "cd24bed" };
    expect(buildSiteMeta(meta, samplePayload)).toEqual({
      dataUpdatedAtLabel: "2026/09/06 01:38",
      groups: 2,
      items: 3,
      dataCommit: "cd24bed",
    });
  });

  it("counts items as versions + events across all groups", () => {
    const meta = { dataUpdatedAt: "2026-09-05T17:38:48Z", dataCommit: "cd24bed" };
    const payload = {
      ...samplePayload,
      groups: [
        ...samplePayload.groups,
        {
          key: "game-c/cn",
          game: { id: "game-c", name: "游戏C" },
          region: { id: "cn", name: "国服" },
          versions: [{ start: 9 } as never, { start: 10 } as never],
          events: [],
        },
      ],
    };
    expect(buildSiteMeta(meta, payload)?.items).toBe(5);
    expect(buildSiteMeta(meta, payload)?.groups).toBe(3);
  });

  it("returns null when data meta is missing", () => {
    expect(buildSiteMeta(null, samplePayload)).toBeNull();
  });
});
