import { sha256Utf8 } from "../common/hash.ts";
import { normalizeContent as normalizeCanonicalContent } from "../common/content.ts";
import type { RawArticle, Sha256 } from "../types.ts";
import { bluepochGames, type BluepochGameConfig } from "../bluepoch-config.ts";

export interface BluepochListItem {
  sourceId: string;
  title: string;
  url: string;
  publishedAt: string | null;
  content: string;
  contentHash: Sha256;
}

export interface BluepochListPage {
  total: number;
  items: BluepochListItem[];
  /** The raw pageData entries, kept for adapters that inline full article content. */
  rawItems: Array<Record<string, unknown>>;
}

export class BluepochAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BluepochAdapterError";
  }
}

const config: BluepochGameConfig = bluepochGames["reverse-1999"];

/** Announcement channels worth crawling: 2=notices, 3=events, 4=news (reference recipe). */
const allowedInformationTypes = new Set([2, 3, 4]);

export { normalizeContent as normalizeBluepochContent } from "../common/content.ts";

export function buildBluepochDetailUrl(sourceId: string): string {
  if (!/^\d+$/.test(sourceId)) throw new BluepochAdapterError("invalid sourceId");
  const url = `${config.articleHost.startsWith("https://") ? config.articleHost : `https://${config.articleHost}`}/home/detail.html#newsId?${sourceId}`;
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.hostname !== config.articleHost) {
    throw new BluepochAdapterError("generated URL is outside the configured CN article host");
  }
  return url;
}

export interface BluepochRequest {
  method: "POST";
  url: string;
  body: Record<string, string | number>;
}

export function buildBluepochListRequest(page: number, pageSize: number, informationType: "" | 2 | 3 | 4 = ""): BluepochRequest {
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1) {
    throw new BluepochAdapterError("invalid pagination");
  }
  return {
    method: "POST",
    url: `https://${config.transport.host}${config.transport.path}`,
    body: { informationType, current: page, pageSize },
  };
}

function getData(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || !("code" in body) || (body as { code?: unknown }).code !== 200) {
    throw new BluepochAdapterError("invalid code envelope");
  }
  if (!("data" in body)) throw new BluepochAdapterError("missing data envelope");
  const data = (body as { data: unknown }).data;
  if (typeof data !== "object" || data === null) throw new BluepochAdapterError("invalid data envelope");
  return data as Record<string, unknown>;
}

function getString(value: unknown, field: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) throw new BluepochAdapterError(`missing ${field}`);
  return value;
}

function normalizeItem(item: Record<string, unknown>): BluepochListItem | null {
  const rawId = item.id;
  if (typeof rawId !== "number" && !(typeof rawId === "string" && /^\d+$/.test(rawId))) {
    throw new BluepochAdapterError("missing id");
  }
  const informationType = item.informationType;
  // Unknown channel types are skipped (not rejected): the official list mixes
  // promotional/guide entries outside the announcement channels we crawl.
  if (typeof informationType !== "number" || !allowedInformationTypes.has(informationType)) {
    return null;
  }
  const sourceId = String(rawId);
  const title = getString(item.title, "title");
  const content = normalizeCanonicalContent(getString(item.content, "content", true));
  const onlineTime = typeof item.onlineTime === "string" && item.onlineTime.length > 0 ? item.onlineTime : null;
  return {
    sourceId,
    title,
    url: buildBluepochDetailUrl(sourceId),
    publishedAt: onlineTime,
    content,
    contentHash: sha256Utf8(content) as Sha256,
  };
}

export function parseBluepochList(body: unknown): BluepochListPage {
  const data = getData(body);
  if (!Array.isArray(data.pageData)) throw new BluepochAdapterError("missing data.pageData");
  const seen = new Set<string>();
  const items: BluepochListItem[] = [];
  const rawItems: Array<Record<string, unknown>> = [];
  for (const raw of data.pageData) {
    if (typeof raw !== "object" || raw === null) throw new BluepochAdapterError("invalid list item");
    const item = normalizeItem(raw as Record<string, unknown>);
    if (item === null) continue; // outside the crawled channels
    const key = `${item.sourceId}:${item.contentHash}`;
    if (!seen.has(key)) {
      seen.add(key);
      items.push(item);
      rawItems.push(raw as Record<string, unknown>);
    }
  }
  const total = data.total;
  if (typeof total !== "number" || !Number.isSafeInteger(total) || total < 0) {
    throw new BluepochAdapterError("invalid total");
  }
  return { total, items, rawItems };
}

export function parseBluepochDetail(requestedSourceId: string, body: unknown, fetchedAt: string): RawArticle {
  if (!/^\d+$/.test(requestedSourceId)) throw new BluepochAdapterError("invalid sourceId");
  // The detail body is either a {code, data:{...}} envelope (detail endpoint) or a bare
  // list item (inline-detail mode reuses the pageData entry verbatim).
  const envelope = typeof body === "object" && body !== null && "code" in (body as Record<string, unknown>)
    ? getData(body)
    : body as Record<string, unknown>;
  if (String(envelope.id ?? "") !== requestedSourceId) throw new BluepochAdapterError("detail id mismatch");
  const item = normalizeItem(envelope);
  if (item === null) throw new BluepochAdapterError("detail item is outside the crawled channels");
  return {
    game: config.game,
    region: config.region,
    source: "bluepoch",
    sourceId: item.sourceId,
    url: item.url,
    title: item.title,
    publishedAt: item.publishedAt,
    content: item.content,
    contentHash: item.contentHash,
    fetchedAt,
  } satisfies RawArticle;
}
