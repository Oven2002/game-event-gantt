import { describe, expect, it } from "vitest";
import { canonicalizeUrl, canonicalJson, hashCanonicalJson, sha256Utf8, sourceHashProjection, candidateHashProjection, oldValueHashProjection } from "../scripts/crawl/common/hash.ts";
import { appendJsonl, appendJsonlIfUnique, readJsonl, readJsonAtomic, writeJsonAtomic, writeJsonlAtomic } from "../scripts/crawl/common/files.ts";
import { CrawlerHttpError, fetchOfficial } from "../scripts/crawl/common/http.ts";
import { loadState, writeStateAtomic, type CrawlerState } from "../scripts/crawl/common/state.ts";
import type { Sha256 } from "../scripts/crawl/types.ts";

const hash = (letter: string): Sha256 => `sha256:${letter.repeat(64)}` as Sha256;

function response(body: string, init: ResponseInit = {}) {
  return new Response(body, { status: 200, headers: { "content-type": "application/json" }, ...init });
}

describe("crawler hash and canonical JSON", () => {
  it("sorts object keys recursively but preserves array order", () => {
    expect(canonicalJson({ z: 1, a: { d: 2, c: 3 }, list: [{ b: 2, a: 1 }, 1] }))
      .toBe('{"a":{"c":3,"d":2},"list":[{"a":1,"b":2},1],"z":1}');
  });

  it("produces stable SHA-256 values from UTF-8", () => {
    expect(sha256Utf8("穹")).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(hashCanonicalJson({ b: 2, a: 1 })).toBe("sha256:43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777");
  });

  it("uses the fixed source projection and excludes fetch-local fields", () => {
    const raw = {
      game: "demo",
      source: "official",
      region: "cn" as const,
      sourceId: "1",
      url: "https://example.com/1",
      title: "Notice",
      publishedAt: null,
      contentHash: hash("a"),
      fetchedAt: "first",
    };
    expect(sourceHashProjection(raw)).not.toHaveProperty("fetchedAt");
    const changed = { ...raw, fetchedAt: "second" };
    expect(sourceHashProjection(raw)).toEqual(sourceHashProjection(changed));
  });

  it("canonicalizes URL host, default port, and fragment before hashing", () => {
    expect(canonicalizeUrl("HTTPS://Example.com:443/notices/1#section")).toBe("https://example.com/notices/1");
    expect(sourceHashProjection({
      game: "demo",
      region: "cn",
      source: "official",
      sourceId: "1",
      url: "HTTPS://Example.com:443/notices/1#section",
      title: "Notice",
      publishedAt: null,
      contentHash: hash("a"),
    }).url).toBe("https://example.com/notices/1");
  });

  it("uses the candidate projection without approval fields", () => {
    const candidate = {
      kind: "event",
      game: "demo",
      region: "cn",
      candidateKey: "demo/1/event-1",
      sourceId: "1",
      semanticSlot: "event-1",
      name: "Event",
      type: "event",
      start: "2026-08-25T10:00:00+08:00",
      sources: ["https://example.com/1"],
      relatedCandidateKeys: [],
      review: "ready",
      reviewReasons: [],
      evidence: [{ field: "name", text: "Event" }],
      candidateHash: hash("a"),
      targetId: "should-not-be-hashed",
    };
    const projection = candidateHashProjection(candidate);
    expect(projection).not.toHaveProperty("candidateHash");
    expect(projection).not.toHaveProperty("targetId");
    expect(hashCanonicalJson(projection)).toMatch(/^sha256:/);
  });

  it("hashes a formal old YAML value independently of its object key order", () => {
    const value = { id: "event-1", name: "Event", sources: ["https://example.com/1"] };
    expect(oldValueHashProjection(value)).toEqual(oldValueHashProjection({ sources: value.sources, name: value.name, id: value.id }));
  });
});

