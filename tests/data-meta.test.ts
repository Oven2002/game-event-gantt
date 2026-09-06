import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DataValidationError, loadDataMeta } from "../src/lib/data.ts";

const temporaryDirectories: string[] = [];

// Build a minimal data root containing only meta.yaml variants; loadDataMeta
// reads data/meta.yaml without requiring game directories to exist.
function metaFixture(metaYaml: string | null): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "game-gantt-meta-test-"));
  temporaryDirectories.push(root);
  if (metaYaml !== null) {
    fs.writeFileSync(path.join(root, "meta.yaml"), metaYaml);
  }
  return root;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("loadDataMeta", () => {
  it("returns the tracked data meta for valid fields with Z offset", () => {
    const root = metaFixture('dataUpdatedAt: "2026-09-05T17:38:48Z"\ndataCommit: "cd24bed"\n');
    expect(loadDataMeta(root)).toEqual({
      dataUpdatedAt: "2026-09-05T17:38:48Z",
      dataCommit: "cd24bed",
    });
  });

  it("accepts +08:00 offsets and keeps the raw string", () => {
    const root = metaFixture('dataUpdatedAt: "2026-09-06T01:38:00+08:00"\ndataCommit: "cd24bed"\n');
    expect(loadDataMeta(root)?.dataUpdatedAt).toBe("2026-09-06T01:38:00+08:00");
  });

  it("throws when meta.yaml is missing", () => {
    const root = metaFixture(null);
    expect(() => loadDataMeta(root)).toThrow(DataValidationError);
  });

  it.each([
    ["missing dataUpdatedAt", 'dataCommit: "cd24bed"\n'],
    ["missing dataCommit", 'dataUpdatedAt: "2026-09-05T17:38:48Z"\n'],
  ])("throws when %s", (_label, metaYaml) => {
    const root = metaFixture(metaYaml);
    expect(() => loadDataMeta(root)).toThrow(DataValidationError);
  });

  it.each([
    ["fractional seconds", 'dataUpdatedAt: "2026-09-05T17:38:48.5Z"\ndataCommit: "cd24bed"\n'],
    ["local time without offset", 'dataUpdatedAt: "2026-09-05 17:38:48"\ndataCommit: "cd24bed"\n'],
    ["empty commit", 'dataUpdatedAt: "2026-09-05T17:38:48Z"\ndataCommit: ""\n'],
    ["five-char commit", 'dataUpdatedAt: "2026-09-05T17:38:48Z"\ndataCommit: "cd24b"\n'],
    ["commit with uppercase", 'dataUpdatedAt: "2026-09-05T17:38:48Z"\ndataCommit: "cd24BED"\n'],
    ["unexpected extra key", 'dataUpdatedAt: "2026-09-05T17:38:48Z"\ndataCommit: "cd24bed"\nextra: 1\n'],
  ])("rejects %s", (_label, metaYaml) => {
    const root = metaFixture(metaYaml);
    expect(() => loadDataMeta(root)).toThrow(DataValidationError);
  });
});
