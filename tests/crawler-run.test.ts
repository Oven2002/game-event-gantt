import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
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
    await writeFile(artifactPath(root, "20260801-000000", "raw"), "{}\n");
    await expect(assertRunArtifactsAbsent(root, "20260801-000000", ["raw", "errors"])).rejects.toThrow(/artifacts already exist/);
  });

  it("requires an explicit existing run", async () => {
    const root = await mkdtemp(join(tmpdir(), "crawler-run-"));
    await expect(assertRunExists(root, "20260801-000000")).rejects.toThrow(/does not exist/);
  });
});
