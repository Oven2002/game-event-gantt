import { parseExplicitInterval } from "../common/time.ts";
import { candidateHashProjection, hashCanonicalJson, sourceHashProjection } from "../common/hash.ts";
import type { CandidateItem, RawArticle, Sha256 } from "../types.ts";
import { CandidateItemSchema } from "../types.ts";

export type ArticleKind = "version" | "event";
export interface ParsedArticleCandidate {
  status: "ready" | "needs_review";
  kind?: ArticleKind;
  type?: string;
  name?: string;
  start?: string;
  end?: string;
  certainty?: "confirmed";
  reason?: string;
}

type ArticleClassification = { kind: "version" } | { kind: "event"; type: "event" | "banner" | "preview" | "maintenance" };

function classify(title: string): ArticleClassification | undefined {
  if (/前瞻|特别节目/.test(title)) return { kind: "event", type: "preview" };
  if (/寻访|祈愿|跃迁|调频/.test(title)) return { kind: "event", type: "banner" };
  if (/维护|停机|闪断/.test(title)) return { kind: "event", type: "maintenance" };
  if (/(?:版本.*(?:更新|研发|说明|公告)|更新说明)/.test(title)) return { kind: "version" };
  if (/活动/.test(title)) return { kind: "event", type: "event" };
  return undefined;
}

export function parseArticleCandidates(article: { title: string; content: string; publishedAt?: string | null }): ParsedArticleCandidate {
  const classification = classify(article.title);
  if (!classification) return { status: "needs_review", reason: "article kind is not deterministically classified" };
  const base = classification.kind === "event" ? classification : { kind: classification.kind };
  if (!article.content.trim() || /图片|见图|长图/.test(article.content)) return { ...base, status: "needs_review", reason: "time is image-only or content is empty" };
  const intervalPattern = /(?:\d{4}[年/-]\d{1,2}[月/-]\d{1,2}(?:日)?|\d{1,2}月\d{1,2}日)\s*\d{1,2}:\d{2}\s*(?:至|到|—|–|-)\s*(?:\d{4}[年/-]\d{1,2}[月/-]\d{1,2}(?:日)?|\d{1,2}月\d{1,2}日)?\s*\d{1,2}:\d{2}/g;
  const intervals = [...article.content.matchAll(intervalPattern)];
  if (intervals.length !== 1) return { ...base, status: "needs_review", reason: intervals.length === 0 ? "no explicit interval" : "multiple time windows" };
  const referenceYear = article.publishedAt && /^(\d{4})-/.exec(article.publishedAt)?.[1];
  try {
    const interval = parseExplicitInterval(intervals[0][0], referenceYear ? Number(referenceYear) : undefined);
    return { ...base, status: "ready", name: article.title, ...interval };
  } catch (error) {
    return { ...base, status: "needs_review", reason: error instanceof Error ? error.message : "invalid interval" };
  }
}

export function parseArticleCandidate(raw: RawArticle, runId: string, semanticSlot: string): CandidateItem {
  if (!semanticSlot || semanticSlot.includes("/")) throw new Error("semanticSlot must not contain slash");
  const parsed = parseArticleCandidates(raw);
  const candidateKey = `${raw.game}/${raw.sourceId}/${semanticSlot}`;
  const sourceHash = hashCanonicalJson(sourceHashProjection(raw)) as Sha256;
  const base = {
    game: raw.game, region: raw.region, candidateKey, sourceId: raw.sourceId, semanticSlot,
    rawRef: { runId, game: raw.game, sourceId: raw.sourceId }, sourceHash, name: raw.title,
    sources: [raw.url],
    evidence: parsed.start ? [{ field: "start" as const, text: parsed.start }, ...(parsed.end ? [{ field: "end" as const, text: parsed.end }] : [])] : [],
    reviewReasons: parsed.reason ? [parsed.reason] : [],
  };
  const candidate = parsed.status === "ready" && parsed.kind && parsed.start
    ? parsed.kind === "version"
      ? { ...base, kind: "version" as const, review: "ready" as const, start: parsed.start, end: parsed.end!, timeCertainty: { start: "confirmed" as const, end: "confirmed" as const } }
      : { ...base, kind: "event" as const, review: "ready" as const, type: parsed.type ?? "event", start: parsed.start, ...(parsed.end ? { end: parsed.end } : {}), timeCertainty: { start: "confirmed" as const, ...(parsed.end ? { end: "confirmed" as const } : {}) } }
    : { ...base, kind: parsed.kind ?? "unknown" as const, ...(parsed.kind === "event" ? { type: parsed.type ?? "event" } : {}), review: "needs_review" as const };
  const withHash = { ...candidate, candidateHash: hashCanonicalJson(candidateHashProjection(candidate)) as Sha256 };
  try {
    const checked = CandidateItemSchema.safeParse(withHash);
    if (!checked.success) throw new Error(checked.error.message);
    return checked.data as CandidateItem;
  } catch (error) {
    throw new Error(`candidate schema validation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
