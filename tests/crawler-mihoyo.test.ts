import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { mihoyoGames } from "../scripts/crawl/mihoyo-config.ts";
import {
  buildMihoyoDetailUrl,
  buildMihoyoDetailRequest,
  buildMihoyoListRequest,
  normalizeContent,
  parseMihoyoDetail,
  parseMihoyoList,
  type MihoyoListPage,
} from "../scripts/crawl/adapters/mihoyo.ts";

const fixture = async (path: string) => JSON.parse(await readFile(path, "utf8"));
const root = "tests/fixtures/crawler/mihoyo";

describe("Mihoyo game configuration", () => {
  it("declares all three CN games with versions enabled", () => {
    expect(Object.keys(mihoyoGames)).toEqual([
      "genshin-impact",
      "honkai-star-rail",
      "zenless-zone-zero",
    ]);
    for (const config of Object.values(mihoyoGames)) {
      expect(config.supportsVersions).toBe(true);
      expect(config.checkpoint.checkpointKind).toBe(null);
      expect(config.checkpoint.defaultLookbackDays).toBeGreaterThan(0);
      expect(config.officialHosts.length).toBeGreaterThan(0);
    }
  });
});

describe("Mihoyo fixture adapter", () => {
  it("parses a list fixture and derives the official URL when sUrl is empty", async () => {
    const body = await fixture(`${root}/genshin-impact/list-page-1.json`);
    const page: MihoyoListPage = parseMihoyoList("genshin-impact", body);
    expect(page.total).toBe(4637);
    expect(page.items[0].sourceId).toBe("165690");
    expect(page.items[0].url).toBe("https://ys.mihoyo.com/main/news/detail/165690");
    expect(page.items[0].contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(page.items[0].content).not.toMatch(/<\/?p|<img/);
  });

  it("parses detail fixtures for all three games", async () => {
    const cases = [
      ["genshin-impact", "detail-165690.json", "165690"],
      ["honkai-star-rail", "detail-165883.json", "165883"],
      ["zenless-zone-zero", "detail-165865.json", "165865"],
    ] as const;
    for (const [game, file, sourceId] of cases) {
      const body = await fixture(`${root}/${game}/${file}`);
      const article = parseMihoyoDetail(game, body, "2026-08-25T10:00:00+00:00");
      expect(article.sourceId).toBe(sourceId);
      expect(article.region).toBe("cn");
      expect(article.url).toBe(buildMihoyoDetailUrl(game, sourceId));
      expect(article.content).not.toMatch(/<[^>]+>/);
      expect(article.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });

  it("builds the measured list and detail requests", () => {
    const list = buildMihoyoListRequest("honkai-star-rail", 2, 50);
    expect(list.method).toBe("GET");
    expect(list.url).toContain("/content_v2_user/app/1963de8dc19e461c/getContentList");
    expect(list.parameters).toMatchObject({ iPage: "2", iPageSize: "50", iChanId: "257", sLangKey: "zh-cn", isPreview: "0" });

    const genshin = buildMihoyoListRequest("genshin-impact", 1, 1);
    expect(genshin.parameters.iAppId).toBe("43");
    const zzz = buildMihoyoListRequest("zenless-zone-zero", 1, 1);
    expect(zzz.parameters.iChanId).toBe("288");

    const detail = buildMihoyoDetailRequest("zenless-zone-zero", "165865");
    expect(detail.url).toContain("/content_v2_user/app/3e9196a4b9274bd7/getContent");
    expect(detail.parameters).toMatchObject({ iInfoId: "165865", iPageSize: "50", sLangKey: "zh-cn", isPreview: "0" });
  });

  it("preserves a legitimate empty list-body article and rejects malformed responses", async () => {
    const body = await fixture(`${root}/honkai-star-rail/list-page-1.json`);
    const page = parseMihoyoList("honkai-star-rail", body);
    expect(page.items[0].content).toBe("");
    expect(() => parseMihoyoList("honkai-star-rail", { retcode: 0, data: { list: "bad" } })).toThrow(/data\.list/);
    expect(() => parseMihoyoList("honkai-star-rail", { retcode: -1, message: "failed", data: { list: [] } })).toThrow(/retcode/);
  });

  it("does not treat dtStartTime as the publication time", async () => {
    const body = await fixture(`${root}/genshin-impact/list-page-1.json`);
    const item = { ...body.data.list[0] };
    delete item.dtCreateTime;
    const page = parseMihoyoList("genshin-impact", { ...body, data: { ...body.data, list: [item] } });
    expect(page.items[0].publishedAt).toBe(null);
  });

  it("normalizes readable text without changing meaningful order", () => {
    expect(normalizeContent("<p>第一段</p><p>第二段 &amp; 其他</p><img src=\"x\"><script>alert(1)</script>"))
      .toBe("第一段\n第二段 & 其他");
  });

  it("deduplicates the same source article by sourceId and contentHash", async () => {
    const body = await fixture(`${root}/genshin-impact/list-page-1.json`);
    const page = parseMihoyoList("genshin-impact", body);
    expect(page.items.filter((item) => item.sourceId === "165690")).toHaveLength(1);
    expect(page.items[0].sourceId).toBe("165690");
  });
});
