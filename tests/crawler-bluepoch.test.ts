import { describe, expect, it } from "vitest";
import {
  buildBluepochListRequest,
  parseBluepochList,
  parseBluepochDetail,
  buildBluepochDetailUrl,
  normalizeBluepochContent,
  type BluepochListPage,
} from "../scripts/crawl/adapters/bluepoch.ts";

describe("bluepoch request contract", () => {
  it("builds the measured POST list request without credentials", () => {
    const request = buildBluepochListRequest(2, 50);
    expect(request.method).toBe("POST");
    expect(request.url).toBe("https://re.bluepoch.com/activity/official/websites/information/query");
    expect(request.body).toEqual({ informationType: "", current: 2, pageSize: 50 });
    expect(JSON.stringify(request.body)).not.toMatch(/cookie|token|sign|auth/i);
  });

  it("rejects invalid pagination", () => {
    expect(() => buildBluepochListRequest(0, 50)).toThrow(/pagination/i);
    expect(() => buildBluepochListRequest(1, 0)).toThrow(/pagination/i);
  });
});

describe("bluepoch list parsing", () => {
  it("parses the measured data.pageData envelope and derives official URLs", () => {
    const body = {
      code: 200,
      msg: "成功",
      data: {
        current: 1,
        pageSize: 50,
        total: 2,
        pageData: [
          {
            id: 98,
            title: "3.9「重燃！流金之海」版本更新维护公告",
            informationType: 2,
            onlineTime: "2026-08-12 18:01:09",
            content: "<p>维护时间：2026年8月13日 06:00 - 10:00</p>",
          },
          {
            id: 97,
            title: "制作组播报第27期",
            informationType: 4,
            onlineTime: "2026-07-10 20:00:00",
            content: "<p>发布会预告</p>",
          },
        ],
      },
    };
    const page: BluepochListPage = parseBluepochList(body);
    expect(page.total).toBe(2);
    expect(page.items).toHaveLength(2);
    expect(page.items[0]).toMatchObject({
      sourceId: "98",
      title: "3.9「重燃！流金之海」版本更新维护公告",
      url: "https://re.bluepoch.com/home/detail.html#newsId?98",
      publishedAt: "2026-08-12 18:01:09",
    });
    expect(page.items[0].content).not.toMatch(/<[^>]+>/);
    expect(page.items[0].contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("rejects code != 200, missing pageData, and invalid totals", () => {
    expect(() => parseBluepochList({ code: 500, msg: "error" })).toThrow(/code/);
    expect(() => parseBluepochList({ code: 200, data: {} })).toThrow(/pageData/);
    expect(() => parseBluepochList({ code: 200, data: { pageData: [], total: -1 } })).toThrow(/total/);
    expect(() => parseBluepochList({ code: 200, data: { pageData: [{ id: "x", title: "t", onlineTime: "2026-08-12 18:01:09", content: "c", informationType: 2 }] } })).toThrow(/id/);
  });

  it("rejects items whose informationType is outside the configured channels", () => {
    const body = {
      code: 200,
      data: { total: 1, pageData: [{ id: 99, title: "未知栏目", informationType: 9, onlineTime: "2026-08-12 18:01:09", content: "x" }] },
    };
    expect(() => parseBluepochList(body)).toThrow(/informationType|channel/i);
  });
});

describe("bluepoch detail parsing", () => {
  it("builds the official detail URL for the article host", () => {
    expect(buildBluepochDetailUrl("98")).toBe("https://re.bluepoch.com/home/detail.html#newsId?98");
  });

  it("returns a canonical RawArticle for a matching detail body", () => {
    const body = {
      code: 200,
      data: {
        id: 98,
        title: "3.9 维护公告",
        informationType: 2,
        onlineTime: "2026-08-12 18:01:09",
        content: "<p>维护时间：2026年8月13日 06:00 - 10:00</p>",
      },
    };
    const article = parseBluepochDetail("98", body, "2026-09-04T12:00:00.000Z");
    expect(article.game).toBe("reverse-1999");
    expect(article.region).toBe("cn");
    expect(article.sourceId).toBe("98");
    expect(article.url).toBe("https://re.bluepoch.com/home/detail.html#newsId?98");
    expect(article.publishedAt).toBe("2026-08-12 18:01:09");
    expect(article.content).not.toMatch(/<[^>]+>/);
    expect(article.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("rejects a detail body whose id differs from the requested id", () => {
    const body = { code: 200, data: { id: 97, title: "x", informationType: 2, onlineTime: "2026-08-12 18:01:09", content: "c" } };
    expect(() => parseBluepochDetail("98", body, "2026-09-04T12:00:00.000Z")).toThrow(/id|mismatch/i);
  });
});

describe("bluepoch content normalization", () => {
  it("strips tags and preserves block order idempotently", () => {
    expect(normalizeBluepochContent("<p>第一段</p><p><strong>第二段</strong></p><img src=\"x\"><script>x</script>"))
      .toBe("第一段\n第二段");
    const once = normalizeBluepochContent("<p>literal &lt;span&gt;</p>");
    expect(once).toBe("literal <span>");
    expect(normalizeBluepochContent(once)).toBe(once);
  });
});
