import { describe, expect, it } from "vitest";
import {
  ApprovalSelectionSchema,
  CandidateItemSchema,
  NeedsReviewCandidateSchema,
  RawArticleSchema,
  ReadyEventCandidateSchema,
  ApprovedManifestEntrySchema,
  EventSelectionPatchSchema,
  ReadyVersionCandidateSchema,
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

  it("requires fetchedAt to be a real timezone-aware ISO timestamp", () => {
    const raw = {
      game: "genshin-impact",
      region: "cn",
      source: "mihoyo",
      sourceId: "165690",
      url: "https://ys.mihoyo.com/main/news/detail/165690",
      title: "Official notice",
      publishedAt: null,
      content: "Official content",
      contentHash: "sha256:" + "a".repeat(64),
      fetchedAt: "x",
    };
    expect(RawArticleSchema.safeParse(raw).success).toBe(false);
    expect(RawArticleSchema.safeParse({ ...raw, fetchedAt: "2026-02-30T10:24:52+00:00" }).success).toBe(false);
    expect(RawArticleSchema.safeParse({ ...raw, fetchedAt: "2026-08-25T10:24:52Z" }).success).toBe(true);
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

  it("rejects ready candidates without sources", () => {
    const base = {
      game: "genshin-impact",
      region: "cn" as const,
      candidateKey: "genshin-impact/165690/event-1",
      sourceId: "165690",
      semanticSlot: "event-1",
      rawRef: { runId: "20260825-102452", game: "genshin-impact", sourceId: "165690" },
      sourceHash: "sha256:" + "b".repeat(64),
      candidateHash: "sha256:" + "c".repeat(64),
      name: "Event",
      sources: [],
      evidence: [],
      review: "ready" as const,
      reviewReasons: [],
      kind: "event" as const,
      type: "event",
      start: "2026-08-25T10:00:00+08:00",
      timeCertainty: { start: "confirmed" as const },
    };

    expect(ReadyEventCandidateSchema.safeParse(base).success).toBe(false);
  });

  it("rejects impossible Beijing timestamps", () => {
    const candidate = {
      game: "genshin-impact",
      region: "cn",
      candidateKey: "genshin-impact/165690/version-1",
      sourceId: "165690",
      semanticSlot: "version-1",
      rawRef: { runId: "20260825-102452", game: "genshin-impact", sourceId: "165690" },
      sourceHash: "sha256:" + "b".repeat(64),
      candidateHash: "sha256:" + "c".repeat(64),
      name: "Version",
      sources: ["https://ys.mihoyo.com/main/news/detail/165690"],
      evidence: [],
      review: "ready",
      reviewReasons: [],
      kind: "version",
      start: "2026-99-99T99:99:00+08:00",
      end: "2026-12-31T23:59:00+08:00",
      timeCertainty: { start: "confirmed" },
    };

    expect(ReadyVersionCandidateSchema.safeParse(candidate).success).toBe(false);
  });

  it("rejects patch fields that conflict with the manifest kind", () => {
    const manifestEntry = {
      candidateKey: "genshin-impact/165690/version-1",
      candidateHash: "sha256:" + "a".repeat(64),
      sourceHash: "sha256:" + "b".repeat(64),
      game: "genshin-impact",
      region: "cn",
      operation: "update",
      targetFile: "data/genshin-impact/cn-2026.yaml",
      targetId: "version-1",
      oldValueHash: "sha256:" + "d".repeat(64),
      proposalHash: "sha256:" + "e".repeat(64),
      kind: "version",
      patch: { kind: "event", set: { priority: 1 }, unset: [] },
      oldValue: null,
      yamlValue: {
        id: "version-1",
        name: "Version",
        start: "2026-08-25T00:00:00+08:00",
        end: "2026-08-26T00:00:00+08:00",
        sources: ["https://example.com/source"],
      },
    };

    expect(ApprovedManifestEntrySchema.safeParse(manifestEntry).success).toBe(false);
  });

  it("rejects duplicate or overlapping patch fields", () => {
    expect(EventSelectionPatchSchema.safeParse({
      kind: "event",
      set: { priority: 1 },
      unset: ["priority"],
    }).success).toBe(false);
    expect(EventSelectionPatchSchema.safeParse({
      kind: "event",
      set: {},
      unset: ["url", "url"],
    }).success).toBe(false);
  });

  it("requires candidateKey and rawRef to match candidate identity", () => {
    const candidate = {
      game: "genshin-impact",
      region: "cn",
      candidateKey: "star-rail/other-source/event-1",
      sourceId: "165690",
      semanticSlot: "event-1",
      rawRef: { runId: "20260825-102452", game: "star-rail", sourceId: "other-source" },
      sourceHash: "sha256:" + "b".repeat(64),
      candidateHash: "sha256:" + "c".repeat(64),
      name: "Event",
      sources: ["https://ys.mihoyo.com/main/news/detail/165690"],
      evidence: [],
      review: "needs_review",
      reviewReasons: ["identity mismatch"],
      kind: "unknown",
    };

    expect(NeedsReviewCandidateSchema.safeParse(candidate).success).toBe(false);
  });
});
