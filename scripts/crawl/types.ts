import { z } from "zod";
import {
  eventSchema,
  httpUrl,
  subtypeSchema,
  versionSchema,
  type EventYamlValue,
  type VersionYamlValue,
} from "../../src/lib/data.ts";

export type { EventYamlValue, VersionYamlValue };

const entryIdPattern = /^[a-z0-9][a-z0-9._-]*$/;
const candidateKeyPattern = /^[^/]+\/[^/]+\/[^/]+$/;
const beijingTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\+08:00$/;

export const sha256Schema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const beijingTimestampSchema = z.string().regex(beijingTimestampPattern);
const readyTimeCertaintySchema = z.object({
  start: z.enum(["confirmed", "inferred", "estimated"]),
  end: z.enum(["confirmed", "inferred", "estimated"]).optional(),
}).strict();

export interface RawArticle {
  game: string;
  region: "cn";
  source: string;
  sourceId: string;
  url: string;
  title: string;
  publishedAt: string | null;
  content: string;
  contentHash: `sha256:${string}`;
  fetchedAt: string;
}

export interface Evidence {
  field: "name" | "type" | "start" | "end" | "related" | "source" | "lifecycle" | "cadence" | "subtype";
  text: string;
}

export interface CandidateBase {
  game: string;
  region: "cn";
  candidateKey: `${string}/${string}/${string}`;
  sourceId: string;
  semanticSlot: string;
  rawRef: { runId: string; game: string; sourceId: string };
  sourceHash: `sha256:${string}`;
  candidateHash: `sha256:${string}`;
  name: string;
  sources: string[];
  evidence: Evidence[];
  review: "ready" | "needs_review";
  reviewReasons: string[];
}

export interface ReadyVersionCandidate extends CandidateBase {
  kind: "version";
  review: "ready";
  start: string;
  end: string;
  timeCertainty: { start: "confirmed" | "inferred" | "estimated"; end?: "confirmed" | "inferred" | "estimated" };
  note?: string;
}

export interface ReadyEventCandidate extends CandidateBase {
  kind: "event";
  review: "ready";
  type: string;
  start: string;
  end?: string;
  relatedCandidateKeys?: string[];
  lifecycle?: "limited" | "permanent";
  cadence?: "one_off" | "rotating" | "recurring";
  subtype?: EventYamlValue["subtype"];
  timeCertainty: { start: "confirmed" | "inferred" | "estimated"; end?: "confirmed" | "inferred" | "estimated" };
  note?: string;
}

export interface NeedsReviewCandidate extends CandidateBase {
  review: "needs_review";
  kind: "version" | "event" | "unknown";
  type?: string;
}

export type CandidateItem = ReadyVersionCandidate | ReadyEventCandidate | NeedsReviewCandidate;

export interface CandidateRejection {
  rawRef: { runId: string; game: string; sourceId: string };
  candidateKey?: string;
  attemptedKind?: "version" | "event";
  reasonCode: CandidateRejectionReason;
  detail?: string;
}

export type CandidateRejectionReason =
  | "supports_versions_disabled"
  | "article_out_of_scope"
  | "unsupported_official_format"
  | "invalid_source_identity"
  | "candidate_validation_failed";

export type VersionSelectionPatch = {
  kind: "version";
  set: Partial<Pick<VersionYamlValue, "url">>;
  unset: Array<"url">;
};

export type EventSelectionPatch = {
  kind: "event";
  set: Partial<Pick<EventYamlValue, "url" | "priority">>;
  unset: Array<"url" | "priority">;
};

type ApprovedManifestEntryBase = {
  candidateKey: string;
  candidateHash: `sha256:${string}`;
  sourceHash: `sha256:${string}`;
  game: string;
  region: "cn";
  operation: "add" | "update";
  targetFile: string;
  targetId: string;
  oldValueHash: `sha256:${string}` | null;
  proposalHash: `sha256:${string}`;
  patch: VersionSelectionPatch | EventSelectionPatch | null;
};

export type ApprovedManifestEntry =
  | (ApprovedManifestEntryBase & { kind: "version"; oldValue: VersionYamlValue | null; yamlValue: VersionYamlValue })
  | (ApprovedManifestEntryBase & { kind: "event"; oldValue: EventYamlValue | null; yamlValue: EventYamlValue });

type SelectionBase = {
  candidateKey: string;
  candidateHash: `sha256:${string}`;
  sourceHash: `sha256:${string}`;
  targetId: string;
  targetFile: string;
};

