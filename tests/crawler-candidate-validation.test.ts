import { describe, expect, it } from "vitest";
import { parseArticleCandidate } from "../scripts/crawl/parsers/article.ts";
import { validateCandidate, loadEventTypeIds } from "../scripts/crawl/common/candidate-validation.ts";
import type { RawArticle, Sha256 } from "../scripts/crawl/types.ts";

const raw = (overrides: Partial<RawArticle> = {}): RawArticle => ({
  game: "genshin-impact", region: "cn", source: "mihoyo", sourceId: "123",
  url: "https://ys.mihoyo.com/main/news/detail/123", title: "活动说明",
  publishedAt: "2026-08-01T00:00:00+08:00", content: "活动时间：8月20日 04:00 至 11:00",
  contentHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Sha256,
  fetchedAt: "2026-08-01T00:00:00+00:00", ...overrides,
});

describe("candidate validation", () => {
  it("loads event type ids from the official data config", async () => {
    await expect(loadEventTypeIds("data/event-types.yaml")).resolves.toEqual(["event", "banner", "preview", "maintenance"]);
  });

  it("accepts a ready candidate with evidence and an allowed source", () => {
    const candidate = parseArticleCandidate(raw(), "20260801-000000", "slot-1");
    expect(validateCandidate(candidate, { supportsVersions: true, eventTypeIds: ["event", "banner", "preview", "maintenance"] })).toMatchObject({ ok: true });
  });

  it("rejects version candidates for an events-only game", () => {
    const candidate = parseArticleCandidate(raw({ title: "7.0版本更新说明", content: "版本时间：2026年8月20日 04:00 至 2026年9月30日 04:00" }), "20260801-000000", "version");
    expect(validateCandidate(candidate, { supportsVersions: false, eventTypeIds: ["event"] })).toMatchObject({ ok: false, rejection: { reasonCode: "supports_versions_disabled" } });
  });

  it("rejects unknown event types and sources that are discovery-only", () => {
    const candidate = parseArticleCandidate(raw(), "20260801-000000", "slot-1");
    expect(validateCandidate({ ...candidate, type: "unknown" } as typeof candidate, { supportsVersions: true, eventTypeIds: ["event"] })).toMatchObject({ ok: false, rejection: { reasonCode: "candidate_validation_failed" } });
    expect(validateCandidate({ ...candidate, sources: ["https://www.zhihu.com/question/123"] } as typeof candidate, { supportsVersions: true, eventTypeIds: ["event"] })).toMatchObject({ ok: false, rejection: { reasonCode: "candidate_validation_failed" } });
  });

  it("requires evidence for confirmed times and note for estimated times", () => {
    const candidate = parseArticleCandidate(raw(), "20260801-000000", "slot-1");
    expect(validateCandidate({ ...candidate, evidence: [] } as typeof candidate, { supportsVersions: true, eventTypeIds: ["event"] })).toMatchObject({ ok: false });
  });
});
