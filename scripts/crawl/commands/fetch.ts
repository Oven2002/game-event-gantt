import { rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { fetchOfficial, type OfficialHttpResponse } from "../common/http.ts";
import { artifactPath } from "../common/run.ts";
import { appendJsonlIfUnique } from "../common/files.ts";
import type { RawArticle } from "../types.ts";

export interface FetchAdapter<TPage> {
  list(page: number, pageSize: number, body: unknown): TPage;
  listItems(page: TPage): Array<{ sourceId: string; url: string }>;
  detail(sourceId: string, body: unknown, fetchedAt: string): RawArticle;
  listUrl(page: number, pageSize: number): string;
  detailUrl(sourceId: string): string;
  allowedHosts: string[];
}

export interface FetchCommandOptions<TPage> {
  runtimeRoot: string;
  runId: string;
  pageSize?: number;
  maxPages?: number;
  fetcher?: (url: string, allowedHosts: string[]) => Promise<OfficialHttpResponse>;
  adapter: FetchAdapter<TPage>;
  writeRaw?: (article: RawArticle) => Promise<boolean>;
}

export interface FetchCommandResult { rawPath: string; count: number; pages: number; }

export async function fetchGame<TPage>(options: FetchCommandOptions<TPage>): Promise<FetchCommandResult> {
  const pageSize = options.pageSize ?? 20;
  const maxPages = options.maxPages ?? 500;
  const rawPath = artifactPath(options.runtimeRoot, options.runId, "raw");
  const errorPath = artifactPath(options.runtimeRoot, options.runId, "errors");
  await mkdir(dirname(rawPath), { recursive: true });
  const temporary = `${rawPath}.tmp-${process.pid}-${randomUUID()}`;
  const writeRaw = options.writeRaw ?? ((article: RawArticle) => appendJsonlIfUnique(temporary, article, (value) => `${value.game}/${value.sourceId}/${value.contentHash}`));
  const get = options.fetcher ?? (async (url, allowedHosts) => fetchOfficial(url, { allowedHosts }));
  let count = 0;
  let pages = 0;
  try {
    for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
      pages = pageNumber;
      const listResponse = await get(options.adapter.listUrl(pageNumber, pageSize), options.adapter.allowedHosts);
      const parsed = options.adapter.list(pageNumber, pageSize, JSON.parse(listResponse.body));
      const items = options.adapter.listItems(parsed);
      if (items.length === 0) break;
      for (const item of items) {
        const detailResponse = await get(item.url || options.adapter.detailUrl(item.sourceId), options.adapter.allowedHosts);
        const article = options.adapter.detail(item.sourceId, JSON.parse(detailResponse.body), new Date().toISOString());
        if (await writeRaw(article)) count += 1;
      }
      if (items.length < pageSize) break;
    }
    await rename(temporary, rawPath);
    return { rawPath, count, pages };
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    await mkdir(dirname(errorPath), { recursive: true });
    await writeFile(errorPath, `${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`, "utf8");
    throw error;
  }
}