describe("crawler files", () => {
  it("writes and reads JSONL without retaining the whole stream", async () => {
    const path = "/tmp/gameg-task2-jsonl-test/items.jsonl";
    await writeJsonAtomic(path, { first: true });
    await appendJsonl(path, { second: true });
    await expect(readJsonl(path)).resolves.toEqual([{ first: true }, { second: true }]);
  });

  it("does not append a duplicate sourceId and contentHash pair", async () => {
    const path = `/tmp/gameg-task2-jsonl-test/raw-${process.pid}-${Date.now()}.jsonl`;
    const article = { sourceId: "1", contentHash: hash("a"), title: "first" };
    await expect(appendJsonlIfUnique(path, article, (value) => `${value.sourceId}:${value.contentHash}`)).resolves.toBe(true);
    await expect(appendJsonlIfUnique(path, { ...article, title: "duplicate" }, (value) => `${value.sourceId}:${value.contentHash}`)).resolves.toBe(false);
    await expect(readJsonl(path)).resolves.toEqual([article]);
  });

  it("serializes concurrent duplicate checks for one JSONL path", async () => {
    const path = `/tmp/gameg-task2-jsonl-test/concurrent-${process.pid}-${Date.now()}.jsonl`;
    const article = { sourceId: "2", contentHash: hash("b") };
    const results = await Promise.all(Array.from({ length: 8 }, () => appendJsonlIfUnique(path, article, (value) => `${value.sourceId}:${value.contentHash}`)));
    expect(results.filter(Boolean)).toHaveLength(1);
    await expect(readJsonl(path)).resolves.toEqual([article]);
  });

  it("keeps the previous JSONL when an atomic replacement is rejected", async () => {
    const path = `/tmp/gameg-task2-jsonl-test/atomic-${process.pid}-${Date.now()}.jsonl`;
    await writeJsonlAtomic(path, [{ version: 1 }]);
    await expect(writeJsonlAtomic(path, [{ version: 2 }], { rename: async () => { throw new Error("rename failed"); } }))
      .rejects.toThrow("rename failed");
    await expect(readJsonl(path)).resolves.toEqual([{ version: 1 }]);
  });

  it("preserves the previous file when an atomic replacement is rejected", async () => {
    const path = "/tmp/gameg-task2-jsonl-test/unchanged.json";
    await writeJsonAtomic(path, { version: 1 });
    await expect(writeJsonAtomic(path, { version: 2 }, { rename: async () => { throw new Error("rename failed"); } }))
      .rejects.toThrow("rename failed");
    await expect(readJsonAtomic(path)).resolves.toEqual({ version: 1 });
  });
});

describe("safe official HTTP client", () => {
  it("rejects non-HTTPS and hosts outside the allowlist", async () => {
    await expect(fetchOfficial("http://example.com/a", { allowedHosts: ["example.com"], fetchImpl: async () => response("ok") }))
      .rejects.toMatchObject({ code: "UNSAFE_URL" });
    await expect(fetchOfficial("https://other.example/a", { allowedHosts: ["example.com"], fetchImpl: async () => response("ok") }))
      .rejects.toMatchObject({ code: "UNSAFE_URL" });
  });

  it("limits content type and response size", async () => {
    await expect(fetchOfficial("https://example.com/a", {
      allowedHosts: ["example.com"],
      allowedContentTypes: ["application/json"],
      fetchImpl: async () => response("<html>", { headers: { "content-type": "text/html" } }),
    })).rejects.toMatchObject({ code: "CONTENT_TYPE" });

    await expect(fetchOfficial("https://example.com/a", {
      allowedHosts: ["example.com"],
      maxBytes: 3,
      fetchImpl: async () => response("1234"),
    })).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });
  });

  it("returns structured HTTP failures and retries only retryable statuses", async () => {
    let attempts = 0;
    await expect(fetchOfficial("https://example.com/a", {
      allowedHosts: ["example.com"],
      retryDelaysMs: [0],
      fetchImpl: async () => {
        attempts += 1;
        return response("busy", { status: 503, statusText: "Busy" });
      },
    })).rejects.toBeInstanceOf(CrawlerHttpError);
    expect(attempts).toBe(2);
  });

  it("revalidates every manual redirect target", async () => {
    await expect(fetchOfficial("https://example.com/a", {
      allowedHosts: ["example.com"],
      fetchImpl: async () => response("", { status: 302, headers: { location: "https://other.example/b" } }),
    })).rejects.toMatchObject({ code: "UNSAFE_URL" });
  });

  it("rejects public IP literals and expanded private IPv6 forms", async () => {
    for (const host of ["203.0.113.10", "[0:0:0:0:0:0:0:1]", "[0:0:0:0:0:ffff:7f00:1]", "[::ffff:127.0.0.1]"]) {
      await expect(fetchOfficial(`https://${host}/a`, {
        allowedHosts: [host],
        minHostIntervalMs: 0,
        fetchImpl: async () => response("ok"),
      })).rejects.toMatchObject({ code: "UNSAFE_URL" });
    }
  });

  it("rejects unsupported content types without an explicit allowlist", async () => {
    await expect(fetchOfficial("https://example.com/a", {
      allowedHosts: ["example.com"],
      minHostIntervalMs: 0,
      fetchImpl: async () => response("binary", { headers: { "content-type": "application/octet-stream" } }),
    })).rejects.toMatchObject({ code: "CONTENT_TYPE" });
  });

  it("rejects an allowlisted hostname that resolves to no addresses", async () => {
    await expect(fetchOfficial("https://example.com/no-address", {
      allowedHosts: ["example.com"],
      lookup: async () => [],
      fetchImpl: async () => response("should not be called"),
    })).rejects.toMatchObject({ code: "UNSAFE_URL" });
  });

  it("passes the validated DNS address to the pinned transport", async () => {
    let capturedAddress = "";
    const result = await fetchOfficial("https://example.com/pinned", {
      allowedHosts: ["example.com"],
      lookup: async () => ["93.184.216.34"],
      fetchImpl: async () => response("unpinned"),
      pinnedFetchImpl: async (_url, _init, address) => {
        capturedAddress = address;
        return response("pinned");
      },
    });
    expect(result.body).toBe("pinned");
    expect(capturedAddress).toBe("93.184.216.34");
  });

  it("revalidates DNS before retrying an official request", async () => {
    let lookups = 0;
    let attempts = 0;
    await expect(fetchOfficial("https://example.com/a", {
      allowedHosts: ["example.com"],
      retryDelaysMs: [0, 0],
      minHostIntervalMs: 0,
      lookup: async () => {
        lookups += 1;
        return lookups < 3 ? ["93.184.216.34"] : ["127.0.0.1"];
      },
      fetchImpl: async () => {
        attempts += 1;
        return response("busy", { status: 503 });
      },
    })).rejects.toMatchObject({ code: "UNSAFE_URL" });
    expect(attempts).toBe(2);
    expect(lookups).toBeGreaterThanOrEqual(3);
  });

  it("returns a structured error for an invalid redirect location", async () => {
    await expect(fetchOfficial("https://example.com/a", {
      allowedHosts: ["example.com"],
      minHostIntervalMs: 0,
      fetchImpl: async () => response("", { status: 302, headers: { location: "http://[invalid" } }),
    })).rejects.toMatchObject({ code: "REDIRECT" });
  });

  it("limits redirect chains", async () => {
    await expect(fetchOfficial("https://example.com/a", {
      allowedHosts: ["example.com"],
      maxRedirects: 2,
      fetchImpl: async () => response("", { status: 302, headers: { location: "https://example.com/a" } }),
    })).rejects.toMatchObject({ code: "REDIRECT_LIMIT" });
  });

  it("treats maxRedirects as the exact number of followed redirects", async () => {
    await expect(fetchOfficial("https://example.com/a", {
      allowedHosts: ["example.com"],
      maxRedirects: 0,
      minHostIntervalMs: 0,
      fetchImpl: async () => response("", { status: 302, headers: { location: "https://example.com/a" } }),
    })).rejects.toMatchObject({ code: "REDIRECT_LIMIT" });
  });

  it("rejects private address variants and DNS resolution to private addresses", async () => {
    for (const host of ["172.16.0.1", "100.64.0.1", "198.18.0.1", "[fe80::1]", "[::ffff:127.0.0.1]", "[::ffff:7f00:1]"]) {
      await expect(fetchOfficial(`https://${host}/a`, { allowedHosts: [host], fetchImpl: async () => response("ok") }))
        .rejects.toMatchObject({ code: "UNSAFE_URL" });
    }
    await expect(fetchOfficial("https://example.com/a", {
      allowedHosts: ["example.com"],
      lookup: async () => ["::ffff:7f00:1"],
      fetchImpl: async () => response("ok"),
    })).rejects.toMatchObject({ code: "UNSAFE_URL" });
  });

  it("times out while the response body is stalled", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode("part")); },
    });
    await expect(fetchOfficial("https://example.com/a", {
      allowedHosts: ["example.com"],
      timeoutMs: 10,
      minHostIntervalMs: 0,
      fetchImpl: async () => new Response(body, { status: 200, headers: { "content-type": "text/plain" } }),
    })).rejects.toMatchObject({ code: "TIMEOUT" });
  });
});

