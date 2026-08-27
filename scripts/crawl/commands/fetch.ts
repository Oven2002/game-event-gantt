import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fetchOfficial, type OfficialHttpResponse } from "../common/http.ts";
import { appendJsonlIfUnique } from "../common/files.ts";
import { artifactPath, assertRuntimePathSafe, assertRuntimeRootSafe, assertRunArtifactsAbsent, assertRunExists, RUN_ARTIFACTS } from "../common/run.ts";
import { sha256Utf8, canonicalizeUrl } from "../common/hash.ts";
import { RawArticleSchema, type RawArticle } from "../types.ts";

export interface FetchListItem {
  sourceId: string;
  url: string;
  publishedAt?: string | null;
}

export interface FetchAdapter<TPage> {
  list(page: number, pageSize: number, body: unknown): TPage;
  listItems(page: TPage): FetchListItem[];
  detail(sourceId: string, body: unknown, fetchedAt: string): RawArticle;
  allowedListContentTypes?: readonly string[];
  allowedDetailContentTypes?: readonly string[];
  isCanonicalContent?: (content: string) => boolean;
  listUrl(page: number, pageSize: number): string;
  detailUrl(sourceId: string): string;
  hasMore?: (page: TPage, pageNumber: number, requestedPageSize: number, itemCount: number) => boolean;
  allowedHosts: string[];
  decodeListResponse?: (response: OfficialHttpResponse) => unknown;
  decodeDetailResponse?: (response: OfficialHttpResponse) => unknown;
}

export interface FetchCommandOptions<TPage> {
  runtimeRoot: string;
  runId: string;
  game: string;
  pageSize?: number;
  maxPages?: number;
  since?: string;
  fetcher?: (url: string, allowedHosts: string[]) => Promise<OfficialHttpResponse>;
  adapter: FetchAdapter<TPage>;
  writeRaw?: (article: RawArticle) => Promise<boolean>;
  now?: () => string;
}

export interface FetchCommandResult { rawPath: string; count: number; pages: number; }

function decodeJson(response: OfficialHttpResponse): unknown {
  return JSON.parse(response.body);
}

function parseTimestamp(value: string): number {
  const trimmed = value.trim();
  let normalized = trimmed;
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    normalized = `${trimmed}T00:00:00+08:00`;
  } else if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(trimmed)) {
    normalized = `${trimmed.replace(" ", "T")}+08:00`;
  }
  const timestamp = Date.parse(normalized);
  if (!Number.isFinite(timestamp)) throw new Error(`invalid --since value: ${value}`);
  return timestamp;
}

function parseSince(value: string): number {
  return parseTimestamp(value);
}

function publishedTimestamp(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  try {
    return parseTimestamp(value);
  } catch {
    return undefined;
  }
}

function assertResponseContentType(response: OfficialHttpResponse, allowed: readonly string[] | undefined, kind: "list" | "detail"): void {
  if (!allowed) return;
  const actual = response.contentType.toLowerCase().split(";", 1)[0].trim();
  const expected = allowed.map((value) => value.toLowerCase().split(";", 1)[0].trim());
  if (!expected.includes(actual)) throw new Error(`unexpected ${kind} content-type: ${response.contentType}`);
}

