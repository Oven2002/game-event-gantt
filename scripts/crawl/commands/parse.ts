import { randomUUID } from "node:crypto";
import { access, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { parseArticleCandidate } from "../parsers/article.ts";
import { CandidateItemSchema, CandidateRejectionSchema, RawArticleSchema, type CandidateItem, type CandidateRejection, type RawArticle } from "../types.ts";
import { loadEventTypeIds, validateCandidate } from "../common/candidate-validation.ts";
import { artifactDirectory, artifactPath, assertRunExists } from "../common/run.ts";
import { mihoyoGames } from "../mihoyo-config.ts";
import { hypergryphGames } from "../hypergryph-config.ts";

const configuredGames = {
  ...mihoyoGames,
  ...hypergryphGames,
};

export interface ParseCommandOptions {
  runtimeRoot: string;
  runId: string;
  eventTypesPath?: string;
  supportsVersionsByGame?: Record<string, boolean>;
  rename?: (from: string, to: string) => Promise<void>;
}

export interface ParseGameResult {
  game: string;
  rawPath: string;
  candidatesPath: string;
  rejectionsPath: string;
  ready: number;
  needsReview: number;
  rejections: number;
}

export interface ParseCommandResult {
  results: ParseGameResult[];
  ready: number;
  needsReview: number;
  rejections: number;
}

function outputPaths(runtimeRoot: string, runId: string, game: string): Pick<ParseGameResult, "candidatesPath" | "rejectionsPath"> {
  return {
    candidatesPath: artifactPath(runtimeRoot, runId, "candidates", "json", game),
    rejectionsPath: artifactPath(runtimeRoot, runId, "rejections"),
  };
}

async function assertAbsent(paths: string[]): Promise<void> {
  const present: string[] = [];
  for (const path of paths) {
    try {
      await access(path);
      present.push(path);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (present.length > 0) throw new Error(`parse artifacts already exist: ${present.join(", ")}`);
}

async function rawFiles(runtimeRoot: string, runId: string): Promise<string[]> {
  const directory = artifactDirectory(runtimeRoot, runId, "raw");
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`raw directory does not exist: ${directory}`);
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const path = join(directory, entry.name);
    if ((await stat(path)).isFile()) files.push(path);
  }
  files.sort();
  if (files.length === 0) throw new Error(`no raw JSONL files found for run: ${runId}`);
  return files;
}

function configuredGame(game: string): typeof configuredGames[keyof typeof configuredGames] {
  if (!(game in configuredGames)) throw new Error(`unknown raw game: ${game}`);
  return configuredGames[game as keyof typeof configuredGames];
}

function fileGame(rawPath: string): string {
  const game = basename(rawPath, ".jsonl");
  configuredGame(game);
  return game;
}

function rejectionForRaw(runId: string, game: string, raw: unknown, detail: string): CandidateRejection {
  const value = typeof raw === "object" && raw !== null ? raw as Record<string, unknown> : {};
  const sourceId = typeof value.sourceId === "string" && value.sourceId.length > 0 ? value.sourceId : "unknown";
  const candidateKey = typeof value.candidateKey === "string" && /^[^/]+\/[^/]+\/[^/]+$/.test(value.candidateKey) ? value.candidateKey : undefined;
  const result: CandidateRejection = {
    rawRef: { runId, game, sourceId },
    reasonCode: "candidate_validation_failed",
    detail,
  };
  if (candidateKey) result.candidateKey = candidateKey;
  return result;
}

function checkedRejection(value: CandidateRejection): CandidateRejection {
  const result = CandidateRejectionSchema.safeParse(value);
  if (!result.success) throw new Error(`rejection schema validation failed: ${result.error.message}`);
  return result.data;
}

async function parseRawFile(rawPath: string, options: ParseCommandOptions, eventTypeIds: string[]): Promise<{ candidates: CandidateItem[]; rejections: CandidateRejection[] }> {
  const game = fileGame(rawPath);
  const config = configuredGame(game);
  const supportsVersions = options.supportsVersionsByGame?.[game] ?? config.supportsVersions;
  const lines = (await readFile(rawPath, "utf8")).split(/\r?\n/);
  const candidates: CandidateItem[] = [];
  const rejections: CandidateRejection[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      rejections.push(checkedRejection(rejectionForRaw(options.runId, game, undefined, `raw JSONL line ${index + 1} is not valid JSON`)));
      continue;
    }
    const rawResult = RawArticleSchema.safeParse(value);
    if (!rawResult.success) {
      rejections.push(checkedRejection(rejectionForRaw(options.runId, game, value, `raw article schema validation failed: ${rawResult.error.message}`)));
      continue;
    }
    const raw = rawResult.data as RawArticle;
    if (raw.game !== game) {
      rejections.push(checkedRejection(rejectionForRaw(options.runId, game, raw, "raw article game does not match its JSONL file")));
      continue;
    }
    try {
      const candidate = parseArticleCandidate(raw, options.runId, "primary");
      const validation = validateCandidate(candidate, { supportsVersions, eventTypeIds, rawArticle: raw });
      if (!validation.ok) {
        rejections.push(checkedRejection(validation.rejection));
        continue;
      }
      const checkedCandidate = CandidateItemSchema.safeParse(validation.candidate);
      if (!checkedCandidate.success) {
        rejections.push(checkedRejection(rejectionForRaw(options.runId, game, raw, `candidate schema validation failed: ${checkedCandidate.error.message}`)));
        continue;
      }
      candidates.push(checkedCandidate.data as CandidateItem);
    } catch (error) {
      rejections.push(checkedRejection(rejectionForRaw(options.runId, game, raw, error instanceof Error ? error.message : String(error))));
    }
  }
  return { candidates, rejections };
}

