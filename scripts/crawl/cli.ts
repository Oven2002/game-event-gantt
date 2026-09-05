import { pathToFileURL } from "node:url";
import { join, resolve } from "node:path";
import { fetchGame, type FetchAdapter, type FetchCommandOptions, type FetchCommandResult } from "./commands/fetch.ts";
import { parseRun, type ParseCommandResult } from "./commands/parse.ts";
import { reviewRun } from "./commands/review.ts";
import { approveRun } from "./commands/approve.ts";
import { createRun, artifactPath, assertRuntimeRootSafe, assertRunId } from "./common/run.ts";
import { readJsonl } from "./common/files.ts";
import { sha256Utf8 } from "./common/hash.ts";
import { abortStateTransaction, beginStateTransaction, loadState, markStateTransactionPending, recoverStateTransactions, removeStateTransaction, stateTransactionPath, updateStateAtomic, withRunLock, writeStateAtomic, type CrawlerState } from "./common/state.ts";
import { RawArticleSchema, type Sha256 } from "./types.ts";
import { buildHypergryphListRequest, displayTimeToBeijing, normalizeHypergryphContent, parseHypergryphDetail, parseHypergryphList, type HypergryphListPage } from "./adapters/hypergryph.ts";
import { hypergryphGames } from "./hypergryph-config.ts";
import { buildMihoyoDetailRequest, buildMihoyoListRequest, parseMihoyoDetail, parseMihoyoList, type MihoyoListPage } from "./adapters/mihoyo.ts";
import { mihoyoGames } from "./mihoyo-config.ts";
import { normalizeContent as normalizeMihoyoContent } from "./common/content.ts";
import { parseBluepochDetail, parseBluepochList, buildBluepochListRequest, buildBluepochDetailUrl, type BluepochListPage } from "./adapters/bluepoch.ts";
import { bluepochGames } from "./bluepoch-config.ts";
import { parsePostroomContent, parsePostroomList, parsePostroomPreview, buildPostroomListRequest, buildPostroomPreviewRequest, buildPostroomContentRequest, buildPostroomDetailPageUrl, type PostroomListPage } from "./adapters/postroom.ts";
import { postroomGames } from "./postroom-config.ts";

export type CrawlGame = "genshin-impact" | "honkai-star-rail" | "zenless-zone-zero" | "arknights" | "arknights-endfield" | "reverse-1999" | "light-and-night";
export type CrawlCommand = "fetch" | "parse" | "review" | "approve";
export interface CliArgs { command: CrawlCommand; game?: CrawlGame; since?: string; full?: boolean; run?: string; selection?: string; }

const games = new Set<CrawlGame>(["genshin-impact", "honkai-star-rail", "zenless-zone-zero", "arknights", "arknights-endfield", "reverse-1999", "light-and-night"]);

export function createRunId(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
}

