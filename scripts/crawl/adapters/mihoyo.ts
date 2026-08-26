import { sha256Utf8 } from "../common/hash.ts";
import type { RawArticle, Sha256 } from "../types.ts";
import { mihoyoGames, type MihoyoGameConfig } from "../mihoyo-config.ts";

export interface MihoyoListItem {
  sourceId: string;
  title: string;
  url: string;
  publishedAt: string | null;
  content: string;
  contentHash: Sha256;
}

export interface MihoyoListPage {
  total: number;
  items: MihoyoListItem[];
}

export class MihoyoAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MihoyoAdapterError";
  }
}

const detailUrlTemplates: Record<MihoyoGameConfig["game"], string> = {
  "genshin-impact": "https://ys.mihoyo.com/main/news/detail/{sourceId}",
  "honkai-star-rail": "https://sr.mihoyo.com/news/{sourceId}",
  "zenless-zone-zero": "https://zenless.hoyoverse.com/zh-cn/news/{sourceId}",
};

export function buildMihoyoDetailUrl(game: MihoyoGameConfig["game"], sourceId: string): string {
  return detailUrlTemplates[game].replace("{sourceId}", encodeURIComponent(sourceId));
}

export interface MihoyoRequest {
  method: "GET";
  url: string;
  parameters: Record<string, string>;
}

function buildMihoyoApiUrl(game: MihoyoGameConfig["game"], endpoint: "getContentList" | "getContent"): string {
  return `https://${mihoyoGames[game].officialHosts[0]}/content_v2_user/app/${mihoyoGames[game].appId}/${endpoint}`;
}

export function buildMihoyoListRequest(game: MihoyoGameConfig["game"], page: number, pageSize: number): MihoyoRequest {
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1) throw new MihoyoAdapterError("invalid pagination");
  const parameters = {
    iPage: String(page),
    iPageSize: String(pageSize),
    sLangKey: "zh-cn",
    isPreview: "0",
    iChanId: String(mihoyoGames[game].channels[0]),
    ...(mihoyoGames[game].listAppId === undefined ? {} : { iAppId: mihoyoGames[game].listAppId }),
  };
  return { method: "GET", url: `${buildMihoyoApiUrl(game, "getContentList")}?${new URLSearchParams(parameters)}`, parameters };
}

export function buildMihoyoDetailRequest(game: MihoyoGameConfig["game"], sourceId: string): MihoyoRequest {
  if (!/^\d+$/.test(sourceId)) throw new MihoyoAdapterError("invalid sourceId");
  const parameters = { iInfoId: sourceId, iPageSize: "50", sLangKey: "zh-cn", isPreview: "0" };
  return { method: "GET", url: `${buildMihoyoApiUrl(game, "getContent")}?${new URLSearchParams(parameters)}`, parameters };
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, digits: string) => String.fromCodePoint(Number(digits)))
    .replace(/&#x([0-9a-f]+);/gi, (_, digits: string) => String.fromCodePoint(Number.parseInt(digits, 16)));
}

export function normalizeContent(html: string): string {
  return decodeHtmlEntities(html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\s*\/(?:p|div|li|h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]+>/g, ""))
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter((line, index, lines) => line.length > 0 || (index > 0 && lines[index - 1].length > 0))
    .join("\n")
    .trim();
}

function getData(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || !("retcode" in body) || (body as { retcode?: unknown }).retcode !== 0) {
    throw new MihoyoAdapterError("invalid retcode");
  }
  if (!("data" in body)) throw new MihoyoAdapterError("missing data envelope");
  const data = (body as { data: unknown }).data;
  if (typeof data !== "object" || data === null) throw new MihoyoAdapterError("invalid data envelope");
  return data as Record<string, unknown>;
}

function getString(value: unknown, field: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) throw new MihoyoAdapterError(`missing ${field}`);
  return value;
}

function normalizeItem(game: MihoyoGameConfig["game"], item: Record<string, unknown>, fetchedAt?: string): MihoyoListItem | RawArticle {
  const sourceId = String(item.iInfoId ?? "");
  if (!/^\d+$/.test(sourceId)) throw new MihoyoAdapterError("missing iInfoId");
  const title = getString(item.sTitle, "sTitle");
  const content = normalizeContent(getString(item.sContent, "sContent", true));
  const contentHash = sha256Utf8(content) as Sha256;
  const normalized = {
    sourceId,
    title,
    url: buildMihoyoDetailUrl(game, sourceId),
    publishedAt: typeof item.dtCreateTime === "string" ? item.dtCreateTime : null,
    content,
    contentHash,
  };
  if (fetchedAt === undefined) return normalized;
  return {
    game,
    region: "cn",
    source: "mihoyo",
    sourceId,
    url: normalized.url,
    title,
    publishedAt: normalized.publishedAt,
    content,
    contentHash,
    fetchedAt,
  } satisfies RawArticle;
}

export function parseMihoyoList(game: MihoyoGameConfig["game"], body: unknown): MihoyoListPage {
  const data = getData(body);
  if (!Array.isArray(data.list)) throw new MihoyoAdapterError("missing data.list");
  const seen = new Set<string>();
  const items: MihoyoListItem[] = [];
  for (const raw of data.list) {
    if (typeof raw !== "object" || raw === null) throw new MihoyoAdapterError("invalid list item");
    const item = normalizeItem(game, raw as Record<string, unknown>);
    const key = `${item.sourceId}:${item.contentHash}`;
    if (!seen.has(key)) {
      seen.add(key);
      items.push(item);
    }
  }
  return { total: typeof data.iTotal === "number" ? data.iTotal : items.length, items };
}

export function parseMihoyoDetail(game: MihoyoGameConfig["game"], body: unknown, fetchedAt: string): RawArticle {
  return normalizeItem(game, getData(body), fetchedAt) as RawArticle;
}

export function getMihoyoConfig(game: MihoyoGameConfig["game"]): MihoyoGameConfig {
  return mihoyoGames[game];
}
