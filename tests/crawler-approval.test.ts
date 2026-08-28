import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { eventSchema, versionSchema } from "../src/lib/data.ts";
import { approveRun, readApprovedManifest } from "../scripts/crawl/common/approval.ts";
import { mergeSources } from "../scripts/crawl/common/sources.ts";
import { parseArticleCandidate } from "../scripts/crawl/parsers/article.ts";
import { artifactPath, createRun } from "../scripts/crawl/common/run.ts";
import { candidateHashProjection, hashCanonicalJson, oldValueHashProjection, proposalHashProjection, sha256Utf8 } from "../scripts/crawl/common/hash.ts";
import { ApprovalSelectionSchema, ApprovedManifestEntrySchema, ApprovedManifestSchema, type CandidateItem, type RawArticle, type Sha256 } from "../scripts/crawl/types.ts";

const eventTypesPath = resolve("data/event-types.yaml");

function raw(sourceId: string, title: string, content: string, url = `https://ys.mihoyo.com/main/news/detail/${sourceId}`): RawArticle {
  return {
    game: "genshin-impact",
    region: "cn",
    source: "mihoyo",
    sourceId,
    url,
    title,
    publishedAt: "2026-08-01T00:00:00+08:00",
    content,
    contentHash: sha256Utf8(content) as Sha256,
    fetchedAt: "2026-08-27T00:00:00+00:00",
  };
}

function rehash(candidate: CandidateItem, changes: Record<string, unknown>): CandidateItem {
  const next = { ...candidate, ...changes } as CandidateItem;
  return { ...next, candidateHash: hashCanonicalJson(candidateHashProjection(next)) as Sha256 };
}

function eventValue(id: string, name: string, source: string, start = "2026-08-20T04:00:00+08:00", end = "2026-08-20T11:00:00+08:00", extra: Record<string, unknown> = {}) {
  return eventSchema.parse({ id, name, type: "event", start, end, sources: [source], ...extra });
}

function versionValue(id: string, name: string, source: string, start = "2026-08-20T04:00:00+08:00", end = "2026-09-20T04:00:00+08:00") {
  return versionSchema.parse({ id, name, start, end, sources: [source] });
}

function dataFile(game: string, region: string, values: { versions?: unknown[]; events?: unknown[] }): string {
  return `${JSON.stringify({ game, region, ...values }, null, 2)}\n`;
}

function selectionItem(candidate: CandidateItem, operation: "add" | "update", targetId: string, targetFile: string, expectedOldValueHash: Sha256 | null, patch?: unknown) {
  return {
    candidateKey: candidate.candidateKey,
    candidateHash: candidate.candidateHash,
    sourceHash: candidate.sourceHash,
    kind: candidate.kind,
    operation,
    expectedOldValueHash,
    targetId,
    targetFile,
    ...(patch === undefined ? {} : { patch }),
  };
}

async function prepareRun(items: Array<{ raw: RawArticle; candidate: CandidateItem }>, dataContent: string, selections: unknown[], mapEntries: unknown[] = []) {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "crawler-approval-runtime-"));
  const dataRoot = await mkdtemp(join(tmpdir(), "crawler-approval-data-"));
  const gameRoot = join(dataRoot, "genshin-impact");
  await mkdir(gameRoot, { recursive: true });
  await writeFile(join(gameRoot, "cn-2026.yaml"), dataContent, "utf8");
  const runId = "20260827-000001";
  await createRun(runtimeRoot, runId);
  await mkdir(join(runtimeRoot, "raw", runId), { recursive: true });
  await mkdir(join(runtimeRoot, "candidates", runId), { recursive: true });
  await mkdir(join(runtimeRoot, "rejections"), { recursive: true });
  await writeFile(artifactPath(runtimeRoot, runId, "raw", "jsonl", "genshin-impact"), `${items.map(({ raw: value }) => JSON.stringify(value)).join("\n")}\n`, "utf8");
  await writeFile(artifactPath(runtimeRoot, runId, "candidates", "json", "genshin-impact"), `${JSON.stringify(items.map(({ candidate }) => candidate))}\n`, "utf8");
  await writeFile(artifactPath(runtimeRoot, runId, "rejections"), "", "utf8");
  const targetMapPath = join(runtimeRoot, "candidate-target-map.json");
  await writeFile(targetMapPath, `${JSON.stringify({ schemaVersion: 1, entries: mapEntries })}\n`, "utf8");
  const selectionPath = join(runtimeRoot, "approved-selection.json");
  await writeFile(selectionPath, `${JSON.stringify({ schemaVersion: 1, runId, selections })}\n`, "utf8");
  return { runtimeRoot, dataRoot, targetMapPath, selectionPath, runId };
}

