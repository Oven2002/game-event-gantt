import { access, readdir, rm } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { readJsonAtomic, tryFileLock, updateJsonAtomic, withFileLock, writeJsonAtomic } from "./files.ts";
import { sha256Schema, type Sha256 } from "../types.ts";
import { artifactPath, assertRunId, assertRuntimePathSafe, assertRuntimeRootSafe, runMetadataPath, runRoot } from "./run.ts";

const RUN_LOCK_STALE_MS = 120_000;

export function runLockPath(runtimeRoot: string, runId: string): string {
  assertRunId(runId);
  return join(runtimeRoot, "runs", runId, "run.lock");
}

export interface RunLockOptions {
  timeoutMs?: number;
}

export async function withRunLock<T>(runtimeRoot: string, runId: string, operation: () => Promise<T>, options: RunLockOptions = {}): Promise<T> {
  const lockPath = runLockPath(runtimeRoot, runId);
  await assertRuntimeRootSafe(runtimeRoot);
  await assertRuntimePathSafe(runtimeRoot, lockPath);
  return withFileLock(lockPath, operation, { staleMs: RUN_LOCK_STALE_MS, ...options });
}

async function tryRunLock<T>(runtimeRoot: string, runId: string, operation: () => Promise<T>): Promise<{ acquired: true; value: T } | { acquired: false }> {
  const lockPath = runLockPath(runtimeRoot, runId);
  await assertRuntimeRootSafe(runtimeRoot);
  await assertRuntimePathSafe(runtimeRoot, lockPath);
  return tryFileLock(lockPath, operation, { staleMs: RUN_LOCK_STALE_MS });
}

export interface AdapterCheckpoint {
  kind: string;
  value: unknown;
}

export interface CrawlerStateGame {
  checkpoint: AdapterCheckpoint | null;
  sourceHashes: Record<string, Sha256>;
}

export interface CrawlerState {
  schemaVersion: 1;
  games: Record<string, CrawlerStateGame>;
}

export type StateTransactionPhase = "fetching" | "state_pending";
export interface StateTransactionMarker {
  schemaVersion: 1;
  runId: string;
  game: string;
  rawPath: string;
  phase: StateTransactionPhase;
  sourceHashes: Record<string, Sha256> | null;
}

export interface StateTransactionWriteOptions {
  rename?: (from: string, to: string) => Promise<void>;
}

export function stateTransactionPath(runtimeRoot: string, runId: string): string {
  assertRunId(runId);
  return join(runtimeRoot, "runs", runId, "state-transaction.json");
}

export interface CheckpointSchemaRegistryEntry {
  kind: string;
  schema: { safeParse(value: unknown): { success: boolean; data?: unknown } };
}

export type CheckpointSchemaRegistry = Record<string, CheckpointSchemaRegistryEntry>;
export type KnownGameCheckpointKinds = Record<string, string | null>;

export class CrawlerStateError extends Error {
  public readonly code: "INVALID_STATE" | "INVALID_SCAN_MODE";

  constructor(code: "INVALID_STATE" | "INVALID_SCAN_MODE", message: string) {
    super(message);
    this.name = "CrawlerStateError";
    this.code = code;
  }
}

const stateShape = z.object({
  schemaVersion: z.literal(1),
  games: z.record(z.string(), z.object({
    checkpoint: z.object({ kind: z.string().min(1), value: z.unknown() }).strict().nullable(),
    sourceHashes: z.record(z.string().min(1), sha256Schema),
  }).strict()),
}).strict();

const stateTransactionShape = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().regex(/^\d{8}-\d{6}$/),
  game: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  rawPath: z.string().min(1),
  phase: z.enum(["fetching", "state_pending"]),
  sourceHashes: z.record(z.string().min(1), sha256Schema).nullable(),
}).strict().superRefine((value, ctx) => {
  if (value.phase === "fetching" && value.sourceHashes !== null) ctx.addIssue({ code: "custom", message: "fetching transaction must not contain source hashes" });
  if (value.phase === "state_pending" && value.sourceHashes === null) ctx.addIssue({ code: "custom", message: "state-pending transaction must contain source hashes" });
});

const runMetadataShape = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().regex(/^\d{8}-\d{6}$/),
  game: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
}).strict();

function validateStateTransaction(value: unknown): StateTransactionMarker {
  const parsed = stateTransactionShape.safeParse(value);
  if (!parsed.success) throw new CrawlerStateError("INVALID_STATE", "state transaction marker validation failed");
  return parsed.data as StateTransactionMarker;
}

async function trustedRunGame(runtimeRoot: string, runId: string, knownGames: ReadonlySet<string>): Promise<string> {
  const metadataPath = runMetadataPath(runtimeRoot, runId);
  await assertRuntimePathSafe(runtimeRoot, metadataPath);
  let value: unknown;
  try {
    value = await readJsonAtomic(metadataPath);
  } catch {
    throw new CrawlerStateError("INVALID_STATE", "run metadata is missing or invalid");
  }
  const parsed = runMetadataShape.safeParse(value);
  if (!parsed.success || parsed.data.runId !== runId || !knownGames.has(parsed.data.game)) {
    throw new CrawlerStateError("INVALID_STATE", "run metadata identity validation failed");
  }
  return parsed.data.game;
}

