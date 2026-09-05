import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  eventSchema,
  versionSchema,
  type EventYamlValue,
  type VersionYamlValue,
} from "../../../src/lib/data.ts";
import {
  ApprovalSelectionSchema,
  ApprovedManifestEntrySchema,
  ApprovedManifestSchema,
  type ApprovalSelection,
  type ApprovalSelectionItem,
  type ApprovedManifest,
  type ApprovedManifestEntry,
  type CandidateItem,
  type ReadyEventCandidate,
  type ReadyVersionCandidate,
  type RawArticle,
  type Sha256,
} from "../types.ts";
import {
  candidateHashProjection,
  canonicalizeUrl,
  hashCanonicalJson,
  oldValueHashProjection,
  proposalHashProjection,
  sha256Utf8,
  sourceHashProjection,
} from "./hash.ts";
import { mergeSources } from "./sources.ts";
import { evaluateSource } from "./source-policy.ts";
import { normalizeContent as normalizeMihoyoContent } from "./content.ts";
import { normalizeHypergryphContent } from "../adapters/hypergryph.ts";
// bluepoch and postroom share the same canonical content normalizer.
const normalizeBluepochContent = normalizeMihoyoContent;
import { loadEventTypeIds } from "./candidate-validation.ts";
import { buildDataIndex, loadCandidateTargetMap, readRunCandidates, type DataIndex, type IndexedTarget } from "./diff.ts";
import { withFileLock } from "./files.ts";
import {
  artifactPath,
  assertRunArtifactsAbsent,
  assertRunExists,
  assertRunId,
  assertRuntimePathSafe,
  assertRuntimeRootSafe,
  runRoot,
} from "./run.ts";

const targetFilePattern = /^data\/([a-z0-9]+(?:-[a-z0-9]+)*)\/([a-z0-9]+)-(\d{4})\.ya?ml$/;

export interface ApprovalRunOptions {
  runtimeRoot: string;
  runId: string;
  selectionPath: string;
  dataRoot?: string;
  eventTypesPath?: string;
  targetMapPath?: string;
  generatedAt?: string;
  rename?: (from: string, to: string) => Promise<void>;
}

export interface ApprovalRunResult {
  manifestPath: string;
  manifest: ApprovedManifest;
}

interface TargetRef {
  game: string;
  region: string;
  kind: "version" | "event";
  targetId: string;
  targetFile: string;
}

interface PreparedSelection {
  selection: ApprovalSelectionItem;
  candidate: ReadyVersionCandidate | ReadyEventCandidate;
  raw: RawArticle;
  target?: IndexedTarget;
}

