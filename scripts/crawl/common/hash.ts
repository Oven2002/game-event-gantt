import { createHash } from "node:crypto";
import type { CandidateItem, RawArticle } from "../types.ts";

function compareCodeUnits(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => compareCodeUnits(left, right))
        .map(([key, item]) => [key, sortValue(item)]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

export function sha256Utf8(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

export function hashCanonicalJson(value: unknown): `sha256:${string}` {
  return sha256Utf8(canonicalJson(value));
}

export function canonicalizeUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase();
  if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) url.port = "";
  url.hash = "";
  return url.toString();
}

export function sourceHashProjection(raw: Pick<RawArticle, "game" | "region" | "source" | "sourceId" | "url" | "title" | "publishedAt" | "contentHash">): Record<string, unknown> {
  return {
    game: raw.game,
    region: raw.region,
    source: raw.source,
    sourceId: raw.sourceId,
    url: canonicalizeUrl(raw.url),
    title: raw.title,
    publishedAt: raw.publishedAt,
    contentHash: raw.contentHash,
  };
}

const evidenceOrder = ["name", "type", "start", "end", "related", "source", "lifecycle", "cadence", "subtype"];

export function candidateHashProjection(candidate: CandidateItem | Record<string, unknown>): Record<string, unknown> {
  const value = candidate as Record<string, unknown>;
  const evidence = Array.isArray(value.evidence)
    ? [...value.evidence as Array<{ field: string; text: string }>].sort((left, right) => {
      const fieldDiff = evidenceOrder.indexOf(left.field) - evidenceOrder.indexOf(right.field);
      return fieldDiff || compareCodeUnits(left.text, right.text);
    })
    : [];
  return {
    kind: value.kind,
    game: value.game,
    region: value.region,
    candidateKey: value.candidateKey,
    sourceId: value.sourceId,
    semanticSlot: value.semanticSlot,
    name: value.name,
    type: value.type,
    start: value.start,
    end: value.end,
    timeCertainty: value.timeCertainty,
    note: value.note,
    sources: value.sources,
    relatedCandidateKeys: value.relatedCandidateKeys,
    lifecycle: value.lifecycle,
    cadence: value.cadence,
    subtype: value.subtype,
    review: value.review,
    reviewReasons: value.reviewReasons,
    evidence,
  };
}

export function oldValueHashProjection(value: unknown): unknown {
  return sortValue(value);
}

export function proposalHashProjection(value: {
  operation: "add" | "update";
  kind: "version" | "event";
  candidateHash: unknown;
  sourceHash: unknown;
  oldValueHash: unknown;
  targetFile: unknown;
  targetId: unknown;
  patch: unknown;
  yamlValue: unknown;
}): Record<string, unknown> {
  return {
    operation: value.operation,
    kind: value.kind,
    candidateHash: value.candidateHash,
    sourceHash: value.sourceHash,
    oldValueHash: value.oldValueHash,
    targetFile: value.targetFile,
    targetId: value.targetId,
    patch: value.patch,
    yamlValue: value.yamlValue,
  };
}