async function assertTransactionMarker(
  runtimeRoot: string,
  entryName: string,
  marker: StateTransactionMarker,
  knownGames: ReadonlySet<string>,
): Promise<void> {
  if (marker.runId !== entryName) throw new CrawlerStateError("INVALID_STATE", "state transaction marker run mismatch");
  const expectedGame = await trustedRunGame(runtimeRoot, marker.runId, knownGames);
  if (marker.game !== expectedGame) throw new CrawlerStateError("INVALID_STATE", "state transaction marker game mismatch");
  assertRunRootSafe(runtimeRoot, marker.runId);
  if (!isWithin(resolve(runtimeRoot), resolve(marker.rawPath))) {
    throw new CrawlerStateError("INVALID_STATE", "state transaction marker path escapes runtime root");
  }
  assertCanonicalRawPath(runtimeRoot, marker.runId, expectedGame, marker.rawPath);
  await assertRuntimePathSafe(runtimeRoot, marker.rawPath);
}

function isWithin(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`));
}

function canonicalRawPath(runtimeRoot: string, runId: string, game: string): string {
  return artifactPath(runtimeRoot, runId, "raw", "jsonl", game);
}

function assertCanonicalRawPath(runtimeRoot: string, runId: string, game: string, rawPath: string): void {
  if (resolve(rawPath) !== resolve(canonicalRawPath(runtimeRoot, runId, game))) {
    throw new CrawlerStateError("INVALID_STATE", "state transaction raw path is not canonical");
  }
}

function assertRunRootSafe(runtimeRoot: string, runId: string): void {
  const root = runRoot(runtimeRoot, runId);
  if (!isWithin(resolve(runtimeRoot), resolve(root))) throw new CrawlerStateError("INVALID_STATE", "state transaction path escapes runtime root");
}

async function removeRawAndTemps(rawPath: string): Promise<void> {
  await rm(rawPath, { force: true });
  let entries;
  try {
    entries = await readdir(dirname(rawPath), { withFileTypes: true });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const prefix = `${basename(rawPath)}.tmp-`;
  await Promise.all(entries.filter((entry) => entry.isFile() && entry.name.startsWith(prefix)).map((entry) => rm(join(dirname(rawPath), entry.name), { force: true })));
}

export async function beginStateTransaction(
  runtimeRoot: string,
  runId: string,
  game: string,
  rawPath: string,
  options: StateTransactionWriteOptions = {},
): Promise<void> {
  assertRunRootSafe(runtimeRoot, runId);
  assertCanonicalRawPath(runtimeRoot, runId, game, rawPath);
  await assertRuntimeRootSafe(runtimeRoot);
  await assertRuntimePathSafe(runtimeRoot, stateTransactionPath(runtimeRoot, runId));
  await assertRuntimePathSafe(runtimeRoot, rawPath);
  await writeJsonAtomic(stateTransactionPath(runtimeRoot, runId), {
    schemaVersion: 1,
    runId,
    game,
    rawPath,
    phase: "fetching",
    sourceHashes: null,
  }, options);
}

export async function markStateTransactionPending(
  runtimeRoot: string,
  transactionPath: string,
  runId: string,
  game: string,
  rawPath: string,
  sourceHashes: Record<string, Sha256>,
  options: StateTransactionWriteOptions = {},
): Promise<void> {
  assertRunRootSafe(runtimeRoot, runId);
  assertCanonicalRawPath(runtimeRoot, runId, game, rawPath);
  if (resolve(transactionPath) !== resolve(stateTransactionPath(runtimeRoot, runId))) {
    throw new CrawlerStateError("INVALID_STATE", "state transaction path is not canonical");
  }
  await assertRuntimeRootSafe(runtimeRoot);
  await assertRuntimePathSafe(runtimeRoot, transactionPath);
  await assertRuntimePathSafe(runtimeRoot, rawPath);
  await writeJsonAtomic(transactionPath, { schemaVersion: 1, runId, game, rawPath, phase: "state_pending", sourceHashes }, options);
}

export async function removeStateTransaction(transactionPath: string): Promise<void> {
  await rm(transactionPath, { force: true });
}

export async function abortStateTransaction(transactionPath: string, rawPath: string): Promise<void> {
  await removeRawAndTemps(rawPath);
  await removeStateTransaction(transactionPath);
}

async function latestStateForRecovery(runtimeRoot: string, fallback: CrawlerState): Promise<CrawlerState> {
  const statePath = join(runtimeRoot, "state.json");
  return withFileLock(statePath, async () => {
    try {
      const parsed = stateShape.safeParse(await readJsonAtomic(statePath));
      if (!parsed.success) throw new CrawlerStateError("INVALID_STATE", "state schema validation failed during recovery");
      return parsed.data as CrawlerState;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
      if (error instanceof CrawlerStateError) throw error;
      throw new CrawlerStateError("INVALID_STATE", "state file is not valid JSON during recovery");
    }
  });
}

export async function recoverStateTransactions(runtimeRoot: string, state: CrawlerState, knownGames: ReadonlySet<string>): Promise<void> {
  await assertRuntimeRootSafe(runtimeRoot);
  const runsDirectory = join(runtimeRoot, "runs");
  await assertRuntimePathSafe(runtimeRoot, runsDirectory);
  let entries;
  try {
    entries = await readdir(runsDirectory, { withFileTypes: true });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new CrawlerStateError("INVALID_STATE", `runtime runs directory contains a symlink: ${entry.name}`);
    if (!entry.isDirectory()) continue;
    const transactionPath = join(runsDirectory, entry.name, "state-transaction.json");
    await assertRuntimePathSafe(runtimeRoot, transactionPath);
    let value: unknown;
    try {
      value = await readJsonAtomic(transactionPath);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new CrawlerStateError("INVALID_STATE", "state transaction marker is not valid JSON");
    }
    const marker = validateStateTransaction(value);
    await assertTransactionMarker(runtimeRoot, entry.name, marker, knownGames);
    const result = await tryRunLock(runtimeRoot, marker.runId, async () => {
      let lockedValue: unknown;
      try {
        lockedValue = await readJsonAtomic(transactionPath);
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw new CrawlerStateError("INVALID_STATE", "state transaction marker is not valid JSON");
      }
      const lockedMarker = validateStateTransaction(lockedValue);
      await assertTransactionMarker(runtimeRoot, entry.name, lockedMarker, knownGames);
      const currentState = await latestStateForRecovery(runtimeRoot, state);
      const current = currentState.games[lockedMarker.game]?.sourceHashes;
      const committed = lockedMarker.phase === "state_pending"
        && lockedMarker.sourceHashes !== null
        && current !== undefined
        && Object.entries(lockedMarker.sourceHashes).every(([sourceId, contentHash]) => current[sourceId] === contentHash);
      if (!committed) await removeRawAndTemps(lockedMarker.rawPath);
      await removeStateTransaction(transactionPath);
      return true;
    });
    if (!result.acquired) continue;
  }
}


function validateState(value: unknown, checkpointSchemas: CheckpointSchemaRegistry, knownGames: KnownGameCheckpointKinds): CrawlerState {
  const parsed = stateShape.safeParse(value);
  if (!parsed.success) throw new CrawlerStateError("INVALID_STATE", "state schema validation failed");
  for (const [game, stateGame] of Object.entries(parsed.data.games)) {
    if (!(game in knownGames)) throw new CrawlerStateError("INVALID_STATE", `unknown game: ${game}`);
    const expectedKind = knownGames[game];
    if (stateGame.checkpoint === null) {
      if (expectedKind !== null) throw new CrawlerStateError("INVALID_STATE", `missing checkpoint for ${game}`);
      continue;
    }
    if (expectedKind !== stateGame.checkpoint.kind) throw new CrawlerStateError("INVALID_STATE", `checkpoint kind mismatch for ${game}`);
    const registry = checkpointSchemas[stateGame.checkpoint.kind];
    if (!registry || registry.kind !== stateGame.checkpoint.kind || !registry.schema.safeParse(stateGame.checkpoint.value).success) {
      throw new CrawlerStateError("INVALID_STATE", `checkpoint schema validation failed for ${game}`);
    }
  }
  return parsed.data as CrawlerState;
}

export async function loadState(
  statePath: string,
  checkpointSchemas: CheckpointSchemaRegistry,
  knownGames: KnownGameCheckpointKinds,
): Promise<CrawlerState> {
  try {
    await access(statePath);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: 1, games: {} };
    throw new CrawlerStateError("INVALID_STATE", "state file cannot be accessed");
  }
  let value: unknown;
  try {
    value = await readJsonAtomic(statePath);
  } catch {
    throw new CrawlerStateError("INVALID_STATE", "state file is not valid JSON");
  }
  return validateState(value, checkpointSchemas, knownGames);
}

export interface StateWriteOptions {
  checkpointSchemas: CheckpointSchemaRegistry;
  knownGames: KnownGameCheckpointKinds;
  rename?: (from: string, to: string) => Promise<void>;
}

export async function writeStateAtomic(statePath: string, state: CrawlerState, options: StateWriteOptions): Promise<void> {
  validateState(state, options.checkpointSchemas, options.knownGames);
  await writeJsonAtomic(statePath, state, options);
}

export async function updateStateAtomic(
  statePath: string,
  initialState: CrawlerState,
  updater: (current: CrawlerState) => CrawlerState | Promise<CrawlerState>,
  options: StateWriteOptions,
): Promise<CrawlerState> {
  return updateJsonAtomic(statePath, initialState, async (value) => {
    const current = validateState(value, options.checkpointSchemas, options.knownGames);
    const next = await updater(current);
    validateState(next, options.checkpointSchemas, options.knownGames);
    return next;
  }, options);
}

export function assertScanMode(options: { since?: string; full?: boolean }): void {
  if (options.since !== undefined && options.full === true) {
    throw new CrawlerStateError("INVALID_SCAN_MODE", "--since and --full are mutually exclusive");
  }
}
