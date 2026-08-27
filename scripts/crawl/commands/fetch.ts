import { randomUUID } from "node:crypto";
import { access, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fetchOfficial, type OfficialHttpResponse } from "../common/http.ts";
import { appendJsonlIfUnique } from "../common/files.ts";
import { assertRunExists, runRoot } from "../common/run.ts";
import { sha256Utf8 } from "../common/hash.ts";
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
  listUrl(page: number, pageSize: number): string;
  detailUrl(sourceId: string): string;
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
  if (present.length > 0) throw new Error(`fetch artifacts already exist: ${present.join(", ")}`);
}

function decodeJson(response: OfficialHttpResponse): unknown {
  return JSON.parse(response.body);
}

function parseSince(value: string): number {
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00+08:00` : value;
  const timestamp = Date.parse(normalized);
  if (!Number.isFinite(timestamp)) throw new Error(`invalid --since value: ${value}`);
  return timestamp;
}

function publishedTimestamp(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

export async function fetchGame<TPage>(options: FetchCommandOptions<TPage>): Promise<FetchCommandResult> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(options.game)) throw new Error(`invalid game: ${options.game}`);
  await assertRunExists(options.runtimeRoot, options.runId);
  const pageSize = options.pageSize ?? 20;
  const maxPages = options.maxPages ?? 500;
  const root = runRoot(options.runtimeRoot, options.runId);
  const rawPath = join(root, "raw", `${options.game}.jsonl`);
  const errorPath = join(root, "errors.jsonl");
  await assertAbsent([rawPath, errorPath]);
  await mkdir(dirname(rawPath), { recursive: true });
  const temporary = `${rawPath}.tmp-${process.pid}-${randomUUID()}`;
  const writeRaw = options.writeRaw ?? ((article: RawArticle) => appendJsonlIfUnique(temporary, article, (value) => `${value.game}/${value.sourceId}/${value.contentHash}`));
  const get = options.fetcher ?? (async (url, allowedHosts) => fetchOfficial(url, { allowedHosts }));
  const fetchedAt = options.now ?? (() => new Date().toISOString());
  let count = 0;
  let pages = 0;
  try {
    const sinceMs = options.since === undefined ? undefined : parseSince(options.since);
    await writeFile(temporary, "", "utf8");
    for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
      pages = pageNumber;
      const listResponse = await get(options.adapter.listUrl(pageNumber, pageSize), options.adapter.allowedHosts);
      const listBody = options.adapter.decodeListResponse?.(listResponse) ?? decodeJson(listResponse);
      const parsed = options.adapter.list(pageNumber, pageSize, listBody);
      const listedItems = options.adapter.listItems(parsed);
      if (listedItems.length === 0) break;
      const items = sinceMs === undefined
        ? listedItems
        : listedItems.filter((item) => {
          const timestamp = publishedTimestamp(item.publishedAt);
          return timestamp === undefined || timestamp >= sinceMs;
        });
      for (const item of items) {
        const detailResponse = await get(item.url || options.adapter.detailUrl(item.sourceId), options.adapter.allowedHosts);
        const detailBody = options.adapter.decodeDetailResponse?.(detailResponse) ?? decodeJson(detailResponse);
        const article = options.adapter.detail(item.sourceId, detailBody, fetchedAt());
        const checked = RawArticleSchema.safeParse(article);
        if (!checked.success) throw new Error(`RawArticle schema validation failed: ${checked.error.message}`);
        if (sha256Utf8(checked.data.content) !== checked.data.contentHash) throw new Error("RawArticle contentHash does not match content");
        if (checked.data.game !== options.game) throw new Error(`RawArticle game does not match fetch game: ${checked.data.game}`);
        if (await writeRaw(checked.data as RawArticle)) count += 1;
      }
      const pageBeforeSince = sinceMs !== undefined && listedItems.every((item) => {
        const timestamp = publishedTimestamp(item.publishedAt);
        return timestamp !== undefined && timestamp < sinceMs;
      });
      if (pageBeforeSince || listedItems.length < pageSize) break;
    }
    await rename(temporary, rawPath);
    return { rawPath, count, pages };
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    await mkdir(dirname(errorPath), { recursive: true });
    await writeFile(errorPath, `${JSON.stringify({ game: options.game, error: error instanceof Error ? error.message : String(error) })}\n`, "utf8");
    throw error;
  }
}
