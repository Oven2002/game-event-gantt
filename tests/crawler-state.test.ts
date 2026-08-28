import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expect, it } from "vitest";
import { readJsonAtomic, writeJsonAtomic } from "../scripts/crawl/common/files.ts";
import { beginStateTransaction, markStateTransactionPending, recoverStateTransactions, assertScanMode, loadState, stateTransactionPath, writeStateAtomic, withRunLock, type CrawlerState } from "../scripts/crawl/common/state.ts";
import { createRun } from "../scripts/crawl/common/run.ts";

const registry = {
  page: {
    kind: "page",
    schema: { safeParse: (value: unknown) => ({ success: typeof value === "number" && Number.isInteger(value), data: value }) },
  },
};
const knownGames = { demo: "page", noCheckpoint: null };
const recoveryGames = new Set(Object.keys(knownGames));
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
  const rawPath = join(root, "raw", runId, "demo.jsonl");
  const sourceHash = `sha256:${"a".repeat(64)}` as never;
  await createRun(root, runId, "demo");
  await mkdir(dirname(rawPath), { recursive: true });
  await writeFile(rawPath, "raw\n", "utf8");
  await writeStateAtomic(join(root, "state.json"), {
    schemaVersion: 1,
    games: { demo: { checkpoint: { kind: "page", value: 1 }, sourceHashes: { article: sourceHash } } },
  }, { checkpointSchemas: registry, knownGames });
  const transactionPath = stateTransactionPath(root, runId);
  await beginStateTransaction(root, runId, "demo", rawPath);
  await markStateTransactionPending(root, transactionPath, runId, "demo", rawPath, { article: sourceHash });
  await recoverStateTransactions(root, { schemaVersion: 1, games: {} }, recoveryGames);
  await expect(readFile(rawPath, "utf8")).resolves.toBe("raw\n");
});

it("skips recovery cleanup for a run that still owns its run lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "crawler-state-live-"));
  const runId = "20260827-000011";
  await createRun(root, runId, "demo");
  const rawPath = join(root, "raw", runId, "demo.jsonl");
  await mkdir(dirname(rawPath), { recursive: true });
  await writeFile(rawPath, "raw\n", "utf8");
  await writeFile(join(root, "raw", runId, "demo.jsonl.tmp-1-abc"), "partial\n", "utf8");
  await writeJsonAtomic(stateTransactionPath(root, runId), {
    schemaVersion: 1,
    runId,
    game: "demo",
    rawPath,
    phase: "fetching",
    sourceHashes: null,
  });
  let markAcquired!: () => void;
  const acquired = new Promise<void>((resolveAcquired) => { markAcquired = resolveAcquired; });
  let release!: () => void;
  const held = new Promise<void>((resolveRelease) => { release = resolveRelease; });
  const activeRun = withRunLock(root, runId, async () => {
    markAcquired();
    await held;
  });
  await acquired;
  await recoverStateTransactions(root, { schemaVersion: 1, games: {} }, recoveryGames);
  await expect(readFile(rawPath, "utf8")).resolves.toBe("raw\n");
  await expect(readJsonAtomic(stateTransactionPath(root, runId))).resolves.toMatchObject({ phase: "fetching" });
  release();
  await activeRun;
});

it("rejects a non-canonical raw path before writing a transaction", async () => {
  const root = await mkdtemp(join(tmpdir(), "crawler-state-path-"));
  const runId = "20260827-000012";
  await createRun(root, runId, "demo");
  const invalidRawPath = join(root, "raw", runId, "other.jsonl");
  await expect(beginStateTransaction(root, runId, "demo", invalidRawPath)).rejects.toMatchObject({ code: "INVALID_STATE" });
});

it("fails closed on a symlinked raw parent during recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "crawler-state-symlink-"));
  const outside = await mkdtemp(join(tmpdir(), "crawler-state-outside-"));
  const runId = "20260827-000013";
  await createRun(root, runId, "demo");
  await mkdir(join(root, "raw"), { recursive: true });
  const rawRunDirectory = join(root, "raw", runId);
  await symlink(outside, rawRunDirectory, "dir");
  const outsideRaw = join(outside, "demo.jsonl");
  await writeFile(outsideRaw, "protected\n", "utf8");
  await writeJsonAtomic(stateTransactionPath(root, runId), {
    schemaVersion: 1,
    runId,
    game: "demo",
    rawPath: join(rawRunDirectory, "demo.jsonl"),
    phase: "fetching",
    sourceHashes: null,
  });
  await expect(recoverStateTransactions(root, { schemaVersion: 1, games: {} }, recoveryGames)).rejects.toThrow(/symlink|runtime path/i);
  await expect(readFile(outsideRaw, "utf8")).resolves.toBe("protected\n");
});

it("fails closed on a symlinked run entry during recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "crawler-state-run-entry-"));
  const outside = await mkdtemp(join(tmpdir(), "crawler-state-run-outside-"));
  await mkdir(join(root, "runs"), { recursive: true });
  await symlink(outside, join(root, "runs", "20260827-000014"), "dir");
  await expect(recoverStateTransactions(root, { schemaVersion: 1, games: {} }, recoveryGames)).rejects.toThrow(/symlink|runtime path/i);
});

it("rejects a tampered marker even while its run lock is held", async () => {
  const root = await mkdtemp(join(tmpdir(), "crawler-state-tampered-"));
  const runId = "20260827-000015";
  await createRun(root, runId, "demo");
  await writeJsonAtomic(stateTransactionPath(root, runId), {
    schemaVersion: 1,
    runId,
    game: "demo",
    rawPath: join(root, "raw", runId, "other.jsonl"),
    phase: "fetching",
    sourceHashes: null,
  });
  let markAcquired!: () => void;
  const acquired = new Promise<void>((resolveAcquired) => { markAcquired = resolveAcquired; });
  let release!: () => void;
  const held = new Promise<void>((resolveRelease) => { release = resolveRelease; });
  const activeRun = withRunLock(root, runId, async () => {
    markAcquired();
    await held;
  });
  await acquired;
  await expect(recoverStateTransactions(root, { schemaVersion: 1, games: {} }, recoveryGames)).rejects.toMatchObject({ code: "INVALID_STATE" });
  release();
  await activeRun;
});

it("rejects a marker that changes game and raw path together", async () => {
  const root = await mkdtemp(join(tmpdir(), "crawler-state-game-tampered-"));
  const runId = "20260827-000016";
  await createRun(root, runId, "demo");
  await writeJsonAtomic(stateTransactionPath(root, runId), {
    schemaVersion: 1,
    runId,
    game: "other-game",
    rawPath: join(root, "raw", runId, "other-game.jsonl"),
    phase: "fetching",
    sourceHashes: null,
  });
  await expect(recoverStateTransactions(root, { schemaVersion: 1, games: {} }, recoveryGames)).rejects.toMatchObject({ code: "INVALID_STATE" });
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