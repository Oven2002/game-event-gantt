import { access } from "node:fs/promises";
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
