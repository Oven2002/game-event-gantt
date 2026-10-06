import { describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCrawlCli, checkpointKinds } from "../scripts/crawl/cli.ts";
import { createRun, artifactPath } from "../scripts/crawl/common/run.ts";
import { writeStateAtomic, builtinCheckpointSchemas, type CrawlerState } from "../scripts/crawl/common/state.ts";
import { buildMihoyoListRequest, buildMihoyoDetailRequest } from "../scripts/crawl/adapters/mihoyo.ts";
import { fetchGame } from "../scripts/crawl/commands/fetch.ts";
import { sha256Utf8 } from "../scripts/crawl/common/hash.ts";
import type { RawArticle, Sha256 } from "../scripts/crawl/types.ts";

const GAME = "genshin-impact" as const;
const CONTENT = "活动时间：2026年8月20日 04:00 至 2026年8月20日 11:00";
const listUrl = buildMihoyoListRequest(GAME, 1, 20).url;
const detailUrl = (sourceId: string) => buildMihoyoDetailRequest(GAME, sourceId).url;

const mihoyoItem = (sourceId: string, publishedAt: string) => ({
  iInfoId: sourceId,
  sTitle: "活动说明",
  sContent: CONTENT,
  sChanId: ["719"],
  dtCreateTime: publishedAt,
});

const mihoyoListBody = (items: ReturnType<typeof mihoyoItem>[]) =>
  JSON.stringify({ retcode: 0, message: "OK", data: { iTotal: items.length, list: items } });
const mihoyoDetailBody = (item: ReturnType<typeof mihoyoItem>) =>
  JSON.stringify({ retcode: 0, message: "OK", data: item });

async function seedState(root: string, checkpointValue: string): Promise<void> {
  const state: CrawlerState = {
    schemaVersion: 1,
    games: {
      [GAME]: { checkpoint: { kind: "last-success-date", value: checkpointValue }, sourceHashes: {} },
    },
  };
  await writeStateAtomic(join(root, "state.json"), state, {
    checkpointSchemas: builtinCheckpointSchemas,
    knownGames: checkpointKinds,
  });
}

interface RunFetchOptions {
  now?: () => Date;
  seedCheckpoint?: string;
  dropDetails?: string[];
}

async function runFetch(items: ReturnType<typeof mihoyoItem>[], args: string[] = [], options: RunFetchOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), "crawler-checkpoint-"));
  if (options.seedCheckpoint) await seedState(root, options.seedCheckpoint);
  const runId = "20261005-000000";
  const responses = new Map<string, { contentType: string; body: string }>([
    [listUrl, { contentType: "application/json", body: mihoyoListBody(items) }],
    ...items
      .filter((item) => !(options.dropDetails ?? []).includes(item.iInfoId))
      .map((item) => [detailUrl(item.iInfoId), { contentType: "application/json", body: mihoyoDetailBody(item) }] as const),
  ]);
  const output: string[] = [];
  const code = await runCrawlCli(["fetch", "--game", GAME, ...args], {
    runtimeRoot: root,
    now: options.now ?? (() => new Date("2026-10-05T00:00:00Z")),
    fetcher: async (url) => {
      const response = responses.get(url);
      if (!response) throw new Error(`unexpected fixture URL: ${url}`);
      return { url, status: 200, ...response };
    },
    print: (line) => output.push(line),
  });
  return { code, output: output.join("\n"), root, runId };
}

