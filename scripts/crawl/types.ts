import { z } from "zod";
import { hashCanonicalJson, oldValueHashProjection, proposalHashProjection } from "./common/hash.ts";
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
const machineId = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const targetFilePattern = /^data\/[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+-\d{4}\.ya?ml$/;
const beijingTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\+08:00$/;

export type Sha256 = string & { readonly __sha256: unique symbol };

export const sha256Schema = z.string().regex(/^sha256:[0-9a-f]{64}$/).transform((value) => value as Sha256);
const beijingTimestampSchema = z.string().regex(beijingTimestampPattern).superRefine((value, ctx) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):00\+08:00$/.exec(value);
  if (!match) return;

  const [, yearText, monthText, dayText, hourText, minuteText] = match;
  const date = new Date(0);
  date.setUTCFullYear(Number(yearText), Number(monthText) - 1, Number(dayText));
  date.setUTCHours(Number(hourText), Number(minuteText), 0, 0);
  if (
    date.getUTCFullYear() !== Number(yearText)
    || date.getUTCMonth() !== Number(monthText) - 1
    || date.getUTCDate() !== Number(dayText)
    || date.getUTCHours() !== Number(hourText)
    || date.getUTCMinutes() !== Number(minuteText)
  ) {
    ctx.addIssue({ code: "custom", message: "必须是合法的北京时间" });
  }
});
const auditTimestampPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/;
function isValidAuditTimestamp(value: string): boolean {
  const match = auditTimestampPattern.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fractionText, offsetText] = match;
  const offsetMatch = offsetText === "Z" ? null : /([+-])(\d{2}):(\d{2})/.exec(offsetText);
  if (offsetMatch && (Number(offsetMatch[2]) > 23 || Number(offsetMatch[3]) > 59)) return false;
  const date = new Date(0);
  date.setUTCFullYear(Number(yearText), Number(monthText) - 1, Number(dayText));
  date.setUTCHours(Number(hourText), Number(minuteText), Number(secondText), fractionText ? Number(`0.${fractionText}`) * 1000 : 0);
  return date.getUTCFullYear() === Number(yearText)
    && date.getUTCMonth() === Number(monthText) - 1
    && date.getUTCDate() === Number(dayText)
    && date.getUTCHours() === Number(hourText)
    && date.getUTCMinutes() === Number(minuteText)
    && date.getUTCSeconds() === Number(secondText);
}
const auditTimestampSchema = z.string().regex(auditTimestampPattern).superRefine((value, ctx) => {
  if (!isValidAuditTimestamp(value)) ctx.addIssue({ code: "custom", message: "必须是合法的审计时间" });
});
const httpsUrl = httpUrl.refine((value) => new URL(value).protocol === "https:", "必须是 HTTPS URL");
const fixtureRequestSchema = z.object({
  method: z.literal("GET"),
  url: httpsUrl,
  parameters: z.record(z.string(), z.string()),
}).strict();
const fixtureResponseSchema = z.object({
  status: z.number().int().min(100).max(599),
  contentType: z.string().regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i),
  finalUrl: httpsUrl,
  redirects: z.array(httpsUrl),
}).strict();
const fixturePaginationSchema = z.object({
  kind: z.string().min(1),
  termination: z.string().min(1),
}).strict();
const fixtureCheckpointSchema = z.object({
  kind: z.string().min(1).nullable(),
  reusable: z.boolean(),
  reason: z.string().min(1),
}).strict();

export const FixtureMetadataSchema = z.object({
  fixtureKind: z.enum(["real", "synthetic"]),
  fixtureRole: z.enum(["list", "detail", "error", "blocker"]),
  game: z.string().regex(machineId),
  capturedAt: auditTimestampSchema,
  request: fixtureRequestSchema,
  response: fixtureResponseSchema,
  responseFormat: z.enum(["json", "json-envelope", "html", "text"]),
  pagination: fixturePaginationSchema.nullable(),
  urlDerivation: z.string().min(1),
  detailSourceId: z.string().regex(/^\d+$/).optional(),
  checkpoint: fixtureCheckpointSchema,
  blocker: z.string().min(1).nullable(),
}).strict().superRefine((value, ctx) => {
  if (value.fixtureRole === "list" && value.pagination === null) ctx.addIssue({ code: "custom", message: "list fixture must declare pagination" });
  if (value.fixtureRole === "detail" && value.pagination !== null) ctx.addIssue({ code: "custom", message: "detail fixture must not declare pagination" });
  if (value.fixtureRole === "detail" && value.detailSourceId === undefined) ctx.addIssue({ code: "custom", message: "detail fixture must declare detailSourceId" });
  if (value.fixtureRole === "blocker" && value.blocker === null) ctx.addIssue({ code: "custom", message: "blocker fixture must declare blocker" });
  if (value.fixtureRole !== "blocker" && value.blocker !== null) ctx.addIssue({ code: "custom", message: "non-blocker fixture must not declare blocker" });
  if (value.checkpoint.kind !== null && !value.checkpoint.reusable) ctx.addIssue({ code: "custom", message: "non-reusable checkpoint must use null kind" });
});
export type FixtureMetadata = z.infer<typeof FixtureMetadataSchema>;

