import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  dataFileSchema,
  parseBeijingTimestamp,
  type DataFileYamlValue,
  type EventYamlValue,
  type VersionYamlValue,
} from "../../../src/lib/data.ts";
import {
  ApprovalSelectionTemplateSchema,
  CandidateItemSchema,
  CandidateTargetMapSchema,
  RawArticleSchema,
  CandidateRejectionSchema,
  type ApprovalSelectionTemplate,
  type CandidateItem,
  type CandidateRejection,
  type CandidateTargetMapEntry,
  type RawArticle,
  type Sha256,
} from "../types.ts";
import { candidateHashProjection, canonicalizeUrl, hashCanonicalJson, oldValueHashProjection, sourceHashProjection } from "./hash.ts";
import { assertRunId, assertRuntimePathSafe, assertRuntimeRootSafe, assertRunArtifactsAbsent, assertRunExists, artifactDirectory, artifactPath, runRoot } from "./run.ts";
import { withFileLock } from "./files.ts";
import { loadEventTypeIds, validateCandidate } from "./candidate-validation.ts";
import { mihoyoGames } from "../mihoyo-config.ts";
import { hypergryphGames } from "../hypergryph-config.ts";

const configuredGames: Record<string, { supportsVersions: boolean }> = {
  ...mihoyoGames,
  ...hypergryphGames,
};

export interface IndexedTarget {
  key: string;
  game: string;
  region: string;
  kind: "version" | "event";
  targetId: string;
  targetFile: string;
  value: VersionYamlValue | EventYamlValue;
  oldValueHash: Sha256;
}

export interface DataIndex {
  targets: Map<string, IndexedTarget>;
  files: string[];
  filesByGameRegion: Map<string, string[]>;
}

export interface ReviewRunOptions {
  runtimeRoot: string;
  runId: string;
  dataRoot?: string;
  eventTypesPath?: string;
  targetMapPath?: string;
  rename?: (from: string, to: string) => Promise<void>;
}

export interface ReviewFieldChange {
  field: string;
  currentField?: string;
  current: unknown;
  candidate: unknown;
}

export interface ReviewTargetDiff {
  targetId: string;
  targetFile: string;
  changes: ReviewFieldChange[];
}

export interface ReviewEntry {
  candidate: CandidateItem;
  raw: RawArticle;
  target?: IndexedTarget;
  targetOptions: Array<{
    targetId: string;
    targetFile: string;
    expectedOldValueHash: Sha256;
    matchReasons: string[];
  }>;
  targetDiffs: ReviewTargetDiff[];
  availableTargetFiles: string[];
  changes: ReviewFieldChange[];
  category: "new_confirmed" | "new_uncertain" | "time_change" | "source_change" | "ambiguous" | "needs_review" | "matched";
  matchReasons: string[];
}

export interface ReviewRunResult {
  reportPath: string;
  templatePath: string;
  template: ApprovalSelectionTemplate;
  entries: ReviewEntry[];
  rejections: CandidateRejection[];
}

function isWithin(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !child.startsWith("/"));
}

function targetKey(game: string, region: string, kind: string, targetId: string): string {
  return `${game}/${region}/${kind}/${targetId}`;
}

function targetFileFor(game: string, fileName: string): string {
  return `data/${game}/${fileName}`;
}

function oldValueHash(value: unknown): Sha256 {
  return hashCanonicalJson(oldValueHashProjection(value)) as Sha256;
}

