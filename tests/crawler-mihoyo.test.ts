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
      expect(config.region).toBe("cn");
      expect(config.language).toBe("zh-cn");
      expect(config.supportsVersions).toBe(true);
      expect(config.checkpoint.checkpointKind).toBe(null);
      expect(config.checkpoint.defaultLookbackDays).toBeGreaterThan(0);
      expect(config.officialHosts.length).toBeGreaterThan(0);
      expect(config.apiHost).toBe(config.officialHosts[0]);
      expect(config.articleHost).toBe(config.officialHosts[1]);
      expect(config.contentChannels.length).toBeGreaterThan(0);
    }
    expect(mihoyoGames).toMatchObject({
      "genshin-impact": {
        region: "cn",
        language: "zh-cn",
        apiHost: "act-api-takumi-static.mihoyo.com",
        articleHost: "ys.mihoyo.com",
        appId: "16471662a82d418a",
        listAppId: "43",
        channels: [719],
        contentChannels: [719, 720, 721, 723],
      },
      "honkai-star-rail": {
        region: "cn",
        language: "zh-cn",
        apiHost: "act-api-takumi-static.mihoyo.com",
        articleHost: "sr.mihoyo.com",
        appId: "1963de8dc19e461c",
        channels: [257],
        contentChannels: [257],
      },
    });
    expect(mihoyoGames["zenless-zone-zero"]).toMatchObject({
      region: "cn",
      language: "zh-cn",
      apiHost: "api-takumi-static.mihoyo.com",
      articleHost: "zzz.mihoyo.com",
      appId: "706fd13a87294881",
      channels: [278],
      contentChannels: [278],
    });
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
      ["zenless-zone-zero", "detail-165853.json", "165853"],
    ] as const;
    for (const [game, file, sourceId] of cases) {
      const body = await fixture(`${root}/${game}/${file}`);
      const article = parseMihoyoDetail(game, sourceId, body, "2026-08-25T10:00:00+00:00");
      expect(article.sourceId).toBe(sourceId);
      expect(article.region).toBe("cn");
      expect(article.url).toBe(buildMihoyoDetailUrl(game, sourceId));
      expect(article.content).not.toMatch(/<[^>]+>/);
      expect(article.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });

  it("rejects a detail response whose id differs from the requested id", async () => {
    const body = await fixture(`${root}/genshin-impact/detail-165690.json`);
    expect(() => parseMihoyoDetail("genshin-impact", "999999", body, "2026-08-25T10:00:00+00:00")).toThrow(/sourceId|iInfoId/);
  });

  it("builds the measured list and detail requests", () => {
    const list = buildMihoyoListRequest("honkai-star-rail", 2, 50);
    expect(list.method).toBe("GET");
    expect(list.url).toContain("/content_v2_user/app/1963de8dc19e461c/getContentList");
    expect(list.parameters).toMatchObject({ iPage: "2", iPageSize: "50", iChanId: "257", sLangKey: "zh-cn", isPreview: "0" });

    const genshin = buildMihoyoListRequest("genshin-impact", 1, 1);
    expect(genshin.parameters.iAppId).toBe("43");
    const zzz = buildMihoyoListRequest("zenless-zone-zero", 1, 1);
    expect(zzz.url).toContain("api-takumi-static.mihoyo.com/content_v2_user/app/706fd13a87294881/getContentList");
    expect(zzz.parameters.iChanId).toBe("278");

    const detail = buildMihoyoDetailRequest("zenless-zone-zero", "165853");
    expect(detail.url).toContain("api-takumi-static.mihoyo.com/content_v2_user/app/706fd13a87294881/getContent");
    expect(detail.parameters).toMatchObject({ iInfoId: "165853", iPageSize: "50", sLangKey: "zh-cn", isPreview: "0" });
  });

  it("rejects a Mihoyo response from a different configured channel", async () => {
    const listBody = await fixture(`${root}/honkai-star-rail/list-page-1.json`);
    expect(() => parseMihoyoList("zenless-zone-zero", listBody)).toThrow(/channel/i);
    const detailBody = await fixture(`${root}/honkai-star-rail/detail-165883.json`);
    expect(() => parseMihoyoDetail("zenless-zone-zero", "165883", detailBody, "2026-08-25T10:00:00+00:00"))
      .toThrow(/channel/i);
  });

  it("rejects the preserved foreign ZZZ fixture", async () => {
    const listBody = await fixture(`${root}/zenless-zone-zero/list-page-1-foreign.json`);
    expect(() => parseMihoyoList("zenless-zone-zero", listBody)).toThrow(/channel/i);
    const detailBody = await fixture(`${root}/zenless-zone-zero/detail-165865-foreign.json`);
    expect(() => parseMihoyoDetail("zenless-zone-zero", "165865", detailBody, "2026-08-25T10:00:00+00:00"))
      .toThrow(/channel/i);
  });

  it("preserves a legitimate empty list-body article and rejects malformed responses", async () => {
    const body = await fixture(`${root}/honkai-star-rail/list-page-1.json`);
    const page = parseMihoyoList("honkai-star-rail", body);
    expect(page.items[0].content).toBe("");
    expect(() => parseMihoyoList("honkai-star-rail", { retcode: 0, data: { list: "bad" } })).toThrow(/data\.list/);
    expect(() => parseMihoyoList("honkai-star-rail", { retcode: -1, message: "failed", data: { list: [] } })).toThrow(/retcode/);
  });

  it("rejects missing or malformed list totals instead of guessing pagination", async () => {
    const body = await fixture(`${root}/genshin-impact/list-page-1.json`);
    const variants = [
      { ...body.data, list: [] },
      { ...body.data, list: [], iTotal: "bad" },
      { ...body.data, list: [], iTotal: -1 },
      { ...body.data, list: [], iTotal: 1.5 },
    ];
    delete variants[0].iTotal;
    for (const data of variants) {
      expect(() => parseMihoyoList("genshin-impact", { ...body, data })).toThrow(/iTotal/);
    }
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
    expect(normalizeContent("<font color=\"red\">字体</font>")).toBe("字体");
    const escaped = normalizeContent("<p>literal &lt;span&gt;</p>");
    expect(escaped).toBe("literal <span>");
    expect(normalizeContent(escaped)).toBe(escaped);
  });

  it("deduplicates the same source article by sourceId and contentHash", async () => {
    const body = await fixture(`${root}/genshin-impact/list-page-1.json`);
    const duplicated = { ...body, data: { ...body.data, list: [body.data.list[0], body.data.list[0]] } };
    const page = parseMihoyoList("genshin-impact", duplicated);
    expect(page.items.filter((item) => item.sourceId === "165690")).toHaveLength(1);
    expect(page.items[0].sourceId).toBe("165690");
  });
});
