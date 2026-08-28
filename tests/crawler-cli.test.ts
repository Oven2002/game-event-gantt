import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename as fsRename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArticleCandidate } from "../scripts/crawl/parsers/article.ts";
import { parseCliArgs, createRunId, defaultLookbackSince, runCrawlCli, createFetchAdapter, advanceState } from "../scripts/crawl/cli.ts";
import { parseRun } from "../scripts/crawl/commands/parse.ts";
import { sha256Utf8 } from "../scripts/crawl/common/hash.ts";
import { artifactDirectory, artifactPath, createRun, runRoot } from "../scripts/crawl/common/run.ts";
import { beginStateTransaction, markStateTransactionPending, stateTransactionPath, recoverStateTransactions } from "../scripts/crawl/common/state.ts";
import type { RawArticle, Sha256 } from "../scripts/crawl/types.ts";

const makeRaw = (overrides: Partial<RawArticle> = {}): RawArticle => {
  const content = overrides.content ?? "活动时间：2026年8月20日 04:00 至 2026年8月20日 11:00";
  return {
    game: "genshin-impact",
    region: "cn",
    source: "mihoyo",
    sourceId: "123",
    url: "https://ys.mihoyo.com/main/news/detail/123",
    title: "活动说明",
    publishedAt: "2026-08-01T00:00:00+08:00",
    content,
    contentHash: sha256Utf8(content) as Sha256,
    fetchedAt: "2026-08-01T00:00:00+00:00",
    ...overrides,
  };
};

async function writeRaw(root: string, runId: string, game: string, articles: RawArticle[]): Promise<void> {
  const path = artifactPath(root, runId, "raw", "jsonl", game);
  await mkdir(artifactDirectory(root, runId, "raw"), { recursive: true });
  await writeFile(path, `${articles.map((article) => JSON.stringify(article)).join("\n")}\n`, "utf8");
}

describe("crawler CLI argument contract", () => {
  it("parses fetch with one game and since", () => {
    expect(parseCliArgs(["fetch", "--game", "honkai-star-rail", "--since", "2026-08-01"])).toEqual({
      command: "fetch", game: "honkai-star-rail", since: "2026-08-01", full: false,
    });
    expect(parseCliArgs(["fetch", "--game", "honkai-star-rail"])).toEqual({
      command: "fetch", game: "honkai-star-rail", full: false,
    });
  });

  it("derives the configured default lookback date in Beijing time", () => {
    expect(defaultLookbackSince("genshin-impact", new Date("2026-08-31T12:00:00Z"))).toBe("2026-08-01");
    expect(defaultLookbackSince("arknights", new Date("2026-03-01T00:30:00Z"))).toBe("2026-01-30");
  });

  it("parses parse with an explicit run and rejects missing run", () => {
    expect(parseCliArgs(["parse", "--run", "20260801-000000"])).toMatchObject({ command: "parse", run: "20260801-000000" });
    expect(() => parseCliArgs(["parse"])).toThrow(/--run/);
  });

  it("rejects mutually exclusive scan modes and unknown flags", () => {
    expect(() => parseCliArgs(["fetch", "--game", "arknights", "--since", "2026-08-01", "--full"])).toThrow(/mutually exclusive/);
    expect(() => parseCliArgs(["fetch", "--game", "arknights", "--wat"])).toThrow(/unknown/);
  });

  it("validates the fixed run-id format", () => {
    expect(createRunId(new Date("2026-08-01T12:34:56Z"))).toBe("20260801-123456");
    expect(() => parseCliArgs(["review"])).toThrow(/--run/);
  });
});