describe("crawler approval manifest", () => {
  it("creates a sanitized add manifest with null old value and patch", async () => {
    const article = raw("add-1", "新增活动", "活动时间：2026年8月20日 04:00 至 2026年8月20日 11:00");
    const candidate = rehash(parseArticleCandidate(article, "20260827-000001", "primary"), { note: "公告正文明确说明" });
    const targetFile = "data/genshin-impact/cn-2026.yaml";
    const setup = await prepareRun([{ raw: article, candidate }], dataFile("genshin-impact", "cn", { events: [eventValue("old-event", "旧活动", article.url)] }), [selectionItem(candidate, "add", "new-event", targetFile, null)]);
    const result = await approveRun({ ...setup, eventTypesPath, generatedAt: "2026-08-27T00:00:00Z" });
    expect(result.manifest.entries).toHaveLength(1);
    const entry = result.manifest.entries[0];
    expect(entry).toMatchObject({ operation: "add", kind: "event", targetId: "new-event", oldValue: null, oldValueHash: null, patch: null });
    expect(entry.yamlValue).toMatchObject({ id: "new-event", name: article.title, type: "event", start: "2026-08-20T04:00:00+08:00", end: "2026-08-20T11:00:00+08:00", note: "公告正文明确说明" });
    expect(entry.yamlValue).not.toHaveProperty("candidateKey");
    expect(entry.yamlValue).not.toHaveProperty("evidence");
    expect(entry.yamlValue).not.toHaveProperty("relatedCandidateKeys");
    expect(JSON.parse(await readFile(result.manifestPath, "utf8")).entries[0].patch).toBeNull();
  });

  it("updates an existing event with stable source union and preserves old optional fields", async () => {
    const oldSource = "https://ys.mihoyo.com/main/news/detail/old-source";
    const article = raw("update-1", "活动更新", "活动时间：2026年8月20日 05:00 至 2026年8月20日 12:00");
    const candidate = parseArticleCandidate(article, "20260827-000001", "primary");
    const oldValue = eventValue("old-event", "旧名称", oldSource, "2026-08-20T04:00:00+08:00", "2026-08-20T11:00:00+08:00", { priority: 7 });
    const oldHash = hashCanonicalJson(oldValueHashProjection(oldValue)) as Sha256;
    const setup = await prepareRun([{ raw: article, candidate }], dataFile("genshin-impact", "cn", { events: [oldValue] }), [selectionItem(candidate, "update", "old-event", "data/genshin-impact/cn-2026.yaml", oldHash)]);
    const result = await approveRun({ ...setup, eventTypesPath, generatedAt: "2026-08-27T00:00:00Z" });
    const entry = result.manifest.entries[0];
    expect(entry.yamlValue.sources).toEqual([oldSource, article.url]);
    expect("priority" in entry.yamlValue ? entry.yamlValue.priority : undefined).toBe(7);
    expect(entry.oldValueHash).toBe(oldHash);
    expect("expectedOldValueHash" in entry).toBe(false);
  });

  it("rejects a non-canonical raw URL even when hashes are recomputed", async () => {
    const article = raw("noncanonical-raw-1", "非规范活动", "活动时间：2026年8月20日 04:00 至 2026年8月20日 11:00", "https://YS.MIHOYO.COM/main/news/detail/noncanonical-raw-1");
    const candidate = parseArticleCandidate(article, "20260827-000001", "primary");
    const setup = await prepareRun([{ raw: article, candidate }], dataFile("genshin-impact", "cn", { events: [eventValue("old-event", "旧活动", article.url)] }), [selectionItem(candidate, "add", "noncanonical-event", "data/genshin-impact/cn-2026.yaml", null)]);
    await expect(approveRun({ ...setup, eventTypesPath })).rejects.toThrow(/canonical|URL/i);
  });

  it("rejects an old value containing a source that current policy disallows", async () => {
    const article = raw("legacy-source-1", "活动更新", "活动时间：2026年8月20日 05:00 至 2026年8月20日 12:00");
    const candidate = parseArticleCandidate(article, "20260827-000001", "primary");
    const oldValue = eventValue("old-event", "旧活动", "https://www.zhihu.com/question/123", "2026-08-20T04:00:00+08:00", "2026-08-20T11:00:00+08:00");
    const oldHash = hashCanonicalJson(oldValueHashProjection(oldValue)) as Sha256;
    const setup = await prepareRun([{ raw: article, candidate }], dataFile("genshin-impact", "cn", { events: [oldValue] }), [selectionItem(candidate, "update", "old-event", "data/genshin-impact/cn-2026.yaml", oldHash)]);
    await expect(approveRun({ ...setup, eventTypesPath })).rejects.toThrow(/source policy|Zhihu|discovery/i);
  });

  it("rejects a disallowed old url even when a patch tries to unset it", async () => {
    const article = raw("legacy-url-1", "活动更新", "活动时间：2026年8月20日 05:00 至 2026年8月20日 12:00");
    const candidate = parseArticleCandidate(article, "20260827-000001", "primary");
    const oldValue = eventValue("old-event", "旧活动", article.url, "2026-08-20T04:00:00+08:00", "2026-08-20T11:00:00+08:00", { url: "https://www.zhihu.com/question/123" });
    const oldHash = hashCanonicalJson(oldValueHashProjection(oldValue)) as Sha256;
    const setup = await prepareRun([{ raw: article, candidate }], dataFile("genshin-impact", "cn", { events: [oldValue] }), [selectionItem(candidate, "update", "old-event", "data/genshin-impact/cn-2026.yaml", oldHash, { kind: "event", set: {}, unset: ["url"] })]);
    await expect(approveRun({ ...setup, eventTypesPath })).rejects.toThrow(/source policy|Zhihu|discovery/i);
  });

  it("rejects a patch URL that is not an allowed official source", async () => {
    const article = raw("patch-source-1", "补充活动", "活动时间：2026年8月20日 04:00 至 2026年8月20日 11:00");
    const candidate = parseArticleCandidate(article, "20260827-000001", "primary");
    const setup = await prepareRun([{ raw: article, candidate }], dataFile("genshin-impact", "cn", { events: [eventValue("old-event", "旧活动", article.url)] }), [selectionItem(candidate, "add", "bad-source-event", "data/genshin-impact/cn-2026.yaml", null, { kind: "event", set: { url: "https://www.zhihu.com/question/123" }, unset: [] })]);
    await expect(approveRun({ ...setup, eventTypesPath })).rejects.toThrow(/source policy|Zhihu|discovery/i);
  });

  it("rejects stale candidate hashes before creating a manifest", async () => {
    const article = raw("stale-1", "新增活动", "活动时间：2026年8月20日 04:00 至 2026年8月20日 11:00");
    const candidate = parseArticleCandidate(article, "20260827-000001", "primary");
    const selection = selectionItem(candidate, "add", "stale-event", "data/genshin-impact/cn-2026.yaml", null);
    selection.candidateHash = sha256Utf8("stale candidate") as Sha256;
    const setup = await prepareRun([{ raw: article, candidate }], dataFile("genshin-impact", "cn", { events: [eventValue("old-event", "旧活动", article.url)] }), [selection]);
    await expect(approveRun({ ...setup, eventTypesPath })).rejects.toThrow(/candidateHash|stale|hash/i);
    await expect(readFile(artifactPath(setup.runtimeRoot, setup.runId, "approved", "json"), "utf8")).rejects.toThrow();
  });

  it("rejects needs-review candidates and invalid target paths", async () => {
    const article = raw("review-1", "无法分类公告", "正文没有明确时间");
    const candidate = parseArticleCandidate(article, "20260827-000001", "primary");
    const selection = selectionItem(candidate, "add", "bad-event", "../data/genshin-impact/cn-2026.yaml", null);
    const setup = await prepareRun([{ raw: article, candidate }], dataFile("genshin-impact", "cn", { events: [eventValue("old-event", "旧活动", article.url)] }), [selection]);
    await expect(approveRun({ ...setup, eventTypesPath })).rejects.toThrow(/ready|target|path|review/i);
  });

  it("applies an allowed event patch and rejects unset on add", async () => {
    const article = raw("patch-1", "补充活动", "活动时间：2026年8月20日 04:00 至 2026年8月20日 11:00");
    const candidate = parseArticleCandidate(article, "20260827-000001", "primary");
    const targetFile = "data/genshin-impact/cn-2026.yaml";
    const allowedPatch = { kind: "event", set: { priority: 3 }, unset: [] };
    const setup = await prepareRun([{ raw: article, candidate }], dataFile("genshin-impact", "cn", { events: [eventValue("old-event", "旧活动", article.url)] }), [selectionItem(candidate, "add", "patched-event", targetFile, null, allowedPatch)]);
    const result = await approveRun({ ...setup, eventTypesPath });
    expect("priority" in result.manifest.entries[0].yamlValue ? result.manifest.entries[0].yamlValue.priority : undefined).toBe(3);

    const invalidPatchSetup = await prepareRun([{ raw: article, candidate }], dataFile("genshin-impact", "cn", { events: [eventValue("old-event", "旧活动", article.url)] }), [selectionItem(candidate, "add", "patched-event", targetFile, null, { kind: "event", set: {}, unset: ["priority"] })]);
    await expect(approveRun({ ...invalidPatchSetup, eventTypesPath })).rejects.toThrow(/add|unset|patch/i);
  });

  it("rejects an add collision and a stale update old hash before output", async () => {
    const article = raw("collision-1", "新增活动", "活动时间：2026年8月20日 04:00 至 2026年8月20日 11:00");
    const candidate = parseArticleCandidate(article, "20260827-000001", "primary");
    const existing = eventValue("existing-event", "旧活动", article.url);
    const collisionSetup = await prepareRun([{ raw: article, candidate }], dataFile("genshin-impact", "cn", { events: [existing] }), [selectionItem(candidate, "add", "existing-event", "data/genshin-impact/cn-2026.yaml", null)]);
    await expect(approveRun({ ...collisionSetup, eventTypesPath })).rejects.toThrow(/already exists|collision|target/i);
    await expect(readFile(artifactPath(collisionSetup.runtimeRoot, collisionSetup.runId, "approved", "json"), "utf8")).rejects.toThrow();

    const updateSetup = await prepareRun([{ raw: article, candidate }], dataFile("genshin-impact", "cn", { events: [existing] }), [selectionItem(candidate, "update", "existing-event", "data/genshin-impact/cn-2026.yaml", sha256Utf8("stale old value") as Sha256)]);
    await expect(approveRun({ ...updateSetup, eventTypesPath })).rejects.toThrow(/oldValueHash|stale|mismatch/i);
  });

  it("preserves old event periods while applying candidate fields", async () => {
    const article = raw("periods-1", "周期活动更新", "活动时间：2026年8月20日 05:00 至 2026年8月20日 12:00");
    const candidate = parseArticleCandidate(article, "20260827-000001", "primary");
    const oldValue = eventValue("period-event", "旧周期活动", "https://ys.mihoyo.com/main/news/detail/old-period", "2026-08-20T04:00:00+08:00", "2026-08-20T11:00:00+08:00", { periods: [{ start: "2026-08-20T04:00:00+08:00", end: "2026-08-20T11:00:00+08:00" }, { start: "2026-08-21T04:00:00+08:00", end: "2026-08-21T11:00:00+08:00" }] });
    const oldHash = hashCanonicalJson(oldValueHashProjection(oldValue)) as Sha256;
    const setup = await prepareRun([{ raw: article, candidate }], dataFile("genshin-impact", "cn", { events: [oldValue] }), [selectionItem(candidate, "update", "period-event", "data/genshin-impact/cn-2026.yaml", oldHash)]);
    const result = await approveRun({ ...setup, eventTypesPath });
    expect("periods" in result.manifest.entries[0].yamlValue ? result.manifest.entries[0].yamlValue.periods : undefined).toEqual(oldValue.periods);
  });

  it("uses exactly the nine proposal hash projection fields", () => {
    const projection = proposalHashProjection({ operation: "add", kind: "event", candidateHash: "candidate", sourceHash: "source", oldValueHash: null, targetFile: "file", targetId: "id", patch: null, yamlValue: { id: "id" } });
    expect(Object.keys(projection)).toEqual(["operation", "kind", "candidateHash", "sourceHash", "oldValueHash", "targetFile", "targetId", "patch", "yamlValue"]);
  });

  it("keeps old source spelling while canonicalizing new candidate sources", () => {
    const oldSource = "https://YS.MIHOYO.COM/main/news/detail/old";
    const candidateSource = "https://ys.mihoyo.com/main/news/detail/new";
    expect(mergeSources([oldSource], [candidateSource, oldSource])).toEqual([oldSource, candidateSource]);
  });

  it("resolves related candidate keys through the batch target map", async () => {
    const versionArticle = raw("version-1", "7.0版本更新说明", "版本时间：2026年8月20日 04:00 至 2026年9月20日 04:00");
    const eventArticle = raw("event-1", "活动说明", "活动时间：2026年8月20日 05:00 至 2026年8月20日 12:00");
    const versionCandidate = parseArticleCandidate(versionArticle, "20260827-000001", "primary");
    const eventCandidate = rehash(parseArticleCandidate(eventArticle, "20260827-000001", "primary"), { relatedCandidateKeys: [versionCandidate.candidateKey] });
    const targetFile = "data/genshin-impact/cn-2026.yaml";
    const selections = [
      selectionItem(eventCandidate, "add", "event-new", targetFile, null),
      selectionItem(versionCandidate, "add", "version-new", targetFile, null),
    ];
    const setup = await prepareRun([{ raw: versionArticle, candidate: versionCandidate }, { raw: eventArticle, candidate: eventCandidate }], dataFile("genshin-impact", "cn", { events: [eventValue("old-event", "旧活动", eventArticle.url)] }), selections);
    const result = await approveRun({ ...setup, eventTypesPath });
    const eventEntry = result.manifest.entries.find((entry) => entry.kind === "event");
    expect(eventEntry?.yamlValue.related).toEqual(["version-new"]);
  });

  it("resolves related candidate keys through a durable version mapping", async () => {
    const article = raw("history-event-1", "活动说明", "活动时间：2026年8月20日 05:00 至 2026年8月20日 12:00");
    const baseCandidate = parseArticleCandidate(article, "20260827-000001", "primary");
    const candidate = rehash(baseCandidate, { relatedCandidateKeys: ["genshin-impact/historical-version/primary"] });
    const targetFile = "data/genshin-impact/cn-2026.yaml";
    const mapEntry = {
      candidateKey: "genshin-impact/historical-version/primary",
      game: "genshin-impact",
      region: "cn",
      kind: "version",
      targetFile,
      targetId: "historical-version",
      appliedRunId: "20260826-000001",
      appliedAt: "2026-08-26T00:00:00Z",
    };
    const setup = await prepareRun([{ raw: article, candidate }], dataFile("genshin-impact", "cn", { versions: [versionValue("historical-version", "历史版本", article.url)], events: [eventValue("old-event", "旧活动", article.url)] }), [selectionItem(candidate, "add", "history-event", targetFile, null)], [mapEntry]);
    const result = await approveRun({ ...setup, eventTypesPath });
    const entry = result.manifest.entries[0];
    expect("related" in entry.yamlValue ? entry.yamlValue.related : undefined).toEqual(["historical-version"]);
  });

  it("rejects a related candidate key with no selected or durable mapping", async () => {
    const article = raw("missing-related-1", "活动说明", "活动时间：2026年8月20日 05:00 至 2026年8月20日 12:00");
    const candidate = rehash(parseArticleCandidate(article, "20260827-000001", "primary"), { relatedCandidateKeys: ["genshin-impact/missing-version/primary"] });
    const setup = await prepareRun([{ raw: article, candidate }], dataFile("genshin-impact", "cn", { events: [eventValue("old-event", "旧活动", article.url)] }), [selectionItem(candidate, "add", "missing-related-event", "data/genshin-impact/cn-2026.yaml", null)]);
    await expect(approveRun({ ...setup, eventTypesPath })).rejects.toThrow(/related.*missing|mapping/i);
  });

  it("does not write a partial manifest when a later selection fails", async () => {
    const firstArticle = raw("batch-first", "第一活动", "活动时间：2026年8月20日 04:00 至 2026年8月20日 11:00");
    const secondArticle = raw("batch-second", "第二活动", "活动时间：2026年8月21日 04:00 至 2026年8月21日 11:00");
    const firstCandidate = parseArticleCandidate(firstArticle, "20260827-000001", "primary");
    const secondCandidate = parseArticleCandidate(secondArticle, "20260827-000001", "primary");
    const setup = await prepareRun([{ raw: firstArticle, candidate: firstCandidate }, { raw: secondArticle, candidate: secondCandidate }], dataFile("genshin-impact", "cn", { events: [eventValue("old-event", "旧活动", firstArticle.url)] }), [selectionItem(firstCandidate, "add", "batch-first-event", "data/genshin-impact/cn-2026.yaml", null), selectionItem(secondCandidate, "update", "old-event", "data/genshin-impact/cn-2026.yaml", sha256Utf8("stale old value") as Sha256)]);
    await expect(approveRun({ ...setup, eventTypesPath })).rejects.toThrow(/oldValueHash|stale|mismatch/i);
    await expect(readFile(artifactPath(setup.runtimeRoot, setup.runId, "approved", "json"), "utf8")).rejects.toThrow();
  });

  it("refuses a second manifest and cleans up a failed atomic rename", async () => {
    const article = raw("atomic-1", "原子活动", "活动时间：2026年8月20日 04:00 至 2026年8月20日 11:00");
    const candidate = parseArticleCandidate(article, "20260827-000001", "primary");
    const selection = [selectionItem(candidate, "add", "atomic-event", "data/genshin-impact/cn-2026.yaml", null)];
    const first = await prepareRun([{ raw: article, candidate }], dataFile("genshin-impact", "cn", { events: [eventValue("old-event", "旧活动", article.url)] }), selection);
    await approveRun({ ...first, eventTypesPath });
    await expect(approveRun({ ...first, eventTypesPath })).rejects.toThrow(/already|manifest|exist/i);

    const second = await prepareRun([{ raw: article, candidate }], dataFile("genshin-impact", "cn", { events: [eventValue("old-event", "旧活动", article.url)] }), selection);
    const rename = async (_from: string, _to: string) => { throw new Error("manifest rename failed"); };
    await expect(approveRun({ ...second, eventTypesPath, rename })).rejects.toThrow("manifest rename failed");
    await expect(readFile(artifactPath(second.runtimeRoot, second.runId, "approved", "json"), "utf8")).rejects.toThrow();
  });

  it("revalidates proposal hashes when reading a manifest", async () => {
    const article = raw("read-manifest-1", "读取活动", "活动时间：2026年8月20日 04:00 至 2026年8月20日 11:00");
    const candidate = parseArticleCandidate(article, "20260827-000001", "primary");
    const setup = await prepareRun([{ raw: article, candidate }], dataFile("genshin-impact", "cn", { events: [eventValue("old-event", "旧活动", article.url)] }), [selectionItem(candidate, "add", "read-manifest-event", "data/genshin-impact/cn-2026.yaml", null)]);
    const result = await approveRun({ ...setup, eventTypesPath });
    await expect(readApprovedManifest(result.manifestPath)).resolves.toMatchObject({ runId: setup.runId });
    const manifest = JSON.parse(await readFile(result.manifestPath, "utf8")) as { entries: Array<Record<string, unknown>> };
    manifest.entries[0].proposalHash = sha256Utf8("tampered proposal") as Sha256;
    await writeFile(result.manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");
    await expect(readApprovedManifest(result.manifestPath)).rejects.toThrow(/proposalHash|hash/i);
  });

  it("keeps selection and manifest schemas strict at their boundaries", () => {
    const validHash = `sha256:${"a".repeat(64)}`;
    const validSelectionItem = { kind: "event", operation: "add", expectedOldValueHash: null, candidateKey: "g/s/x", candidateHash: validHash, sourceHash: validHash, targetId: "x", targetFile: "data/genshin-impact/cn-2026.yaml" };
    expect(ApprovalSelectionSchema.safeParse({ schemaVersion: 1, runId: "20260827-000001", selections: [] }).success).toBe(true);
    expect(ApprovalSelectionSchema.safeParse({ schemaVersion: 1, runId: "20260827-000001", selections: [], extra: true }).success).toBe(false);
    expect(ApprovalSelectionSchema.safeParse({ schemaVersion: 1, runId: "20260827-000001", selections: [validSelectionItem, validSelectionItem] }).success).toBe(false);
    expect(ApprovalSelectionSchema.safeParse({ schemaVersion: 1, runId: "20260827-000001", selections: [{ ...validSelectionItem, patch: { kind: "event", set: { url: undefined }, unset: [] } }] }).success).toBe(false);
    const value = eventValue("x", "活动", "https://ys.mihoyo.com/main/news/detail/x");
    const validEntry = { candidateKey: "g/s/x", candidateHash: validHash, sourceHash: validHash, game: "genshin-impact", region: "cn", operation: "add", targetFile: "data/genshin-impact/cn-2026.yaml", targetId: "x", oldValueHash: null, proposalHash: validHash, kind: "event", patch: null, oldValue: null, yamlValue: value };
    const updateOldHash = hashCanonicalJson(oldValueHashProjection(value)) as Sha256;
    const updateEntry = { ...validEntry, operation: "update" as const, kind: "event" as const, oldValue: value, oldValueHash: updateOldHash, yamlValue: value };
    updateEntry.proposalHash = hashCanonicalJson(proposalHashProjection(updateEntry)) as Sha256;
    expect(ApprovedManifestEntrySchema.safeParse(updateEntry).success).toBe(true);
    expect(ApprovedManifestEntrySchema.safeParse({ ...updateEntry, oldValue: { ...value, name: "被篡改" } }).success).toBe(false);
    expect(ApprovedManifestSchema.safeParse({ schemaVersion: 1, runId: "20260827-000001", generatedAt: "not-an-audit-time", entries: [] }).success).toBe(false);
  });
});
