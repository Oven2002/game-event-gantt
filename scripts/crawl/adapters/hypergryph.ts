import { sha256Utf8 } from "../common/hash.ts";
import type { RawArticle, Sha256 } from "../types.ts";
import { hypergryphGames, type HypergryphGameConfig } from "../hypergryph-config.ts";

export interface HypergryphRequest { method: "GET"; url: string; parameters: Record<string, string>; }
export interface HypergryphListItem { sourceId: string; title: string; tab: string; displayTime: number; url: string; brief: string; }
export interface HypergryphListPage { total: number; items: HypergryphListItem[]; current: number; pageSize: number; }
export class HypergryphAdapterError extends Error { constructor(message: string) { super(message); this.name = "HypergryphAdapterError"; } }

export function buildHypergryphListRequest(game: HypergryphGameConfig["game"], page: number, pageSize = 20): HypergryphRequest {
  const config = hypergryphGames[game];
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 20) throw new HypergryphAdapterError("invalid pagination");
  const parameters = { lang: "zh-cn", code: config.apiCode, page: String(page), pageSize: String(pageSize) };
  return { method: "GET", url: `https://web-news.hypergryph.com/api/bulletin?${new URLSearchParams(parameters)}`, parameters };
}

function envelope(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || (body as { code?: unknown }).code !== 0) throw new HypergryphAdapterError("invalid code");
  const data = (body as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) throw new HypergryphAdapterError("invalid data envelope");
  return data as Record<string, unknown>;
}
function stringField(item: Record<string, unknown>, key: string): string {
  if (typeof item[key] !== "string" || item[key] === "") throw new HypergryphAdapterError(`missing ${key}`);
  return item[key] as string;
}

function positiveIntegerField(data: Record<string, unknown>, key: string, allowZero = false): number {
  const value = data[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || (allowZero ? value < 0 : value < 1)) throw new HypergryphAdapterError(`invalid ${key}`);
  return value;
}


export function parseHypergryphList(game: HypergryphGameConfig["game"], body: unknown): HypergryphListPage {
  const data = envelope(body);
  if (!Array.isArray(data.list)) throw new HypergryphAdapterError("invalid list");
  const items = data.list.map((raw) => {
    if (typeof raw !== "object" || raw === null) throw new HypergryphAdapterError("invalid list item");
    const item = raw as Record<string, unknown>;
    const sourceId = stringField(item, "cid");
    if (!/^\d+$/.test(sourceId)) throw new HypergryphAdapterError("invalid cid");
    const displayTime = item.displayTime;
    if (typeof displayTime !== "number" || !Number.isInteger(displayTime) || displayTime <= 0) throw new HypergryphAdapterError("invalid displayTime");
    return { sourceId, title: stringField(item, "title"), tab: stringField(item, "tab"), displayTime, url: `https://${hypergryphGames[game].officialHost}/news/${encodeURIComponent(sourceId)}`, brief: typeof item.brief === "string" ? item.brief : "" };
  });
  const total = positiveIntegerField(data, "total", true);
  const current = positiveIntegerField(data, "current");
  const pageSizeValue = positiveIntegerField(data, "pageSize");
  if (pageSizeValue > 20) throw new HypergryphAdapterError("invalid pageSize");
  return { total, current, pageSize: pageSizeValue, items };
}

function htmlFromEnvelope(body: unknown): string {
  if (typeof body !== "object" || body === null || (body as { status?: unknown }).status !== 200 || typeof (body as { body?: unknown }).body !== "string") throw new HypergryphAdapterError("invalid detail response");
  return (body as { body: string }).body;
}
function decode(value: string): string { return value.replace(/\\u003c/g, "<").replace(/\\u003e/g, ">").replace(/\\u0026/g, "&").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">"); }
export function normalizeHypergryphContent(html: string): string {
  return decode(html).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "").replace(/<\s*br\s*\/?>/gi, "\n").replace(/<\s*\/(?:p|div|li|h[1-6])\s*>/gi, "\n").replace(/<[^>]+>/g, "").replace(/\r\n?/g, "\n").split("\n").map((line) => line.replace(/[ \t]+/g, " ").trim()).filter((line, index, lines) => line || (index > 0 && lines[index - 1])).join("\n").trim();
}
function parsePublishedAt(value: string): string | null {
  const full = value.match(/^(\d{4})\.(\d{2})\.(\d{2})\s+(\d{2}):(\d{2})$/);
  return full ? `${full[1]}-${full[2]}-${full[3]}T${full[4]}:${full[5]}:00+08:00` : null;
}
function detailMeta(html: string, sourceId: string): { title: string; publishedAt: string | null; content: string } {
  const decodedHtml = decode(html);
  const title = decodedHtml.match(/<title>([^<]+?)\s*-\s*(?:明日方舟|Arknights)/i)?.[1]?.trim() ?? decodedHtml.match(/class="[^"]*title[^"]*"[^>]*>([\s\S]*?)<\/div>/i)?.[1];
  let contentMatch = decodedHtml.match(/class="[^"]*(?:NoticeDetail_content|SectionViewer_content)[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i);
  if (!contentMatch) {
    const titleIndex = title ? decodedHtml.indexOf(title) : -1;
    const start = decodedHtml.indexOf("<p", titleIndex);
    const end = decodedHtml.indexOf('<div class="_61725cbe"', start);
    if (start >= 0 && end > start) contentMatch = ["", decodedHtml.slice(start, end)] as RegExpMatchArray;
  }
  if (!title || !contentMatch) throw new HypergryphAdapterError(`cannot parse detail ${sourceId}`);
  const dateText = decodedHtml.match(/class="[^"]*date[^"]*"[^>]*>([^<]+)</i)?.[1]?.trim() ?? null;
  const embeddedId = decodedHtml.match(/cid\\?\":\\?\"(\d+)/)?.[1] ?? decodedHtml.match(/"cid"\s*:\s*"(\d+)"/)?.[1];
  if (embeddedId !== sourceId) throw new HypergryphAdapterError(`detail sourceId mismatch: ${sourceId}/${embeddedId ?? "missing"}`);
  return { title: normalizeHypergryphContent(title), publishedAt: dateText ? parsePublishedAt(dateText) : null, content: normalizeHypergryphContent(contentMatch[1]) };
}
export function parseHypergryphDetail(game: HypergryphGameConfig["game"], sourceId: string, body: unknown, fetchedAt: string): RawArticle {
  if (!/^\d+$/.test(sourceId)) throw new HypergryphAdapterError("invalid sourceId");
  const meta = detailMeta(htmlFromEnvelope(body), sourceId);
  const url = `https://${hypergryphGames[game].officialHost}/news/${sourceId}`;
  return { game, region: "cn", source: "hypergryph", sourceId, url, title: meta.title, publishedAt: meta.publishedAt, content: meta.content, contentHash: sha256Utf8(meta.content) as Sha256, fetchedAt };
}