describe("crawler parse command", () => {
  it("turns raw JSONL into validated candidates and writes parse artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "crawler-parse-"));
    const runId = "20260801-000000";
    await mkdir(runRoot(root, runId), { recursive: true });
    await writeRaw(root, runId, "genshin-impact", [
      makeRaw(),
      makeRaw({ sourceId: "124", title: "公告摘要", content: "请关注后续公告" }),
    ]);

    const result = await parseRun({
      runtimeRoot: root,
      runId,
      eventTypesPath: resolve("data/event-types.yaml"),
    });

    expect(result).toMatchObject({ ready: 1, needsReview: 1, rejections: 0 });
    expect(result.results).toHaveLength(1);
    const candidates = JSON.parse(await readFile(result.results[0].candidatesPath, "utf8"));
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toMatchObject({ kind: "event", review: "ready", sourceId: "123" });
    expect(candidates[1]).toMatchObject({ kind: "unknown", review: "needs_review", sourceId: "124" });
    expect((await readFile(result.results[0].rejectionsPath, "utf8"))).toBe("");
  });

  it("rejects provider raw content that is not canonical before parsing candidates", async () => {
    const root = await mkdtemp(join(tmpdir(), "crawler-parse-"));
    const runId = "20260801-000008";
    await mkdir(runRoot(root, runId), { recursive: true });
    const content = "<p>活动时间：2026年8月20日 04:00 至 2026年8月20日 11:00</p>";
    await writeRaw(root, runId, "genshin-impact", [makeRaw({ content })]);

    const result = await parseRun({
      runtimeRoot: root,
      runId,
      eventTypesPath: resolve("data/event-types.yaml"),
    });
    expect(result).toMatchObject({ ready: 0, needsReview: 0, rejections: 1 });
    expect(JSON.parse(await readFile(result.results[0].candidatesPath, "utf8"))).toEqual([]);
    expect(await readFile(result.results[0].rejectionsPath, "utf8")).toMatch(/canonical content/i);
  });

  it("revalidates raw content hashes before advancing state", async () => {
    const root = await mkdtemp(join(tmpdir(), "crawler-state-"));
    const runId = "20260801-000009";
    await mkdir(runRoot(root, runId), { recursive: true });
    const tampered = makeRaw();
    tampered.content = "tampered after fetch";
    const rawPath = artifactPath(root, runId, "raw", "jsonl", "genshin-impact");
    await writeRaw(root, runId, "genshin-impact", [tampered]);

    await expect(advanceState(root, "genshin-impact", rawPath, { schemaVersion: 1, games: {} })).rejects.toThrow(/contentHash/i);
  });

  it("rolls back raw and transaction marker when state commit fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "crawler-state-"));
    const runId = "20260801-000010";
    await mkdir(runRoot(root, runId), { recursive: true });
    const rawPath = artifactPath(root, runId, "raw", "jsonl", "genshin-impact");
    await writeRaw(root, runId, "genshin-impact", [makeRaw()]);
    const transactionPath = stateTransactionPath(root, runId);
    await beginStateTransaction(root, runId, "genshin-impact", rawPath);

    await expect(advanceState(root, "genshin-impact", rawPath, { schemaVersion: 1, games: {} }, {
      runId,
      transactionPath,
      writeState: async () => { throw new Error("state write failed"); },
    })).rejects.toThrow("state write failed");
    await expect(readFile(rawPath, "utf8")).rejects.toThrow();
    await expect(readFile(transactionPath, "utf8")).rejects.toThrow();
  });

  it("rolls back an unfinished state transaction during recovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "crawler-state-"));
    const runId = "20260801-000011";
    await mkdir(runRoot(root, runId), { recursive: true });
    const rawPath = artifactPath(root, runId, "raw", "jsonl", "genshin-impact");
    await writeRaw(root, runId, "genshin-impact", [makeRaw()]);
    const transactionPath = stateTransactionPath(root, runId);
    await beginStateTransaction(root, runId, "genshin-impact", rawPath);

    await recoverStateTransactions(root, { schemaVersion: 1, games: {} });
    await expect(readFile(rawPath, "utf8")).rejects.toThrow();
    await expect(readFile(transactionPath, "utf8")).rejects.toThrow();
  });

  it("keeps raw when recovery sees that state already contains the transaction hashes", async () => {
    const root = await mkdtemp(join(tmpdir(), "crawler-state-"));
    const runId = "20260801-000012";
    await mkdir(runRoot(root, runId), { recursive: true });
    const article = makeRaw();
    const rawPath = artifactPath(root, runId, "raw", "jsonl", "genshin-impact");
    await writeRaw(root, runId, "genshin-impact", [article]);
    const transactionPath = stateTransactionPath(root, runId);
    await beginStateTransaction(root, runId, "genshin-impact", rawPath);
    await markStateTransactionPending(root, transactionPath, runId, "genshin-impact", rawPath, { [article.sourceId]: article.contentHash });

    await recoverStateTransactions(root, {
      schemaVersion: 1,
      games: { "genshin-impact": { checkpoint: null, sourceHashes: { [article.sourceId]: article.contentHash } } },
    });
    await expect(readFile(rawPath, "utf8")).resolves.toContain(article.sourceId);
    await expect(readFile(transactionPath, "utf8")).rejects.toThrow();
  });

  it("keeps events-only version notices in rejection JSONL", async () => {
    const root = await mkdtemp(join(tmpdir(), "crawler-parse-"));
    const runId = "20260801-000001";
    await mkdir(runRoot(root, runId), { recursive: true });
    await writeRaw(root, runId, "arknights", [makeRaw({
      game: "arknights",
      source: "hypergryph",
      sourceId: "4924",
      url: "https://ak.hypergryph.com/news/4924",
      title: "版本更新说明",
      content: "版本时间：2026年8月20日 04:00 至 2026年8月20日 11:00",
    })]);

    const result = await parseRun({
      runtimeRoot: root,
      runId,
      eventTypesPath: resolve("data/event-types.yaml"),
    });

    expect(result).toMatchObject({ ready: 0, needsReview: 0, rejections: 1 });
    expect(JSON.parse(await readFile(result.results[0].candidatesPath, "utf8"))).toEqual([]);
    expect(JSON.parse((await readFile(result.results[0].rejectionsPath, "utf8")).trim())).toMatchObject({
      reasonCode: "supports_versions_disabled",
      rawRef: { runId, game: "arknights", sourceId: "4924" },
    });
  });

  it("refuses to overwrite an existing parse artifact", async () => {
    const root = await mkdtemp(join(tmpdir(), "crawler-parse-"));
    const runId = "20260801-000002";
    await mkdir(runRoot(root, runId), { recursive: true });
    await writeRaw(root, runId, "genshin-impact", [makeRaw()]);
    const candidatesPath = artifactPath(root, runId, "candidates", "json", "genshin-impact");
    await mkdir(join(root, "candidates", runId), { recursive: true });
    await writeFile(candidatesPath, "sentinel\n", "utf8");

    await expect(parseRun({
      runtimeRoot: root,
      runId,
      eventTypesPath: resolve("data/event-types.yaml"),
    })).rejects.toThrow(/artifacts already exist/);
    expect(await readFile(candidatesPath, "utf8")).toBe("sentinel\n");
  });

  it("removes all parse outputs when an atomic output commit fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "crawler-parse-"));
    const runId = "20260801-000004";
    await mkdir(runRoot(root, runId), { recursive: true });
    await writeRaw(root, runId, "genshin-impact", [makeRaw()]);
    const candidatesPath = artifactPath(root, runId, "candidates", "json", "genshin-impact");
    const rejectionsPath = artifactPath(root, runId, "rejections");
    let renameCalls = 0;

    await expect(parseRun({
      runtimeRoot: root,
      runId,
      eventTypesPath: resolve("data/event-types.yaml"),
      rename: async (from: string, to: string) => {
        renameCalls += 1;
        if (renameCalls === 2) throw new Error("rename failed");
        await fsRename(from, to);
      },
    })).rejects.toThrow("rename failed");
    await expect(readFile(candidatesPath, "utf8")).rejects.toThrow();
    await expect(readFile(rejectionsPath, "utf8")).rejects.toThrow();
  });

  it("refuses any pre-existing candidate file in the run directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "crawler-parse-"));
    const runId = "20260801-000005";
    await mkdir(runRoot(root, runId), { recursive: true });
    await writeRaw(root, runId, "genshin-impact", [makeRaw()]);
    const candidatesDirectory = artifactDirectory(root, runId, "candidates");
    await mkdir(candidatesDirectory, { recursive: true });
    await writeFile(join(candidatesDirectory, "stale.json"), "stale\n", "utf8");

    await expect(parseRun({
      runtimeRoot: root,
      runId,
      eventTypesPath: resolve("data/event-types.yaml"),
    })).rejects.toThrow(/artifacts already exist/);
    expect(await readFile(join(candidatesDirectory, "stale.json"), "utf8")).toBe("stale\n");
  });

  it("fails closed when raw articles produce duplicate candidate keys", async () => {
    const root = await mkdtemp(join(tmpdir(), "crawler-parse-"));
    const runId = "20260801-000006";
    await mkdir(runRoot(root, runId), { recursive: true });
    const firstContent = "活动时间：2026年8月20日 04:00 至 2026年8月20日 11:00";
    const secondContent = "活动时间：2026年8月21日 04:00 至 2026年8月21日 11:00";
    await writeRaw(root, runId, "genshin-impact", [
      makeRaw({ content: firstContent, contentHash: sha256Utf8(firstContent) as Sha256 }),
      makeRaw({ content: secondContent, contentHash: sha256Utf8(secondContent) as Sha256 }),
    ]);

    await expect(parseRun({
      runtimeRoot: root,
      runId,
      eventTypesPath: resolve("data/event-types.yaml"),
    })).rejects.toThrow(/duplicate candidateKey/i);
    await expect(readFile(artifactPath(root, runId, "candidates", "json", "genshin-impact"), "utf8")).rejects.toThrow();
    await expect(readFile(artifactPath(root, runId, "rejections"), "utf8")).rejects.toThrow();
  });

  it("routes review through the executable CLI and writes report/template", async () => {
    const root = await mkdtemp(join(tmpdir(), "crawler-cli-review-"));
    const runId = "20260827-000020";
    await createRun(root, runId);
    const article = makeRaw({ sourceId: "cli-new", url: "https://ys.mihoyo.com/main/news/detail/cli-new", title: "CLI 新活动" });
    await writeRaw(root, runId, article.game, [article]);
    await mkdir(artifactDirectory(root, runId, "candidates"), { recursive: true });
    await writeFile(artifactPath(root, runId, "candidates", "json", article.game), `${JSON.stringify([parseArticleCandidate(article, runId, "primary")])}\n`, "utf8");
    await mkdir(artifactDirectory(root, runId, "rejections"), { recursive: true });
    await writeFile(artifactPath(root, runId, "rejections"), "", "utf8");
    const output: string[] = [];
    await expect(runCrawlCli(["review", "--run", runId], { runtimeRoot: root, print: (line: string) => output.push(line) })).resolves.toBe(0);
    await expect(readFile(artifactPath(root, runId, "reports", "md"), "utf8")).resolves.toContain("Review diff");
    await expect(readFile(artifactPath(root, runId, "selections", "json"), "utf8")).resolves.toContain(runId);
    expect(output.join("\n")).toMatch(/reportPath=.*templatePath=/);
  });

  it("routes approve through the executable CLI and writes a manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "crawler-cli-approve-"));
    const runId = "20260827-000021";
    await createRun(root, runId);
    const article = makeRaw({ sourceId: "cli-approve", url: "https://ys.mihoyo.com/main/news/detail/cli-approve", title: "CLI 批准活动" });
    await writeRaw(root, runId, article.game, [article]);
    await mkdir(artifactDirectory(root, runId, "candidates"), { recursive: true });
    await writeFile(artifactPath(root, runId, "candidates", "json", article.game), `${JSON.stringify([parseArticleCandidate(article, runId, "primary")])}\n`, "utf8");
    await mkdir(artifactDirectory(root, runId, "rejections"), { recursive: true });
    await writeFile(artifactPath(root, runId, "rejections"), "", "utf8");
    const candidate = parseArticleCandidate(article, runId, "primary");
    const selectionPath = join(root, "approved-selection.json");
    await writeFile(selectionPath, `${JSON.stringify({ schemaVersion: 1, runId, selections: [{ candidateKey: candidate.candidateKey, candidateHash: candidate.candidateHash, sourceHash: candidate.sourceHash, kind: candidate.kind, operation: "add", expectedOldValueHash: null, targetId: "task9-cli-approved-event-20260827", targetFile: "data/genshin-impact/cn-2026.yaml" }] })}\n`, "utf8");
    const output: string[] = [];
    await expect(runCrawlCli(["approve", "--run", runId, "--selection", selectionPath], { runtimeRoot: root, print: (line: string) => output.push(line) })).resolves.toBe(0);
    await expect(readFile(artifactPath(root, runId, "approved", "json"), "utf8")).resolves.toContain(runId);
    expect(output.join("\n")).toMatch(/manifestPath=/);
  });

  it("routes parse through the executable CLI and reports its output", async () => {
    const root = await mkdtemp(join(tmpdir(), "crawler-cli-"));
    const runId = "20260801-000003";
    await mkdir(runRoot(root, runId), { recursive: true });
    await writeRaw(root, runId, "genshin-impact", [makeRaw()]);
    const output: string[] = [];

    await expect(runCrawlCli(["parse", "--run", runId], {
      runtimeRoot: root,
      eventTypesPath: resolve("data/event-types.yaml"),
      print: (line: string) => output.push(line),
    })).resolves.toBe(0);
    expect(output.join("\n")).toMatch(/ready=1/);
    expect(output.join("\n")).toMatch(/candidatesPath=.*genshin-impact\.json/);
  });

  it("uses the measured Mihoyo and Hypergryph adapters for fixture fetches", async () => {
    const cases = [
      {
        game: "genshin-impact" as const,
        pageSize: 1,
        listUrl: "https://act-api-takumi-static.mihoyo.com/content_v2_user/app/16471662a82d418a/getContentList?iPage=1&iPageSize=1&sLangKey=zh-cn&isPreview=0&iChanId=719&iAppId=43",
        detailUrl: "https://act-api-takumi-static.mihoyo.com/content_v2_user/app/16471662a82d418a/getContent?iInfoId=165690&iPageSize=50&sLangKey=zh-cn&isPreview=0",
        detailSourceId: "165690",
        listPath: "tests/fixtures/crawler/mihoyo/genshin-impact/list-page-1.json",
        detailPath: "tests/fixtures/crawler/mihoyo/genshin-impact/detail-165690.json",
        detailContentType: "application/json",
        detailBody: async (path: string) => await readFile(path, "utf8"),
      },
      {
        game: "honkai-star-rail" as const,
        pageSize: 50,
        listUrl: "https://act-api-takumi-static.mihoyo.com/content_v2_user/app/1963de8dc19e461c/getContentList?iPage=1&iPageSize=50&sLangKey=zh-cn&isPreview=0&iChanId=257",
        detailUrl: "https://act-api-takumi-static.mihoyo.com/content_v2_user/app/1963de8dc19e461c/getContent?iInfoId=165883&iPageSize=50&sLangKey=zh-cn&isPreview=0",
        detailSourceId: "165883",
        listPath: "tests/fixtures/crawler/mihoyo/honkai-star-rail/list-page-1.json",
        detailPath: "tests/fixtures/crawler/mihoyo/honkai-star-rail/detail-165883.json",
        detailContentType: "application/json",
        detailBody: async (path: string) => await readFile(path, "utf8"),
      },
      {
        game: "zenless-zone-zero" as const,
        pageSize: 1,
        listUrl: "https://sg-public-api-static.hoyoverse.com/content_v2_user/app/3e9196a4b9274bd7/getContentList?iPage=1&iPageSize=1&sLangKey=zh-cn&isPreview=0&iChanId=288",
        detailUrl: "https://sg-public-api-static.hoyoverse.com/content_v2_user/app/3e9196a4b9274bd7/getContent?iInfoId=165865&iPageSize=50&sLangKey=zh-cn&isPreview=0",
        detailSourceId: "165865",
        listPath: "tests/fixtures/crawler/mihoyo/zenless-zone-zero/list-page-1.json",
        detailPath: "tests/fixtures/crawler/mihoyo/zenless-zone-zero/detail-165865.json",
        detailContentType: "application/json",
        detailBody: async (path: string) => await readFile(path, "utf8"),
      },
      {
        game: "arknights" as const,
        pageSize: 1,
        listUrl: "https://web-news.hypergryph.com/api/bulletin?lang=zh-cn&code=arknights&page=1&pageSize=1",
        detailUrl: "https://ak.hypergryph.com/news/4924",
        detailSourceId: "4924",
        listPath: "tests/fixtures/crawler/hypergryph/arknights/list-page-1.json",
        detailPath: "tests/fixtures/crawler/hypergryph/arknights/detail-4924.json",
        detailContentType: "text/html",
        detailBody: async (path: string) => (JSON.parse(await readFile(path, "utf8")) as { body: string }).body,
      },
      {
        game: "arknights-endfield" as const,
        pageSize: 1,
        listUrl: "https://web-news.hypergryph.com/api/bulletin?lang=zh-cn&code=endfield_web&page=1&pageSize=1",
        detailUrl: "https://endfield.hypergryph.com/news/4776",
        detailSourceId: "4776",
        listPath: "tests/fixtures/crawler/hypergryph/arknights-endfield/list-page-1.json",
        detailPath: "tests/fixtures/crawler/hypergryph/arknights-endfield/detail-4776.json",
        detailContentType: "text/html",
        detailBody: async (path: string) => (JSON.parse(await readFile(path, "utf8")) as { body: string }).body,
      },
    ];

    for (const item of cases) {
      const root = await mkdtemp(join(tmpdir(), "crawler-cli-fetch-"));
      const output: string[] = [];
      const detailBody = await item.detailBody(item.detailPath);
      const secondListUrl = new URL(item.listUrl);
      const isMihoyo = item.game !== "arknights" && item.game !== "arknights-endfield";
      secondListUrl.searchParams.set(isMihoyo ? "iPage" : "page", "2");
      const fixtureListValue = JSON.parse(await readFile(item.listPath, "utf8")) as { data: Record<string, unknown> };
      const fixtureItems = Array.isArray(fixtureListValue.data.list) ? fixtureListValue.data.list as Array<Record<string, unknown>> : [];
      const listValue = {
        ...fixtureListValue,
        data: {
          ...fixtureListValue.data,
          list: item.game === "honkai-star-rail"
            ? fixtureItems.filter((entry) => String(entry.iInfoId) === item.detailSourceId)
            : fixtureItems,
        },
      };
      const listBody = JSON.stringify(listValue);
      const secondListBody = {
        ...listValue,
        data: {
          ...listValue.data,
          list: [],
          ...(isMihoyo ? {} : { current: 2 }),
        },
      };
      const responses = new Map([
        [item.listUrl, { contentType: "application/json", body: listBody }],
        [secondListUrl.toString(), { contentType: "application/json", body: JSON.stringify(secondListBody) }],
        [item.detailUrl, { contentType: item.detailContentType, body: detailBody }],
      ]);
      const fetcher = async (url: string) => {
        const response = responses.get(url);
        if (!response) throw new Error(`unexpected fixture URL: ${url}`);
        return { url, status: 200, ...response };
      };

      await expect(runCrawlCli(["fetch", "--game", item.game, "--full"], {
        runtimeRoot: root,
        now: () => new Date("2026-08-01T00:00:00Z"),
        pageSize: item.pageSize,
        fetcher,
        print: (line: string) => output.push(line),
      })).resolves.toBe(0);
      const adapter = createFetchAdapter(item.game);
      expect(adapter.allowedHosts.length).toBeGreaterThan(0);
      expect(adapter.allowedListContentTypes).toEqual(["application/json"]);
      expect(adapter.allowedDetailContentTypes).toEqual(item.game === "arknights" || item.game === "arknights-endfield" ? ["text/html"] : ["application/json"]);
      expect(output.join("\n")).toMatch(new RegExp(`run=20260801-000000.*rawPath=.*${item.game}\\.jsonl count=1 pages=2`));
      const state = JSON.parse(await readFile(join(root, "state.json"), "utf8"));
      expect(state.games[item.game].checkpoint).toBe(null);
      const sourceId = item.game === "genshin-impact" ? "165690"
        : item.game === "honkai-star-rail" ? "165883"
          : item.game === "zenless-zone-zero" ? "165865"
            : item.game === "arknights" ? "4924" : "4776";
      expect(state.games[item.game].sourceHashes).toHaveProperty(sourceId);
      if (item.game === "arknights") {
        const raw = JSON.parse((await readFile(artifactPath(root, "20260801-000000", "raw", "jsonl", item.game), "utf8")).trim()) as { publishedAt: string | null };
        expect(raw.publishedAt).toBe("2026-08-21T17:00:00+08:00");
      }
    }
  });

  it("loads the direct Node strip-only entrypoint without unsupported syntax", async () => {
    const result = await new Promise<{ code: number; stderr: string }>((resolveResult) => {
      execFile("node", ["--experimental-strip-types", "scripts/crawl/cli.ts"], { cwd: resolve(".") }, (error, _stdout, stderr) => {
        resolveResult({ code: typeof error?.code === "number" ? error.code : 0, stderr });
      });
    });
    expect(result.code).toBe(1);
    expect(result.stderr).not.toMatch(/ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX/);
    expect(result.stderr).toMatch(/unknown command/);
  });
});