function isWithin(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !child.startsWith("/"));
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function readSelection(selectionPath: string): Promise<ApprovalSelection> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(selectionPath, "utf8"));
  } catch (error) {
    throw new Error(`cannot read approval selection: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = ApprovalSelectionSchema.safeParse(value);
  if (!parsed.success) throw new Error(`approval selection schema failed: ${parsed.error.message}`);
  return parsed.data as ApprovalSelection;
}

function assertRawCanonical(raw: RawArticle): void {
  if (canonicalizeUrl(raw.url) !== raw.url) throw new Error(`raw URL is not canonical: ${raw.sourceId}`);
  const normalizers = { mihoyo: normalizeMihoyoContent, hypergryph: normalizeHypergryphContent, bluepoch: normalizeBluepochContent, postroom: normalizeBluepochContent } as Record<string, (content: string) => string>;
  const normalize = normalizers[raw.source];
  if (!normalize) throw new Error(`unsupported raw source for approval: ${raw.source}`);
  const normalized = normalize(raw.content);
  if (normalized !== raw.content) throw new Error(`raw content is not canonical: ${raw.sourceId}`);
  if (sha256Utf8(raw.content) !== raw.contentHash) throw new Error(`raw contentHash is stale: ${raw.sourceId}`);
}

function assertSourcePolicy(game: string, sources: readonly string[], raw: RawArticle): void {
  const author = raw.sourceAuthor
    ? { platform: raw.sourceAuthor.platform, authorId: raw.sourceAuthor.accountId, authorProfileUrl: raw.sourceAuthor.profileUrl }
    : undefined;
  for (const source of sources) {
    const decision = evaluateSource(game, source, author);
    if (!decision.allowed) throw new Error(`source policy rejected ${source}: ${decision.reason}`);
  }
}

function targetIdentityKey(ref: TargetRef): string {
  return `${ref.game}/${ref.region}/${ref.kind}/${ref.targetId}`;
}

function indexTarget(index: DataIndex, ref: TargetRef): IndexedTarget {
  const target = index.targets.get(targetIdentityKey(ref));
  if (!target || target.targetFile !== ref.targetFile) throw new Error(`target is stale or does not match targetFile: ${targetIdentityKey(ref)}`);
  return target;
}

async function resolveTargetFile(
  dataRoot: string,
  targetFile: string,
  candidate: CandidateItem,
  index: DataIndex,
): Promise<string> {
  if (targetFile.includes("\\") || isAbsolute(targetFile) || targetFile.includes("..")) throw new Error(`targetFile path is not allowed: ${targetFile}`);
  const match = targetFilePattern.exec(targetFile);
  if (!match) throw new Error(`targetFile path is not allowed: ${targetFile}`);
  const [, game, region] = match;
  const fileName = targetFile.split("/")[2];
  if (game !== candidate.game || region !== candidate.region) throw new Error(`targetFile game/region mismatch: ${targetFile}`);
  if (!index.filesByGameRegion.get(`${candidate.game}/${candidate.region}`)?.includes(targetFile)) throw new Error(`targetFile is not a current formal data file: ${targetFile}`);
  const rootReal = await realpath(dataRoot);
  const filePath = resolve(dataRoot, game, fileName);
  const fileReal = await realpath(filePath);
  if (!isWithin(rootReal, fileReal)) throw new Error(`targetFile escapes data root: ${targetFile}`);
  return fileReal;
}

function validatePatch(selection: ApprovalSelectionItem, raw: RawArticle): void {
  const patch = selection.patch;
  if (!patch) return;
  if (patch.kind !== selection.kind) throw new Error(`selection patch kind mismatch: ${selection.candidateKey}`);
  if (selection.operation === "add" && patch.unset.length > 0) throw new Error(`add selection cannot unset fields: ${selection.candidateKey}`);
  const patchSet = patch.set as Record<string, unknown>;
  if (typeof patchSet.url === "string") assertSourcePolicy(raw.game, [patchSet.url], raw);
}

function readyCandidate(candidate: CandidateItem): ReadyVersionCandidate | ReadyEventCandidate {
  if (candidate.review !== "ready" || (candidate.kind !== "version" && candidate.kind !== "event")) throw new Error(`cannot approve non-ready candidate: ${candidate.candidateKey}`);
  return candidate as ReadyVersionCandidate | ReadyEventCandidate;
}

function resolveRelatedIds(
  candidate: ReadyEventCandidate,
  oldRelated: readonly string[] | undefined,
  batchTargetMap: Map<string, TargetRef>,
  historyTargetMap: Map<string, TargetRef>,
): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const targetId of oldRelated ?? []) {
    if (seen.has(targetId)) continue;
    seen.add(targetId);
    result.push(targetId);
  }
  if (candidate.kind !== "event") return result;
  for (const candidateKey of candidate.relatedCandidateKeys ?? []) {
    const target = batchTargetMap.get(candidateKey) ?? historyTargetMap.get(candidateKey);
    if (!target) throw new Error(`related candidate mapping is missing: ${candidateKey}`);
    if (target.game !== candidate.game || target.region !== candidate.region || target.kind !== "version") {
      throw new Error(`related candidate mapping is not a same-region version: ${candidateKey}`);
    }
    if (seen.has(target.targetId)) continue;
    seen.add(target.targetId);
    result.push(target.targetId);
  }
  return result;
}

function applyPatch(value: Record<string, unknown>, selection: ApprovalSelectionItem): void {
  const patch = selection.patch;
  if (!patch) return;
  for (const [field, fieldValue] of Object.entries(patch.set as Record<string, unknown>)) {
    if (fieldValue !== undefined) value[field] = fieldValue;
  }
  for (const field of patch.unset) delete value[field];
}

function buildVersionValue(
  candidate: ReadyVersionCandidate,
  selection: ApprovalSelectionItem,
  oldValue: VersionYamlValue | undefined,
): VersionYamlValue {
  const value: Record<string, unknown> = oldValue ? { ...oldValue } : {};
  value.id = selection.targetId;
  value.name = candidate.name;
  value.start = candidate.start;
  value.end = candidate.end;
  value.timeCertainty = candidate.timeCertainty;
  value.sources = mergeSources(oldValue?.sources ?? [], candidate.sources);
  if (candidate.note !== undefined) value.note = candidate.note;
  applyPatch(value, selection);
  const parsed = versionSchema.safeParse(value);
  if (!parsed.success) throw new Error(`approved version YAML value failed: ${parsed.error.message}`);
  return parsed.data;
}

function buildEventValue(
  candidate: ReadyEventCandidate,
  selection: ApprovalSelectionItem,
  oldValue: EventYamlValue | undefined,
  related: string[],
): EventYamlValue {
  const value: Record<string, unknown> = oldValue ? { ...oldValue } : {};
  value.id = selection.targetId;
  value.name = candidate.name;
  value.type = candidate.type;
  value.start = candidate.start;
  if (candidate.end !== undefined) value.end = candidate.end;
  value.timeCertainty = candidate.timeCertainty;
  value.sources = mergeSources(oldValue?.sources ?? [], candidate.sources);
  if (candidate.note !== undefined) value.note = candidate.note;
  if (related.length > 0 || oldValue?.related !== undefined) value.related = related;
  else delete value.related;
  if (candidate.lifecycle !== undefined) value.lifecycle = candidate.lifecycle;
  if (candidate.cadence !== undefined) value.cadence = candidate.cadence;
  if (candidate.subtype !== undefined) value.subtype = candidate.subtype;
  applyPatch(value, selection);
  if (selection.operation === "add") delete value.periods;
  const parsed = eventSchema.safeParse(value);
  if (!parsed.success) throw new Error(`approved event YAML value failed: ${parsed.error.message}`);
  return parsed.data;
}

function proposalHash(entry: {
  operation: "add" | "update";
  kind: "version" | "event";
  candidateHash: Sha256;
  sourceHash: Sha256;
  oldValueHash: Sha256 | null;
  targetFile: string;
  targetId: string;
  patch: unknown;
  yamlValue: VersionYamlValue | EventYamlValue;
}): Sha256 {
  return hashCanonicalJson(proposalHashProjection(entry)) as Sha256;
}

function assertManifestEntry(entry: ApprovedManifestEntry): ApprovedManifestEntry {
  const parsed = ApprovedManifestEntrySchema.safeParse(entry);
  if (!parsed.success) throw new Error(`approved manifest entry schema failed: ${parsed.error.message}`);
  const checked = parsed.data as ApprovedManifestEntry;
  const expected = proposalHash({
    operation: checked.operation,
    kind: checked.kind,
    candidateHash: checked.candidateHash,
    sourceHash: checked.sourceHash,
    oldValueHash: checked.oldValueHash,
    targetFile: checked.targetFile,
    targetId: checked.targetId,
    patch: checked.patch,
    yamlValue: checked.yamlValue,
  });
  if (checked.proposalHash !== expected) throw new Error(`proposalHash mismatch: ${checked.candidateKey}`);
  if (checked.yamlValue.id !== checked.targetId) throw new Error(`approved YAML id mismatch: ${checked.candidateKey}`);
  return checked;
}

export async function readApprovedManifest(path: string): Promise<ApprovedManifest> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`cannot read approved manifest: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = ApprovedManifestSchema.safeParse(value);
  if (!parsed.success) throw new Error(`approved manifest schema failed: ${parsed.error.message}`);
  const manifest = parsed.data as ApprovedManifest;
  assertRunId(manifest.runId);
  for (const entry of manifest.entries) assertManifestEntry(entry);
  return manifest;
}

async function writeManifestAtomic(
  runtimeRoot: string,
  runId: string,
  manifestPath: string,
  manifest: ApprovedManifest,
  dataRoot: string,
  renameOutput?: (from: string, to: string) => Promise<void>,
): Promise<void> {
  const lockPath = join(runtimeRoot, "approve-locks", runId);
  await assertRuntimePathSafe(runtimeRoot, lockPath, dataRoot);
  await withFileLock(lockPath, async () => {
    if (await exists(manifestPath)) throw new Error(`approved manifest already exists for run: ${runId}`);
    const temporary = `${manifestPath}.tmp-${process.pid}-${randomUUID()}`;
    try {
      await mkdir(dirname(manifestPath), { recursive: true });
      await writeFile(temporary, `${JSON.stringify(manifest)}\n`, "utf8");
      await (renameOutput ?? rename)(temporary, manifestPath);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  });
}

export async function approveRun(options: ApprovalRunOptions): Promise<ApprovalRunResult> {
  assertRunId(options.runId);
  const dataRoot = resolve(options.dataRoot ?? resolve(process.cwd(), "data"));
  await assertRuntimeRootSafe(options.runtimeRoot, dataRoot);
  await assertRuntimePathSafe(options.runtimeRoot, runRoot(options.runtimeRoot, options.runId), dataRoot);
  await assertRunExists(options.runtimeRoot, options.runId);
  await assertRunArtifactsAbsent(options.runtimeRoot, options.runId, ["approved"]);
  const manifestPath = artifactPath(options.runtimeRoot, options.runId, "approved", "json");
  await assertRuntimePathSafe(options.runtimeRoot, manifestPath, dataRoot);

  const selection = await readSelection(options.selectionPath);
  if (selection.runId !== options.runId) throw new Error(`approval selection runId mismatch: ${selection.runId}`);
  assertRunId(selection.runId);
  const index = await buildDataIndex(dataRoot);
  const eventTypeIds = await loadEventTypeIds(options.eventTypesPath ?? resolve(process.cwd(), "data/event-types.yaml"));
  const records = await readRunCandidates(options.runtimeRoot, options.runId, eventTypeIds, dataRoot);
  const candidateByKey = new Map<string, { candidate: CandidateItem; raw: RawArticle }>();
  for (const record of records) {
    if (candidateByKey.has(record.candidate.candidateKey)) throw new Error(`candidateKey is duplicated: ${record.candidate.candidateKey}`);
    assertRawCanonical(record.raw);
    const sourceHash = hashCanonicalJson(sourceHashProjection(record.raw)) as Sha256;
    const candidateHash = hashCanonicalJson(candidateHashProjection(record.candidate)) as Sha256;
    if (sourceHash !== record.candidate.sourceHash) throw new Error(`candidate sourceHash is stale: ${record.candidate.candidateKey}`);
    if (candidateHash !== record.candidate.candidateHash) throw new Error(`candidateHash is stale: ${record.candidate.candidateKey}`);
    candidateByKey.set(record.candidate.candidateKey, record);
  }

  const durableEntries = await loadCandidateTargetMap(options.targetMapPath ?? resolve(process.cwd(), "scripts/crawl/candidate-target-map.json"));
  const historyTargetMap = new Map<string, TargetRef>();
  for (const entry of durableEntries) {
    const targetRef: TargetRef = {
      game: entry.game,
      region: entry.region,
      kind: entry.kind,
      targetId: entry.targetId,
      targetFile: entry.targetFile,
    };
    indexTarget(index, targetRef);
    historyTargetMap.set(entry.candidateKey, targetRef);
  }

  const batchTargetMap = new Map<string, TargetRef>();
  const batchIdentity = new Set<string>();
  const prepared: PreparedSelection[] = [];
  const seenSelections = new Set<string>();
  for (const item of selection.selections) {
    if (seenSelections.has(item.candidateKey)) throw new Error(`candidateKey is duplicated in selection: ${item.candidateKey}`);
    seenSelections.add(item.candidateKey);
    const record = candidateByKey.get(item.candidateKey);
    if (!record) throw new Error(`selected candidate does not exist: ${item.candidateKey}`);
    const { raw } = record;
    const candidate = readyCandidate(record.candidate);
    if (candidate.kind !== item.kind) throw new Error(`selection kind mismatch: ${item.candidateKey}`);
    if (candidate.candidateHash !== item.candidateHash) throw new Error(`selection candidateHash mismatch: ${item.candidateKey}`);
    if (candidate.sourceHash !== item.sourceHash) throw new Error(`selection sourceHash mismatch: ${item.candidateKey}`);
    validatePatch(item, raw);
    await resolveTargetFile(dataRoot, item.targetFile, candidate, index);
    const targetRef: TargetRef = {
      game: candidate.game,
      region: candidate.region,
      kind: item.kind,
      targetId: item.targetId,
      targetFile: item.targetFile,
    };
    const identity = targetIdentityKey(targetRef);
    if (batchIdentity.has(identity)) throw new Error(`duplicate target identity in selection: ${identity}`);
    batchIdentity.add(identity);
    let target: IndexedTarget | undefined;
    if (item.operation === "add") {
      if (index.targets.has(identity)) throw new Error(`add target already exists: ${identity}`);
    } else {
      target = indexTarget(index, targetRef);
      if (item.expectedOldValueHash === null || target.oldValueHash !== item.expectedOldValueHash) throw new Error(`update oldValueHash mismatch: ${item.candidateKey}`);
    }
    const oldUrl = target && "url" in target.value ? (target.value as { url?: string }).url : undefined;
    if (oldUrl !== undefined) assertSourcePolicy(candidate.game, [oldUrl], raw);
    batchTargetMap.set(item.candidateKey, targetRef);
    prepared.push({ selection: item, candidate, raw, target });
  }

  const entries: ApprovedManifestEntry[] = [];
  for (const item of prepared) {
    const oldValue = item.target?.value;
    const oldRelated = item.candidate.kind === "event" && item.target?.kind === "event"
      ? (oldValue as EventYamlValue | undefined)?.related
      : undefined;
    const related = item.candidate.kind === "event"
      ? resolveRelatedIds(item.candidate, oldRelated, batchTargetMap, historyTargetMap)
      : [];
    const patch = item.selection.patch ?? null;
    const yamlValue = item.candidate.kind === "version"
      ? buildVersionValue(item.candidate, item.selection, oldValue as VersionYamlValue | undefined)
      : buildEventValue(item.candidate, item.selection, oldValue as EventYamlValue | undefined, related);
    assertSourcePolicy(item.candidate.game, yamlValue.sources, item.raw);
    const oldValueHash = item.target ? hashCanonicalJson(oldValueHashProjection(item.target.value)) as Sha256 : null;
    if (oldValueHash !== item.selection.expectedOldValueHash) throw new Error(`selection expectedOldValueHash mismatch: ${item.selection.candidateKey}`);
    const entry = {
      candidateKey: item.candidate.candidateKey,
      candidateHash: item.candidate.candidateHash,
      sourceHash: item.candidate.sourceHash,
      game: item.candidate.game,
      region: item.candidate.region,
      kind: item.candidate.kind,
      operation: item.selection.operation,
      targetFile: item.selection.targetFile,
      targetId: item.selection.targetId,
      oldValueHash,
      patch,
      oldValue: item.target?.value ?? null,
      yamlValue,
      proposalHash: "sha256:" as Sha256,
    } as ApprovedManifestEntry & { proposalHash: Sha256 };
    entry.proposalHash = proposalHash({
      operation: entry.operation,
      kind: entry.kind,
      candidateHash: entry.candidateHash,
      sourceHash: entry.sourceHash,
      oldValueHash: entry.oldValueHash,
      targetFile: entry.targetFile,
      targetId: entry.targetId,
      patch: entry.patch,
      yamlValue: entry.yamlValue,
    });
    entries.push(assertManifestEntry(entry));
  }

  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const manifestValue = { schemaVersion: 1 as const, runId: options.runId, generatedAt, entries };
  const checkedManifest = ApprovedManifestSchema.safeParse(manifestValue);
  if (!checkedManifest.success) throw new Error(`approved manifest schema failed: ${checkedManifest.error.message}`);
  const manifest = checkedManifest.data as ApprovedManifest;
  for (const entry of manifest.entries) assertManifestEntry(entry);
  await writeManifestAtomic(options.runtimeRoot, options.runId, manifestPath, manifest, dataRoot, options.rename);
  return { manifestPath, manifest };
}