export const CrawlerErrorRecordSchema = z.object({
  runId: z.string().regex(/^\d{8}-\d{6}$/),
  game: z.string().regex(machineId),
  code: z.string().min(1),
  message: z.string().min(1),
  details: z.record(z.string(), z.unknown()),
}).strict();
export type CrawlerErrorRecord = z.infer<typeof CrawlerErrorRecordSchema>;

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
  contentHash: Sha256;
  fetchedAt: string;
  sourceAuthor?: { platform: "bilibili" | "weibo" | "miyoushe" | "taptap"; accountId: string; profileUrl: string };
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
  sourceHash: Sha256;
  candidateHash: Sha256;
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

export const CandidateTargetMapEntrySchema = z.object({
  candidateKey: z.string().regex(candidateKeyPattern),
  game: z.string().regex(machineId),
  region: z.literal("cn"),
  kind: z.enum(["version", "event"]),
  targetFile: z.string().regex(/^data\/[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+-\d{4}\.ya?ml$/),
  targetId: z.string().regex(entryIdPattern),
  appliedRunId: z.string().regex(/^\d{8}-\d{6}$/),
  appliedAt: auditTimestampSchema,
}).strict();
export type CandidateTargetMapEntry = z.infer<typeof CandidateTargetMapEntrySchema>;

export const CandidateTargetMapSchema = z.object({
  schemaVersion: z.literal(1),
  entries: z.array(CandidateTargetMapEntrySchema),
}).strict().superRefine((value, ctx) => {
  const seen = new Set<string>();
  value.entries.forEach((entry, index) => {
    const [keyGame] = entry.candidateKey.split("/");
    const targetFilePrefix = `data/${entry.game}/${entry.region}-`;
    if (keyGame !== entry.game || !entry.targetFile.startsWith(targetFilePrefix)) {
      ctx.addIssue({ code: "custom", path: ["entries", index], message: "candidateKey、game、region 与 targetFile 必须一致" });
    }
    if (seen.has(entry.candidateKey)) {
      ctx.addIssue({ code: "custom", path: ["entries", index, "candidateKey"], message: "candidateKey 不能重复" });
    }
    seen.add(entry.candidateKey);
  });
});
export type CandidateTargetMap = z.infer<typeof CandidateTargetMapSchema>;

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
  candidateHash: Sha256;
  sourceHash: Sha256;
  game: string;
  region: "cn";
  operation: "add" | "update";
  targetFile: string;
  targetId: string;
  oldValueHash: Sha256 | null;
  proposalHash: Sha256;
};

export type ApprovedManifestEntry =
  | (ApprovedManifestEntryBase & { kind: "version"; patch: VersionSelectionPatch | null; oldValue: VersionYamlValue | null; yamlValue: VersionYamlValue })
  | (ApprovedManifestEntryBase & { kind: "event"; patch: EventSelectionPatch | null; oldValue: EventYamlValue | null; yamlValue: EventYamlValue });

type SelectionBase = {
  candidateKey: string;
  candidateHash: Sha256;
  sourceHash: Sha256;
  targetId: string;
  targetFile: string;
};

export type ApprovalSelectionItem =
  | (SelectionBase & { kind: "version"; operation: "add"; expectedOldValueHash: null; patch?: VersionSelectionPatch })
  | (SelectionBase & { kind: "version"; operation: "update"; expectedOldValueHash: Sha256; patch?: VersionSelectionPatch })
  | (SelectionBase & { kind: "event"; operation: "add"; expectedOldValueHash: null; patch?: EventSelectionPatch })
  | (SelectionBase & { kind: "event"; operation: "update"; expectedOldValueHash: Sha256; patch?: EventSelectionPatch });