export type ApprovalSelectionItem =
  | (SelectionBase & { kind: "version"; operation: "add"; expectedOldValueHash: null; patch?: VersionSelectionPatch })
  | (SelectionBase & { kind: "version"; operation: "update"; expectedOldValueHash: `sha256:${string}`; patch?: VersionSelectionPatch })
  | (SelectionBase & { kind: "event"; operation: "add"; expectedOldValueHash: null; patch?: EventSelectionPatch })
  | (SelectionBase & { kind: "event"; operation: "update"; expectedOldValueHash: `sha256:${string}`; patch?: EventSelectionPatch });

export interface ApprovalSelectionTemplateItem {
  candidateKey: string;
  candidateHash: `sha256:${string}`;
  sourceHash: `sha256:${string}`;
  kind: "version" | "event";
  suggestedOperation?: "add" | "update";
  targetOptions: Array<{
    targetId: string;
    targetFile: string;
    expectedOldValueHash: `sha256:${string}`;
    matchReasons: string[];
  }>;
  matchReasons: string[];
}

export interface ApprovalSelectionTemplate {
  schemaVersion: 1;
  runId: string;
  items: ApprovalSelectionTemplateItem[];
}

export interface ApprovalSelection {
  schemaVersion: 1;
  runId: string;
  selections: ApprovalSelectionItem[];
}

export interface ApprovedManifest {
  schemaVersion: 1;
  runId: string;
  generatedAt: string;
  entries: ApprovedManifestEntry[];
}

export const RawArticleSchema = z.object({
  game: z.string().min(1),
  region: z.literal("cn"),
  source: z.string().min(1),
  sourceId: z.string().min(1),
  url: httpUrl,
  title: z.string().min(1),
  publishedAt: z.string().min(1).nullable(),
  content: z.string(),
  contentHash: sha256Schema,
  fetchedAt: z.string().min(1),
}).strict();

export const EvidenceSchema = z.object({
  field: z.enum(["name", "type", "start", "end", "related", "source", "lifecycle", "cadence", "subtype"]),
  text: z.string(),
}).strict();

const candidateBaseSchema = z.object({
  game: z.string().min(1),
  region: z.literal("cn"),
  candidateKey: z.string().regex(candidateKeyPattern),
  sourceId: z.string().min(1),
  semanticSlot: z.string().min(1),
  rawRef: z.object({ runId: z.string().min(1), game: z.string().min(1), sourceId: z.string().min(1) }).strict(),
  sourceHash: sha256Schema,
  candidateHash: sha256Schema,
  name: z.string().min(1),
  sources: z.array(httpUrl),
  evidence: z.array(EvidenceSchema),
  review: z.enum(["ready", "needs_review"]),
  reviewReasons: z.array(z.string()),
}).strict();

export const ReadyVersionCandidateSchema = candidateBaseSchema.extend({
  kind: z.literal("version"),
  review: z.literal("ready"),
  start: beijingTimestampSchema,
  end: beijingTimestampSchema,
  timeCertainty: readyTimeCertaintySchema,
  note: z.string().min(1).optional(),
}).strict();

export const ReadyEventCandidateSchema = candidateBaseSchema.extend({
  kind: z.literal("event"),
  review: z.literal("ready"),
  type: z.string().min(1),
  start: beijingTimestampSchema,
  end: beijingTimestampSchema.optional(),
  relatedCandidateKeys: z.array(z.string().regex(candidateKeyPattern)).optional(),
  lifecycle: z.enum(["limited", "permanent"]).optional(),
  cadence: z.enum(["one_off", "rotating", "recurring"]).optional(),
  subtype: subtypeSchema.optional(),
  timeCertainty: readyTimeCertaintySchema,
  note: z.string().min(1).optional(),
}).strict();

export const NeedsReviewCandidateSchema = candidateBaseSchema.extend({
  review: z.literal("needs_review"),
  kind: z.enum(["version", "event", "unknown"]),
  type: z.string().min(1).optional(),
}).strict();

export const CandidateItemSchema = z.union([
  ReadyVersionCandidateSchema,
  ReadyEventCandidateSchema,
  NeedsReviewCandidateSchema,
]);

export const CandidateRejectionSchema = z.object({
  rawRef: z.object({ runId: z.string().min(1), game: z.string().min(1), sourceId: z.string().min(1) }).strict(),
  candidateKey: z.string().regex(candidateKeyPattern).optional(),
  attemptedKind: z.enum(["version", "event"]).optional(),
  reasonCode: z.enum([
    "supports_versions_disabled",
    "article_out_of_scope",
    "unsupported_official_format",
    "invalid_source_identity",
    "candidate_validation_failed",
  ]),
  detail: z.string().optional(),
}).strict();

