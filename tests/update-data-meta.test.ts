import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatDataMeta, findLatestDataCommit, updateDataMetaFile } from "../scripts/update-data-meta.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("update-data-meta", () => {
  it("formats the tracked data commit metadata as strict YAML", () => {
    expect(formatDataMeta({
      dataUpdatedAt: "2026-09-13T15:26:06Z",
      dataCommit: "ed86e32",
    })).toBe(
      'dataUpdatedAt: "2026-09-13T15:26:06Z"\ndataCommit: "ed86e32"\n',
    );
  });

  it("updates data/meta.yaml and is idempotent", () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "game-gantt-data-meta-"));
    temporaryDirectories.push(dataRoot);
    fs.writeFileSync(
      path.join(dataRoot, "meta.yaml"),
      'dataUpdatedAt: "2026-09-05T17:38:48Z"\ndataCommit: "cd24bed"\n',
    );

    const metadata = {
      dataUpdatedAt: "2026-09-13T15:26:06Z",
      dataCommit: "ed86e32",
    };
    expect(updateDataMetaFile(dataRoot, metadata)).toBe(true);
    expect(fs.readFileSync(path.join(dataRoot, "meta.yaml"), "utf8")).toBe(formatDataMeta(metadata));
    expect(updateDataMetaFile(dataRoot, metadata)).toBe(false);
  });

  it("ignores a metadata-only commit when finding the latest data commit", () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "game-gantt-meta-git-"));
    temporaryDirectories.push(repoRoot);
    execFileSync("git", ["init", "-q"], { cwd: repoRoot });
    execFileSync("git", ["config", "user.name", "Test User"], { cwd: repoRoot });
    execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: repoRoot });
    fs.mkdirSync(path.join(repoRoot, "data", "demo-game"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, "data", "demo-game", "cn-2026.yaml"), "game: demo-game\nregion: cn\nevents: []\n");
    execFileSync("git", ["add", "data"], { cwd: repoRoot });
    execFileSync("git", ["commit", "-qm", "data"], { cwd: repoRoot });
    const dataCommit = execFileSync("git", ["rev-parse", "--short=7", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
    const dataUpdatedAt = execFileSync("git", ["show", "-s", "--format=%cI", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();

    fs.writeFileSync(path.join(repoRoot, "data", "meta.yaml"), "stale: true\n");
    execFileSync("git", ["add", "data/meta.yaml"], { cwd: repoRoot });
    execFileSync("git", ["commit", "-qm", "metadata"], { cwd: repoRoot });

    expect(findLatestDataCommit(repoRoot)).toEqual({ dataUpdatedAt, dataCommit });
  });
});