export async function buildDataIndex(dataRoot = resolve(process.cwd(), "data")): Promise<DataIndex> {
  const resolvedRoot = resolve(dataRoot);
  const rootReal = await realpath(resolvedRoot);
  const targets = new Map<string, IndexedTarget>();
  const files: string[] = [];
  const filesByGameRegion = new Map<string, string[]>();
  const gameEntries = (await readdir(resolvedRoot, { withFileTypes: true }))
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  for (const gameEntry of gameEntries) {
    if (gameEntry.isSymbolicLink()) throw new Error(`data entry must not be a symlink: ${gameEntry.name}`);
    if (!gameEntry.isDirectory()) continue;
    const gameDirectory = join(resolvedRoot, gameEntry.name);
    const gameReal = await realpath(gameDirectory);
    if (!isWithin(rootReal, gameReal)) throw new Error(`data game directory escapes data root: ${gameDirectory}`);
    const dataEntries = (await readdir(gameDirectory, { withFileTypes: true }))
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const dataEntry of dataEntries) {
      if (dataEntry.isSymbolicLink()) throw new Error(`data file must not be a symlink: ${join(gameDirectory, dataEntry.name)}`);
      if (!dataEntry.isFile() || dataEntry.name === "meta.yaml" || !/\.ya?ml$/i.test(dataEntry.name)) continue;
      const filePath = join(gameDirectory, dataEntry.name);
      const fileReal = await realpath(filePath);
      if (!isWithin(rootReal, fileReal)) throw new Error(`data file escapes data root: ${filePath}`);
      let parsedYaml: unknown;
      try {
        parsedYaml = parseYaml(await readFile(fileReal, "utf8"));
      } catch (error) {
        throw new Error(`cannot parse data YAML ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
      }
      const parsed = dataFileSchema.safeParse(parsedYaml);
      if (!parsed.success) throw new Error(`data YAML schema failed ${filePath}: ${parsed.error.message}`);
      const value = parsed.data as DataFileYamlValue;
      if (value.game !== gameEntry.name) throw new Error(`data game mismatch ${filePath}: ${value.game}`);
      const targetFile = targetFileFor(gameEntry.name, dataEntry.name);
      files.push(targetFile);
      const regionFiles = filesByGameRegion.get(`${value.game}/${value.region}`) ?? [];
      regionFiles.push(targetFile);
      filesByGameRegion.set(`${value.game}/${value.region}`, regionFiles);
      for (const [kind, values] of [["version", value.versions ?? []], ["event", value.events ?? []]] as const) {
        for (const item of values) {
          const key = targetKey(value.game, value.region, kind, item.id);
          if (targets.has(key)) throw new Error(`duplicate global target identity: ${key}`);
          targets.set(key, {
            key,
            game: value.game,
            region: value.region,
            kind,
            targetId: item.id,
            targetFile,
            value: item,
            oldValueHash: oldValueHash(item),
          });
        }
      }
    }
  }
  return { targets, files, filesByGameRegion };
}

export async function loadCandidateTargetMap(path = resolve(process.cwd(), "scripts/crawl/candidate-target-map.json")): Promise<CandidateTargetMapEntry[]> {
  const value = JSON.parse(await readFile(path, "utf8")) as unknown;
  const parsed = CandidateTargetMapSchema.safeParse(value);
  if (!parsed.success) throw new Error(`candidate target map schema failed: ${parsed.error.message}`);
  const seen = new Set<string>();
  for (const entry of parsed.data.entries) {
    assertRunId(entry.appliedRunId);
    const [keyGame] = entry.candidateKey.split("/");
    const targetFilePrefix = `data/${entry.game}/${entry.region}-`;
    if (keyGame !== entry.game || !entry.targetFile.startsWith(targetFilePrefix)) throw new Error(`candidate target mapping identity or target file mismatch: ${entry.candidateKey}`);
    if (seen.has(entry.candidateKey)) throw new Error(`candidateKey has duplicate mapping: ${entry.candidateKey}`);
    seen.add(entry.candidateKey);
  }
  return [...parsed.data.entries].sort((left, right) => left.candidateKey < right.candidateKey ? -1 : left.candidateKey > right.candidateKey ? 1 : 0);
}

function candidateKind(candidate: CandidateItem): "version" | "event" | undefined {
  return candidate.kind === "version" || candidate.kind === "event" ? candidate.kind : undefined;
}

function candidateUncertain(candidate: CandidateItem): boolean {
  if (candidate.review !== "ready") return false;
  return candidate.timeCertainty.start !== "confirmed" || (candidate.timeCertainty.end !== undefined && candidate.timeCertainty.end !== "confirmed");
}

function candidateField(candidate: CandidateItem, field: string): unknown {
  const value = candidate as unknown as Record<string, unknown>;
  if (field === "sources") return (value.sources as string[]).map(canonicalizeUrl);
  if (field === "relatedCandidateKeys") return value.relatedCandidateKeys ?? [];
  return value[field] ?? null;
}

function targetField(target: IndexedTarget, field: string): unknown {
  const value = target.value as unknown as Record<string, unknown>;
  if (field === "sources") return (value.sources as string[]).map(canonicalizeUrl);
  if (field === "related") return value.related ?? [];
  return value[field] ?? null;
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function reviewFields(candidate: CandidateItem, target?: IndexedTarget): ReviewFieldChange[] {
  const fields: Array<string | { field: string; currentField: string }> = candidate.kind === "event"
    ? ["name", "type", "start", "end", "timeCertainty", "sources", { field: "relatedCandidateKeys", currentField: "related" }, "lifecycle", "cadence", "subtype", "note"]
    : ["name", "start", "end", "timeCertainty", "sources", "note"];
  return fields
    .map((spec) => {
      const field = typeof spec === "string" ? spec : spec.field;
      const currentField = typeof spec === "string" ? field : spec.currentField;
      return { field, currentField: currentField === field ? undefined : currentField, current: target ? targetField(target, currentField) : null, candidate: candidateField(candidate, field) };
    })
    .filter((change) => !sameValue(change.current, change.candidate));
}

function timestampRange(value: { start?: string; end?: string; periods?: Array<{ start: string; end: string }> }): Array<[number, number]> {
  if (value.periods && value.periods.length > 0) return value.periods.map((period) => [parseBeijingTimestamp(period.start), parseBeijingTimestamp(period.end)]);
  if (!value.start) return [];
  const start = parseBeijingTimestamp(value.start);
  const end = value.end ? parseBeijingTimestamp(value.end) : start;
  return [[start, end]];
}

function rangesOverlap(left: Array<[number, number]>, right: Array<[number, number]>): boolean {
  return left.some(([leftStart, leftEnd]) => right.some(([rightStart, rightEnd]) => Math.max(leftStart, rightStart) <= Math.min(leftEnd, rightEnd)));
}

function suspectedTargets(candidate: CandidateItem, index: DataIndex): Array<{ target: IndexedTarget; reasons: string[] }> {
  const kind = candidateKind(candidate);
  if (!kind) return [];
  const candidateSources = new Set(candidate.sources.map(canonicalizeUrl));
  const candidateRanges = timestampRange(candidate as { start?: string; end?: string; periods?: Array<{ start: string; end: string }> });
  return [...index.targets.values()]
    .filter((target) => target.game === candidate.game && target.region === candidate.region && target.kind === kind)
    .map((target) => {
      const reasons: string[] = [];
      if (target.value.name === candidate.name) reasons.push("name matches");
      if ((target.value.sources ?? []).some((source) => candidateSources.has(canonicalizeUrl(source)))) reasons.push("source URL matches");
      if (rangesOverlap(candidateRanges, timestampRange(target.value))) reasons.push("time interval overlaps");
      return { target, reasons };
    })
    .filter((value) => value.reasons.length > 0)
    .sort((left, right) => left.target.targetFile < right.target.targetFile ? -1 : left.target.targetFile > right.target.targetFile ? 1 : left.target.targetId < right.target.targetId ? -1 : 1);
}

function mappingTarget(candidate: CandidateItem, mapping: CandidateTargetMapEntry, index: DataIndex): IndexedTarget {
  const kind = candidateKind(candidate);
  if (!kind || mapping.game !== candidate.game || mapping.region !== candidate.region || mapping.kind !== kind) throw new Error(`candidate target mapping identity mismatch: ${candidate.candidateKey}`);
  const target = index.targets.get(targetKey(mapping.game, mapping.region, mapping.kind, mapping.targetId));
  if (!target || target.targetFile !== mapping.targetFile) throw new Error(`candidate target mapping is stale: ${candidate.candidateKey}`);
  return target;
}

async function readRawArticles(runtimeRoot: string, runId: string, game: string, protectedRoot: string): Promise<Map<string, RawArticle>> {
  const rawPath = artifactPath(runtimeRoot, runId, "raw", "jsonl", game);
  await assertRuntimePathSafe(runtimeRoot, rawPath, protectedRoot);
  const raw = new Map<string, RawArticle>();
  const lines = (await readFile(rawPath, "utf8")).split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    const parsed = RawArticleSchema.safeParse(JSON.parse(line));
    if (!parsed.success) throw new Error(`raw article schema failed: ${parsed.error.message}`);
    if (parsed.data.game !== game || raw.has(parsed.data.sourceId)) throw new Error(`raw source identity is invalid or duplicated: ${parsed.data.sourceId}`);
    raw.set(parsed.data.sourceId, parsed.data as RawArticle);
  }
  return raw;
}

async function readRejections(runtimeRoot: string, runId: string, protectedRoot: string): Promise<CandidateRejection[]> {
  const rejectionPath = artifactPath(runtimeRoot, runId, "rejections");
  await assertRuntimePathSafe(runtimeRoot, rejectionPath, protectedRoot);
  const lines = (await readFile(rejectionPath, "utf8")).split(/\r?\n/);
  const rejections: CandidateRejection[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error(`rejection JSONL contains invalid JSON: ${rejectionPath}`);
    }
    const parsed = CandidateRejectionSchema.safeParse(value);
    if (!parsed.success) throw new Error(`rejection schema failed: ${parsed.error.message}`);
    if (parsed.data.rawRef.runId !== runId) throw new Error(`rejection runId mismatch: ${rejectionPath}`);
    rejections.push(parsed.data as CandidateRejection);
  }
  return rejections;
}

async function readCandidates(runtimeRoot: string, runId: string, eventTypeIds: string[], protectedRoot: string): Promise<Array<{ candidate: CandidateItem; raw: RawArticle }>> {
  const directory = artifactDirectory(runtimeRoot, runId, "candidates");
  await assertRuntimePathSafe(runtimeRoot, directory, protectedRoot);
  const entries = (await readdir(directory, { withFileTypes: true }))
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  const result: Array<{ candidate: CandidateItem; raw: RawArticle }> = [];
  const keys = new Set<string>();
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new Error(`candidate artifact entry must not be a symlink: ${entry.name}`);
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const candidatePath = join(directory, entry.name);
    await assertRuntimePathSafe(runtimeRoot, candidatePath, protectedRoot);
    const game = basename(entry.name, ".json");
    const config = configuredGames[game];
    if (!config) throw new Error(`unknown candidate game: ${game}`);
    const raws = await readRawArticles(runtimeRoot, runId, game, protectedRoot);
    const parsed = JSON.parse(await readFile(candidatePath, "utf8")) as unknown;
    if (!Array.isArray(parsed)) throw new Error(`candidate artifact must be an array: ${entry.name}`);
    for (const item of parsed) {
      const candidateResult = CandidateItemSchema.safeParse(item);
      if (!candidateResult.success) throw new Error(`candidate schema failed ${entry.name}: ${candidateResult.error.message}`);
      const candidate = candidateResult.data as CandidateItem;
      if (candidate.rawRef.runId !== runId || candidate.rawRef.game !== game || candidate.game !== game || keys.has(candidate.candidateKey)) throw new Error(`candidate identity is invalid or duplicated: ${candidate.candidateKey}`);
      keys.add(candidate.candidateKey);
      const raw = raws.get(candidate.rawRef.sourceId);
      if (!raw || raw.sourceId !== candidate.sourceId) throw new Error(`candidate raw reference is missing: ${candidate.candidateKey}`);
      if (hashCanonicalJson(sourceHashProjection(raw)) !== candidate.sourceHash) throw new Error(`candidate sourceHash is stale: ${candidate.candidateKey}`);
      if (hashCanonicalJson(candidateHashProjection(candidate)) !== candidate.candidateHash) throw new Error(`candidateHash is stale: ${candidate.candidateKey}`);
      const validation = validateCandidate(candidate, { supportsVersions: config.supportsVersions, eventTypeIds, rawArticle: raw });
      if (!validation.ok) throw new Error(`candidate validation failed: ${validation.rejection.detail ?? validation.rejection.reasonCode}`);
      result.push({ candidate, raw });
    }
  }
  return result;
}

function jsonValue(value: unknown): string {
  return JSON.stringify(value ?? null, null, 2);
}

function availableTargetFiles(candidate: CandidateItem, index: DataIndex): string[] {
  return index.filesByGameRegion.get(`${candidate.game}/${candidate.region}`) ?? [];
}

function reviewReasonText(entry: ReviewEntry): string {
  const reasons = [...entry.candidate.reviewReasons, ...entry.matchReasons].filter((value, index, values) => value.length > 0 && values.indexOf(value) === index);
  return reasons.length ? reasons.join("；") : "无";
}

function evidenceText(entry: ReviewEntry, change: ReviewFieldChange): string {
  const fields = change.field === "timeCertainty"
    ? ["start", "end"]
    : [change.field === "relatedCandidateKeys" ? "related" : change.field];
  const evidence = entry.candidate.evidence.filter((item) => fields.includes(item.field)).map((item) => `${item.field}: ${item.text}`);
  return evidence.length ? evidence.join("；") : entry.raw.content;
}

function appendFieldChanges(lines: string[], entry: ReviewEntry, changes: ReviewFieldChange[], heading = "####"): void {
  for (const change of changes) {
    lines.push(`${heading} ${change.field}${change.currentField ? `（当前 YAML ${change.currentField}）` : ""}`);
    lines.push(`- source URL: ${entry.candidate.sources.join(", ")}`);
    lines.push(`- evidence 原文: ${evidenceText(entry, change)}`);
    lines.push(`- review reason: ${reviewReasonText(entry)}`);
    lines.push(`- 当前 YAML 值: \`${jsonValue(change.current)}\``, `- 候选值: \`${jsonValue(change.candidate)}\``);
  }
}

function entryMarkdown(entry: ReviewEntry): string {
  const lines = [
    `### ${entry.candidate.candidateKey}`,
    `- source URL: ${entry.candidate.sources.join(", ")}`,
    `- evidence 原文: ${entry.raw.content}`,
    `- candidate evidence: ${entry.candidate.evidence.length ? entry.candidate.evidence.map((item) => `${item.field}: ${item.text}`).join("；") : "无"}`,
    `- review reason: ${reviewReasonText(entry)}`,
  ];
  if (entry.availableTargetFiles.length) lines.push("- 可选 targetFile（同 game/region）:", ...entry.availableTargetFiles.map((path) => `  - ${path}`));
  if (entry.target) lines.push(`- target: ${entry.target.targetFile}#${entry.target.targetId}`);
  if (entry.targetOptions.length) lines.push(`- target options: ${entry.targetOptions.map((option) => `${option.targetFile}#${option.targetId} (${option.matchReasons.join("；")})`).join(", ")}`);
  if (entry.targetDiffs.length && !entry.target) {
    lines.push("#### 各 target option 字段变化");
    for (const targetDiff of entry.targetDiffs) {
      lines.push(`##### ${targetDiff.targetFile}#${targetDiff.targetId}`);
      if (targetDiff.changes.length === 0) lines.push("- field changes: 无");
      else appendFieldChanges(lines, entry, targetDiff.changes, "######");
    }
  } else if (entry.changes.length === 0) {
    lines.push("- field changes: 无");
  } else {
    appendFieldChanges(lines, entry, entry.changes);
  }
  return lines.join("\n");
}

function renderRejectionSummary(rejections: CandidateRejection[]): string[] {
  const counts = new Map<string, number>();
  for (const rejection of rejections) counts.set(rejection.reasonCode, (counts.get(rejection.reasonCode) ?? 0) + 1);
  const lines = ["\n## 候选拒绝（按 reasonCode）\n"];
  if (counts.size === 0) return [...lines, "无"];
  for (const [reasonCode, count] of [...counts.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) lines.push(`- ${reasonCode}: ${count}`);
  return lines;
}

function renderReport(entries: ReviewEntry[], runId: string, rejections: CandidateRejection[]): string {
  const sections: Array<[string, ReviewEntry[]]> = [
    ["新增 confirmed", entries.filter((entry) => entry.category === "new_confirmed")],
    ["新增 inferred/estimated", entries.filter((entry) => entry.category === "new_uncertain")],
    ["已有条目时间变化", entries.filter((entry) => entry.target !== undefined && (entry.category === "time_change" || entry.changes.some((change) => ["start", "end"].includes(change.field))))],
    ["已有条目来源变化", entries.filter((entry) => entry.target !== undefined && (entry.category === "source_change" || entry.changes.some((change) => change.field === "sources")))],
    ["已有条目其他字段变化", entries.filter((entry) => entry.category === "matched" && entry.changes.length > 0 && !entry.changes.some((change) => ["start", "end", "sources"].includes(change.field)))],
    ["重复/无法匹配", entries.filter((entry) => entry.category === "ambiguous")],
    ["需要人工查看", entries.filter((entry) => entry.category === "needs_review")],
  ];
  const lines = [`# Review diff\n\n- runId: ${runId}`];
  lines.push(...renderRejectionSummary(rejections));
  for (const [title, values] of sections) {
    lines.push(`\n## ${title}\n`);
    lines.push(values.length ? values.map(entryMarkdown).join("\n\n") : "无");
  }
  return `${lines.join("\n")}\n`;
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

async function writeReviewOutputsAtomic(runtimeRoot: string, runId: string, reportPath: string, templatePath: string, report: string, template: ApprovalSelectionTemplate, protectedRoot: string, renameOutput?: (from: string, to: string) => Promise<void>): Promise<void> {
  const lockPath = join(runtimeRoot, "review-locks", runId);
  await assertRuntimePathSafe(runtimeRoot, lockPath, protectedRoot);
  await withFileLock(lockPath, async () => {
    if (await exists(reportPath) || await exists(templatePath)) throw new Error(`review output already exists for run: ${runId}`);
    const reportTemporary = `${reportPath}.tmp-${process.pid}-${randomUUID()}`;
    const templateTemporary = `${templatePath}.tmp-${process.pid}-${randomUUID()}`;
    const committed: string[] = [];
    const renameFile = renameOutput ?? rename;
    try {
      await mkdir(dirname(reportPath), { recursive: true });
      await mkdir(dirname(templatePath), { recursive: true });
      await writeFile(reportTemporary, report, "utf8");
      await writeFile(templateTemporary, `${JSON.stringify(template)}\n`, "utf8");
      await renameFile(reportTemporary, reportPath);
      committed.push(reportPath);
      await renameFile(templateTemporary, templatePath);
      committed.push(templatePath);
    } catch (error) {
      await rm(reportTemporary, { force: true }).catch(() => undefined);
      await rm(templateTemporary, { force: true }).catch(() => undefined);
      await Promise.all(committed.map((path) => rm(path, { force: true })));
      throw error;
    }
  });
}

export async function reviewRun(options: ReviewRunOptions): Promise<ReviewRunResult> {
  assertRunId(options.runId);
  const dataRoot = resolve(options.dataRoot ?? resolve(process.cwd(), "data"));
  await assertRuntimeRootSafe(options.runtimeRoot, dataRoot);
  await assertRuntimePathSafe(options.runtimeRoot, runRoot(options.runtimeRoot, options.runId), dataRoot);
  await assertRunExists(options.runtimeRoot, options.runId);
  await assertRunArtifactsAbsent(options.runtimeRoot, options.runId, ["reports", "selections"]);
  const reportPath = artifactPath(options.runtimeRoot, options.runId, "reports", "md");
  const templatePath = artifactPath(options.runtimeRoot, options.runId, "selections", "json");
  await assertRuntimePathSafe(options.runtimeRoot, reportPath, dataRoot);
  await assertRuntimePathSafe(options.runtimeRoot, templatePath, dataRoot);
  await assertRuntimePathSafe(options.runtimeRoot, artifactDirectory(options.runtimeRoot, options.runId, "raw"), dataRoot);
  await assertRuntimePathSafe(options.runtimeRoot, artifactDirectory(options.runtimeRoot, options.runId, "candidates"), dataRoot);
  await assertRuntimePathSafe(options.runtimeRoot, artifactPath(options.runtimeRoot, options.runId, "rejections"), dataRoot);
  const index = await buildDataIndex(dataRoot);
  const mapEntries = await loadCandidateTargetMap(options.targetMapPath ?? resolve(process.cwd(), "scripts/crawl/candidate-target-map.json"));
  const eventTypeIds = await loadEventTypeIds(options.eventTypesPath ?? resolve(process.cwd(), "data/event-types.yaml"));
  const mapByCandidate = new Map(mapEntries.map((entry) => [entry.candidateKey, entry]));
  const rejections = await readRejections(options.runtimeRoot, options.runId, dataRoot);
  const candidates = await readCandidates(options.runtimeRoot, options.runId, eventTypeIds, dataRoot);
  const entries: ReviewEntry[] = [];
  const templateItems: ApprovalSelectionTemplate["items"] = [];
  for (const { candidate, raw } of candidates) {
    const candidateTargetFiles = availableTargetFiles(candidate, index);
    if (candidate.review !== "ready" || !candidateKind(candidate)) {
      entries.push({ candidate, raw, targetOptions: [], targetDiffs: [], availableTargetFiles: candidateTargetFiles, changes: [], category: "needs_review", matchReasons: candidate.reviewReasons });
      continue;
    }
    const mapping = mapByCandidate.get(candidate.candidateKey);
    if (mapping) {
      const target = mappingTarget(candidate, mapping, index);
      const changes = reviewFields(candidate, target);
      const reasons = ["durable applied mapping", ...changes.map((change) => `${change.field} differs`).filter((value, position, values) => values.indexOf(value) === position)];
      const targetOptions = [{ targetId: target.targetId, targetFile: target.targetFile, expectedOldValueHash: target.oldValueHash, matchReasons: reasons }];
      const targetDiffs = [{ targetId: target.targetId, targetFile: target.targetFile, changes }];
      const entry: ReviewEntry = { candidate, raw, target, targetOptions, targetDiffs, availableTargetFiles: candidateTargetFiles, changes, category: "matched", matchReasons: reasons };
      entries.push(entry);
      if (changes.some((change) => ["start", "end"].includes(change.field))) entry.category = "time_change";
      else if (changes.some((change) => change.field === "sources")) entry.category = "source_change";
      templateItems.push({ candidateKey: candidate.candidateKey, candidateHash: candidate.candidateHash, sourceHash: candidate.sourceHash, kind: candidate.kind, suggestedOperation: "update", targetOptions, matchReasons: reasons });
      continue;
    }
    const suspected = suspectedTargets(candidate, index);
    if (suspected.length > 0) {
      const targetOptions = suspected.map(({ target, reasons }) => ({ targetId: target.targetId, targetFile: target.targetFile, expectedOldValueHash: target.oldValueHash, matchReasons: reasons }));
      const reasons = targetOptions.flatMap((option) => option.matchReasons).filter((value, position, values) => values.indexOf(value) === position);
      const targetDiffs = suspected.map(({ target }) => ({ targetId: target.targetId, targetFile: target.targetFile, changes: reviewFields(candidate, target) }));
      entries.push({ candidate, raw, targetOptions, targetDiffs, availableTargetFiles: candidateTargetFiles, changes: [], category: "ambiguous", matchReasons: reasons });
      templateItems.push({ candidateKey: candidate.candidateKey, candidateHash: candidate.candidateHash, sourceHash: candidate.sourceHash, kind: candidate.kind, targetOptions, matchReasons: reasons });
      continue;
    }
    const category = candidateUncertain(candidate) ? "new_uncertain" : "new_confirmed";
    entries.push({ candidate, raw, targetOptions: [], targetDiffs: [], availableTargetFiles: candidateTargetFiles, changes: reviewFields(candidate), category, matchReasons: [] });
    templateItems.push({ candidateKey: candidate.candidateKey, candidateHash: candidate.candidateHash, sourceHash: candidate.sourceHash, kind: candidate.kind, suggestedOperation: "add", targetOptions: [], matchReasons: [] });
  }
  const template: ApprovalSelectionTemplate = { schemaVersion: 1, runId: options.runId, items: templateItems };
  const checkedTemplate = ApprovalSelectionTemplateSchema.safeParse(template);
  if (!checkedTemplate.success) throw new Error(`review template schema failed: ${checkedTemplate.error.message}`);
  const report = renderReport(entries, options.runId, rejections);
  await writeReviewOutputsAtomic(options.runtimeRoot, options.runId, reportPath, templatePath, report, checkedTemplate.data as ApprovalSelectionTemplate, dataRoot, options.rename);
  return { reportPath, templatePath, template: checkedTemplate.data as ApprovalSelectionTemplate, entries, rejections };
}
