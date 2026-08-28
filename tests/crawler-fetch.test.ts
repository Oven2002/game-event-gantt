import { describe, expect, it } from "vitest";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchGame } from "../scripts/crawl/commands/fetch.ts";
import { CrawlerHttpError } from "../scripts/crawl/common/http.ts";
import { sha256Utf8 } from "../scripts/crawl/common/hash.ts";
import { createRun, artifactPath } from "../scripts/crawl/common/run.ts";
import type { RawArticle, Sha256 } from "../scripts/crawl/types.ts";

const article = (id: string): RawArticle => ({
  game: "demo",
  region: "cn",
  source: "official",
  sourceId: id,
  url: `https://demo.example/${id}`,
  title: id,
  publishedAt: null,
  content: id,
  contentHash: sha256Utf8(id) as Sha256,
  fetchedAt: "2026-08-01T00:00:00Z",
});

async function newRun(): Promise<{ root: string; runId: string }> {
  const root = await mkdtemp(join(tmpdir(), "crawler-fetch-"));
  const runId = "20260801-000000";
  await createRun(root, runId, "demo");
  return { root, runId };
}

describe("fetch command", () => {
  it("refuses fetch when another same-run artifact already exists", async () => {
    const { root, runId } = await newRun();
    const candidatePath = artifactPath(root, runId, "candidates", "json", "demo");
    await mkdir(join(root, "candidates", runId), { recursive: true });
    await writeFile(candidatePath, "sentinel\n", "utf8");

    await expect(fetchGame({
      runtimeRoot: root,
      runId,
      game: "demo",
      fetcher: async (url) => ({ url, status: 200, contentType: "application/json", body: JSON.stringify({ items: [] }) }),
      adapter: {
        allowedHosts: ["demo.example"],
        listUrl: () => "list:1",
        detailUrl: (id) => `detail:${id}`,
        list: (_page, _size, body) => body as { items: Array<{ sourceId: string; url: string }> },
        listItems: (page) => page.items,
        detail: (id, _body, fetchedAt) => ({ ...article(id), fetchedAt }),
      },
    })).rejects.toThrow(/artifacts already exist/);
    expect(await readFile(candidatePath, "utf8")).toBe("sentinel\n");
  });

  it("fetches paged list/detail fixtures and writes a game-scoped raw JSONL", async () => {
    const { root, runId } = await newRun();
    const responses = new Map<string, string>([
      ["list:1", JSON.stringify({ items: [{ sourceId: "1", url: "detail:1" }] })],
      ["list:2", JSON.stringify({ items: [] })],
      ["detail:1", JSON.stringify({ id: "1" })],
    ]);
    const result = await fetchGame({
      runtimeRoot: root,
      runId,
      game: "demo",
      pageSize: 1,
      fetcher: async (url) => ({ url, status: 200, contentType: "application/json", body: responses.get(url)! }),
      adapter: {
        allowedHosts: ["demo.example"],
        listUrl: (page) => `list:${page}`,
        detailUrl: (id) => `detail:${id}`,
        list: (_page, _size, body) => body as { items: Array<{ sourceId: string; url: string }> },
        listItems: (page) => page.items,
        detail: (id, _body, fetchedAt) => ({ ...article(id), fetchedAt }),
      },
    });
    expect(result).toMatchObject({ count: 1, pages: 2 });
    expect(result.rawPath).toBe(artifactPath(root, runId, "raw", "jsonl", "demo"));
    expect(JSON.parse((await readFile(result.rawPath, "utf8")).trim()).sourceId).toBe("1");
  });

  it("fails instead of committing when maxPages is reached before pagination completes", async () => {
    const { root, runId } = await newRun();
    await expect(fetchGame({
      runtimeRoot: root,
      runId,
      game: "demo",
      maxPages: 1,
      fetcher: async (url) => ({
        url,
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(url.startsWith("detail:") ? article("1") : { items: [{ sourceId: "1", url: "detail:1" }] }),
      }),
      adapter: {
        allowedHosts: ["demo.example"],
        listUrl: (page) => `list:${page}`,
        detailUrl: (id) => `detail:${id}`,
        list: (_page, _size, body) => body as { items: Array<{ sourceId: string; url: string }> },
        listItems: (page) => page.items,
        hasMore: () => true,
        detail: (id, _body, fetchedAt) => ({ ...article(id), fetchedAt }),
      },
    })).rejects.toThrow(/pagination|maxPages/i);
    await expect(access(artifactPath(root, runId, "raw", "jsonl", "demo"))).rejects.toThrow();
    expect(await readFile(artifactPath(root, runId, "errors"), "utf8")).toMatch(/pagination|maxPages/i);
  });

  it("writes structured error records with the run context", async () => {
    const { root, runId } = await newRun();
    await expect(fetchGame({
      runtimeRoot: root,
      runId,
      game: "demo",
      fetcher: async () => { throw new CrawlerHttpError("CONTENT_TYPE", "unsupported", { contentType: "application/octet-stream" }); },
      adapter: {
        allowedHosts: ["demo.example"],
        listUrl: () => "list:1",
        detailUrl: (id) => `detail:${id}`,
        list: (_page, _size, body) => body as { items: Array<{ sourceId: string; url: string }> },
        listItems: (page) => page.items,
        detail: (id, _body, fetchedAt) => ({ ...article(id), fetchedAt }),
      },
    })).rejects.toMatchObject({ code: "CONTENT_TYPE" });
    const record = JSON.parse((await readFile(artifactPath(root, runId, "errors"), "utf8")).trim());
    expect(record).toMatchObject({ runId, game: "demo", code: "CONTENT_TYPE", message: "unsupported", details: { contentType: "application/octet-stream" } });
  });

  it("writes an empty raw artifact when the first page has no items", async () => {
    const { root, runId } = await newRun();
    const result = await fetchGame({
      runtimeRoot: root,
      runId,
      game: "demo",
      fetcher: async (url) => ({ url, status: 200, contentType: "application/json", body: JSON.stringify({ items: [] }) }),
      adapter: {
        allowedHosts: ["demo.example"],
        listUrl: (page) => `list:${page}`,
        detailUrl: (id) => `detail:${id}`,
        list: (_page, _size, body) => body as { items: Array<{ sourceId: string; url: string }> },
        listItems: (page) => page.items,
        detail: (id, _body, fetchedAt) => ({ ...article(id), fetchedAt }),
      },
    });
    expect(result.count).toBe(0);
    expect(await readFile(result.rawPath, "utf8")).toBe("");
  });

  it("uses adapter pagination metadata instead of the requested page size", async () => {
    const { root, runId } = await newRun();
    type Page = { items: Array<{ sourceId: string; url: string }>; current: number; pageSize: number; total: number };
    const pages = new Map<string, Page>([
      ["list:1", { items: [{ sourceId: "1", url: "detail:1" }], current: 1, pageSize: 1, total: 2 }],
      ["list:2", { items: [{ sourceId: "2", url: "detail:2" }], current: 2, pageSize: 1, total: 2 }],
    ]);
    const result = await fetchGame({
      runtimeRoot: root,
      runId,
      game: "demo",
      pageSize: 20,
      fetcher: async (url) => {
        const value = url.startsWith("detail:") ? { id: url.slice("detail:".length) } : pages.get(url);
        return { url, status: 200, contentType: "application/json", body: JSON.stringify(value) };
      },
      adapter: {
        allowedHosts: ["demo.example"],
        listUrl: (page) => `list:${page}`,
        detailUrl: (id) => `detail:${id}`,
        list: (_page, _size, body) => body as Page,
        listItems: (page) => page.items,
        hasMore: (page) => page.current * page.pageSize < page.total,
        detail: (id, _body, fetchedAt) => ({ ...article(id), fetchedAt }),
      },
    });
    expect(result).toMatchObject({ count: 2, pages: 2 });
  });

  it("uses a since boundary to skip older listed notices", async () => {
    const { root, runId } = await newRun();
    const pages = new Map([["list:1", { items: [
      { sourceId: "old", url: "detail:old", publishedAt: "2026-07-31T23:59:00+08:00" },
      { sourceId: "new", url: "detail:new", publishedAt: "2026-08-01T00:01:00+08:00" },
    ] }], ["list:2", { items: [] }]]);
    const details = new Map([["detail:old", article("old")], ["detail:new", article("new")]]);
    const calls: string[] = [];
    const result = await fetchGame({
      runtimeRoot: root,
      runId,
      game: "demo",
      since: "2026-08-01",
      pageSize: 2,
      fetcher: async (url) => {
        calls.push(url);
        if (url.startsWith("detail:")) return { url, status: 200, contentType: "application/json", body: JSON.stringify(details.get(url)) };
        return { url, status: 200, contentType: "application/json", body: JSON.stringify(pages.get(url)) };
      },
      adapter: {
        allowedHosts: ["demo.example"],
        listUrl: (page) => `list:${page}`,
        detailUrl: (id) => `detail:${id}`,
        list: (_page, _size, body) => body as { items: Array<{ sourceId: string; url: string; publishedAt?: string }> },
        listItems: (page) => page.items,
        detail: (id, _body, fetchedAt) => ({ ...article(id), fetchedAt }),
      },
    });
    expect(result.count).toBe(1);
    expect(calls).toContain("list:1");
    expect(calls).toContain("detail:new");
    expect(calls).not.toContain("detail:old");
  });

  it("interprets offset-free publication timestamps as Beijing time", async () => {
    const { root, runId } = await newRun();
    const pages = new Map([["list:1", { items: [{ sourceId: "border", url: "detail:border", publishedAt: "2026-08-01 00:30:00" }] }], ["list:2", { items: [] }]]);
    const result = await fetchGame({
      runtimeRoot: root,
      runId,
      game: "demo",
      since: "2026-08-01T01:00:00+08:00",
      pageSize: 1,
      fetcher: async (url) => {
        if (url.startsWith("detail:")) return { url, status: 200, contentType: "application/json", body: JSON.stringify(article("border")) };
        return { url, status: 200, contentType: "application/json", body: JSON.stringify(pages.get(url)) };
      },
      adapter: {
        allowedHosts: ["demo.example"],
        listUrl: (page) => `list:${page}`,
        detailUrl: (id) => `detail:${id}`,
        list: (_page, _size, body) => body as { items: Array<{ sourceId: string; url: string; publishedAt?: string }> },
        listItems: (page) => page.items,
        detail: (id, _body, fetchedAt) => ({ ...article(id), fetchedAt }),
      },
    });
    expect(result.count).toBe(0);
  });

  it("rejects raw articles that are not already canonical content", async () => {
    const { root, runId } = await newRun();
    await expect(fetchGame({
      runtimeRoot: root,
      runId,
      game: "demo",
      fetcher: async (url) => ({
        url,
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(url.startsWith("detail:") ? article("1") : { items: [{ sourceId: "1", url: "detail:1" }] }),
      }),
      adapter: {
        allowedHosts: ["demo.example"],
        listUrl: () => "list:1",
        detailUrl: (id) => `detail:${id}`,
        list: (_page, _size, body) => body as { items: Array<{ sourceId: string; url: string }> },
        listItems: (page) => page.items,
        detail: (id, _body, fetchedAt) => ({ ...article(id), fetchedAt }),
        isCanonicalContent: () => false,
      },
    })).rejects.toThrow(/canonical content/i);
    await expect(access(artifactPath(root, runId, "raw", "jsonl", "demo"))).rejects.toThrow();
  });

  it("rejects an invalid RawArticle and leaves no final raw artifact", async () => {
    const { root, runId } = await newRun();
    const invalid = { ...article("1"), content: "tampered" };
    await expect(fetchGame({
      runtimeRoot: root,
      runId,
      game: "demo",
      fetcher: async (url) => ({ url, status: 200, contentType: "application/json", body: JSON.stringify({ items: [{ sourceId: "1", url: "detail:1" }] }) }),
      adapter: {
        allowedHosts: ["demo.example"],
        listUrl: () => "list:1",
        detailUrl: () => "detail:1",
        list: (_page, _size, body) => body as { items: Array<{ sourceId: string; url: string }> },
        listItems: (page) => page.items,
        detail: (_id, _body, _fetchedAt) => invalid,
      },
    })).rejects.toThrow(/RawArticle|schema|contentHash/i);
    await expect(access(artifactPath(root, runId, "raw", "jsonl", "demo"))).rejects.toThrow();
    expect((await readFile(artifactPath(root, runId, "errors"), "utf8"))).toMatch(/contentHash|RawArticle|schema/i);
  });
});