describe("crawler state", () => {
  const schemas = {
    page: { kind: "page", schema: { safeParse: (value: unknown) => ({ success: typeof value === "number" && Number.isInteger(value), data: value }) } },
  };
  const games = { demo: "page", noCheckpoint: null };

  it("returns an in-memory empty state when the file does not exist", async () => {
    await expect(loadState("/tmp/gameg-task2-state/missing.json", schemas, games))
      .resolves.toEqual({ schemaVersion: 1, games: {} });
  });

  it("fails closed on an unknown game or invalid checkpoint", async () => {
    const path = "/tmp/gameg-task2-state/invalid.json";
    await writeJsonAtomic(path, { schemaVersion: 1, games: { unknown: { checkpoint: null, sourceHashes: {} } } });
    await expect(loadState(path, schemas, games)).rejects.toMatchObject({ code: "INVALID_STATE" });

    await writeJsonAtomic(path, { schemaVersion: 1, games: { demo: { checkpoint: { kind: "page", value: "bad" }, sourceHashes: {} } } });
    await expect(loadState(path, schemas, games)).rejects.toMatchObject({ code: "INVALID_STATE" });
  });

  it("writes a valid state atomically", async () => {
    const path = "/tmp/gameg-task2-state/valid.json";
    const state: CrawlerState = { schemaVersion: 1, games: { noCheckpoint: { checkpoint: null, sourceHashes: { id: hash("a") } } } };
    await writeStateAtomic(path, state, { checkpointSchemas: schemas, knownGames: games });
    await expect(loadState(path, schemas, games)).resolves.toEqual(state);
  });
});
