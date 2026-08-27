import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename as fsRename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseCliArgs, createRunId, runCrawlCli, createFetchAdapter } from "../scripts/crawl/cli.ts";
import { buildHypergryphListRequest } from "../scripts/crawl/adapters/hypergryph.ts";
import { buildMihoyoDetailRequest, buildMihoyoListRequest } from "../scripts/crawl/adapters/mihoyo.ts";
import { parseRun } from "../scripts/crawl/commands/parse.ts";
import { sha256Utf8 } from "../scripts/crawl/common/hash.ts";
import { artifactDirectory, artifactPath, runRoot } from "../scripts/crawl/common/run.ts";
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
        listUrl: buildMihoyoListRequest("genshin-impact", 1, 20).url,
        detailUrl: buildMihoyoDetailRequest("genshin-impact", "165690").url,
        listPath: "tests/fixtures/crawler/mihoyo/genshin-impact/list-page-1.json",
        detailPath: "tests/fixtures/crawler/mihoyo/genshin-impact/detail-165690.json",
        detailContentType: "application/json",
        detailBody: async (path: string) => await readFile(path, "utf8"),
      },
      {
        game: "zenless-zone-zero" as const,
        listUrl: buildMihoyoListRequest("zenless-zone-zero", 1, 20).url,
        detailUrl: buildMihoyoDetailRequest("zenless-zone-zero", "165865").url,
        listPath: "tests/fixtures/crawler/mihoyo/zenless-zone-zero/list-page-1.json",
        detailPath: "tests/fixtures/crawler/mihoyo/zenless-zone-zero/detail-165865.json",
        detailContentType: "application/json",
        detailBody: async (path: string) => await readFile(path, "utf8"),
      },
      {
        game: "arknights" as const,
        listUrl: buildHypergryphListRequest("arknights", 1, 20).url,
        detailUrl: "https://ak.hypergryph.com/news/4924",
        listPath: "tests/fixtures/crawler/hypergryph/arknights/list-page-1.json",
        detailPath: "tests/fixtures/crawler/hypergryph/arknights/detail-4924.json",
        detailContentType: "text/html",
        detailBody: async (path: string) => (JSON.parse(await readFile(path, "utf8")) as { body: string }).body,
      },
      {
        game: "arknights-endfield" as const,
        listUrl: buildHypergryphListRequest("arknights-endfield", 1, 20).url,
        detailUrl: "https://endfield.hypergryph.com/news/4776",
        listPath: "tests/fixtures/crawler/hypergryph/arknights-endfield/list-page-1.json",
        detailPath: "tests/fixtures/crawler/hypergryph/arknights-endfield/detail-4776.json",
        detailContentType: "text/html",
        detailBody: async (path: string) => (JSON.parse(await readFile(path, "utf8")) as { body: string }).body,
      },
    ];

    for (const item of cases) {
      const root = await mkdtemp(join(tmpdir(), "crawler-cli-fetch-"));
      const output: string[] = [];
      const listBody = await readFile(item.listPath, "utf8");
      const detailBody = await item.detailBody(item.detailPath);
      const secondListUrl = new URL(item.listUrl);
      const isMihoyo = item.game !== "arknights" && item.game !== "arknights-endfield";
      secondListUrl.searchParams.set(isMihoyo ? "iPage" : "page", "2");
      const listValue = JSON.parse(listBody) as { data: Record<string, unknown> };
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
        fetcher,
        print: (line: string) => output.push(line),
      })).resolves.toBe(0);
      expect(createFetchAdapter(item.game).allowedHosts.length).toBeGreaterThan(0);
      expect(output.join("\n")).toMatch(new RegExp(`run=20260801-000000.*rawPath=.*${item.game}\\.jsonl count=1 pages=2`));
      const state = JSON.parse(await readFile(join(root, "state.json"), "utf8"));
      expect(state.games[item.game].checkpoint).toBe(null);
      const sourceId = item.game === "genshin-impact" ? "165690"
        : item.game === "zenless-zone-zero" ? "165865"
          : item.game === "arknights" ? "4924" : "4776";
      expect(state.games[item.game].sourceHashes).toHaveProperty(sourceId);
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