export interface ApprovalSelectionTemplateItem {
  candidateKey: string;
  candidateHash: Sha256;
  sourceHash: Sha256;
  kind: "version" | "event";
  suggestedOperation?: "add" | "update";
  targetOptions: Array<{
    targetId: string;
    targetFile: string;
    expectedOldValueHash: Sha256;
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
  fetchedAt: auditTimestampSchema,
  sourceAuthor: z.object({ platform: z.enum(["bilibili", "weibo", "miyoushe", "taptap"]), accountId: z.string().min(1), profileUrl: httpUrl }).strict().optional(),
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

const candidateIdentityCheck = (value: z.infer<typeof candidateBaseSchema>, ctx: z.RefinementCtx) => {
  const [keyGame, keySourceId, keySemanticSlot] = value.candidateKey.split("/");
  if (keyGame !== value.game || keySourceId !== value.sourceId || keySemanticSlot !== value.semanticSlot) {
    ctx.addIssue({ code: "custom", message: "candidateKey 必须与 game/sourceId/semanticSlot 一致" });
  }
  if (value.rawRef.game !== value.game || value.rawRef.sourceId !== value.sourceId) {
    ctx.addIssue({ code: "custom", message: "rawRef 必须与 candidate 身份一致" });
  }
};

export const ReadyVersionCandidateSchema = candidateBaseSchema.extend({
  sources: z.array(httpUrl).min(1),
  kind: z.literal("version"),
  review: z.literal("ready"),
  start: beijingTimestampSchema,
  end: beijingTimestampSchema,
  timeCertainty: readyTimeCertaintySchema,
  note: z.string().min(1).optional(),
}).strict().superRefine(candidateIdentityCheck);

export const ReadyEventCandidateSchema = candidateBaseSchema.extend({
  sources: z.array(httpUrl).min(1),
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
}).strict().superRefine(candidateIdentityCheck);

export const NeedsReviewCandidateSchema = candidateBaseSchema.extend({
  review: z.literal("needs_review"),
  kind: z.enum(["version", "event", "unknown"]),
  type: z.string().min(1).optional(),
}).strict().superRefine(candidateIdentityCheck);

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
}).strict().superRefine((value, ctx) => {
  if (new Set(value.unset).size !== value.unset.length) {
    ctx.addIssue({ code: "custom", message: "unset 不能包含重复字段" });
  }
  if (Object.keys(value.set).some((field) => value.unset.includes(field as "url"))) {
    ctx.addIssue({ code: "custom", message: "set 与 unset 不能有交集" });
  }
  if (Object.values(value.set).some((fieldValue) => fieldValue === undefined)) {
    ctx.addIssue({ code: "custom", message: "set 不允许包含 undefined" });
  }
});

export const EventSelectionPatchSchema = z.object({
  kind: z.literal("event"),
  set: z.object({ url: httpUrl.optional(), priority: z.number().int().optional() }).strict(),
  unset: z.array(z.enum(["url", "priority"])),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.unset).size !== value.unset.length) {
    ctx.addIssue({ code: "custom", message: "unset 不能包含重复字段" });
  }
  if (Object.keys(value.set).some((field) => value.unset.includes(field as "url" | "priority"))) {
    ctx.addIssue({ code: "custom", message: "set 与 unset 不能有交集" });
  }
  if (Object.values(value.set).some((fieldValue) => fieldValue === undefined)) {
    ctx.addIssue({ code: "custom", message: "set 不允许包含 undefined" });
  }
});

const selectionBaseSchema = {
  candidateKey: z.string().regex(candidateKeyPattern),
  candidateHash: sha256Schema,
  sourceHash: sha256Schema,
  targetId: z.string().regex(entryIdPattern),
  targetFile: z.string().regex(targetFilePattern),
};

export const ApprovalSelectionItemSchema = z.union([
  z.object({ ...selectionBaseSchema, kind: z.literal("version"), operation: z.literal("add"), expectedOldValueHash: z.null(), patch: VersionSelectionPatchSchema.optional() }).strict(),
  z.object({ ...selectionBaseSchema, kind: z.literal("version"), operation: z.literal("update"), expectedOldValueHash: sha256Schema, patch: VersionSelectionPatchSchema.optional() }).strict(),
  z.object({ ...selectionBaseSchema, kind: z.literal("event"), operation: z.literal("add"), expectedOldValueHash: z.null(), patch: EventSelectionPatchSchema.optional() }).strict(),
  z.object({ ...selectionBaseSchema, kind: z.literal("event"), operation: z.literal("update"), expectedOldValueHash: sha256Schema, patch: EventSelectionPatchSchema.optional() }).strict(),
]);