export function defaultLookbackSince(game: CrawlGame, now: Date): string {
  const config = game === "genshin-impact" || game === "honkai-star-rail" || game === "zenless-zone-zero"
    ? mihoyoGames[game]
    : game === "arknights" || game === "arknights-endfield"
      ? hypergryphGames[game]
      : game === "reverse-1999"
        ? bluepochGames[game]
        : postroomGames[game];
  if (!Number.isSafeInteger(config.checkpoint.defaultLookbackDays) || config.checkpoint.defaultLookbackDays < 1) throw new Error(`invalid defaultLookbackDays for ${game}`);
  const target = new Date(now.getTime() - config.checkpoint.defaultLookbackDays * 24 * 60 * 60 * 1000);
  if (!Number.isFinite(target.getTime())) throw new Error("invalid current time");
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(target);
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
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
      assertRunId(run);
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

function bluepochAdapter(game: Extract<CrawlGame, "reverse-1999">): AnyFetchAdapter {
  const config = bluepochGames[game];
  return {
    allowedHosts: config.officialHosts,
    allowedListContentTypes: ["application/json"],
    allowedDetailContentTypes: ["application/json"],
    isCanonicalContent: (content) => normalizeMihoyoContent(content) === content,
    // The bluepoch list endpoint requires POST (GET returns code 5002); the body is the
    // measured credential-free query shape. Detail is skipped: content is inlined in the list.
    listRequestBody: (page, pageSize) => buildBluepochListRequest(page, pageSize).body,
    listUrl: (page, pageSize) => buildBluepochListRequest(page, pageSize).url,
    detailUrl: (sourceId) => buildBluepochDetailUrl(sourceId),
    list: (_page, _pageSize, body) => parseBluepochList(body),
    // The bluepoch list response inlines each article's full content: no per-item request.
    inlineDetailBodies: (page) => {
      const bodies = new Map<string, unknown>();
      for (const raw of (page as BluepochListPage).rawItems) {
        bodies.set(String(raw.id), raw);
      }
      return bodies;
    },
    listItems: (page) => (page as BluepochListPage).items.map((item) => ({
      sourceId: item.sourceId,
      url: buildBluepochDetailUrl(item.sourceId),
      publishedAt: item.publishedAt,
    })),
    hasMore: (page, pageNumber, _requestedPageSize, itemCount) => pageNumber * itemCount < (page as BluepochListPage).total,
    detail: (sourceId, body, fetchedAt) => parseBluepochDetail(sourceId, body, fetchedAt),
  };
}

function postroomAdapter(game: Extract<CrawlGame, "light-and-night">): AnyFetchAdapter {
  const config = postroomGames[game];
  // Postroom chain: preview (name + publishDate) -> content (HTML body).
  // nextDetailUrl drives the fetch loop; onDetailStep caches the preview metadata.
  const previewMeta = new Map<string, { name: string; publishedAt: string }>();
  return {
    allowedHosts: config.officialHosts,
    allowedListContentTypes: ["application/json"],
    allowedDetailContentTypes: ["application/json"],
    isCanonicalContent: (content) => normalizeMihoyoContent(content) === content,
    listUrl: (_page, _pageSize) => buildPostroomListRequest().url,
    detailUrl: (sourceId) => buildPostroomPreviewRequest(sourceId).url,
    list: (page, _pageSize, body) => {
      if (page > 1) return { ids: [] } satisfies PostroomListPage;
      return parsePostroomList(body);
    },
    listItems: (page) => (page as PostroomListPage).ids.map((id) => ({
      sourceId: id,
      url: buildPostroomPreviewRequest(id).url,
      publishedAt: null,
    })),
    decodeDetailResponse: (response) => JSON.parse(response.body),
    nextDetailUrl: (sourceId, body) => {
      if (previewMeta.has(sourceId)) return undefined;
      // First response is the preview: cache metadata, request the content next.
      const meta = parsePostroomPreview(sourceId, body);
      previewMeta.set(sourceId, { name: meta.name, publishedAt: meta.publishedAt });
      return buildPostroomContentRequest(sourceId).url;
    },
    detail: (sourceId, body, fetchedAt) => {
      const meta = previewMeta.get(sourceId);
      if (!meta) throw new Error(`postroom preview metadata is missing for ${sourceId}`);
      // Hyperlink-only posts return null: the fetch loop skips them.
      return parsePostroomContent(sourceId, meta.name, meta.publishedAt, body, fetchedAt);
    },
  };
}

export function createFetchAdapter(game: CrawlGame): AnyFetchAdapter {
  if (game === "genshin-impact" || game === "honkai-star-rail" || game === "zenless-zone-zero") return mihoyoAdapter(game);
  if (game === "reverse-1999") return bluepochAdapter(game);
  if (game === "light-and-night") return postroomAdapter(game);
  return hypergryphAdapter(game);
}

export const checkpointKinds: Record<CrawlGame, string | null> = {
  "genshin-impact": mihoyoGames["genshin-impact"].checkpoint.checkpointKind,
  "honkai-star-rail": mihoyoGames["honkai-star-rail"].checkpoint.checkpointKind,
  "zenless-zone-zero": mihoyoGames["zenless-zone-zero"].checkpoint.checkpointKind,
  arknights: hypergryphGames.arknights.checkpoint.checkpointKind,
  "arknights-endfield": hypergryphGames["arknights-endfield"].checkpoint.checkpointKind,
  "reverse-1999": bluepochGames["reverse-1999"].checkpoint.checkpointKind,
  "light-and-night": postroomGames["light-and-night"].checkpoint.checkpointKind,
};

export interface AdvanceStateOptions {
  runId?: string;
  transactionPath?: string;
  writeState?: typeof writeStateAtomic;
}

export async function advanceState(runtimeRoot: string, game: CrawlGame, rawPath: string, state: CrawlerState, options: AdvanceStateOptions = {}): Promise<void> {
  const rawSourceHashes: Record<string, Sha256> = {};
  try {
    for (const value of await readJsonl(rawPath)) {
      const result = RawArticleSchema.safeParse(value);
      if (!result.success) throw new Error(`raw state update failed: ${result.error.message}`);
      if (result.data.game !== game) throw new Error(`raw state update game mismatch: ${result.data.game}`);
      if (sha256Utf8(result.data.content) !== result.data.contentHash) throw new Error(`raw state update contentHash mismatch: ${result.data.sourceId}`);
      rawSourceHashes[result.data.sourceId] = result.data.contentHash;
    }
    const buildNextState = (current: CrawlerState): CrawlerState => ({
      schemaVersion: 1,
      games: {
        ...current.games,
        [game]: {
          checkpoint: null,
          sourceHashes: { ...(current.games[game]?.sourceHashes ?? {}), ...rawSourceHashes },
        },
      },
    });
    if (options.transactionPath) {
      if (!options.runId) throw new Error("state transaction requires runId");
      await markStateTransactionPending(runtimeRoot, options.transactionPath, options.runId, game, rawPath, rawSourceHashes);
    }
    if (options.writeState) {
      await options.writeState(join(runtimeRoot, "state.json"), buildNextState(state), {
        checkpointSchemas: {},
        knownGames: checkpointKinds,
      });
    } else {
      await updateStateAtomic(join(runtimeRoot, "state.json"), state, buildNextState, {
        checkpointSchemas: {},
        knownGames: checkpointKinds,
      });
    }
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
      const now = (options.now ?? (() => new Date()))();
      const runId = createRunId(now);
      await assertRuntimeRootSafe(runtimeRoot);
      const state = await loadState(join(runtimeRoot, "state.json"), {}, checkpointKinds);
      await recoverStateTransactions(runtimeRoot, state, new Set(Object.keys(checkpointKinds)));
      await createRun(runtimeRoot, runId, args.game!);
      const rawPath = artifactPath(runtimeRoot, runId, "raw", "jsonl", args.game!);
      const transactionPath = stateTransactionPath(runtimeRoot, runId);
      return await withRunLock(runtimeRoot, runId, async () => {
        await beginStateTransaction(runtimeRoot, runId, args.game!, rawPath);
        try {
          const result = await fetchGame({
            runtimeRoot,
            runId,
            game: args.game!,
            pageSize: options.pageSize,
            since: args.since ?? (args.full ? undefined : defaultLookbackSince(args.game!, now)),
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
      });
    }
    if (args.command === "review") {
      const result = await reviewRun({ runtimeRoot, runId: args.run!, eventTypesPath });
      print(`run=${args.run} reportPath=${result.reportPath} templatePath=${result.templatePath} items=${result.template.items.length}`);
      return 0;
    }
    if (args.command === "approve") {
      const result = await approveRun({ runtimeRoot, runId: args.run!, selectionPath: args.selection!, eventTypesPath });
      print(`run=${args.run} manifestPath=${result.manifestPath} entries=${result.manifest.entries.length}`);
      return 0;
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
