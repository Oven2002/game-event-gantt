import { describe, expect, it } from "vitest";
import { parseCliArgs, createRunId } from "../scripts/crawl/cli.ts";

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
