// Update data/meta.yaml from the latest commit that changed formal data.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface DataCommitMeta {
  dataUpdatedAt: string;
  dataCommit: string;
}

export function formatDataMeta(meta: DataCommitMeta): string {
  return `dataUpdatedAt: "${meta.dataUpdatedAt}"\ndataCommit: "${meta.dataCommit}"\n`;
}

export function updateDataMetaFile(dataRoot: string, meta: DataCommitMeta): boolean {
  const metaFile = path.join(dataRoot, "meta.yaml");
  const next = formatDataMeta(meta);
  const current = fs.existsSync(metaFile) ? fs.readFileSync(metaFile, "utf8") : "";
  if (current === next) return false;
  fs.writeFileSync(metaFile, next, "utf8");
  return true;
}

export function isDataMetaCurrent(dataRoot: string, meta: DataCommitMeta): boolean {
  const metaFile = path.join(dataRoot, "meta.yaml");
  return fs.existsSync(metaFile) && fs.readFileSync(metaFile, "utf8") === formatDataMeta(meta);
}

export function findLatestDataCommit(repoRoot: string): DataCommitMeta {
  const output = execFileSync(
    "git",
    [
      "log",
      "-1",
      "--abbrev=7",
      "--format=%cI%x00%h",
      "--",
      "data",
      ":(exclude)data/meta.yaml",
    ],
    { cwd: repoRoot, encoding: "utf8" },
  ).trim();
  const [dataUpdatedAt, dataCommit] = output.split("\0");
  if (!dataUpdatedAt || !/^[0-9a-f]{7}$/.test(dataCommit ?? "")) {
    throw new Error("Unable to find a recent commit that changed formal data");
  }
  return { dataUpdatedAt, dataCommit };
}

export function updateFromGit(repoRoot: string): { changed: boolean; meta: DataCommitMeta } {
  const meta = findLatestDataCommit(repoRoot);
  const changed = updateDataMetaFile(path.join(repoRoot, "data"), meta);
  return { changed, meta };
}

function gitRoot(cwd: string): string {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
  }).trim();
}

function main(): void {
  const repoRoot = gitRoot(process.cwd());
  const meta = findLatestDataCommit(repoRoot);
  if (process.argv.includes("--check")) {
    if (!isDataMetaCurrent(path.join(repoRoot, "data"), meta)) {
      console.error(`stale: data/meta.yaml should point to ${meta.dataCommit} at ${meta.dataUpdatedAt}`);
      process.exitCode = 1;
      return;
    }
    console.log(`current: data ${meta.dataCommit} at ${meta.dataUpdatedAt}`);
    return;
  }

  const changed = updateDataMetaFile(path.join(repoRoot, "data"), meta);
  console.log(`${changed ? "updated" : "unchanged"}: data ${meta.dataCommit} at ${meta.dataUpdatedAt}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
