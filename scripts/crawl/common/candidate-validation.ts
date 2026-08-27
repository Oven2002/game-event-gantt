import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { CandidateItemSchema, type CandidateItem, type CandidateRejection } from "../types.ts";
import { evaluateSource } from "./source-policy.ts";

export interface CandidateValidationOptions { supportsVersions: boolean; eventTypeIds: string[]; }
export type CandidateValidationResult = { ok: true; candidate: CandidateItem } | { ok: false; rejection: CandidateRejection };

export async function loadEventTypeIds(path: string): Promise<string[]> {
  const value: unknown = parseYaml(await readFile(path, "utf8"));
  if (typeof value !== "object" || value === null || !Array.isArray((value as { types?: unknown }).types)) throw new Error("invalid event types config");
  return (value as { types: unknown[] }).types.map((item) => {
    if (typeof item !== "object" || item === null || typeof (item as { id?: unknown }).id !== "string" || !(item as { id: string }).id) throw new Error("invalid event type entry");
    return (item as { id: string }).id;
  });
}

function rejection(candidate: Partial<CandidateItem>, reasonCode: CandidateRejection["reasonCode"], detail: string): CandidateValidationResult {
  const rawRef = candidate.rawRef ?? { runId: "unknown", game: candidate.game ?? "unknown", sourceId: candidate.sourceId ?? "unknown" };
  return { ok: false, rejection: { rawRef, candidateKey: candidate.candidateKey, attemptedKind: candidate.kind === "version" || candidate.kind === "event" ? candidate.kind : undefined, reasonCode, detail } };
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
  if (parsed.kind === "version" && !options.supportsVersions) return rejection(parsed, "supports_versions_disabled", "this game does not support versions");
  if (parsed.kind === "event" && parsed.review === "ready" && !options.eventTypeIds.includes(parsed.type)) return rejection(parsed, "candidate_validation_failed", `event type is not configured: ${parsed.type}`);
  for (const source of parsed.sources) {
    const decision = evaluateSource(parsed.game, source);
    if (!decision.allowed) return rejection(parsed, "candidate_validation_failed", decision.reason);
  }
  if (parsed.review === "ready") {
    const evidenceFields = new Set(parsed.evidence.map((item) => item.field));
    if (!evidenceFields.has("start") || ("end" in parsed && parsed.end !== undefined && !evidenceFields.has("end"))) return rejection(parsed, "candidate_validation_failed", "confirmed times require evidence");
    if (parsed.timeCertainty.start !== "confirmed" && !("note" in parsed && parsed.note)) return rejection(parsed, "candidate_validation_failed", "inferred or estimated times require note");
    if ("end" in parsed && parsed.end !== undefined && parsed.timeCertainty.end !== "confirmed" && !("note" in parsed && parsed.note)) return rejection(parsed, "candidate_validation_failed", "inferred or estimated times require note");
  }
  return { ok: true, candidate: parsed };
}
