import { expect, it } from "vitest";
import { writeJsonAtomic } from "../scripts/crawl/common/files.ts";
import { assertScanMode, loadState, writeStateAtomic, type CrawlerState } from "../scripts/crawl/common/state.ts";

const registry = {
  page: {
    kind: "page",
    schema: { safeParse: (value: unknown) => ({ success: typeof value === "number" && Number.isInteger(value), data: value }) },
  },
};
const knownGames = { demo: "page", noCheckpoint: null };
const state: CrawlerState = { schemaVersion: 1, games: { noCheckpoint: { checkpoint: null, sourceHashes: {} } } };

it("fails closed for malformed JSON and wrong schema versions", async () => {
  const path = "/tmp/gameg-task2-state/malformed.json";
  await writeJsonAtomic(path, "not-json");
  await expect(loadState(path, registry, knownGames)).rejects.toMatchObject({ code: "INVALID_STATE" });
  await writeJsonAtomic(path, { schemaVersion: 2, games: {} });
  await expect(loadState(path, registry, knownGames)).rejects.toMatchObject({ code: "INVALID_STATE" });
});

it("rejects unknown checkpoint kinds and accepts null checkpoints", async () => {
  const path = "/tmp/gameg-task2-state/checkpoint.json";
  await writeJsonAtomic(path, { schemaVersion: 1, games: { demo: { checkpoint: { kind: "offset", value: 1 }, sourceHashes: {} } } });
  await expect(loadState(path, registry, knownGames)).rejects.toMatchObject({ code: "INVALID_STATE" });
  await writeStateAtomic(path, state);
  await expect(loadState(path, registry, knownGames)).resolves.toEqual(state);
});

it("preserves the previous state when atomic replacement fails", async () => {
  const path = "/tmp/gameg-task2-state/atomic.json";
  await writeStateAtomic(path, state);
  await expect(writeStateAtomic(path, { schemaVersion: 1, games: {} }, {
    rename: async () => { throw new Error("rename failed"); },
  })).rejects.toThrow("rename failed");
  await expect(loadState(path, registry, knownGames)).resolves.toEqual(state);
});

it("rejects mutually exclusive scan modes", () => {
  expect(() => assertScanMode({ since: "2026-08-01", full: true })).toThrow(/mutually exclusive/);
  expect(() => assertScanMode({ since: "2026-08-01" })).not.toThrow();
  expect(() => assertScanMode({ full: true })).not.toThrow();
});