describe("last-success-date checkpoint", () => {
  it("seeds a last-success-date checkpoint after a successful fetch", async () => {
    const { code, output, root, runId } = await runFetch([mihoyoItem("165690", "2026-09-25 05:00:00")]);
    expect(code).toBe(0);
    const state = JSON.parse(await readFile(join(root, "state.json"), "utf8"));
    expect(state.games[GAME].checkpoint).toEqual({ kind: "last-success-date", value: "2026-10-05" });
    expect(output).toMatch(/checkpoint=2026-10-05/);
    const raw = await readFile(artifactPath(root, runId, "raw", "jsonl", GAME), "utf8");
    expect(raw).toContain('"sourceId":"165690"');
  });

  it("reads the checkpoint from state and scans from that date (inclusive)", async () => {
    const { code, root, runId } = await runFetch(
      [
        mihoyoItem("1", "2026-09-25 05:00:00"),
        mihoyoItem("2", "2026-09-24 05:00:00"),
        mihoyoItem("3", "2026-09-23 23:00:00"),
      ],
      [],
      { seedCheckpoint: "2026-09-24" },
    );
    expect(code).toBe(0);
    const raw = await readFile(artifactPath(root, runId, "raw", "jsonl", GAME), "utf8");
    expect(raw).toContain('"sourceId":"1"');
    expect(raw).toContain('"sourceId":"2"');
    expect(raw).not.toContain('"sourceId":"3"');
    const state = JSON.parse(await readFile(join(root, "state.json"), "utf8"));
    expect(state.games[GAME].checkpoint).toEqual({ kind: "last-success-date", value: "2026-10-05" });
  });

  it("keeps the 30-day default lookback when no checkpoint exists", async () => {
    // No seeded checkpoint: the default is a 30-day lookback from 2026-10-05,
    // i.e. 2026-09-05. The 09-25 article is inside the window, the 09-01 one is not.
    const { code, root, runId } = await runFetch([
      mihoyoItem("1", "2026-09-25 05:00:00"),
      mihoyoItem("2", "2026-09-01 05:00:00"),
    ]);
    expect(code).toBe(0);
    const raw = await readFile(artifactPath(root, runId, "raw", "jsonl", GAME), "utf8");
    expect(raw).toContain('"sourceId":"1"');
    expect(raw).not.toContain('"sourceId":"2"');
  });

  it("does not advance the checkpoint when fetch fails", async () => {
    const { code, root } = await runFetch(
      [mihoyoItem("1", "2026-09-25 05:00:00")],
      [],
      { seedCheckpoint: "2026-09-24", dropDetails: ["1"] },
    );
    expect(code).toBe(1);
    const state = JSON.parse(await readFile(join(root, "state.json"), "utf8"));
    expect(state.games[GAME].checkpoint).toEqual({ kind: "last-success-date", value: "2026-09-24" });
  });

  it("advances the checkpoint when --since is passed explicitly", async () => {
    const { code, root } = await runFetch(
      [mihoyoItem("1", "2026-09-25 05:00:00")],
      ["--since", "2026-09-01"],
      { seedCheckpoint: "2026-08-01" },
    );
    expect(code).toBe(0);
    const state = JSON.parse(await readFile(join(root, "state.json"), "utf8"));
    expect(state.games[GAME].checkpoint).toEqual({ kind: "last-success-date", value: "2026-10-05" });
  });

  it("advances the checkpoint after a successful --full fetch", async () => {
    const { code, root, runId } = await runFetch([mihoyoItem("1", "2020-03-03 05:00:00")], ["--full"]);
    expect(code).toBe(0);
    const raw = await readFile(artifactPath(root, runId, "raw", "jsonl", GAME), "utf8");
    expect(raw).toContain('"sourceId":"1"');
    const state = JSON.parse(await readFile(join(root, "state.json"), "utf8"));
    expect(state.games[GAME].checkpoint).toEqual({ kind: "last-success-date", value: "2026-10-05" });
  });

  it("never regresses the checkpoint to an older success date", async () => {
    const { code, root } = await runFetch(
      [mihoyoItem("1", "2026-09-25 05:00:00")],
      [],
      { seedCheckpoint: "2026-09-24", now: () => new Date("2026-09-01T00:00:00Z") },
    );
    expect(code).toBe(0);
    const state = JSON.parse(await readFile(join(root, "state.json"), "utf8"));
    expect(state.games[GAME].checkpoint).toEqual({ kind: "last-success-date", value: "2026-09-24" });
  });

  it("skips the remaining detail chain when the intermediate publish date falls outside the window", async () => {
    const root = await mkdtemp(join(tmpdir(), "crawler-checkpoint-"));
    const runId = "20261005-000004";
    await createRun(root, runId, "demo");
    const calls: string[] = [];
    const article = (id: string, publishedAt: string): RawArticle => ({
      game: "demo",
      region: "cn",
      source: "official",
      sourceId: id,
      url: `https://demo.example/detail/${id}`,
      title: "活动说明",
      publishedAt,
      content: CONTENT,
      contentHash: sha256Utf8(CONTENT) as Sha256,
      fetchedAt: "2026-10-05T00:00:00.000Z",
    });
    const previewBody = (id: string, publishedAt: string) => JSON.stringify({ id, name: "活动说明", publishedAt });
    const result = await fetchGame({
      runtimeRoot: root,
      runId,
      game: "demo",
      since: "2026-09-01",
      fetcher: async (url) => {
        calls.push(url);
        if (url.endsWith("list.json")) {
          return { url, status: 200, contentType: "application/json", body: JSON.stringify({ items: [{ sourceId: "old", url: "https://demo.example/old.preview.json" }, { sourceId: "new", url: "https://demo.example/new.preview.json" }] }) };
        }
        if (url.endsWith("old.preview.json")) return { url, status: 200, contentType: "application/json", body: previewBody("old", "2026-08-15 10:00:00") };
        if (url.endsWith("new.preview.json")) return { url, status: 200, contentType: "application/json", body: previewBody("new", "2026-09-15 10:00:00") };
        return { url, status: 200, contentType: "application/json", body: JSON.stringify({ content: CONTENT }) };
      },
      adapter: {
        allowedHosts: ["demo.example"],
        listUrl: () => "https://demo.example/list.json",
        detailUrl: (id) => `https://demo.example/${id}.preview.json`,
        list: (_page, _size, body) => body,
        listItems: (page) => (page as { items: Array<{ sourceId: string; url: string }> }).items.map((item) => ({ ...item, publishedAt: null })),
        nextDetailUrl: (sourceId, body) => ((body as { name?: string }).name ? `https://demo.example/${sourceId}.content.json` : undefined),
        detailPublishedAt: (_sourceId, body) => (body as { publishedAt?: string }).publishedAt ?? null,
        detail: (sourceId, _body, _fetchedAt) => article(sourceId, sourceId === "old" ? "2026-08-15 10:00:00" : "2026-09-15 10:00:00"),
      },
    });
    // The old item's preview reveals a publish date before the window: its
    // content request is never issued and the item is not written.
    expect(calls).toEqual([
      "https://demo.example/list.json",
      "https://demo.example/old.preview.json",
      "https://demo.example/new.preview.json",
      "https://demo.example/new.content.json",
    ]);
    expect(result.count).toBe(1);
  });
});
