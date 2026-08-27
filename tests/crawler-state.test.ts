import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { writeJsonAtomic } from "../scripts/crawl/common/files.ts";
import { beginStateTransaction, markStateTransactionPending, recoverStateTransactions, assertScanMode, loadState, stateTransactionPath, writeStateAtomic, type CrawlerState } from "../scripts/crawl/common/state.ts";

const registry = {
  page: {
    kind: "page",
    schema: { safeParse: (value: unknown) => ({ success: typeof value === "number" && Number.isInteger(value), data: value }) },
  },
};
const knownGames = { demo: "page", noCheckpoint: null };
const state: CrawlerState = { schemaVersion: 1, games: { noCheckpoint: { checkpoint: null, sourceHashes: {} } } };

function runStateWorker(args: string[]): Promise<void> {
  return new Promise((finish, fail) => {
    execFile("node", ["--experimental-strip-types", "tests/helpers/crawler-state-worker.ts", ...args], { cwd: resolve(".") }, (error, _stdout, stderr) => {
      if (error) fail(new Error(stderr || error.message));
      else finish();
    });
  });
}

it("rejects traversal in transaction run ids", () => {
  expect(() => stateTransactionPath("/tmp/runtime", "../escape")).toThrow(/run-id/i);
});

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
  await writeStateAtomic(path, state, { checkpointSchemas: registry, knownGames });
  await expect(loadState(path, registry, knownGames)).resolves.toEqual(state);
});

it("preserves the previous state when atomic replacement fails", async () => {
  const path = "/tmp/gameg-task2-state/atomic.json";
  await writeStateAtomic(path, state, { checkpointSchemas: registry, knownGames });
  await expect(writeStateAtomic(path, { schemaVersion: 1, games: {} }, {
    checkpointSchemas: registry,
    knownGames,
    rename: async () => { throw new Error("rename failed"); },
  })).rejects.toThrow("rename failed");
  await expect(loadState(path, registry, knownGames)).resolves.toEqual(state);
});

it("fails closed before writing an unknown game", async () => {
  await expect(writeStateAtomic("/tmp/gameg-task2-state/rejected.json", {
    schemaVersion: 1,
    games: { unknown: { checkpoint: null, sourceHashes: {} } },
  }, { checkpointSchemas: registry, knownGames })).rejects.toMatchObject({ code: "INVALID_STATE" });
});

it("rejects mutually exclusive scan modes", () => {
  expect(() => assertScanMode({ since: "2026-08-01", full: true })).toThrow(/mutually exclusive/);
  expect(() => assertScanMode({ since: "2026-08-01" })).not.toThrow();
  expect(() => assertScanMode({ full: true })).not.toThrow();
});

it("recovers against the latest on-disk state instead of a stale snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "crawler-state-recovery-"));
  const runId = "20260827-000010";
  const rawPath = join(root, "raw", "article.jsonl");
  const sourceHash = `sha256:${"a".repeat(64)}` as never;
  await mkdir(join(root, "raw"), { recursive: true });
  await writeFile(rawPath, "raw\n", "utf8");
  await writeStateAtomic(join(root, "state.json"), {
    schemaVersion: 1,
    games: { demo: { checkpoint: { kind: "page", value: 1 }, sourceHashes: { article: sourceHash } } },
  }, { checkpointSchemas: registry, knownGames });
  const transactionPath = stateTransactionPath(root, runId);
  await beginStateTransaction(root, runId, "demo", rawPath);
  await markStateTransactionPending(transactionPath, runId, "demo", rawPath, { article: sourceHash });
  await recoverStateTransactions(root, { schemaVersion: 1, games: {} });
  await expect(readFile(rawPath, "utf8")).resolves.toBe("raw\n");
});

it("merges state updates from independent processes", async () => {
  const root = await mkdtemp(join(tmpdir(), "crawler-state-workers-"));
  const statePath = join(root, "state.json");
  await Promise.all([
    runStateWorker([statePath, "genshin-impact", "g1"]),
    runStateWorker([statePath, "honkai-star-rail", "s1"]),
  ]);
  const stored = JSON.parse(await readFile(statePath, "utf8")) as CrawlerState;
  expect(stored.games["genshin-impact"].sourceHashes).toHaveProperty("g1");
  expect(stored.games["honkai-star-rail"].sourceHashes).toHaveProperty("s1");
});