import { describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchGame } from "../scripts/crawl/commands/fetch.ts";
import type { RawArticle, Sha256 } from "../scripts/crawl/types.ts";

const article = (id: string): RawArticle => ({ game: "demo", region: "cn", source: "official", sourceId: id, url: `https://demo.example/${id}`, title: id, publishedAt: null, content: id, contentHash: `sha256:${"a".repeat(64)}` as Sha256, fetchedAt: "2026-08-01T00:00:00Z" });

describe("fetch command", () => {
  it("fetches paged list/detail fixtures and writes unique raw JSONL", async () => {
    const root = await mkdtemp(join(tmpdir(), "crawler-fetch-"));
    const responses = new Map<string, string>([["list:1", JSON.stringify({ items: [{ sourceId: "1", url: "detail:1" }] })], ["list:2", JSON.stringify({ items: [] })], ["detail:1", JSON.stringify({ id: "1" })]]);
    const result = await fetchGame({ runtimeRoot: root, runId: "20260801-000000", pageSize: 1, fetcher: async (url) => ({ url, status: 200, contentType: "application/json", body: responses.get(url)! }), adapter: {
      allowedHosts: ["demo.example"], listUrl: (page) => `list:${page}`, detailUrl: (id) => `detail:${id}`, list: (_page, _size, body) => body as { items: Array<{ sourceId: string; url: string }> }, listItems: (page) => page.items, detail: (id, _body, fetchedAt) => ({ ...article(id), fetchedAt }),
    }});
    expect(result.count).toBe(1);
    expect(JSON.parse((await readFile(result.rawPath, "utf8")).trim()).sourceId).toBe("1");
  });
});