interface PendingOutput {
  path: string;
  content: string;
}

async function writeOutputsAtomic(outputs: PendingOutput[], renameOutput: ParseCommandOptions["rename"]): Promise<void> {
  const temporaryPaths = outputs.map((output) => ({
    output,
    temporary: `${output.path}.tmp-${process.pid}-${randomUUID()}`,
  }));
  const committed: string[] = [];
  try {
    for (const { output, temporary } of temporaryPaths) {
      await mkdir(dirname(output.path), { recursive: true });
      await writeFile(temporary, output.content, "utf8");
    }
    const renameFile = renameOutput ?? rename;
    for (const { output, temporary } of temporaryPaths) {
      await renameFile(temporary, output.path);
      committed.push(output.path);
    }
  } catch (error) {
    for (const { temporary } of temporaryPaths) await rm(temporary, { force: true }).catch(() => undefined);
    for (const path of committed) await rm(path, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function parseRun(options: ParseCommandOptions): Promise<ParseCommandResult> {
  await assertRunExists(options.runtimeRoot, options.runId);
  const files = await rawFiles(options.runtimeRoot, options.runId);
  const outputByFile = files.map((rawPath) => {
    const game = fileGame(rawPath);
    return { rawPath, game, output: outputPaths(options.runtimeRoot, options.runId, game) };
  });
  const rejectionPath = artifactPath(options.runtimeRoot, options.runId, "rejections");
  await assertAbsent([...new Set([
    rejectionPath,
    ...outputByFile.map(({ output }) => output.candidatesPath),
  ])]);
  const eventTypeIds = await loadEventTypeIds(options.eventTypesPath ?? resolve(process.cwd(), "data/event-types.yaml"));
  const results: ParseGameResult[] = [];
  const outputs: PendingOutput[] = [];
  const allRejections: CandidateRejection[] = [];
  for (const { rawPath, game, output } of outputByFile) {
    const parsed = await parseRawFile(rawPath, options, eventTypeIds);
    allRejections.push(...parsed.rejections);
    outputs.push({ path: output.candidatesPath, content: `${JSON.stringify(parsed.candidates)}\n` });
    results.push({
      game,
      rawPath,
      candidatesPath: output.candidatesPath,
      rejectionsPath: rejectionPath,
      ready: parsed.candidates.filter((candidate) => candidate.review === "ready").length,
      needsReview: parsed.candidates.filter((candidate) => candidate.review === "needs_review").length,
      rejections: parsed.rejections.length,
    });
  }
  outputs.push({
    path: rejectionPath,
    content: allRejections.length ? `${allRejections.map((value) => JSON.stringify(value)).join("\n")}\n` : "",
  });
  await writeOutputsAtomic(outputs, options.rename);
  return {
    results,
    ready: results.reduce((total, result) => total + result.ready, 0),
    needsReview: results.reduce((total, result) => total + result.needsReview, 0),
    rejections: results.reduce((total, result) => total + result.rejections, 0),
  };
}
