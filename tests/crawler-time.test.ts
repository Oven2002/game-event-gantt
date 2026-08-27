import { describe, expect, it } from "vitest";
import {
  parseBeijingTimestamp,
  parseExplicitInterval,
  parseDateTimeText,
} from "../scripts/crawl/common/time.ts";
import { parseArticleCandidates, parseArticleCandidate } from "../scripts/crawl/parsers/article.ts";
import type { Sha256 } from "../scripts/crawl/types.ts";
import { parseMaintenanceText } from "../scripts/crawl/parsers/maintenance.ts";
import { parseTimelineText } from "../scripts/crawl/parsers/timeline.ts";

describe("Beijing time parser", () => {
  it("accepts only valid minute timestamps with +08:00", () => {
    expect(parseBeijingTimestamp("2026-08-20T04:00:00+08:00")).toBe("2026-08-20T04:00:00+08:00");
    expect(() => parseBeijingTimestamp("2026-08-20T04:00:30+08:00")).toThrow();
    expect(() => parseBeijingTimestamp("2026-08-20T04:00:00Z")).toThrow();
    expect(() => parseBeijingTimestamp("2026-02-30T04:00:00+08:00")).toThrow();
  });

  it("parses same-day and cross-month explicit intervals", () => {
    expect(parseExplicitInterval("2026年8月20日 04:00 至 11:00")).toMatchObject({
      start: "2026-08-20T04:00:00+08:00",
      end: "2026-08-20T11:00:00+08:00",
      certainty: "confirmed",
    });
    expect(parseExplicitInterval("2026/08/20 04:00 - 09/03 05:59")).toMatchObject({
      start: "2026-08-20T04:00:00+08:00",
      end: "2026-09-03T05:59:00+08:00",
    });
  });

  it("marks missing year, non-minute and foreign-offset text for review", () => {
    expect(parseDateTimeText("8月20日 04:00")).toMatchObject({ status: "needs_review" });
    expect(parseDateTimeText("2026年8月20日 04:00:30")).toMatchObject({ status: "needs_review" });
    expect(parseDateTimeText("2026-08-20T04:00:00Z")).toMatchObject({ status: "needs_review" });
    expect(parseDateTimeText("1970-01-01 00:00")).toMatchObject({ status: "confirmed" });
    expect(parseDateTimeText("1969-12-31 23:59")).toMatchObject({ status: "needs_review" });
  });
});

