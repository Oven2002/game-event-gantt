import { access, readdir, rm } from "node:fs/promises";
import { dirname, basename, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { readJsonAtomic, writeJsonAtomic } from "./files.ts";
import { sha256Schema, type Sha256 } from "../types.ts";

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

const transactionRunIdPattern = /^\d{8}-\d{6}$/;

export function stateTransactionPath(runtimeRoot: string, runId: string): string {
  if (!transactionRunIdPattern.test(runId)) throw new Error(`invalid run-id: ${runId}`);
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

function validateStateTransaction(value: unknown): StateTransactionMarker {
  const parsed = stateTransactionShape.safeParse(value);
  if (!parsed.success) throw new CrawlerStateError("INVALID_STATE", "state transaction marker validation failed");
  return parsed.data as StateTransactionMarker;
}

function isWithin(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`));
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
  transactionPath: string,
  runId: string,
  game: string,
  rawPath: string,
  sourceHashes: Record<string, Sha256>,
  options: StateTransactionWriteOptions = {},
): Promise<void> {
  await writeJsonAtomic(transactionPath, { schemaVersion: 1, runId, game, rawPath, phase: "state_pending", sourceHashes }, options);
}

export async function removeStateTransaction(transactionPath: string): Promise<void> {
  await rm(transactionPath, { force: true });
}

export async function abortStateTransaction(transactionPath: string, rawPath: string): Promise<void> {
  await removeRawAndTemps(rawPath);
  await removeStateTransaction(transactionPath);
}

export async function recoverStateTransactions(runtimeRoot: string, state: CrawlerState): Promise<void> {
  const runsDirectory = join(runtimeRoot, "runs");
  let entries;
  try {
    entries = await readdir(runsDirectory, { withFileTypes: true });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const transactionPath = join(runsDirectory, entry.name, "state-transaction.json");
    let value: unknown;
    try {
      value = await readJsonAtomic(transactionPath);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new CrawlerStateError("INVALID_STATE", "state transaction marker is not valid JSON");
    }
    const marker = validateStateTransaction(value);
    if (marker.runId !== entry.name || !isWithin(resolve(runtimeRoot), resolve(marker.rawPath))) {
      throw new CrawlerStateError("INVALID_STATE", "state transaction marker path or run mismatch");
    }
    const current = state.games[marker.game]?.sourceHashes;
    const committed = marker.phase === "state_pending"
      && marker.sourceHashes !== null
      && current !== undefined
      && Object.entries(marker.sourceHashes).every(([sourceId, contentHash]) => current[sourceId] === contentHash);
    if (!committed) await removeRawAndTemps(marker.rawPath);
    await removeStateTransaction(transactionPath);
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

export function assertScanMode(options: { since?: string; full?: boolean }): void {
  if (options.since !== undefined && options.full === true) {
    throw new CrawlerStateError("INVALID_SCAN_MODE", "--since and --full are mutually exclusive");
  }
}
