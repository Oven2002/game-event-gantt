import { describe, expect, it } from "vitest";
import { evaluateSource, isDiscoveryOnlySource } from "../scripts/crawl/common/source-policy.ts";
import { officialSourceAccounts } from "../scripts/crawl/source-accounts.ts";

describe("crawler source policy", () => {
  it("allows configured CN official hosts", () => {
    expect(evaluateSource("genshin-impact", "https://ys.mihoyo.com/main/news/detail/1")).toMatchObject({ allowed: true, role: "official" });
    expect(evaluateSource("arknights", "https://ak.hypergryph.com/news/4924")).toMatchObject({ allowed: true, role: "official" });
    expect(evaluateSource("arknights", "https://ak.hypergryph.com:8443/news/4924")).toMatchObject({ allowed: false, role: "rejected" });
  });

  it("rejects insecure, foreign-server, and third-party URLs", () => {
    for (const url of [
      "http://ys.mihoyo.com/main/news/detail/1",
      "https://genshin.hoyoverse.com/zh-tw/news/1",
      "https://forum.gamer.com.tw/C.php?bsn=36730&snA=1",
      "https://news.17173.com/content/1.shtml",
    ]) {
      expect(evaluateSource("genshin-impact", url)).toMatchObject({ allowed: false, role: "rejected" });
    }
  });

  it("treats Zhihu as discovery-only even when the URL is public", () => {
    expect(isDiscoveryOnlySource("https://www.zhihu.com/question/123")).toBe(true);
    expect(evaluateSource("genshin-impact", "https://www.zhihu.com/question/123")).toMatchObject({ allowed: false, role: "discovery" });
    expect(isDiscoveryOnlySource("https://evilzhihu.com/question/123")).toBe(false);
  });

  it("requires configured official account identity for platform URLs", () => {
    expect(officialSourceAccounts.some((account) => account.platform === "bilibili")).toBe(true);
    expect(evaluateSource("arknights-endfield", "https://www.bilibili.com/opus/123")).toMatchObject({ allowed: false, role: "rejected" });
    expect(evaluateSource("arknights-endfield", "https://www.bilibili.com/opus/123", { platform: "bilibili", authorId: "1265652806", authorProfileUrl: "https://space.bilibili.com/1265652806" })).toMatchObject({ allowed: true, role: "official" });
  });

  it("rejects a configured account when the response author platform differs", () => {
    expect(evaluateSource("arknights-endfield", "https://www.bilibili.com/opus/123", {
      platform: "weibo",
      authorId: "1265652806",
      authorProfileUrl: "https://space.bilibili.com/1265652806",
    })).toMatchObject({ allowed: false, role: "rejected" });
  });
});
