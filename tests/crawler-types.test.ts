import { describe, expect, it } from "vitest";
import {
  ApprovalSelectionSchema,
  CandidateItemSchema,
  NeedsReviewCandidateSchema,
  RawArticleSchema,
  ReadyEventCandidateSchema,
  sha256Schema,
} from "../scripts/crawl/types.ts";
import { eventSchema, eventTypesSchema, versionSchema } from "../src/lib/data.ts";

describe("formal data schema exports", () => {
  it("exports the single formal YAML schemas", () => {
    expect(versionSchema.safeParse({}).success).toBe(false);
    expect(eventSchema.safeParse({}).success).toBe(false);
    expect(eventTypesSchema.safeParse({}).success).toBe(false);
  });
});

describe("crawler runtime schemas", () => {
  it("accepts only sha256 hashes", () => {
    expect(sha256Schema.safeParse("sha256:" + "a".repeat(64)).success).toBe(true);
    expect(sha256Schema.safeParse("sha256:bad").success).toBe(false);
  });

  it("validates canonical raw articles and rejects unknown fields", () => {
    const raw = {
      game: "genshin-impact",
      region: "cn",
      source: "mihoyo",
      sourceId: "165690",
      url: "https://ys.mihoyo.com/main/news/detail/165690",
      title: "Official notice",
      publishedAt: "2026-08-25 00:00:00",
      content: "Official content",
      contentHash: "sha256:" + "a".repeat(64),
      fetchedAt: "2026-08-25T10:24:52+00:00",
    };

    expect(RawArticleSchema.safeParse(raw).success).toBe(true);
    expect(RawArticleSchema.safeParse({ ...raw, extra: true }).success).toBe(false);
  });

  it("allows unknown kind only for needs-review candidates", () => {
    const candidate = {
      game: "genshin-impact",
      region: "cn",
      candidateKey: "genshin-impact/165690/unknown",
      sourceId: "165690",
      semanticSlot: "unknown",
      rawRef: { runId: "20260825-102452", game: "genshin-impact", sourceId: "165690" },
      sourceHash: "sha256:" + "b".repeat(64),
      candidateHash: "sha256:" + "c".repeat(64),
      name: "Unclassified notice",
      sources: ["https://ys.mihoyo.com/main/news/detail/165690"],
      evidence: [],
      review: "needs_review",
      reviewReasons: ["unclassified"],
      kind: "unknown",
    };

    expect(NeedsReviewCandidateSchema.safeParse(candidate).success).toBe(true);
    expect(CandidateItemSchema.safeParse(candidate).success).toBe(true);
  });

  it("rejects a ready candidate with unknown kind", () => {
    const candidate = {
      game: "genshin-impact",
      region: "cn",
      candidateKey: "genshin-impact/165690/unknown",
      sourceId: "165690",
      semanticSlot: "unknown",
      rawRef: { runId: "20260825-102452", game: "genshin-impact", sourceId: "165690" },
      sourceHash: "sha256:" + "b".repeat(64),
      candidateHash: "sha256:" + "c".repeat(64),
      name: "Unclassified notice",
      sources: ["https://ys.mihoyo.com/main/news/detail/165690"],
      evidence: [],
      review: "ready",
      reviewReasons: [],
      kind: "unknown",
      start: "2026-08-25T10:00:00+08:00",
    };

    expect(CandidateItemSchema.safeParse(candidate).success).toBe(false);
  });

  it("uses a strict kind-specific approval selection union", () => {
    const selection = {
      schemaVersion: 1,
      runId: "20260825-102452",
      selections: [{
        candidateKey: "genshin-impact/165690/event-1",
        candidateHash: "sha256:" + "a".repeat(64),
        sourceHash: "sha256:" + "b".repeat(64),
        kind: "event",
        operation: "add",
        expectedOldValueHash: null,
        targetId: "event-1",
        targetFile: "data/genshin-impact/cn-2026.yaml",
      }],
    };

    expect(ApprovalSelectionSchema.safeParse(selection).success).toBe(true);
    expect(ApprovalSelectionSchema.safeParse({
      ...selection,
      selections: [{ ...selection.selections[0], unexpected: true }],
    }).success).toBe(false);
  });

  it("requires the native subtype to be a formal event subtype", () => {
    const event = {
      game: "genshin-impact",
      region: "cn",
      candidateKey: "genshin-impact/165690/event-1",
      sourceId: "165690",
      semanticSlot: "event-1",
      rawRef: { runId: "20260825-102452", game: "genshin-impact", sourceId: "165690" },
      sourceHash: "sha256:" + "b".repeat(64),
      candidateHash: "sha256:" + "c".repeat(64),
      name: "Event",
      sources: ["https://ys.mihoyo.com/main/news/detail/165690"],
      evidence: [{ field: "subtype", text: "main event" }],
      review: "ready",
      reviewReasons: [],
      kind: "event",
      type: "event",
      start: "2026-08-25T10:00:00+08:00",
      subtype: "main_event",
      timeCertainty: { start: "confirmed" },
    };

    expect(ReadyEventCandidateSchema.safeParse(event).success).toBe(true);
    expect(ReadyEventCandidateSchema.safeParse({ ...event, subtype: "not-formal" }).success).toBe(false);
  });
});
