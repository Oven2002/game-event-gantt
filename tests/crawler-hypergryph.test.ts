import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { hypergryphGames } from "../scripts/crawl/hypergryph-config.ts";
import {
  buildHypergryphListRequest,
  normalizeHypergryphContent,
  parseHypergryphDetail,
  parseHypergryphList,
} from "../scripts/crawl/adapters/hypergryph.ts";

const root = "tests/fixtures/crawler/hypergryph";
const fixture = async (path: string) => JSON.parse(await readFile(path, "utf8"));

describe("Hypergryph configuration", () => {
  it("keeps Arknights events-only and Endfield version-capable", () => {
    expect(hypergryphGames.arknights.supportsVersions).toBe(false);
    expect(hypergryphGames["arknights-endfield"].supportsVersions).toBe(true);
    expect(hypergryphGames.arknights.checkpoint.checkpointKind).toBe(null);
    expect(hypergryphGames["arknights-endfield"].checkpoint.checkpointKind).toBe(null);
  });
});

describe("Hypergryph fixture adapter", () => {
  it("builds the measured bulletin request and parses list metadata", async () => {
    const request = buildHypergryphListRequest("arknights", 2, 20);
    expect(request.url).toContain("code=arknights");
    expect(request.parameters).toMatchObject({ lang: "zh-cn", page: "2", pageSize: "20" });
    const body = await fixture(`${root}/arknights/list-page-1.json`);
    const page = parseHypergryphList("arknights", body);
    expect(page.total).toBe(1214);
    expect(page.items[0]).toMatchObject({ sourceId: "4924", title: "《明日方舟》制作组通讯#68期", tab: "2" });
    expect(page.items[0].url).toBe("https://ak.hypergryph.com/news/4924");

    const endfieldBody = await fixture(`${root}/arknights-endfield/list-page-1.json`);
    const endfieldPage = parseHypergryphList("arknights-endfield", endfieldBody);
    expect(endfieldPage.total).toBe(92);
    expect(endfieldPage.items[0]).toMatchObject({ sourceId: "4776", title: "「雪凇幽梦」版本研发通讯", tab: "news" });
    expect(endfieldPage.items[0].url).toBe("https://endfield.hypergryph.com/news/4776");
  });

  it("rejects a list response returned for a different page", async () => {
    const body = await fixture(`${root}/arknights/list-page-1.json`);
    expect(() => parseHypergryphList("arknights", body, 2)).toThrow(/current|page/i);
  });

  it("deduplicates repeated bulletin entries by source id", async () => {
    const body = await fixture(`${root}/arknights/list-page-1.json`);
    const duplicated = { ...body, data: { ...body.data, list: [body.data.list[0], body.data.list[0]] } };
    expect(parseHypergryphList("arknights", duplicated).items).toHaveLength(1);
  });
  it("parses both HTML detail fixtures into canonical RawArticle content", async () => {
    for (const [game, sourceId] of [["arknights", "4924"], ["arknights-endfield", "4776"]] as const) {
      const body = await fixture(`${root}/${game}/detail-${sourceId}.json`);
      const article = parseHypergryphDetail(game, sourceId, body, "2026-08-26T00:00:00+00:00");
      expect(article.game).toBe(game);
      expect(article.region).toBe("cn");
      expect(article.sourceId).toBe(sourceId);
      expect(article.url).toBe(`https://${game === "arknights" ? "ak" : "endfield"}.hypergryph.com/news/${sourceId}`);
      if (game === "arknights-endfield") expect(article.publishedAt).toBe("2026-08-22T18:00:00+08:00");
      else expect(article.publishedAt).toBe(null);
      expect(article.content.length).toBeGreaterThan(20);
      expect(article.content).not.toMatch(/<[^>]+>/);
      expect(article.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });

  it("uses a validated list displayTime when detail has no publication date", async () => {
    const body = await fixture(`${root}/arknights/detail-4924.json`);
    const article = parseHypergryphDetail("arknights", "4924", body, "2026-08-26T00:00:00+00:00", "2026-08-21T17:00:00+08:00");
    expect(article.publishedAt).toBe("2026-08-21T17:00:00+08:00");
  });

  it("preserves block order while stripping tags and scripts", () => {
    expect(normalizeHypergryphContent("<p>第一段</p><p><strong>第二段</strong></p><img src=\"x\"><script>x</script>"))
      .toBe("第一段\n第二段");
  });

  it("preserves escaped angle-bracket text and remains idempotent", () => {
    const content = normalizeHypergryphContent("<p>修复&lt;浮空信件&gt;异常</p>");
    expect(content).toBe("修复<浮空信件>异常");
    expect(normalizeHypergryphContent(content)).toBe(content);
  });

  it("rejects a detail envelope with a non-HTML content type", async () => {
    const envelope = await fixture(`${root}/arknights/detail-4924.json`);
    expect(() => parseHypergryphDetail("arknights", "4924", {
      ...envelope,
      contentType: "application/json",
    }, "2026-08-26T00:00:00+00:00")).toThrow(/content.?type/i);
  });

  it("rejects an unknown game or malformed list envelope", async () => {
    const body = await fixture(`${root}/arknights/list-page-1.json`);
    expect(() => parseHypergryphList("arknights", { code: 1, data: body.data })).toThrow(/code/);
    expect(() => parseHypergryphList("arknights", { code: 0, data: { list: "bad" } })).toThrow(/list/);
    expect(() => parseHypergryphList("arknights", { code: 0, data: { list: [], total: -1, current: 1, pageSize: 20 } })).toThrow(/total/);
    expect(() => parseHypergryphList("arknights", { code: 0, data: { list: [{ cid: "not-numeric", title: "x", tab: "2", displayTime: 1 }] } })).toThrow(/cid/);
  });

  it("rejects a detail whose embedded article id differs from the requested id", async () => {
    const body = await fixture(`${root}/arknights/detail-4924.json`);
    expect(() => parseHypergryphDetail("arknights", "9999", body, "2026-08-26T00:00:00+00:00")).toThrow(/sourceId|cid/);
  });
});
