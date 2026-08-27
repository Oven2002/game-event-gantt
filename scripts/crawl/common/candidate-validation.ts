import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { eventTypesSchema } from "../../../src/lib/data.ts";
import { CandidateItemSchema } from "../types.ts";
import type { CandidateItem, CandidateRejection, RawArticle, Sha256 } from "../types.ts";
import { candidateHashProjection, hashCanonicalJson, sha256Utf8, sourceHashProjection } from "./hash.ts";
import { evaluateSource } from "./source-policy.ts";

export interface CandidateValidationOptions {
  supportsVersions: boolean;
  eventTypeIds: string[];
  rawArticle: RawArticle;
}
export interface CandidateConfigValidationOptions {
  supportsVersions: boolean;
  eventTypesPath: string;
  rawArticle: RawArticle;
}
export type CandidateValidationResult = { ok: true; candidate: CandidateItem } | { ok: false; rejection: CandidateRejection };

export async function loadEventTypeIds(path: string): Promise<string[]> {
  const parsed = eventTypesSchema.parse(parseYaml(await readFile(path, "utf8")));
  const ids = parsed.types.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) throw new Error("duplicate event type id");
  return ids;
}

function rejection(candidate: Partial<CandidateItem>, reasonCode: CandidateRejection["reasonCode"], detail: string): CandidateValidationResult {
  const rawRef = candidate.rawRef ?? { runId: "unknown", game: candidate.game ?? "unknown", sourceId: candidate.sourceId ?? "unknown" };
  return { ok: false, rejection: { rawRef, candidateKey: candidate.candidateKey, attemptedKind: candidate.kind === "version" || candidate.kind === "event" ? candidate.kind : undefined, reasonCode, detail } };
}

export async function validateCandidateFromConfig(input: unknown, options: CandidateConfigValidationOptions): Promise<CandidateValidationResult> {
  return validateCandidate(input, { supportsVersions: options.supportsVersions, eventTypeIds: await loadEventTypeIds(options.eventTypesPath), rawArticle: options.rawArticle });
}

export function validateCandidate(input: unknown, options: CandidateValidationOptions): CandidateValidationResult {
  let parsed: CandidateItem;
  try {
    const result = CandidateItemSchema.safeParse(input);
    if (!result.success) return rejection((input ?? {}) as Partial<CandidateItem>, "candidate_validation_failed", result.error.message);
    parsed = result.data as CandidateItem;
  } catch (error) {
    return rejection((input ?? {}) as Partial<CandidateItem>, "candidate_validation_failed", error instanceof Error ? error.message : String(error));
  }
  if (parsed.game !== options.rawArticle.game || parsed.region !== options.rawArticle.region || parsed.sourceId !== options.rawArticle.sourceId) return rejection(parsed, "invalid_source_identity", "candidate identity does not match raw article");
  if (sha256Utf8(options.rawArticle.content) !== options.rawArticle.contentHash) return rejection(parsed, "invalid_source_identity", "raw contentHash does not match content");
  const expectedSourceHash = hashCanonicalJson(sourceHashProjection(options.rawArticle)) as Sha256;
  if (parsed.sourceHash !== expectedSourceHash) return rejection(parsed, "invalid_source_identity", "sourceHash does not match raw article");
  const expectedCandidateHash = hashCanonicalJson(candidateHashProjection(parsed)) as Sha256;
  if (parsed.candidateHash !== expectedCandidateHash) return rejection(parsed, "candidate_validation_failed", "candidateHash does not match candidate content");
  if (!parsed.sources.includes(options.rawArticle.url)) return rejection(parsed, "invalid_source_identity", "candidate sources do not include raw article URL");
  if (parsed.kind === "version" && !options.supportsVersions) return rejection(parsed, "supports_versions_disabled", "this game does not support versions");
  if (parsed.kind === "event" && parsed.review === "ready" && !options.eventTypeIds.includes(parsed.type)) return rejection(parsed, "candidate_validation_failed", `event type is not configured: ${parsed.type}`);
  for (const source of parsed.sources) {
    const author = options.rawArticle.sourceAuthor;
    const decision = evaluateSource(parsed.game, source, author ? {
      platform: author.platform,
      authorId: author.accountId,
      authorProfileUrl: author.profileUrl,
    } : undefined);
    if (!decision.allowed) return rejection(parsed, "candidate_validation_failed", decision.reason);
  }
  if (parsed.review === "ready") {
    const evidenceFields = new Set(parsed.evidence.map((item) => item.field));
    const startEvidence = parsed.evidence.find((item) => item.field === "start");
    if (!evidenceFields.has("start") || !startEvidence || startEvidence.text !== parsed.start || ("end" in parsed && parsed.end !== undefined && (!evidenceFields.has("end") || parsed.evidence.find((item) => item.field === "end")?.text !== parsed.end))) return rejection(parsed, "candidate_validation_failed", "confirmed times require matching evidence");
    if (parsed.timeCertainty.start !== "confirmed" && !("note" in parsed && parsed.note)) return rejection(parsed, "candidate_validation_failed", "inferred or estimated times require note");
    if ("end" in parsed && parsed.end !== undefined && parsed.timeCertainty.end !== "confirmed" && !("note" in parsed && parsed.note)) return rejection(parsed, "candidate_validation_failed", "inferred or estimated times require note");
  }
  return { ok: true, candidate: parsed };
}
