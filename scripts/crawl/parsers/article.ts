import { parseExplicitInterval } from "../common/time.ts";

export type ArticleKind = "version" | "event";
export interface ParsedArticleCandidate {
  status: "ready" | "needs_review";
  kind?: ArticleKind;
  name?: string;
  start?: string;
  end?: string;
  certainty?: "confirmed";
  reason?: string;
}

function classify(title: string): ArticleKind | undefined {
  if (/版本|更新维护|版本更新/.test(title)) return title.includes("版本") ? "version" : undefined;
  if (/活动|寻访|祈愿|跃迁|调频|前瞻/.test(title)) return "event";
  return undefined;
}

export function parseArticleCandidates(article: { title: string; content: string }): ParsedArticleCandidate {
  const kind = classify(article.title);
  if (!kind) return { status: "needs_review", reason: "article kind is not deterministically classified" };
  if (!article.content.trim() || /图片|见图|长图/.test(article.content)) return { status: "needs_review", kind, reason: "time is image-only or content is empty" };
  const intervalText = article.content.match(/(?:\d{4}[年/-]\d{1,2}[月/-]\d{1,2}(?:日)?|\d{1,2}月\d{1,2}日)\s*\d{1,2}:\d{2}\s*(?:至|到|—|–|-)\s*(?:\d{4}[年/-]\d{1,2}[月/-]\d{1,2}(?:日)?|\d{1,2}月\d{1,2}日)?\s*\d{1,2}:\d{2}/);
  if (!intervalText) return { status: "needs_review", kind, reason: "no explicit interval" };
  try {
    const interval = parseExplicitInterval(intervalText[0]);
    return { status: "ready", kind, name: article.title, ...interval };
  } catch (error) {
    return { status: "needs_review", kind, reason: error instanceof Error ? error.message : "invalid interval" };
  }
}
