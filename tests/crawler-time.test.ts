import { describe, expect, it } from "vitest";
import {
  parseBeijingTimestamp,
  parseExplicitInterval,
  parseDateTimeText,
} from "../scripts/crawl/common/time.ts";
import { parseArticleCandidates } from "../scripts/crawl/parsers/article.ts";
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
    expect(parseArticleCandidates({ title: "活动说明", content: "活动时间：2026年8月20日 04:00 至 11:00" })).toMatchObject({
      status: "ready",
      kind: "event",
      start: "2026-08-20T04:00:00+08:00",
      end: "2026-08-20T11:00:00+08:00",
    });
  });
});