export async function fetchGame<TPage>(options: FetchCommandOptions<TPage>): Promise<FetchCommandResult> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(options.game)) throw new Error(`invalid game: ${options.game}`);
  await assertRuntimeRootSafe(options.runtimeRoot);
  await assertRunExists(options.runtimeRoot, options.runId);
  const pageSize = options.pageSize ?? 20;
  const maxPages = options.maxPages ?? 500;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) throw new Error(`invalid pageSize: ${pageSize}`);
  if (!Number.isSafeInteger(maxPages) || maxPages < 1) throw new Error(`invalid maxPages: ${maxPages}`);
  const rawPath = artifactPath(options.runtimeRoot, options.runId, "raw", "jsonl", options.game);
  const errorPath = artifactPath(options.runtimeRoot, options.runId, "errors");
  await assertRuntimePathSafe(options.runtimeRoot, rawPath);
  await assertRuntimePathSafe(options.runtimeRoot, errorPath);
  await assertRunArtifactsAbsent(options.runtimeRoot, options.runId, RUN_ARTIFACTS);
  await mkdir(dirname(rawPath), { recursive: true });
  const temporary = `${rawPath}.tmp-${process.pid}-${randomUUID()}`;
  const writeRaw = options.writeRaw ?? ((article: RawArticle) => appendJsonlIfUnique(temporary, article, (value) => `${value.game}/${value.sourceId}/${value.contentHash}`));
  const get = options.fetcher ?? (async (url, allowedHosts) => fetchOfficial(url, { allowedHosts }));
  const fetchedAt = options.now ?? (() => new Date().toISOString());
  let count = 0;
  let pages = 0;
  let paginationComplete = false;
  try {
    const sinceMs = options.since === undefined ? undefined : parseSince(options.since);
    await writeFile(temporary, "", "utf8");
    for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
      pages = pageNumber;
      const listResponse = await get(options.adapter.listUrl(pageNumber, pageSize), options.adapter.allowedHosts);
      assertResponseContentType(listResponse, options.adapter.allowedListContentTypes, "list");
      const listBody = options.adapter.decodeListResponse?.(listResponse) ?? decodeJson(listResponse);
      const parsed = options.adapter.list(pageNumber, pageSize, listBody);
      const listedItems = options.adapter.listItems(parsed);
      if (listedItems.length === 0) {
        paginationComplete = true;
        break;
      }
      const items = sinceMs === undefined
        ? listedItems
        : listedItems.filter((item) => {
          const timestamp = publishedTimestamp(item.publishedAt);
          return timestamp === undefined || timestamp >= sinceMs;
        });
      for (const item of items) {
        const detailResponse = await get(item.url || options.adapter.detailUrl(item.sourceId), options.adapter.allowedHosts);
        assertResponseContentType(detailResponse, options.adapter.allowedDetailContentTypes, "detail");
        const detailBody = options.adapter.decodeDetailResponse?.(detailResponse) ?? decodeJson(detailResponse);
        const article = options.adapter.detail(item.sourceId, detailBody, fetchedAt());
        const checked = RawArticleSchema.safeParse(article);
        if (!checked.success) throw new Error(`RawArticle schema validation failed: ${checked.error.message}`);
        if (sha256Utf8(checked.data.content) !== checked.data.contentHash) throw new Error("RawArticle contentHash does not match content");
        if (canonicalizeUrl(checked.data.url) !== checked.data.url) throw new Error("RawArticle url is not canonical");
        if (options.adapter.isCanonicalContent && !options.adapter.isCanonicalContent(checked.data.content)) throw new Error("RawArticle canonical content validation failed");
        if (checked.data.game !== options.game) throw new Error(`RawArticle game does not match fetch game: ${checked.data.game}`);
        if (await writeRaw(checked.data as RawArticle)) count += 1;
      }
      const pageBeforeSince = sinceMs !== undefined && listedItems.every((item) => {
        const timestamp = publishedTimestamp(item.publishedAt);
        return timestamp !== undefined && timestamp < sinceMs;
      });
      const continuePaging = options.adapter.hasMore
        ? options.adapter.hasMore(parsed, pageNumber, pageSize, listedItems.length)
        : listedItems.length >= pageSize;
      if (pageBeforeSince || !continuePaging) {
        paginationComplete = true;
        break;
      }
    }
    if (!paginationComplete) throw new Error(`pagination exceeded maxPages=${maxPages}`);
    await rename(temporary, rawPath);
    return { rawPath, count, pages };
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    await mkdir(dirname(errorPath), { recursive: true });
    await writeFile(errorPath, `${JSON.stringify({ game: options.game, error: error instanceof Error ? error.message : String(error) })}\n`, "utf8");
    throw error;
  }
}
