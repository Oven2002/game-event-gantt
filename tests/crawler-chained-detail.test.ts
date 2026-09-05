import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchGame } from "../scripts/crawl/commands/fetch.ts";
import { runCrawlCli } from "../scripts/crawl/cli.ts";
import { createRun, artifactPath } from "../scripts/crawl/common/run.ts";
import type { RawArticle, Sha256 } from "../scripts/crawl/types.ts";
import { sha256Utf8 } from "../scripts/crawl/common/hash.ts";

describe("chained detail fetch (postroom preview -> content)", () => {
  it("runs both chained requests and passes the final body to detail", async () => {
    const root = await mkdtemp(join(tmpdir(), "crawler-chained-"));
    const runId = "20260904-000000";
    await createRun(root, runId, "demo");
    const article = (id: string, content: string): RawArticle => ({
      game: "demo",
      region: "cn",
      source: "official",
      sourceId: id,
      url: `https://demo.example/detail/${id}`,
      title: "活动说明",
      publishedAt: "2026-08-01 20:00:00",
      content,
      contentHash: sha256Utf8(content) as Sha256,
      fetchedAt: "2026-09-04T12:00:00.000Z",
    });
    const previewBody = JSON.stringify({ id: "1", name: "活动说明" });
    const contentBody = JSON.stringify({ content: "活动时间：2026年8月20日 04:00 至 11:00" });
    const calls: string[] = [];
    const result = await fetchGame({
      runtimeRoot: root,
      runId,
      game: "demo",
      fetcher: async (url) => {
        calls.push(url);
        const body = url.endsWith("list.json")
          ? JSON.stringify({ items: [{ sourceId: "1", url: "https://demo.example/1.preview.json" }] })
          : url.endsWith("preview.json")
            ? previewBody
            : contentBody;
        return { url, status: 200, contentType: "application/json", body };
      },
      adapter: {
        allowedHosts: ["demo.example"],
        listUrl: () => "https://demo.example/list.json",
        detailUrl: (id) => `https://demo.example/${id}.preview.json`,
        nextDetailUrl: (sourceId, body) => {
          const parsed = body as { name?: string };
          if (parsed.name) return `https://demo.example/${sourceId}.content.json`;
          return undefined;
        },
        list: (_page, _size, body) => body as { items: Array<{ sourceId: string; url: string }> },
        listItems: (page) => page.items,
        detail: (sourceId, body, fetchedAt) => article(sourceId, (body as { content?: string }).content ?? String(body)),
      },
    });
    expect(calls).toEqual([
      "https://demo.example/list.json",
      "https://demo.example/1.preview.json",
      "https://demo.example/1.content.json",
    ]);
    expect(result.count).toBe(1);
    await rm(root, { recursive: true, force: true });
  });
});
