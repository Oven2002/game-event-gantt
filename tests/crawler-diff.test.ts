import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rename as fsRename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CandidateRejection, type RawArticle, type Sha256 } from "../scripts/crawl/types.ts";
import { reviewRun, buildDataIndex } from "../scripts/crawl/common/diff.ts";
import { createRun, artifactPath } from "../scripts/crawl/common/run.ts";
import { parseArticleCandidate } from "../scripts/crawl/parsers/article.ts";
import { sha256Utf8, candidateHashProjection, hashCanonicalJson } from "../scripts/crawl/common/hash.ts";

const mapEntry = {
  candidateKey: "genshin-impact/old-1/primary",
  game: "genshin-impact",
  region: "cn",
  kind: "event",
  targetFile: "data/genshin-impact/cn-2026.yaml",
  targetId: "old-event",
  appliedRunId: "20260827-000001",
  appliedAt: "2026-08-27T00:00:00+00:00",
};

function raw(sourceId: string, title: string, content: string): RawArticle {
  const url = `https://ys.mihoyo.com/main/news/detail/${sourceId}`;
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

async function prepareRun(rawArticles: RawArticle[], dataFiles: Record<string, string>, map: { schemaVersion: 1; entries: Array<Record<string, unknown>> } = { schemaVersion: 1, entries: [] }, rejections: CandidateRejection[] = []) {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "crawler-review-runtime-"));
  const dataRoot = await mkdtemp(join(tmpdir(), "crawler-review-data-"));
  const gameRoot = join(dataRoot, "genshin-impact");
  await mkdir(gameRoot, { recursive: true });
  for (const [name, content] of Object.entries(dataFiles)) await writeFile(join(gameRoot, name), content, "utf8");
  const runId = "20260827-000001";
  await createRun(runtimeRoot, runId, "genshin-impact");
  await mkdir(join(runtimeRoot, "raw", runId), { recursive: true });
  await mkdir(join(runtimeRoot, "candidates", runId), { recursive: true });
  await writeFile(artifactPath(runtimeRoot, runId, "raw", "jsonl", "genshin-impact"), `${rawArticles.map((value) => JSON.stringify(value)).join("\n")}\n`, "utf8");
  const candidates = rawArticles.map((value) => parseArticleCandidate(value, runId, "primary"));
  await writeFile(artifactPath(runtimeRoot, runId, "candidates", "json", "genshin-impact"), `${JSON.stringify(candidates)}\n`, "utf8");
  await mkdir(join(runtimeRoot, "rejections"), { recursive: true });
  await writeFile(artifactPath(runtimeRoot, runId, "rejections"), rejections.map((value) => JSON.stringify(value)).join("\n") + (rejections.length ? "\n" : ""), "utf8");
  const mapPath = join(runtimeRoot, "candidate-target-map.json");
  await writeFile(mapPath, `${JSON.stringify(map)}\n`, "utf8");
  return { runtimeRoot, dataRoot, targetMapPath: mapPath, runId };
}

const existingEvent = (id: string, name: string, sourceId: string, start = "2026-07-01T04:00:00+08:00", end = "2026-07-01T11:00:00+08:00") => `game: genshin-impact\nregion: cn\nevents:\n  - id: ${id}\n    name: ${name}\n    type: event\n    start: "${start}"\n    end: "${end}"\n    sources:\n      - "https://ys.mihoyo.com/main/news/detail/${sourceId}"\n`;