describe("announcement timeline semantics", () => {
  it("does not invent an end for next-maintenance wording", () => {
    const result = parseMaintenanceText("活动将持续至下次维护前");
    expect(result).toMatchObject({ status: "needs_review" });
    expect(result).not.toHaveProperty("end");
  });

  it("marks maintenance-after start as inferred with a note", () => {
    expect(parseMaintenanceText("维护结束后开启活动", { maintenanceEnd: "2026-08-20T11:00:00+08:00" })).toMatchObject({
      start: "2026-08-20T11:00:00+08:00",
      certainty: "inferred",
    });
  });

  it("keeps ambiguous article semantics in needs_review", () => {
    expect(parseArticleCandidates({ title: "版本更新说明", content: "活动时间见图片" })).toMatchObject({ status: "needs_review" });
    expect(parseTimelineText("2026年8月20日 04:00 至 11:00", { kind: "event", name: "活动" })).toMatchObject({
      kind: "event",
      start: "2026-08-20T04:00:00+08:00",
      end: "2026-08-20T11:00:00+08:00",
    });
  });

  it("classifies an article with one explicit interval without guessing", () => {
    expect(parseArticleCandidates({ title: "活动说明", content: "活动时间：8月20日 04:00 至 11:00", publishedAt: "2026-08-01T00:00:00+08:00" })).toMatchObject({ status: "ready", kind: "event", start: "2026-08-20T04:00:00+08:00", end: "2026-08-20T11:00:00+08:00" });
  });

  it("maps maintenance notices to the configured maintenance event type", () => {
    expect(parseArticleCandidates({
      title: "停机维护公告",
      content: "维护时间：2026年8月20日 04:00 至 2026年8月20日 11:00",
    })).toMatchObject({ status: "ready", kind: "event", type: "maintenance" });
  });

  it("requires a concrete version identity before producing a ready version", () => {
    expect(parseArticleCandidates({
      title: "版本更新说明",
      content: "版本时间：2026年8月20日 04:00 至 2026年8月20日 11:00",
      publishedAt: "2026-08-01T00:00:00+08:00",
    })).toMatchObject({ status: "needs_review", kind: "version", reason: "version identity is not confirmed" });
  });

  it("prioritizes banner and preview markers over a version number", () => {
    const content = "时间：2026年8月20日 04:00 至 2026年8月20日 11:00";
    expect(parseArticleCandidates({ title: "4.5版本活动跃迁（其一）", content })).toMatchObject({ status: "ready", kind: "event", type: "banner" });
    expect(parseArticleCandidates({ title: "3.2版本前瞻特别节目预告", content })).toMatchObject({ status: "ready", kind: "event", type: "preview" });
    expect(parseArticleCandidates({ title: "4.5版本更新说明", content })).toMatchObject({ status: "ready", kind: "version" });
  });
  it("rejects multiple windows instead of collapsing them", () => {
    expect(parseArticleCandidates({ title: "活动说明", content: "第一期：2026年8月20日 04:00 至 11:00；第二期：2026年8月21日 04:00 至 11:00" })).toMatchObject({ status: "needs_review" });
  });

  it("parses hyphen-separated calendar dates", () => {
    expect(parseExplicitInterval("2026-08-20 04:00 - 2026-09-03 05:59")).toMatchObject({
      start: "2026-08-20T04:00:00+08:00",
      end: "2026-09-03T05:59:00+08:00",
    });
  });

  it("returns needs_review for an invalid maintenance context", () => {
    expect(parseMaintenanceText("维护结束后开启活动", { maintenanceEnd: "not-a-time" })).toMatchObject({ status: "needs_review" });
  });

  it("returns the formal CandidateItem boundary for a parsed RawArticle", () => {
    const candidate = parseArticleCandidate({
      game: "demo", region: "cn", source: "official", sourceId: "123", url: "https://example.com/news/123",
      title: "活动说明", publishedAt: "2026-08-01T00:00:00+08:00", content: "活动时间：8月20日 04:00 至 11:00",
      contentHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Sha256,
      fetchedAt: "2026-08-01T00:00:00+00:00",
    }, "20260801-000000", "slot-1");
    expect(candidate).toMatchObject({ game: "demo", region: "cn", candidateKey: "demo/123/slot-1", rawRef: { runId: "20260801-000000", game: "demo", sourceId: "123" }, kind: "event", review: "ready", start: "2026-08-20T04:00:00+08:00", end: "2026-08-20T11:00:00+08:00" });
  });

  it("classifies version activity notices as events rather than versions", () => {
    expect(parseArticleCandidates({
      title: "4.5版本活动说明",
      content: "活动时间：2026年8月20日 04:00 至 2026年8月20日 11:00",
      publishedAt: "2026-08-01T00:00:00+08:00",
    })).toMatchObject({ status: "ready", kind: "event", type: "event" });
  });

  it("parses the supported yearless slash end date through the article entrypoint", () => {
    expect(parseArticleCandidates({
      title: "活动说明",
      content: "活动时间：2026/08/20 04:00 - 09/03 05:59",
      publishedAt: "2026-08-01T00:00:00+08:00",
    })).toMatchObject({
      status: "ready",
      start: "2026-08-20T04:00:00+08:00",
      end: "2026-09-03T05:59:00+08:00",
    });
  });

  it("produces an inferred start when an activity opens after a validated maintenance window", () => {
    expect(parseArticleCandidates({
      title: "活动说明",
      content: "维护时间：2026年8月20日 04:00 至 2026年8月20日 11:00，活动将在维护后开启",
      publishedAt: "2026-08-01T00:00:00+08:00",
    })).toMatchObject({
      status: "ready",
      kind: "event",
      certainty: "inferred",
      start: "2026-08-20T11:00:00+08:00",
    });
  });

  it("rejects an invalid formal candidate at the runtime schema boundary", () => {
    expect(() => parseArticleCandidate({
      game: "demo", region: "cn", source: "official", sourceId: "123", url: "not-a-url",
      title: "活动说明", publishedAt: "2026-08-01T00:00:00+08:00", content: "活动时间：2026年8月20日 04:00 至 11:00",
      contentHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Sha256,
      fetchedAt: "2026-08-01T00:00:00+00:00",
    }, "20260801-000000", "slot-1")).toThrow(/candidate|URL/i);
  });
});
