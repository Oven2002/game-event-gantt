import { pathToFileURL } from "node:url";
import { join, resolve } from "node:path";
import { fetchGame, type FetchAdapter, type FetchCommandOptions, type FetchCommandResult } from "./commands/fetch.ts";
import { parseRun, type ParseCommandResult } from "./commands/parse.ts";
import { createRun, artifactPath, assertRuntimeRootSafe } from "./common/run.ts";
import { readJsonl } from "./common/files.ts";
import { sha256Utf8 } from "./common/hash.ts";
import { abortStateTransaction, beginStateTransaction, loadState, markStateTransactionPending, recoverStateTransactions, removeStateTransaction, stateTransactionPath, writeStateAtomic, type CrawlerState } from "./common/state.ts";
import { RawArticleSchema, type Sha256 } from "./types.ts";
import { buildHypergryphListRequest, displayTimeToBeijing, normalizeHypergryphContent, parseHypergryphDetail, parseHypergryphList, type HypergryphListPage } from "./adapters/hypergryph.ts";
import { hypergryphGames } from "./hypergryph-config.ts";
import { buildMihoyoDetailRequest, buildMihoyoListRequest, parseMihoyoDetail, parseMihoyoList, type MihoyoListPage } from "./adapters/mihoyo.ts";
import { mihoyoGames } from "./mihoyo-config.ts";
import { normalizeContent as normalizeMihoyoContent } from "./common/content.ts";

export type CrawlGame = "genshin-impact" | "honkai-star-rail" | "zenless-zone-zero" | "arknights" | "arknights-endfield";
export type CrawlCommand = "fetch" | "parse" | "review" | "approve";
export interface CliArgs { command: CrawlCommand; game?: CrawlGame; since?: string; full?: boolean; run?: string; selection?: string; }

const games = new Set<CrawlGame>(["genshin-impact", "honkai-star-rail", "zenless-zone-zero", "arknights", "arknights-endfield"]);
const runPattern = /^\d{8}-\d{6}$/;

export function createRunId(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
}

function valueAfter(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

export function parseCliArgs(argv: string[]): CliArgs {
  const command = argv[0] as CrawlCommand | undefined;
  if (!command || !["fetch", "parse", "review", "approve"].includes(command)) throw new Error("unknown command");
  const result: CliArgs = { command, full: false };
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--game") {
      const game = valueAfter(argv, index, flag) as CrawlGame;
      if (!games.has(game)) throw new Error("unknown game");
      result.game = game; index += 1;
    } else if (flag === "--since") {
      result.since = valueAfter(argv, index, flag); index += 1;
    } else if (flag === "--full") {
      result.full = true;
    } else if (flag === "--run") {
      const run = valueAfter(argv, index, flag);
      if (!runPattern.test(run)) throw new Error("invalid run-id");
      result.run = run; index += 1;
    } else if (flag === "--selection") {
      result.selection = valueAfter(argv, index, flag); index += 1;
    } else {
      throw new Error(`unknown flag: ${flag}`);
    }
  }
  if (result.since && result.full) throw new Error("--since and --full are mutually exclusive");
  if (command === "fetch") {
    if (!result.game) throw new Error("fetch requires --game");
    if (!result.since && !result.full) throw new Error("fetch requires --since or --full");
    if (result.run || result.selection) throw new Error("fetch does not accept --run or --selection");
  } else {
    if (!result.run) throw new Error(`${command} requires --run`);
    if (result.game || result.since || result.full) throw new Error(`${command} does not accept fetch scan options`);
  }
  if (command === "approve" && !result.selection) throw new Error("approve requires --selection");
  if (command !== "approve" && result.selection) throw new Error(`${command} does not accept --selection`);
  return result;
}

type AnyFetchAdapter = FetchAdapter<unknown>;

