import { sha256Utf8 } from "../common/hash.ts";
import { normalizeContent as normalizeCanonicalContent } from "../common/content.ts";
import type { RawArticle, Sha256 } from "../types.ts";
import { postroomGames, type PostroomGameConfig } from "../postroom-config.ts";

export interface PostroomListPage {
  ids: string[];
}

export interface PostroomPreviewMeta {
  publishId: string;
  name: string;
  publishedAt: string;
  tags: string[];
  authorName: string;
}

export class PostroomAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PostroomAdapterError";
  }
}

const config: PostroomGameConfig = postroomGames["light-and-night"];
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const officialAuthor = "光与夜之恋官方";

export { normalizeContent as normalizePostroomContent } from "../common/content.ts";

function assertTransportUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.hostname !== config.transport.host) {
    throw new PostroomAdapterError("generated URL is outside the configured CN transport host");
  }
  return url;
}

export function buildPostroomListRequest(): { method: "GET"; url: string } {
  return { method: "GET", url: assertTransportUrl(`https://${config.transport.host}${config.transport.listPath}`) };
}

function assertPublishId(publishId: string): string {
  if (!uuidPattern.test(publishId)) throw new PostroomAdapterError(`invalid publishId: ${publishId}`);
  return publishId;
}

export function buildPostroomPreviewRequest(publishId: string): { method: "GET"; url: string } {
  const id = assertPublishId(publishId);
  return { method: "GET", url: assertTransportUrl(`https://${config.transport.host}${config.transport.previewPath.replace("{publishId}", id)}`) };
}

export function buildPostroomContentRequest(publishId: string): { method: "GET"; url: string } {
  const id = assertPublishId(publishId);
  return { method: "GET", url: assertTransportUrl(`https://${config.transport.host}${config.transport.contentPath.replace("{publishId}", id)}`) };
}

/** Official detail page URL used as the formal `sources` entry (reference recipe). */
export function buildPostroomDetailPageUrl(publishId: string): string {
  const id = assertPublishId(publishId);
  const url = `https://${config.articleHost}/m/web202106/newsdetail.html?newsid=${id}`;
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.hostname !== config.articleHost) {
    throw new PostroomAdapterError("generated URL is outside the configured CN article host");
  }
  return url;
}

const gmt0800Pattern = /^([A-Z][a-z]{2}) ([A-Z][a-z]{2}) (\d{1,2}) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT([+-])(\d{4})/;
const monthIndex: Record<string, number> = {
  Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6,
  Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12,
};

/** Convert the measured `Tue Aug 11 2026 17:08:19 GMT+0800 (...)` JS string to `2026-08-11 17:08:19`. */
export function publishDateToBeijing(publishDate: string): string {
  const match = gmt0800Pattern.exec(publishDate);
  if (!match) throw new PostroomAdapterError(`invalid publishDate (expected GMT+0800 JS date string): ${publishDate || "(empty)"}`);
  const [, , monthName, dayText, yearText, hourText, minuteText, secondText, offsetSign, offsetValue] = match;
  if (offsetSign !== "+" || offsetValue !== "0800") {
    throw new PostroomAdapterError(`publishDate offset must be GMT+0800: ${publishDate}`);
  }
  const month = monthIndex[monthName];
  if (!month) throw new PostroomAdapterError(`invalid publishDate month: ${publishDate}`);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const probe = new Date(Date.UTC(Number(yearText), month - 1, day, hour, minute, second));
  if (
    probe.getUTCFullYear() !== Number(yearText)
    || probe.getUTCMonth() !== month - 1
    || probe.getUTCDate() !== day
    || probe.getUTCHours() !== hour
    || probe.getUTCMinutes() !== minute
    || probe.getUTCSeconds() !== second
  ) {
    throw new PostroomAdapterError(`invalid publishDate: ${publishDate}`);
  }
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${yearText}-${pad(month)}-${pad(day)} ${pad(hour)}:${pad(minute)}:${pad(second)}`;
}

export function parsePostroomList(body: unknown): PostroomListPage {
  if (!Array.isArray(body)) throw new PostroomAdapterError("list body is not an array");
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const raw of body) {
    if (typeof raw !== "object" || raw === null) throw new PostroomAdapterError("invalid list item");
    const item = raw as Record<string, unknown>;
    const publishId = item.postPublishId;
    if (typeof publishId !== "string" || !uuidPattern.test(publishId)) {
      throw new PostroomAdapterError("missing or malformed postPublishId");
    }
    if (!seen.has(publishId)) {
      seen.add(publishId);
      ids.push(publishId);
    }
  }
  return { ids };
}

export function parsePostroomPreview(requestedPublishId: string, body: unknown): PostroomPreviewMeta {
  const requested = assertPublishId(requestedPublishId);
  if (typeof body !== "object" || body === null) throw new PostroomAdapterError("invalid preview envelope");
  const preview = body as Record<string, unknown>;
  if (preview.publishId !== requested) throw new PostroomAdapterError("preview publishId mismatch");
  const name = preview.name;
  if (typeof name !== "string" || name.length === 0) throw new PostroomAdapterError("missing name");
  const authorName = preview.authorName;
  if (authorName !== officialAuthor) throw new PostroomAdapterError(`author is not the configured official account: ${String(authorName)}`);
  if (!Array.isArray(preview.tags) || preview.tags.some((tag) => typeof tag !== "string")) {
    throw new PostroomAdapterError("invalid tags");
  }
  const publishDate = preview.publishDate;
  if (typeof publishDate !== "string") throw new PostroomAdapterError("missing publishDate");
  return {
    publishId: requested,
    name,
    publishedAt: publishDateToBeijing(publishDate),
    tags: preview.tags as string[],
    authorName,
  };
}

export function parsePostroomContent(
  publishId: string,
  name: string,
  publishedAt: string,
  body: unknown,
  fetchedAt: string,
): RawArticle {
  const id = assertPublishId(publishId);
  if (typeof body !== "object" || body === null) throw new PostroomAdapterError("invalid content envelope");
  const envelope = body as Record<string, unknown>;
  const rawContent = envelope.content;
  if (typeof rawContent !== "string") throw new PostroomAdapterError("missing content");
  const content = normalizeCanonicalContent(rawContent);
  return {
    game: config.game,
    region: config.region,
    source: "postroom",
    sourceId: id,
    url: buildPostroomDetailPageUrl(id),
    title: name,
    publishedAt,
    content,
    contentHash: sha256Utf8(content) as Sha256,
    fetchedAt,
  } satisfies RawArticle;
}
