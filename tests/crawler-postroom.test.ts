import { describe, expect, it } from "vitest";
import {
  buildPostroomListRequest,
  buildPostroomPreviewRequest,
  buildPostroomContentRequest,
  parsePostroomList,
  parsePostroomPreview,
  parsePostroomContent,
  publishDateToBeijing,
  type PostroomListPage,
} from "../scripts/crawl/adapters/postroom.ts";

describe("postroom request contract", () => {
  it("builds the three measured static JSON endpoints without credentials", () => {
    const list = buildPostroomListRequest();
    expect(list.url).toBe("https://press-static-love.aurora.qq.com/6lvxlBd9id/latest.list.json");

    const preview = buildPostroomPreviewRequest("cb76fed6-349d-4922-abfe-4909143bcb3b");
    expect(preview.url).toBe("https://press-static-love.aurora.qq.com/cb76fed6-349d-4922-abfe-4909143bcb3b.preview.json");

    const content = buildPostroomContentRequest("cb76fed6-349d-4922-abfe-4909143bcb3b");
    expect(content.url).toBe("https://press-static-love.aurora.qq.com/cb76fed6-349d-4922-abfe-4909143bcb3b.content.json");
  });

  it("keeps every request on the configured transport host", () => {
    for (const url of [
      buildPostroomListRequest().url,
      buildPostroomPreviewRequest("cb76fed6-349d-4922-abfe-4909143bcb3b").url,
      buildPostroomContentRequest("cb76fed6-349d-4922-abfe-4909143bcb3b").url,
    ]) {
      expect(url).toMatch(/^https:\/\/press-static-love\.aurora\.qq\.com\//);
    }
  });

  it("rejects publish ids that are neither the numeric nor the uuid shape", () => {
    expect(() => buildPostroomPreviewRequest("../escape")).toThrow(/publishId/i);
    expect(() => buildPostroomPreviewRequest("NOT-A-UUID")).toThrow(/publishId/i);
  });

  it("accepts the two measured id shapes (numeric legacy and uuid)", () => {
    expect(buildPostroomPreviewRequest("18458857").url).toBe("https://press-static-love.aurora.qq.com/18458857.preview.json");
    expect(buildPostroomContentRequest("18458857").url).toBe("https://press-static-love.aurora.qq.com/18458857.content.json");
  });
});

describe("postroom publishDate conversion", () => {
  it("converts the measured GMT+0800 JS date string to a Beijing-minute timestamp", () => {
    expect(publishDateToBeijing("Wed Aug 26 2026 20:00:00 GMT+0800 (China Standard Time)"))
      .toBe("2026-08-26 20:00:00");
    expect(publishDateToBeijing("Tue Aug 11 2026 17:08:19 GMT+0800 (China Standard Time)"))
      .toBe("2026-08-11 17:08:19");
  });

  it("rejects offsets other than +0800 and malformed strings", () => {
    expect(() => publishDateToBeijing("Wed Aug 26 2026 20:00:00 GMT+0900")).toThrow(/GMT\+0800/i);
    expect(() => publishDateToBeijing("not-a-date")).toThrow(/publishDate/i);
    expect(() => publishDateToBeijing("")).toThrow(/publishDate/i);
  });
});

describe("postroom list parsing", () => {
  it("parses the measured list envelope of postPublishId entries", () => {
    const body = [
      { postPublishId: "cb76fed6-349d-4922-abfe-4909143bcb3b", tagIdList: ["117009", "117010"], locale: null, localeGroupId: null },
      { postPublishId: "49a16145-5604-4ce5-a693-e1491e656105", tagIdList: ["117009"], locale: null, localeGroupId: null },
      { postPublishId: "18458857", tagIdList: ["117009", "item117008"], locale: null, localeGroupId: null },
    ];
    const page: PostroomListPage = parsePostroomList(body);
    expect(page.ids).toEqual(["cb76fed6-349d-4922-abfe-4909143bcb3b", "49a16145-5604-4ce5-a693-e1491e656105", "18458857"]);
  });

  it("rejects non-array bodies and entries with missing or malformed ids", () => {
    expect(() => parsePostroomList({})).toThrow(/array/i);
    expect(() => parsePostroomList([{ postPublishId: "bad-uuid" }])).toThrow(/postPublishId/i);
    expect(() => parsePostroomList([{ tagIdList: [] }])).toThrow(/postPublishId/i);
  });
});

describe("postroom preview parsing", () => {
  const previewBody = {
    publishId: "cb76fed6-349d-4922-abfe-4909143bcb3b",
    name: "8月27日不停服更新说明",
    publishDate: "Wed Aug 26 2026 20:00:00 GMT+0800 (China Standard Time)",
    tags: ["公告"],
    authorName: "光与夜之恋官方",
    summary: "",
    media: [],
    hyperlink: null,
    isHyperlink: false,
    locale: null,
    localeGroupId: null,
  };

  it("requires the official author and returns normalized metadata", () => {
    const meta = parsePostroomPreview("cb76fed6-349d-4922-abfe-4909143bcb3b", previewBody);
    expect(meta).toMatchObject({
      publishId: "cb76fed6-349d-4922-abfe-4909143bcb3b",
      name: "8月27日不停服更新说明",
      publishedAt: "2026-08-26 20:00:00",
      authorName: "光与夜之恋官方",
      tags: ["公告"],
    });
  });

  it("rejects a preview whose publishId differs from the requested id", () => {
    expect(() => parsePostroomPreview("other-id", previewBody)).toThrow(/publishId|mismatch/i);
  });

  it("rejects a non-official author and a missing name", () => {
    expect(() => parsePostroomPreview("cb76fed6-349d-4922-abfe-4909143bcb3b", { ...previewBody, authorName: "游戏小菜哥" }))
      .toThrow(/author|official/i);
    expect(() => parsePostroomPreview("cb76fed6-349d-4922-abfe-4909143bcb3b", { ...previewBody, name: "" }))
      .toThrow(/name/i);
  });
});

describe("postroom content parsing", () => {
  it("normalizes the HTML content field into canonical text", () => {
    const body = { content: "<p><span>亲爱的设计师：</span></p><p>开放时间：8月27日 05:00 - 9月10日 04:59</p>" };
    const article = parsePostroomContent(
      "cb76fed6-349d-4922-abfe-4909143bcb3b",
      "8月27日不停服更新说明",
      "2026-08-26 20:00:00",
      body,
      "2026-09-04T12:00:00.000Z",
    );
    expect(article?.game).toBe("light-and-night");
    expect(article?.region).toBe("cn");
    expect(article?.sourceId).toBe("cb76fed6-349d-4922-abfe-4909143bcb3b");
    expect(article?.url).toBe("https://love.qq.com/m/web202106/newsdetail.html?newsid=cb76fed6-349d-4922-abfe-4909143bcb3b");
    expect(article?.title).toBe("8月27日不停服更新说明");
    expect(article?.publishedAt).toBe("2026-08-26 20:00:00");
    expect(article?.content).toBe("亲爱的设计师：\n开放时间：8月27日 05:00 - 9月10日 04:59");
    expect(article?.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("rejects missing content and canonicalizes literal escapes idempotently", () => {
    expect(() => parsePostroomContent(
      "cb76fed6-349d-4922-abfe-4909143bcb3b",
      "t",
      "2026-08-26 20:00:00",
      { content: 42 },
      "2026-09-04T12:00:00.000Z",
    )).toThrow(/content/i);
  });
});