function mihoyoAdapter(game: Extract<CrawlGame, "genshin-impact" | "honkai-star-rail" | "zenless-zone-zero">): AnyFetchAdapter {
  const config = mihoyoGames[game];
  return {
    allowedHosts: config.officialHosts,
    allowedListContentTypes: ["application/json"],
    allowedDetailContentTypes: ["application/json"],
    isCanonicalContent: (content) => normalizeMihoyoContent(content) === content,
    listUrl: (page, pageSize) => buildMihoyoListRequest(game, page, pageSize).url,
    detailUrl: (sourceId) => buildMihoyoDetailRequest(game, sourceId).url,
    list: (_page, _pageSize, body) => parseMihoyoList(game, body),
    listItems: (page) => (page as MihoyoListPage).items.map((item) => ({
      sourceId: item.sourceId,
      url: buildMihoyoDetailRequest(game, item.sourceId).url,
      publishedAt: item.publishedAt,
    })),
    hasMore: (page, pageNumber, _requestedPageSize, itemCount) => pageNumber * itemCount < (page as MihoyoListPage).total,
    detail: (sourceId, body, fetchedAt) => parseMihoyoDetail(game, sourceId, body, fetchedAt),
  };
}

function hypergryphAdapter(game: Extract<CrawlGame, "arknights" | "arknights-endfield">): AnyFetchAdapter {
  const config = hypergryphGames[game];
  return {
    allowedHosts: [config.officialHost, "web-news.hypergryph.com"],
    allowedListContentTypes: ["application/json"],
    allowedDetailContentTypes: ["text/html"],
    isCanonicalContent: (content) => normalizeHypergryphContent(content) === content,
    listUrl: (page, pageSize) => buildHypergryphListRequest(game, page, pageSize).url,
    detailUrl: (sourceId) => `https://${config.officialHost}/news/${encodeURIComponent(sourceId)}`,
    list: (page, _pageSize, body) => parseHypergryphList(game, body, page),
    listItems: (page) => (page as HypergryphListPage).items.map((item) => ({
      sourceId: item.sourceId,
      url: item.url,
      publishedAt: displayTimeToBeijing(item.displayTime),
    })),
    hasMore: (page) => {
      const value = page as HypergryphListPage;
      return value.current * value.pageSize < value.total;
    },
    decodeDetailResponse: (response) => ({ status: response.status, contentType: response.contentType, body: response.body }),
    detail: (sourceId, body, fetchedAt, publishedAtFallback) => parseHypergryphDetail(game, sourceId, body, fetchedAt, publishedAtFallback),
  };
}

export function createFetchAdapter(game: CrawlGame): AnyFetchAdapter {
  if (game === "genshin-impact" || game === "honkai-star-rail" || game === "zenless-zone-zero") return mihoyoAdapter(game);
  return hypergryphAdapter(game);
}

const checkpointKinds: Record<CrawlGame, string | null> = {
  "genshin-impact": mihoyoGames["genshin-impact"].checkpoint.checkpointKind,
  "honkai-star-rail": mihoyoGames["honkai-star-rail"].checkpoint.checkpointKind,
  "zenless-zone-zero": mihoyoGames["zenless-zone-zero"].checkpoint.checkpointKind,
  arknights: hypergryphGames.arknights.checkpoint.checkpointKind,
  "arknights-endfield": hypergryphGames["arknights-endfield"].checkpoint.checkpointKind,
};

export interface AdvanceStateOptions {
  runId?: string;
  transactionPath?: string;
  writeState?: typeof writeStateAtomic;
}