export const VersionSelectionPatchSchema = z.object({
  kind: z.literal("version"),
  set: z.object({ url: httpUrl.optional() }).strict(),
  unset: z.array(z.literal("url")),
}).strict();

export const EventSelectionPatchSchema = z.object({
  kind: z.literal("event"),
  set: z.object({ url: httpUrl.optional(), priority: z.number().int().optional() }).strict(),
  unset: z.array(z.enum(["url", "priority"])),
}).strict();

const selectionBaseSchema = {
  candidateKey: z.string().min(1),
  candidateHash: sha256Schema,
  sourceHash: sha256Schema,
  targetId: z.string().regex(entryIdPattern),
  targetFile: z.string().min(1),
};

export const ApprovalSelectionItemSchema = z.union([
  z.object({ ...selectionBaseSchema, kind: z.literal("version"), operation: z.literal("add"), expectedOldValueHash: z.null(), patch: VersionSelectionPatchSchema.optional() }).strict(),
  z.object({ ...selectionBaseSchema, kind: z.literal("version"), operation: z.literal("update"), expectedOldValueHash: sha256Schema, patch: VersionSelectionPatchSchema.optional() }).strict(),
  z.object({ ...selectionBaseSchema, kind: z.literal("event"), operation: z.literal("add"), expectedOldValueHash: z.null(), patch: EventSelectionPatchSchema.optional() }).strict(),
  z.object({ ...selectionBaseSchema, kind: z.literal("event"), operation: z.literal("update"), expectedOldValueHash: sha256Schema, patch: EventSelectionPatchSchema.optional() }).strict(),
]);

export const ApprovalSelectionSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().min(1),
  selections: z.array(ApprovalSelectionItemSchema),
}).strict();

const targetOptionSchema = z.object({
  targetId: z.string().regex(entryIdPattern),
  targetFile: z.string().min(1),
  expectedOldValueHash: sha256Schema,
  matchReasons: z.array(z.string().min(1)).min(1),
}).strict();

export const ApprovalSelectionTemplateItemSchema = z.object({
  candidateKey: z.string().min(1),
  candidateHash: sha256Schema,
  sourceHash: sha256Schema,
  kind: z.enum(["version", "event"]),
  suggestedOperation: z.enum(["add", "update"]).optional(),
  targetOptions: z.array(targetOptionSchema),
  matchReasons: z.array(z.string()),
}).strict().superRefine((value, ctx) => {
  if (value.suggestedOperation === "add" && value.targetOptions.length !== 0) {
    ctx.addIssue({ code: "custom", message: "suggested add must not have target options" });
  }
  if (value.suggestedOperation === "update" && value.targetOptions.length !== 1) {
    ctx.addIssue({ code: "custom", message: "suggested update must have exactly one target option" });
  }
  if (value.suggestedOperation === undefined && value.targetOptions.length === 0) {
    ctx.addIssue({ code: "custom", message: "ambiguous template item must have target options" });
  }
});

export const ApprovalSelectionTemplateSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().min(1),
  items: z.array(ApprovalSelectionTemplateItemSchema),
}).strict();

const approvedManifestEntryBaseSchema = {
  candidateKey: z.string().min(1),
  candidateHash: sha256Schema,
  sourceHash: sha256Schema,
  game: z.string().min(1),
  region: z.literal("cn"),
  operation: z.enum(["add", "update"]),
  targetFile: z.string().min(1),
  targetId: z.string().regex(entryIdPattern),
  oldValueHash: sha256Schema.nullable(),
  proposalHash: sha256Schema,
  patch: z.union([VersionSelectionPatchSchema, EventSelectionPatchSchema]).nullable(),
};

export const ApprovedManifestEntrySchema = z.union([
  z.object({ ...approvedManifestEntryBaseSchema, kind: z.literal("version"), oldValue: versionSchema.nullable(), yamlValue: versionSchema }).strict(),
  z.object({ ...approvedManifestEntryBaseSchema, kind: z.literal("event"), oldValue: eventSchema.nullable(), yamlValue: eventSchema }).strict(),
]);

export const ApprovedManifestSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().min(1),
  generatedAt: z.string().min(1),
  entries: z.array(ApprovedManifestEntrySchema),
}).strict();
