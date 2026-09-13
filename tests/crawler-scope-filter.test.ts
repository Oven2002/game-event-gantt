import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyArticleScope } from "../scripts/crawl/common/article-scope.ts";
import { parseRun } from "../scripts/crawl/commands/parse.ts";
import { createRun, artifactPath } from "../scripts/crawl/common/run.ts";
import { sha256Utf8 } from "../scripts/crawl/common/hash.ts";
import type { RawArticle, Sha256 } from "../scripts/crawl/types.ts";

function raw(title: string, content = "正文") : RawArticle {
  return {
    game: "genshin-impact",
    region: "cn",
    source: "mihoyo",
    sourceId: "999001",
    url: "https://ys.mihoyo.com/main/news/detail/999001",
    title,
    publishedAt: "2026-09-01T12:00:00+08:00",
    content,
    contentHash: sha256Utf8(content) as Sha256,
    fetchedAt: "2026-09-13T00:00:00+00:00",
  };
}

describe("deterministic article scope filter", () => {
  it.each([
    ["代理人档案丨赛维里安", "character_profile"],
    ["「薇斯纳」轶事", "character_profile"],
    ["「菲林斯」·侧记", "character_profile"],
    ["「伊涅芙」·近闻", "character_profile"],
    ["克拉蕾EP《血火相连》现已上架音乐平台", "music"],
    ["2026年9月月历壁纸", "wallpaper"],
    ["新品情报丨服饰等多款周边上新", "merchandise"],
    ["《明日方舟》制作组通讯#68期", "production_report"],
  ] as const)("skips an unambiguous %s article", (title, code) => {
    expect(classifyArticleScope(title)?.code).toBe(code);
  });

  it("does not skip a generic in-game collaboration activity", () => {
    expect(classifyArticleScope("原神 × 某品牌联名活动正式开启")).toBeUndefined();
    expect(classifyArticleScope("「月行水上」创作征集活动开启", "活动奖励包含实物周边。")).toBeUndefined();
  });

  it("uses only bounded content headings when the list title is generic", () => {
    expect(classifyArticleScope(
      "《明日方舟：终末地》官方网站",
      "公告2026.09.02 09:00\n「雪凇幽梦」版本更新说明\n本次更新包含游戏周边抽奖。",
    )).toBeUndefined();
    expect(classifyArticleScope(
      "《明日方舟：终末地》官方网站",
      "新闻2026.08.22 18:00\n「雪凇幽梦」版本研发通讯\n这里是项目组。",
    )?.code).toBe("production_report");
  });

  it("writes deterministic skips as auditable out-of-scope rejections", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "crawler-scope-filter-"));
    const runId = "20260913-000001";
    await createRun(runtimeRoot, runId, "genshin-impact");
    await mkdir(join(runtimeRoot, "raw", runId), { recursive: true });
    await writeFile(
      artifactPath(runtimeRoot, runId, "raw", "jsonl", "genshin-impact"),
      `${JSON.stringify(raw("阿贝多生日快乐"))}\n`,
      "utf8",
    );

    const result = await parseRun({ runtimeRoot, runId, eventTypesPath: "data/event-types.yaml" });
    expect(result).toMatchObject({ ready: 0, needsReview: 0, rejections: 1 });
    const rejection = JSON.parse((await readFile(artifactPath(runtimeRoot, runId, "rejections"), "utf8")).trim());
    expect(rejection).toMatchObject({
      candidateKey: "genshin-impact/999001/primary",
      reasonCode: "article_out_of_scope",
      detail: "skip: 角色档案/生日/角色媒体",
    });
  });
});
