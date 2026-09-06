import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readSiteMeta, renderDataMetaLine } from "../src/lib/site-meta.ts";
import type { SiteMeta } from "../src/lib/site-meta.ts";

const temporaryDirectories: string[] = [];

function metaFixture(json: string | null): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "game-gantt-site-meta-test-"));
  temporaryDirectories.push(root);
  if (json !== null) {
    fs.mkdirSync(path.join(root, "generated"), { recursive: true });
    fs.writeFileSync(path.join(root, "generated", "site-meta.json"), json);
  }
  return root;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

const fullMeta: SiteMeta = {
  dataUpdatedAtLabel: "2026/09/06 01:38",
  groups: 15,
  items: 452,
  dataCommit: "cd24bed",
};

describe("renderDataMetaLine", () => {
  it("renders the full footer line from complete meta", () => {
    expect(renderDataMetaLine(fullMeta)).toBe("数据更新：2026/09/06 01:38 · 15 组 452 条 · cd24bed");
  });

  it("returns null when meta is unavailable so the page omits the line", () => {
    expect(renderDataMetaLine(null)).toBeNull();
  });
});

describe("readSiteMeta", () => {
  it("parses the generated site-meta.json", () => {
    const root = metaFixture(JSON.stringify(fullMeta));
    expect(readSiteMeta(path.join(root, "generated", "site-meta.json"))).toEqual(fullMeta);
  });

  it("returns null when the file is missing", () => {
    const root = metaFixture(null);
    expect(readSiteMeta(path.join(root, "generated", "site-meta.json"))).toBeNull();
  });

  it("returns null on malformed JSON", () => {
    const root = metaFixture("{not json");
    expect(readSiteMeta(path.join(root, "generated", "site-meta.json"))).toBeNull();
  });
});