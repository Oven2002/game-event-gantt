import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { artifactPath, assertRunArtifactsAbsent, assertRunExists, createRun, runRoot } from "../scripts/crawl/common/run.ts";

describe("crawler run lifecycle", () => {
  it("creates a run exclusively and rejects a duplicate", async () => {
    const root = await mkdtemp(join(tmpdir(), "crawler-run-"));
    await expect(createRun(root, "20260801-000000")).resolves.toBe(runRoot(root, "20260801-000000"));
    await expect(createRun(root, "20260801-000000")).rejects.toThrow(/already exists/);
  });

  it("rejects any pre-existing artifact before a command writes", async () => {
    const root = await mkdtemp(join(tmpdir(), "crawler-run-"));
    await createRun(root, "20260801-000000");
    await mkdir(join(root, "raw", "20260801-000000"), { recursive: true });
    await writeFile(artifactPath(root, "20260801-000000", "raw", "jsonl", "demo"), "{}\n");
    await expect(assertRunArtifactsAbsent(root, "20260801-000000", ["raw", "errors"])).rejects.toThrow(/artifacts already exist/);
  });

  it("requires an explicit existing run", async () => {
    const root = await mkdtemp(join(tmpdir(), "crawler-run-"));
    await expect(assertRunExists(root, "20260801-000000")).rejects.toThrow(/does not exist/);
  });

  it("uses the V5.2 artifact paths for game and run scoped outputs", async () => {
    const root = await mkdtemp(join(tmpdir(), "crawler-run-"));
    const runId = "20260801-000001";
    expect(artifactPath(root, runId, "raw", "jsonl", "genshin-impact")).toBe(join(root, "raw", runId, "genshin-impact.jsonl"));
    expect(artifactPath(root, runId, "candidates", "json", "genshin-impact")).toBe(join(root, "candidates", runId, "genshin-impact.json"));
    expect(artifactPath(root, runId, "rejections")).toBe(join(root, "rejections", `${runId}.jsonl`));
    expect(artifactPath(root, runId, "errors")).toBe(join(root, "errors", `${runId}.jsonl`));
    expect(artifactPath(root, runId, "reports", "md")).toBe(join(root, "reports", `${runId}.md`));
    expect(artifactPath(root, runId, "selections", "json")).toBe(join(root, "selections", `${runId}.template.json`));
    expect(artifactPath(root, runId, "approved", "json")).toBe(join(root, "approved", `${runId}.json`));
  });

  it("rejects invalid run ids before constructing filesystem paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "crawler-run-"));
    expect(() => runRoot(root, "../escape")).toThrow(/run-id/);
    await expect(createRun(root, "not-a-run")).rejects.toThrow(/run-id/);
  });

  it("rejects path components that could escape the runtime root", async () => {
    const root = await mkdtemp(join(tmpdir(), "crawler-run-"));
    const runId = "20260801-000002";
    expect(() => artifactPath(root, runId, "reports", "../../escape")).toThrow(/suffix/);
    expect(() => artifactPath(root, runId, "raw", "jsonl", "../escape")).toThrow(/game/);
  });
});
