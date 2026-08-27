import { describe, expect, it } from "vitest";
import { parseArticleCandidate } from "../scripts/crawl/parsers/article.ts";
import { candidateHashProjection, hashCanonicalJson, sha256Utf8 } from "../scripts/crawl/common/hash.ts";
import { validateCandidate, validateCandidateFromConfig, loadEventTypeIds } from "../scripts/crawl/common/candidate-validation.ts";
import type { RawArticle, Sha256 } from "../scripts/crawl/types.ts";

const raw = (overrides: Partial<RawArticle> = {}): RawArticle => {
  const value: RawArticle = {
    game: "genshin-impact", region: "cn", source: "mihoyo", sourceId: "123",
    url: "https://ys.mihoyo.com/main/news/detail/123", title: "活动说明",
    publishedAt: "2026-08-01T00:00:00+08:00", content: "活动时间：8月20日 04:00 至 11:00",
    contentHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Sha256,
    fetchedAt: "2026-08-01T00:00:00+00:00", ...overrides,
  };
  return { ...value, contentHash: sha256Utf8(value.content) as Sha256 };
};

const rehashCandidate = <T extends { candidateHash: Sha256 }>(candidate: T): T => ({
  ...candidate,
  candidateHash: hashCanonicalJson(candidateHashProjection(candidate)) as Sha256,
});

describe("candidate validation", () => {
  it("loads event type ids from the official data config", async () => {
    await expect(loadEventTypeIds("data/event-types.yaml")).resolves.toEqual(["event", "banner", "preview", "maintenance"]);
  });

  it("accepts a ready candidate with evidence and an allowed source", async () => {
    const candidate = parseArticleCandidate(raw(), "20260801-000000", "slot-1");
    expect(validateCandidate(candidate, { supportsVersions: true, eventTypeIds: ["event", "banner", "preview", "maintenance"], rawArticle: raw() })).toMatchObject({ ok: true });
    await expect(validateCandidateFromConfig(candidate, { supportsVersions: true, eventTypesPath: "data/event-types.yaml", rawArticle: raw() })).resolves.toMatchObject({ ok: true });
  });

  it("rejects version candidates for an events-only game", () => {
    const candidate = parseArticleCandidate(raw({ title: "7.0版本更新说明", content: "版本时间：2026年8月20日 04:00 至 2026年9月30日 04:00" }), "20260801-000000", "version");
    expect(validateCandidate(candidate, { supportsVersions: false, eventTypeIds: ["event"], rawArticle: raw({ title: "7.0版本更新说明", content: "版本时间：2026年8月20日 04:00 至 2026年9月30日 04:00" }) })).toMatchObject({ ok: false, rejection: { reasonCode: "supports_versions_disabled" } });
  });

  it("rejects unknown event types and sources that are discovery-only", () => {
    const candidate = parseArticleCandidate(raw(), "20260801-000000", "slot-1");
    const unknownType = rehashCandidate({ ...candidate, type: "unknown" });
    const discoverySource = rehashCandidate({ ...candidate, sources: [...candidate.sources, "https://www.zhihu.com/question/123"] });
    expect(validateCandidate(unknownType, { supportsVersions: true, eventTypeIds: ["event"], rawArticle: raw() })).toMatchObject({ ok: false, rejection: { reasonCode: "candidate_validation_failed" } });
    expect(validateCandidate(discoverySource, { supportsVersions: true, eventTypeIds: ["event"], rawArticle: raw() })).toMatchObject({ ok: false, rejection: { reasonCode: "candidate_validation_failed" } });
  });

  it("requires evidence for confirmed times and note for estimated times", () => {
    const candidate = parseArticleCandidate(raw(), "20260801-000000", "slot-1");
    const missingEvidence = rehashCandidate({ ...candidate, evidence: [] });
    const forgedEvidence = rehashCandidate({ ...candidate, evidence: [{ field: "start", text: "forged" }, { field: "end", text: ("end" in candidate ? candidate.end : "") }] });
    const estimatedWithoutNote = rehashCandidate({ ...candidate, timeCertainty: { start: "estimated", end: "confirmed" } });
    expect(validateCandidate(missingEvidence, { supportsVersions: true, eventTypeIds: ["event"], rawArticle: raw() })).toMatchObject({ ok: false });
    expect(validateCandidate(forgedEvidence, { supportsVersions: true, eventTypeIds: ["event"], rawArticle: raw() })).toMatchObject({ ok: false });
    expect(validateCandidate(estimatedWithoutNote, { supportsVersions: true, eventTypeIds: ["event"], rawArticle: raw() })).toMatchObject({ ok: false, rejection: { detail: "inferred or estimated times require note" } });
  });

  it("rejects a candidate when raw content was changed without changing its stale hash", () => {
    const candidate = parseArticleCandidate(raw(), "20260801-000000", "slot-1");
    expect(validateCandidate(candidate, { supportsVersions: true, eventTypeIds: ["event"], rawArticle: raw({ content: "tampered" }) })).toMatchObject({ ok: false, rejection: { reasonCode: "invalid_source_identity" } });
  });

  it("rejects a candidate whose raw article or source hash does not match", () => {
    const candidate = parseArticleCandidate(raw(), "20260801-000000", "slot-1");
    expect(validateCandidate(candidate, { supportsVersions: true, eventTypeIds: ["event"], rawArticle: raw({ title: "另一篇公告" }) })).toMatchObject({ ok: false });
    const wrongSourceHash = rehashCandidate({ ...candidate, sourceHash: sha256Utf8("wrong source") as Sha256 });
    expect(validateCandidate(wrongSourceHash, { supportsVersions: true, eventTypeIds: ["event"], rawArticle: raw() })).toMatchObject({ ok: false, rejection: { reasonCode: "invalid_source_identity" } });
    expect(validateCandidate({ ...candidate, candidateHash: sha256Utf8("wrong candidate") as Sha256 }, { supportsVersions: true, eventTypeIds: ["event"], rawArticle: raw() })).toMatchObject({ ok: false });
  });
});