export const ApprovalSelectionSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().regex(/^\d{8}-\d{6}$/),
  selections: z.array(ApprovalSelectionItemSchema),
}).strict().superRefine((value, ctx) => {
  const seen = new Set<string>();
  value.selections.forEach((selection, index) => {
    if (seen.has(selection.candidateKey)) ctx.addIssue({ code: "custom", path: ["selections", index, "candidateKey"], message: "candidateKey 不能重复" });
    seen.add(selection.candidateKey);
  });
});

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
  candidateKey: z.string().regex(candidateKeyPattern),
  candidateHash: sha256Schema,
  sourceHash: sha256Schema,
  game: z.string().regex(machineId),
  region: z.literal("cn"),
  operation: z.enum(["add", "update"]),
  targetFile: z.string().regex(targetFilePattern),
  targetId: z.string().regex(entryIdPattern),
  oldValueHash: sha256Schema.nullable(),
  proposalHash: sha256Schema,
};

export const ApprovedManifestEntrySchema = z.union([
  z.object({ ...approvedManifestEntryBaseSchema, kind: z.literal("version"), patch: VersionSelectionPatchSchema.nullable(), oldValue: versionSchema.nullable(), yamlValue: versionSchema }).strict(),
  z.object({ ...approvedManifestEntryBaseSchema, kind: z.literal("event"), patch: EventSelectionPatchSchema.nullable(), oldValue: eventSchema.nullable(), yamlValue: eventSchema }).strict(),
]).superRefine((value, ctx) => {
  if (value.yamlValue.id !== value.targetId) ctx.addIssue({ code: "custom", path: ["yamlValue", "id"], message: "yamlValue.id 必须等于 targetId" });
  if (value.operation === "add") {
    if (value.oldValue !== null) ctx.addIssue({ code: "custom", path: ["oldValue"], message: "add 的 oldValue 必须为 null" });
    if (value.oldValueHash !== null) ctx.addIssue({ code: "custom", path: ["oldValueHash"], message: "add 的 oldValueHash 必须为 null" });
  } else {
    if (value.oldValue === null) ctx.addIssue({ code: "custom", path: ["oldValue"], message: "update 必须有 oldValue" });
    if (value.oldValueHash === null) ctx.addIssue({ code: "custom", path: ["oldValueHash"], message: "update 必须有 oldValueHash" });
  }
  if (value.patch !== null && value.patch.kind !== value.kind) ctx.addIssue({ code: "custom", path: ["patch", "kind"], message: "patch.kind 必须等于 manifest kind" });
  const expectedOldValueHash = value.oldValue === null ? null : hashCanonicalJson(oldValueHashProjection(value.oldValue));
  if (value.oldValueHash !== expectedOldValueHash) ctx.addIssue({ code: "custom", path: ["oldValueHash"], message: "oldValueHash 与 oldValue 不一致" });
  const expectedProposalHash = hashCanonicalJson(proposalHashProjection({
    operation: value.operation,
    kind: value.kind,
    candidateHash: value.candidateHash,
    sourceHash: value.sourceHash,
    oldValueHash: value.oldValueHash,
    targetFile: value.targetFile,
    targetId: value.targetId,
    patch: value.patch,
    yamlValue: value.yamlValue,
  }));
  if (value.proposalHash !== expectedProposalHash) ctx.addIssue({ code: "custom", path: ["proposalHash"], message: "proposalHash 与 manifest 内容不一致" });
});

export const ApprovedManifestSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().regex(/^\d{8}-\d{6}$/),
  generatedAt: auditTimestampSchema,
  entries: z.array(ApprovedManifestEntrySchema),
}).strict().superRefine((value, ctx) => {
  const seenCandidates = new Set<string>();
  const seenTargets = new Set<string>();
  value.entries.forEach((entry, index) => {
    if (seenCandidates.has(entry.candidateKey)) ctx.addIssue({ code: "custom", path: ["entries", index, "candidateKey"], message: "candidateKey 不能重复" });
    if (seenTargets.has(`${entry.game}/${entry.region}/${entry.kind}/${entry.targetId}`)) ctx.addIssue({ code: "custom", path: ["entries", index, "targetId"], message: "manifest target identity 不能重复" });
    seenCandidates.add(entry.candidateKey);
    seenTargets.add(`${entry.game}/${entry.region}/${entry.kind}/${entry.targetId}`);
  });
});
