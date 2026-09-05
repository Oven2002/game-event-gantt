import { describe, expect, it } from "vitest";
import { parseCliArgs, defaultLookbackSince, createFetchAdapter, checkpointKinds } from "../scripts/crawl/cli.ts";

describe("new game CLI registration", () => {
  it("accepts reverse-1999 and light-and-night as fetch games", () => {
    expect(parseCliArgs(["fetch", "--game", "reverse-1999", "--full"])).toMatchObject({ command: "fetch", game: "reverse-1999" });
    expect(parseCliArgs(["fetch", "--game", "light-and-night", "--since", "2026-08-01"])).toMatchObject({ command: "fetch", game: "light-and-night" });
  });

  it("rejects the new games for parse-style commands without --run, unchanged", () => {
    expect(() => parseCliArgs(["parse"])).toThrow(/--run/);
  });

  it("derives lookback from the new game configs", () => {
    expect(defaultLookbackSince("reverse-1999", new Date("2026-09-01T00:00:00Z"))).toBe("2026-08-02");
    expect(defaultLookbackSince("light-and-night", new Date("2026-09-01T00:00:00Z"))).toBe("2026-08-02");
  });

  it("registers the new games in the state checkpoint registry", () => {
    expect(checkpointKinds["reverse-1999"]).toBeNull();
    expect(checkpointKinds["light-and-night"]).toBeNull();
  });
});

describe("new game adapter dispatch", () => {
  it("dispatches reverse-1999 to the bluepoch adapter contract", () => {
    const adapter = createFetchAdapter("reverse-1999");
    expect(adapter.allowedHosts).toEqual(["re.bluepoch.com"]);
    expect(adapter.allowedListContentTypes).toEqual(["application/json"]);
    expect(adapter.allowedDetailContentTypes).toEqual(["application/json"]);
  });

  it("dispatches light-and-night to the postroom adapter contract", () => {
    const adapter = createFetchAdapter("light-and-night");
    expect(adapter.allowedHosts).toContain("press-static-love.aurora.qq.com");
    expect(adapter.allowedListContentTypes).toEqual(["application/json"]);
    expect(adapter.allowedDetailContentTypes).toEqual(["application/json"]);
  });
});