export async function advanceState(runtimeRoot: string, game: CrawlGame, rawPath: string, state: CrawlerState, options: AdvanceStateOptions = {}): Promise<void> {
  const sourceHashes = { ...(state.games[game]?.sourceHashes ?? {}) };
  const rawSourceHashes: Record<string, Sha256> = {};
  try {
    for (const value of await readJsonl(rawPath)) {
      const result = RawArticleSchema.safeParse(value);
      if (!result.success) throw new Error(`raw state update failed: ${result.error.message}`);
      if (result.data.game !== game) throw new Error(`raw state update game mismatch: ${result.data.game}`);
      if (sha256Utf8(result.data.content) !== result.data.contentHash) throw new Error(`raw state update contentHash mismatch: ${result.data.sourceId}`);
      sourceHashes[result.data.sourceId] = result.data.contentHash;
      rawSourceHashes[result.data.sourceId] = result.data.contentHash;
    }
    const nextState: CrawlerState = {
      schemaVersion: 1,
      games: { ...state.games, [game]: { checkpoint: null, sourceHashes } },
    };
    if (options.transactionPath) {
      if (!options.runId) throw new Error("state transaction requires runId");
      await markStateTransactionPending(options.transactionPath, options.runId, game, rawPath, rawSourceHashes);
    }
    await (options.writeState ?? writeStateAtomic)(join(runtimeRoot, "state.json"), nextState, {
      checkpointSchemas: {},
      knownGames: checkpointKinds,
    });
  } catch (error) {
    if (options.transactionPath) await abortStateTransaction(options.transactionPath, rawPath).catch(() => undefined);
    throw error;
  }
  if (options.transactionPath) await removeStateTransaction(options.transactionPath).catch(() => undefined);
}

export interface RunCrawlCliOptions {
  runtimeRoot?: string;
  eventTypesPath?: string;
  now?: () => Date;
  fetcher?: FetchCommandOptions<unknown>["fetcher"];
  writeState?: typeof writeStateAtomic;
  pageSize?: number;
  print?: (line: string) => void;
  printError?: (line: string) => void;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function printFetchResult(print: (line: string) => void, runId: string, result: FetchCommandResult): void {
  print(`run=${runId} rawPath=${result.rawPath} count=${result.count} pages=${result.pages}`);
}

function printParseResult(print: (line: string) => void, result: ParseCommandResult): void {
  for (const item of result.results) {
    print(`game=${item.game} candidatesPath=${item.candidatesPath} rejectionsPath=${item.rejectionsPath} ready=${item.ready} needs_review=${item.needsReview} rejections=${item.rejections}`);
  }
  print(`ready=${result.ready} needs_review=${result.needsReview} rejections=${result.rejections}`);
}

export async function runCrawlCli(argv: string[], options: RunCrawlCliOptions = {}): Promise<number> {
  const print = options.print ?? console.log;
  const printError = options.printError ?? console.error;
  try {
    const args = parseCliArgs(argv);
    const runtimeRoot = options.runtimeRoot ?? resolve(process.cwd(), ".runtime/crawl");
    const eventTypesPath = options.eventTypesPath ?? resolve(process.cwd(), "data/event-types.yaml");
    if (args.command === "fetch") {
      const runId = createRunId((options.now ?? (() => new Date()))());
      await assertRuntimeRootSafe(runtimeRoot);
      const state = await loadState(join(runtimeRoot, "state.json"), {}, checkpointKinds);
      await recoverStateTransactions(runtimeRoot, state);
      await createRun(runtimeRoot, runId);
      const rawPath = artifactPath(runtimeRoot, runId, "raw", "jsonl", args.game!);
      const transactionPath = stateTransactionPath(runtimeRoot, runId);
      await beginStateTransaction(runtimeRoot, runId, args.game!, rawPath);
      try {
        const result = await fetchGame({
          runtimeRoot,
          runId,
          game: args.game!,
          pageSize: options.pageSize,
          since: args.since,
          adapter: createFetchAdapter(args.game!),
          fetcher: options.fetcher,
        });
        await advanceState(runtimeRoot, args.game!, result.rawPath, state, {
          runId,
          transactionPath,
          writeState: options.writeState,
        });
        printFetchResult(print, runId, result);
        return 0;
      } catch (error) {
        await abortStateTransaction(transactionPath, rawPath).catch(() => undefined);
        throw error;
      }
    }
    if (args.command === "parse") {
      const result = await parseRun({ runtimeRoot, runId: args.run!, eventTypesPath });
      printParseResult(print, result);
      return 0;
    }
    throw new Error(`${args.command} command is not implemented in Phase 1`);
  } catch (error) {
    printError(errorText(error));
    return 1;
  }
}

const entrypoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === entrypoint) {
  runCrawlCli(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
