import { describe, expect, it } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { FixtureMetadataSchema } from "../scripts/crawl/types.ts";
import { buildHypergryphListRequest } from "../scripts/crawl/adapters/hypergryph.ts";
import { buildMihoyoDetailRequest, buildMihoyoListRequest } from "../scripts/crawl/adapters/mihoyo.ts";
import { hypergryphGames } from "../scripts/crawl/hypergryph-config.ts";
import { mihoyoGames } from "../scripts/crawl/mihoyo-config.ts";

const fixtureRoot = resolve("tests/fixtures/crawler");
const sensitiveText = /authorization|cookie|set-cookie|access.?key|secret|password|token|credential/i;

async function json(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

async function fixtureFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await fixtureFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".json") && !entry.name.endsWith(".meta.json")) files.push(path);
  }
  return files;
}

function baseUrl(url: string): string {
  const value = new URL(url);
  return `${value.origin}${value.pathname}`;
}

function queryParameters(url: string): Record<string, string> {
  return Object.fromEntries(new URL(url).searchParams.entries());
}

describe("crawler fixture sidecars", () => {
  it("validates every response fixture and its metadata as an offline contract", async () => {
    const files = (await fixtureFiles(fixtureRoot)).sort();
    expect(files).toHaveLength(10);
    for (const dataPath of files) {
      const metadataPath = dataPath.replace(/\.json$/, ".meta.json");
      const metadata = await json(metadataPath);
      const result = FixtureMetadataSchema.safeParse(metadata);
      expect(result.success, relative(fixtureRoot, metadataPath)).toBe(true);
      if (!result.success) continue;
      const value = result.data;
      const parts = relative(fixtureRoot, dataPath).split("/");
      expect(value.game).toBe(parts[1]);
      expect(value.fixtureKind).toBe("real");
      expect(value.blocker).toBeNull();
      expect(JSON.stringify(value)).not.toMatch(sensitiveText);
      if (value.fixtureRole === "list") expect(value.pagination).not.toBeNull();
      if (value.fixtureRole === "detail") {
        expect(value.pagination).toBeNull();
        expect(value.detailSourceId).toMatch(/^\d+$/);
      }
      expect(value.response.redirects).toEqual([]);
      expect(value.response.finalUrl).toBe(value.request.url);
    }
  });

  it("matches sidecar request facts against the measured request builders", async () => {
    const files = (await fixtureFiles(fixtureRoot)).sort();
    for (const dataPath of files) {
      const metadata = FixtureMetadataSchema.parse(await json(dataPath.replace(/\.json$/, ".meta.json")));
      const parts = relative(fixtureRoot, dataPath).split("/");
      const provider = parts[0];
      const game = parts[1];
      let expectedUrl: string;
      if (metadata.fixtureRole === "list") {
        const page = Number(metadata.request.parameters.iPage ?? metadata.request.parameters.page);
        const pageSize = Number(metadata.request.parameters.iPageSize ?? metadata.request.parameters.pageSize);
        expectedUrl = provider === "mihoyo"
          ? buildMihoyoListRequest(game as keyof typeof mihoyoGames, page, pageSize).url
          : buildHypergryphListRequest(game as keyof typeof hypergryphGames, page, pageSize).url;
      } else {
        expectedUrl = provider === "mihoyo"
          ? buildMihoyoDetailRequest(game as keyof typeof mihoyoGames, metadata.detailSourceId!).url
          : `https://${hypergryphGames[game as keyof typeof hypergryphGames].officialHost}/news/${metadata.detailSourceId}`;
      }
      expect(baseUrl(expectedUrl), relative(fixtureRoot, dataPath)).toBe(baseUrl(metadata.request.url));
      expect(queryParameters(expectedUrl), relative(fixtureRoot, dataPath)).toEqual(metadata.request.parameters);
    }
  });

  it("keeps detail source ids present in their corresponding list fixture", async () => {
    const files = (await fixtureFiles(fixtureRoot)).filter((path) => basename(path).includes("detail-")).sort();
    for (const detailPath of files) {
      const metadata = FixtureMetadataSchema.parse(await json(detailPath.replace(/\.json$/, ".meta.json")));
      const directory = dirname(detailPath);
      const listPath = join(directory, "list-page-1.json");
      const list = await json(listPath) as { data?: { list?: Array<Record<string, unknown>> } };
      const ids = (list.data?.list ?? []).map((item) => String(item.iInfoId ?? item.cid));
      expect(ids, relative(fixtureRoot, detailPath)).toContain(metadata.detailSourceId);
    }
  });
});