describe("crawler review diff", () => {
  it("suggests a clean confirmed add without target options", async () => {
    const setup = await prepareRun([
      raw("new-1", "全新活动", "活动时间：2026年8月20日 04:00 至 2026年8月20日 11:00"),
    ], { "cn-2026.yaml": existingEvent("existing-event", "旧活动", "old-1") });
    await mkdir(join(setup.dataRoot, "honkai-star-rail"), { recursive: true });
    await writeFile(join(setup.dataRoot, "honkai-star-rail", "cn-2026.yaml"), "game: honkai-star-rail\nregion: cn\nevents:\n  - id: other-event\n    name: 其他活动\n    type: event\n    start: \"2026-07-01T04:00:00+08:00\"\n    sources:\n      - \"https://sr.mihoyo.com/news/other\"\n", "utf8");
    const result = await reviewRun({ ...setup });
    expect(result.template.items).toHaveLength(1);
    expect(result.template.items[0]).toMatchObject({ suggestedOperation: "add", targetOptions: [] });
    const report = await readFile(result.reportPath, "utf8");
    expect(report).toContain("新增 confirmed");
    expect(report).toContain("data/genshin-impact/cn-2026.yaml");
    expect(report).not.toContain("data/honkai-star-rail/cn-2026.yaml");
    expect(report.split("## 已有条目时间变化")[1].split("## 已有条目来源变化")[0]).not.toContain("genshin-impact/new-1/primary");
    expect(report.split("## 已有条目来源变化")[1].split("## 已有条目其他字段变化")[0]).not.toContain("genshin-impact/new-1/primary");
  });

  it("reports uncertain additions separately and still leaves the operation explicit", async () => {
    const setup = await prepareRun([raw("new-1", "推算活动", "活动时间：2026年8月20日 04:00 至 2026年8月20日 11:00")], { "cn-2026.yaml": existingEvent("existing-event", "旧活动", "old-1") });
    const candidatePath = artifactPath(setup.runtimeRoot, setup.runId, "candidates", "json", "genshin-impact");
    const candidate = JSON.parse(await readFile(candidatePath, "utf8"))[0] as Record<string, unknown>;
    const uncertain: Record<string, unknown> = { ...candidate, timeCertainty: { start: "estimated", end: "confirmed" }, note: "按周期推算" };
    uncertain.candidateHash = hashCanonicalJson(candidateHashProjection(uncertain));
    await writeFile(candidatePath, `${JSON.stringify([uncertain])}\n`, "utf8");
    const result = await reviewRun({ ...setup });
    expect(result.template.items[0]).toMatchObject({ suggestedOperation: "add", targetOptions: [] });
    expect(await readFile(result.reportPath, "utf8")).toContain("新增 inferred/estimated");
  });

  it("keeps suspected matches manual when no durable mapping exists", async () => {
    const article = raw("new-1", "活动说明", "活动时间：2026年8月20日 05:00 至 2026年8月20日 12:00");
    const setup = await prepareRun([article], { "cn-2026.yaml": existingEvent("old-event", "活动说明", "old-1", "2026-08-20T04:00:00+08:00", "2026-08-20T11:00:00+08:00") });
    const result = await reviewRun({ ...setup });
    expect(result.template.items[0]).toMatchObject({ targetOptions: [{ targetId: "old-event" }] });
    expect(result.template.items[0]).not.toHaveProperty("suggestedOperation");
    const report = await readFile(result.reportPath, "utf8");
    expect(report).toContain("重复/无法匹配");
    expect(report).toContain("当前 YAML 值");
    expect(report).toContain("候选值");
    expect(report).toContain("candidate evidence");
  });

  it("uses an applied mapping for a deterministic update and reports field changes", async () => {
    const article = raw("new-1", "活动说明", "活动时间：2026年8月20日 05:00 至 2026年8月20日 12:00");
    const candidate = parseArticleCandidate(article, "20260827-000001", "primary");
    const setup = await prepareRun([article], { "cn-2026.yaml": existingEvent("old-event", "活动说明", "old-1", "2026-08-20T04:00:00+08:00", "2026-08-20T11:00:00+08:00") }, {
      schemaVersion: 1,
      entries: [{ ...mapEntry, candidateKey: candidate.candidateKey, targetId: "old-event" }],
    });
    const result = await reviewRun({ ...setup });
    expect(result.template.items[0]).toMatchObject({ suggestedOperation: "update", targetOptions: [{ targetId: "old-event", targetFile: "data/genshin-impact/cn-2026.yaml" }] });
    const report = await readFile(result.reportPath, "utf8");
    expect(report).toContain("已有条目时间变化");
    expect(report).toContain("已有条目来源变化");
    expect(report.split("## 已有条目来源变化")[1].split("## 重复/无法匹配")[0]).toContain(candidate.candidateKey);
    expect(report).toContain("当前 YAML 值");
    expect(report).toContain("候选值");
    expect(report).toContain("timeCertainty");
  });

  it("labels candidate related keys separately from YAML related ids", async () => {
    const article = raw("new-1", "活动说明", "活动时间：2026年8月20日 05:00 至 2026年8月20日 12:00");
    const setup = await prepareRun([article], { "cn-2026.yaml": existingEvent("old-event", "活动说明", "old-1", "2026-08-20T05:00:00+08:00", "2026-08-20T12:00:00+08:00") }, {
      schemaVersion: 1,
      entries: [{ ...mapEntry, candidateKey: "genshin-impact/new-1/primary", targetId: "old-event" }],
    });
    const candidatePath = artifactPath(setup.runtimeRoot, setup.runId, "candidates", "json", "genshin-impact");
    const candidate = JSON.parse(await readFile(candidatePath, "utf8"))[0] as Record<string, unknown>;
    const related: Record<string, unknown> = { ...candidate, relatedCandidateKeys: ["genshin-impact/version-1/primary"] };
    related.candidateHash = hashCanonicalJson(candidateHashProjection(related));
    await writeFile(candidatePath, `${JSON.stringify([related])}\n`, "utf8");
    const result = await reviewRun({ ...setup });
    expect(await readFile(result.reportPath, "utf8")).toContain("relatedCandidateKeys（当前 YAML related）");
  });

  it("keeps needs-review candidates out of the selection template", async () => {
    const setup = await prepareRun([raw("unknown-1", "未分类公告", "正文没有明确时间")], { "cn-2026.yaml": existingEvent("existing-event", "旧活动", "old-1") });
    const result = await reviewRun({ ...setup });
    expect(result.template.items).toHaveLength(0);
    expect(await readFile(result.reportPath, "utf8")).toContain("需要人工查看");
  });

  it("reports rejection counts by reason code without adding them to selections", async () => {
    const rejection: CandidateRejection = {
      rawRef: { runId: "20260827-000001", game: "genshin-impact", sourceId: "rejected-1" },
      reasonCode: "supports_versions_disabled",
      detail: "version candidate was rejected",
    };
    const setup = await prepareRun([raw("new-1", "全新活动", "活动时间：2026年8月20日 04:00 至 2026年8月20日 11:00")], { "cn-2026.yaml": existingEvent("existing-event", "旧活动", "old-1") }, { schemaVersion: 1, entries: [] }, [rejection]);
    const result = await reviewRun({ ...setup });
    expect(result.rejections).toEqual([rejection]);
    const report = await readFile(result.reportPath, "utf8");
    expect(report).toContain("候选拒绝（按 reasonCode）");
    expect(report).toContain("supports_versions_disabled: 1");
    expect(report).not.toContain("version candidate was rejected");
  });

  it("revalidates candidate source policy instead of trusting a recomputed hash", async () => {
    const setup = await prepareRun([raw("new-1", "全新活动", "活动时间：2026年8月20日 04:00 至 2026年8月20日 11:00")], { "cn-2026.yaml": existingEvent("existing-event", "旧活动", "old-1") });
    const candidatePath = artifactPath(setup.runtimeRoot, setup.runId, "candidates", "json", "genshin-impact");
    const candidate = JSON.parse(await readFile(candidatePath, "utf8"))[0] as Record<string, unknown>;
    const tampered: Record<string, unknown> = { ...candidate, sources: [...candidate.sources as string[], "https://www.zhihu.com/question/123"] };
    tampered.candidateHash = hashCanonicalJson(candidateHashProjection(tampered));
    await writeFile(candidatePath, `${JSON.stringify([tampered])}\n`, "utf8");
    await expect(reviewRun({ ...setup })).rejects.toThrow(/candidate validation failed|Zhihu|discovery/i);
  });

  it("reports mapped non-time and non-source changes instead of dropping them", async () => {
    const article = raw("new-1", "新名称活动", "活动时间：2026年8月20日 05:00 至 2026年8月20日 12:00");
    const candidate = parseArticleCandidate(article, "20260827-000001", "primary");
    const setup = await prepareRun([article], { "cn-2026.yaml": existingEvent("old-event", "旧名称活动", "new-1", "2026-08-20T05:00:00+08:00", "2026-08-20T12:00:00+08:00") }, {
      schemaVersion: 1,
      entries: [{ ...mapEntry, candidateKey: candidate.candidateKey, targetId: "old-event" }],
    });
    const result = await reviewRun({ ...setup });
    const report = await readFile(result.reportPath, "utf8");
    expect(report.split("## 已有条目其他字段变化")[1].split("## 重复/无法匹配")[0]).toContain(candidate.candidateKey);
    expect(report).toContain("name");
  });

  it("rejects a stale durable mapping", async () => {
    const article = raw("new-1", "活动说明", "活动时间：2026年8月20日 05:00 至 2026年8月20日 12:00");
    const candidate = parseArticleCandidate(article, "20260827-000001", "primary");
    const setup = await prepareRun([article], { "cn-2026.yaml": existingEvent("old-event", "活动说明", "old-1", "2026-08-20T04:00:00+08:00", "2026-08-20T11:00:00+08:00") }, {
      schemaVersion: 1,
      entries: [{ ...mapEntry, candidateKey: candidate.candidateKey, targetId: "missing-event" }],
    });
    await expect(reviewRun({ ...setup })).rejects.toThrow(/mapping is stale/i);
  });

  it("rejects a review runtime root inside its injected data root", async () => {
    const setup = await prepareRun([raw("new-1", "全新活动", "活动时间：2026年8月20日 04:00 至 2026年8月20日 11:00")], { "cn-2026.yaml": existingEvent("existing-event", "旧活动", "old-1") });
    const unsafeRuntimeRoot = join(setup.dataRoot, ".runtime", "crawl");
    await createRun(unsafeRuntimeRoot, setup.runId, "genshin-impact");
    await expect(reviewRun({ ...setup, runtimeRoot: unsafeRuntimeRoot })).rejects.toThrow(/protected|data|runtime/i);
  });

  it("rejects symlinked raw artifact directories and lock directories", async () => {
    const setup = await prepareRun([raw("new-1", "全新活动", "活动时间：2026年8月20日 04:00 至 2026年8月20日 11:00")], { "cn-2026.yaml": existingEvent("existing-event", "旧活动", "old-1") });
    const externalRoot = await mkdtemp(join(tmpdir(), "crawler-review-external-runtime-"));
    await rm(join(setup.runtimeRoot, "raw", setup.runId), { recursive: true, force: true });
    await symlink(externalRoot, join(setup.runtimeRoot, "raw", setup.runId), "dir");
    await expect(reviewRun({ ...setup })).rejects.toThrow(/symlink|runtime|escape/i);

    const second = await prepareRun([raw("new-2", "全新活动", "活动时间：2026年8月20日 04:00 至 2026年8月20日 11:00")], { "cn-2026.yaml": existingEvent("existing-event", "旧活动", "old-1") });
    const secondExternal = await mkdtemp(join(tmpdir(), "crawler-review-external-lock-"));
    await symlink(secondExternal, join(second.runtimeRoot, "review-locks"), "dir");
    await expect(reviewRun({ ...second })).rejects.toThrow(/symlink|runtime|escape/i);
  });

  it("rejects a second review for the same run without overwriting outputs", async () => {
    const setup = await prepareRun([raw("new-1", "全新活动", "活动时间：2026年8月20日 04:00 至 2026年8月20日 11:00")], { "cn-2026.yaml": existingEvent("existing-event", "旧活动", "old-1") });
    await expect(reviewRun({ ...setup })).resolves.toBeDefined();
    await expect(reviewRun({ ...setup })).rejects.toThrow(/already exist|artifacts/i);
  });

  it("removes both outputs when the second atomic rename fails", async () => {
    const setup = await prepareRun([raw("new-1", "全新活动", "活动时间：2026年8月20日 04:00 至 2026年8月20日 11:00")], { "cn-2026.yaml": existingEvent("existing-event", "旧活动", "old-1") });
    const rename = async (from: string, to: string) => {
      if (to.endsWith(".template.json")) throw new Error("template rename failed");
      await fsRename(from, to);
    };
    await expect(reviewRun({ ...setup, rename })).rejects.toThrow("template rename failed");
    await expect(readFile(artifactPath(setup.runtimeRoot, setup.runId, "reports", "md"), "utf8")).rejects.toThrow();
    await expect(readFile(artifactPath(setup.runtimeRoot, setup.runId, "selections", "json"), "utf8")).rejects.toThrow();
  });

  it("rejects duplicate global target identities across data files", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "crawler-review-duplicate-data-"));
    const gameRoot = join(dataRoot, "genshin-impact");
    await mkdir(gameRoot, { recursive: true });
    await writeFile(join(gameRoot, "cn-2026.yaml"), existingEvent("same-event", "活动一", "one"), "utf8");
    await writeFile(join(gameRoot, "cn-2027.yaml"), existingEvent("same-event", "活动二", "two"), "utf8");
    await expect(buildDataIndex(dataRoot)).rejects.toThrow(/duplicate|重复|same-event/i);
  });
});
