import { describe, expect, it } from "vitest";
import { bluepochGames } from "../scripts/crawl/bluepoch-config.ts";
import { postroomGames } from "../scripts/crawl/postroom-config.ts";

describe("bluepoch game config (reverse-1999)", () => {
  it("exposes the CN-only transport and article hosts", () => {
    const config = bluepochGames["reverse-1999"];
    expect(config.game).toBe("reverse-1999");
    expect(config.region).toBe("cn");
    expect(config.language).toBe("zh-cn");
    expect(config.transport.host).toBe("re.bluepoch.com");
    expect(config.transport.method).toBe("POST");
    expect(config.articleHost).toBe("re.bluepoch.com");
    expect(config.officialHosts).toEqual(["re.bluepoch.com"]);
    expect(config.checkpoint.checkpointKind).toBeNull();
    expect(config.checkpoint.defaultLookbackDays).toBeGreaterThanOrEqual(1);
  });
});

describe("postroom game config (light-and-night)", () => {
  it("exposes the static JSON transport and love.qq.com article host", () => {
    const config = postroomGames["light-and-night"];
    expect(config.game).toBe("light-and-night");
    expect(config.region).toBe("cn");
    expect(config.language).toBe("zh-cn");
    expect(config.transport.host).toBe("press-static-love.aurora.qq.com");
    expect(config.transport.listPath).toMatch(/^\/.+\.list\.json$/);
    expect(config.transport.previewPath).toBe("/{publishId}.preview.json");
    expect(config.transport.contentPath).toBe("/{publishId}.content.json");
    expect(config.articleHost).toBe("love.qq.com");
    expect(config.officialHosts).toContain("love.qq.com");
    expect(config.officialHosts).toContain(config.transport.host);
    expect(config.checkpoint.checkpointKind).toBeNull();
    expect(config.checkpoint.defaultLookbackDays).toBeGreaterThanOrEqual(1);
  });
});
