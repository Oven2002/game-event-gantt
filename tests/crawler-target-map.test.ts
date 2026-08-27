import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CandidateTargetMapSchema } from "../scripts/crawl/types.ts";
import { loadCandidateTargetMap, buildDataIndex } from "../scripts/crawl/common/diff.ts";

const mapEntry = {
  candidateKey: "genshin-impact/old-1/primary",
  game: "genshin-impact",
  region: "cn",
  kind: "event",
  targetFile: "data/genshin-impact/cn-2026.yaml",
  targetId: "old-event",
  appliedRunId: "20260827-000001",
  appliedAt: "2026-08-27T00:00:00+00:00",
};

describe("crawler target map", () => {
  it("accepts the fixed empty registry shape and rejects duplicate candidate keys", () => {
    expect(CandidateTargetMapSchema.safeParse({ schemaVersion: 1, entries: [] }).success).toBe(true);
    expect(CandidateTargetMapSchema.safeParse({ schemaVersion: 1, entries: [], extra: true }).success).toBe(false);
    expect(CandidateTargetMapSchema.safeParse({ schemaVersion: 1, entries: [mapEntry, mapEntry] }).success).toBe(false);
  });

  it("accepts the committed empty registry", async () => {
    await expect(loadCandidateTargetMap("scripts/crawl/candidate-target-map.json")).resolves.toEqual([]);
    expect(await readFile("scripts/crawl/candidate-target-map.json", "utf8")).toBe('{"schemaVersion":1,"entries":[]}\n');
  });

  it("indexes every current formal data file", async () => {
    const index = await buildDataIndex("data");
    expect(index.files).toHaveLength(15);
    expect(index.targets.size).toBe(441);
  });

  it("preserves a non-cn region instead of coercing it to cn", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "crawler-review-region-data-"));
    const gameRoot = join(dataRoot, "genshin-impact");
    await mkdir(gameRoot, { recursive: true });
    await writeFile(join(gameRoot, "tw-2026.yaml"), "game: genshin-impact\nregion: tw\nevents:\n  - id: tw-event\n    name: 台服活动\n    type: event\n    start: \"2026-07-01T04:00:00+08:00\"\n    sources:\n      - \"https://ys.mihoyo.com/main/news/detail/tw\"\n", "utf8");
    const index = await buildDataIndex(dataRoot);
    expect(index.targets.get("genshin-impact/tw/event/tw-event")?.region).toBe("tw");
  });

  it("rejects a candidate remapping while allowing shared targets", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "crawler-target-map-")), "map.json");
    await writeFile(path, JSON.stringify({ schemaVersion: 1, entries: [mapEntry, { ...mapEntry, candidateKey: "genshin-impact/old-2/primary" }] }), "utf8");
    await expect(loadCandidateTargetMap(path)).resolves.toHaveLength(2);
    await writeFile(path, JSON.stringify({ schemaVersion: 1, entries: [mapEntry, { ...mapEntry, targetId: "another-event" }] }), "utf8");
    await expect(loadCandidateTargetMap(path)).rejects.toThrow(/candidateKey.*(?:mapping|duplicate)|不能重复|remap/i);
  });

  it("rejects mappings whose identity and target file disagree", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "crawler-target-map-identity-")), "map.json");
    await writeFile(path, JSON.stringify({ schemaVersion: 1, entries: [{ ...mapEntry, game: "honkai-star-rail" }] }), "utf8");
    await expect(loadCandidateTargetMap(path)).rejects.toThrow(/identity|target file|game/i);
  });

  it("fails closed when the durable registry is missing", async () => {
    await expect(loadCandidateTargetMap("/tmp/crawler-target-map-does-not-exist.json")).rejects.toThrow(/missing|not found|ENOENT/i);
  });
});
