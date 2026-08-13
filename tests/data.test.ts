import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DataValidationError, loadTimelineData, parseBeijingTimestamp } from "../src/lib/data.ts";
import {
  defaultExpandedGameIds,
  parseTimelinePreferences,
  preferenceValue,
} from "../src/lib/preferences.ts";
import { domainAroundAnchor } from "../src/lib/timeline-domain.ts";
import { packIntoLanes, statusAt } from "../src/lib/types.ts";
import { parseEffectsPreferences } from "../src/lib/effects-preferences.ts";
import { resolveAssetUrl } from "../src/lib/asset-url.ts";
import {
  DAY,
  beijingDayKey,
  beijingDayStart,
  formatTimelineTick,
  isBeijingWeekend,
} from "../src/lib/calendar.ts";

describe("Beijing calendar ticks", () => {
  it("switches date and weekend status at Beijing midnight", () => {
    const fridayBeforeMidnight = Date.parse("2026-08-07T15:59:00Z");
    const saturdayMidnight = Date.parse("2026-08-07T16:00:00Z");

    expect(isBeijingWeekend(fridayBeforeMidnight)).toBe(false);
    expect(isBeijingWeekend(saturdayMidnight)).toBe(true);
    expect(beijingDayStart(saturdayMidnight)).toBe(saturdayMidnight);
    expect(beijingDayKey(saturdayMidnight)).not.toBe(beijingDayKey(saturdayMidnight - 1));
    expect(beijingDayKey(saturdayMidnight)).toBe(beijingDayKey(saturdayMidnight + DAY - 1));
  });

  it("uses weekday and time labels at appropriate zoom levels", () => {
    const saturdayMidnight = Date.parse("2026-08-07T16:00:00Z");

    expect(formatTimelineTick(saturdayMidnight, 28 * DAY)).toEqual({ primary: "8/8", secondary: "周六" });
    expect(formatTimelineTick(saturdayMidnight, 2 * DAY)).toEqual({ primary: "周六", secondary: "00:00" });
    expect(formatTimelineTick(saturdayMidnight, 180 * DAY).secondary).toBeUndefined();
  });
});

const temporaryDirectories: string[] = [];

function fixture(versionBlock: string, eventBlock = ""): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "game-gantt-test-"));
  temporaryDirectories.push(root);
  fs.mkdirSync(path.join(root, "demo-game"));
  fs.writeFileSync(path.join(root, "event-types.yaml"), `types:\n  - id: event\n    name: 活动\n`);
  fs.writeFileSync(path.join(root, "demo-game", "meta.yaml"), `id: demo-game\nname: 示例游戏\nregions:\n  - id: cn\n    name: 国服\n`);
  fs.writeFileSync(path.join(root, "demo-game", "cn.yaml"), `game: demo-game\nregion: cn\n${versionBlock}${eventBlock}`);
  return root;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("北京时间解析", () => {
  it("将 +08:00 时间转换为正确 UTC 时间戳", () => {
    expect(parseBeijingTimestamp("2026-08-28T06:00:00+08:00"))
      .toBe(Date.parse("2026-08-27T22:00:00Z"));
  });

  it.each([
    "2026-08-28T06:00:30+08:00",
    "2026-08-28T06:00:00Z",
    "2026-02-30T06:00:00+08:00",
    "0099-08-28T06:00:00+08:00",
  ])("拒绝无效时间 %s", (value) => {
    expect(() => parseBeijingTimestamp(value)).toThrow();
  });
});

describe("状态边界", () => {
  const item = { start: 1000, end: 2000 };

  it("在开始时间进入进行中，在结束时间进入已结束", () => {
    expect(statusAt(item, 999)).toBe("upcoming");
    expect(statusAt(item, 1000)).toBe("ongoing");
    expect(statusAt(item, 1999)).toBe("ongoing");
    expect(statusAt(item, 2000)).toBe("ended");
  });

  it("单点事件到达开始时间后直接结束", () => {
    expect(statusAt({ start: 1000 }, 999)).toBe("upcoming");
    expect(statusAt({ start: 1000 }, 1000)).toBe("ended");
  });
});

describe("时间轴当前时间定位", () => {
  it("默认显示当前时间前 7 天和后 21 天", () => {
    const day = 86_400_000;
    const now = Date.parse("2026-08-10T00:00:00Z");
    const [start, end] = domainAroundAnchor(now, 28 * day, 0.25);

    expect(start).toBe(now - 7 * day);
    expect(end).toBe(now + 21 * day);
  });

  it("保留缩放跨度并将锚点放在 25%", () => {
    const anchor = 10_000;
    const span = 4_000;
    const [start, end] = domainAroundAnchor(anchor, span, 0.25);

    expect(end - start).toBe(span);
    expect((anchor - start) / (end - start)).toBe(0.25);
  });
});

describe("时间轴偏好", () => {
  it("默认选择排序最前的三个不同游戏", () => {
    const expanded = defaultExpandedGameIds([
      { game: { id: "game-a" } },
      { game: { id: "game-a" } },
      { game: { id: "game-b" } },
      { game: { id: "game-c" } },
      { game: { id: "game-d" } },
    ]);

    expect([...expanded]).toEqual(["game-a", "game-b", "game-c"]);
  });

  it("解析已知筛选和分组状态并忽略错误类型", () => {
    const preferences = parseTimelinePreferences(JSON.stringify({
      filters: {
        game: { genshin: false, invalid: "no" },
        unknown: { value: true },
      },
      groupOpen: { "genshin/cn": true, broken: 1 },
    }));

    expect(preferences.filters.game).toEqual({ genshin: false });
    expect(preferences.groupOpen).toEqual({ "genshin/cn": true });
    expect(preferences.filters).not.toHaveProperty("unknown");
  });

  it.each(["not-json", "[]", '{"filters":42}'])("损坏偏好安全回退：%s", (raw) => {
    expect(parseTimelinePreferences(raw)).toEqual({ filters: {}, groupOpen: {} });
  });

  it("未保存的新筛选项保留页面默认值", () => {
    expect(preferenceValue({ existing: false }, "new-game", true)).toBe(true);
    expect(preferenceValue({ existing: false }, "new-status", false)).toBe(false);
  });
});

describe("页面特效偏好", () => {
  it("首次访问采用系统动效默认值并显示看板娘", () => {
    expect(parseEffectsPreferences(null, true)).toEqual({ sakuraEnabled: true, mascotVisible: true });
    expect(parseEffectsPreferences(null, false)).toEqual({ sakuraEnabled: false, mascotVisible: true });
  });

  it("恢复合法字段并忽略损坏内容", () => {
    expect(parseEffectsPreferences('{"sakuraEnabled":false,"mascotVisible":false}', true))
      .toEqual({ sakuraEnabled: false, mascotVisible: false });
    expect(parseEffectsPreferences("not-json", true))
      .toEqual({ sakuraEnabled: true, mascotVisible: true });
  });
});

describe("静态资源基路径", () => {
  it("保留没有尾斜杠的子路径部署基路径", () => {
    expect(resolveAssetUrl("/game-event-gantt", "vendor/live2d-config.json", "https://example.com"))
      .toBe("https://example.com/game-event-gantt/vendor/live2d-config.json");
  });

  it("兼容站点根路径与资源前导斜杠", () => {
    expect(resolveAssetUrl("/", "/vendor/model.json", "https://example.com"))
      .toBe("https://example.com/vendor/model.json");
  });
});

describe("Live2D 看板娘资源", () => {
  const modelCases = [
    ["mao", "mao_pro.model3.json", 7],
    ["hibiki", "hibiki.model3.json", 5],
  ] as const;

  it("Live2D runtime uses a stable logger chunk without circular entry imports", () => {
    const dist = path.join(process.cwd(), "public/vendor/live2d-widget/dist");
    const entry = fs.readFileSync(path.join(dist, "waifu-tips.js"), "utf8");
    const cubism2 = fs.readFileSync(path.join(dist, "chunk/index.js"), "utf8");
    const cubism5 = fs.readFileSync(path.join(dist, "chunk/index2.js"), "utf8");
    const logger = fs.readFileSync(path.join(dist, "chunk/logger.js"), "utf8");

    expect(entry).toContain("./chunk/logger.js");
    expect(cubism2).toContain("./logger.js");
    expect(cubism5).toContain("./logger.js");
    expect(cubism2).not.toContain("../waifu-tips.js");
    expect(cubism5).not.toContain("../waifu-tips.js");
    expect(logger).toMatch(/export\{[^}]*\bas logger\b[^}]*\}/);
  });

  it("默认使用 Mao 并提供 Hibiki 切换", () => {
    const config = JSON.parse(fs.readFileSync(path.join(process.cwd(), "public/vendor/live2d-config.json"), "utf8"));
    expect(config.models.map((model: { name: string }) => model.name))
      .toEqual(["Mao Niziiro", "Hibiki"]);
  });

  it.each(modelCases)("%s 模型只在点击时播放动作且引用完整", (directory, configFile, motionCount) => {
    const root = path.join(process.cwd(), "public/vendor/live2d-models", directory);
    const model = JSON.parse(fs.readFileSync(path.join(root, configFile), "utf8"));
    const references = model.FileReferences;
    const files = [
      references.Moc,
      references.Physics,
      references.Pose,
      references.DisplayInfo,
      ...references.Textures,
      ...(references.Expressions ?? []).map((entry: { File: string }) => entry.File),
      ...Object.values(references.Motions ?? {}).flatMap((entries) =>
        (entries as Array<{ File: string; Sound?: string }>).flatMap((entry) => [entry.File, entry.Sound])
      ),
    ].filter((file): file is string => typeof file === "string");

    expect(references.Motions.Idle).toBeUndefined();
    expect(references.Motions.TapBody).toHaveLength(motionCount);
    expect(files.every((file) => fs.existsSync(path.join(root, file)))).toBe(true);
  });

  it("网页纹理最长边不超过 2048", () => {
    const textures = [
      "public/vendor/live2d-models/mao/mao_pro.2048/texture_00.png",
      "public/vendor/live2d-models/hibiki/hibiki.2048/texture_00.png",
    ];
    for (const texture of textures) {
      const png = fs.readFileSync(path.join(process.cwd(), texture));
      expect(Math.max(png.readUInt32BE(16), png.readUInt32BE(20))).toBeLessThanOrEqual(2048);
    }
  });

  it("模型切换复用 Cubism 5 实例并串行执行", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "vendor/live2d-widget/src/model.ts"),
      "utf8"
    );
    expect(source).toContain("if (!this.cubism5model)");
    expect(source).toContain("await this.waitForCubism5ModelReady(token)");
    expect(source).toContain("private releaseRuntime()");
    expect(source).toContain("this.cubism5model?.stop?.()");
    expect(source).toContain("this.cubism5model?.release?.()");
    expect(source).toContain("document.addEventListener('visibilitychange', handleVisibilityChange)");
    expect(source).toContain("getVisibleElapsed() >= timeoutMs");
    expect(source).toContain("this.cubism5model.changeModel(previousCubism5ModelPath)");
    expect(source).toContain("live2dManager.onTap(x, y)");
    expect(source.match(/model\._state !== 22/g)).toHaveLength(2);
    expect(source).not.toContain("this.modelJSONCache[url] = result;\n    } catch");
    expect(source).toContain("this.modelSwitchQueue.then(switchModel)");
    expect(source.indexOf("const loaded = await this.loadModel(message, nextModelId, 0)"))
      .toBeLessThan(source.indexOf("this.modelId = nextModelId"));
  });

  it("Live2D lifecycle releases resources and limits canvas resolution", () => {
    const cubism5 = fs.readFileSync(
      path.join(process.cwd(), "vendor/live2d-widget/src/cubism5/index.js"),
      "utf8"
    );
    const cubism2 = fs.readFileSync(
      path.join(process.cwd(), "vendor/live2d-widget/src/cubism2/index.js"),
      "utf8"
    );
    const cubism2Manager = fs.readFileSync(
      path.join(process.cwd(), "vendor/live2d-widget/src/cubism2/LAppLive2DManager.js"),
      "utf8"
    );
    const cubism2Model = fs.readFileSync(
      path.join(process.cwd(), "vendor/live2d-widget/src/cubism2/LAppModel.js"),
      "utf8"
    );
    const mascot = fs.readFileSync(path.join(process.cwd(), "src/scripts/mascot.ts"), "utf8");
    const runtime = fs.readFileSync(
      path.join(process.cwd(), "public/vendor/live2d-widget/dist/chunk/index2.js"),
      "utf8"
    );
    const cubism2Runtime = fs.readFileSync(
      path.join(process.cwd(), "public/vendor/live2d-widget/dist/chunk/index.js"),
      "utf8"
    );
    expect(cubism5).toContain("releaseLive2DModels");
    expect(cubism5).toContain("super.release()");
    expect(cubism5).toContain("preserveDrawingBuffer: false");
    expect(cubism5).toContain("if (this._running) return;");
    expect(cubism2).toContain("pauseDraw()");
    expect(cubism2).toContain("preserveDrawingBuffer: false");
    expect(cubism2Manager).toContain("this.loadToken = 0");
    expect(cubism2Model).toContain("this.live2DModel?.deleteTextures?.()");
    expect(mascot).toContain("waifuData: config");
    expect(mascot).not.toContain("URL.createObjectURL");
    expect(runtime).toContain("preserveDrawingBuffer:!1");
    expect(runtime.match(/function ws\(/g)).toHaveLength(1);
    expect(cubism2Runtime).toContain("getModel(){return this.model}release(){");
    expect(cubism2Runtime).toContain("pauseDraw(){");
  });

  it("折叠或禁用看板娘时不会持续观察页面 DOM", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "src/scripts/mascot.ts"),
      "utf8"
    );
    expect(source).toContain('localStorage.getItem("waifu-disabled") === "true"');
    expect(source).toContain('toggle.addEventListener("click", resumeWhenOpened, { once: true })');
    expect(source).toContain("stopObserving();");
  });
});

describe("轨道自动合并", () => {
  it("将互不重叠的上下半卡池放在同一行", () => {
    const lanes = packIntoLanes([
      { start: 1000, end: 2000 },
      { start: 2000, end: 3000 },
    ]);
    expect(lanes).toHaveLength(1);
    expect(lanes[0]).toHaveLength(2);
  });

  it("为与普通卡池重叠的长期特殊卡池保留独立行", () => {
    const regularUpper = { start: 1000, end: 2000 };
    const regularLower = { start: 2000, end: 3000 };
    const special = { start: 1200, end: 2800 };
    const lanes = packIntoLanes([regularUpper, special, regularLower]);
    expect(lanes).toHaveLength(2);
    expect(lanes.flat()).toEqual(expect.arrayContaining([regularUpper, regularLower, special]));
  });
});

describe("跨文件业务校验", () => {
  const version = `versions:\n  - id: v1\n    name: V1\n    start: "2026-08-01T00:00:00+08:00"\n    end: "2026-09-01T00:00:00+08:00"\n    sources: ["https://example.com/v1"]\n`;

  it("合并合法版本和单点活动", () => {
    const root = fixture(version, `events:\n  - id: preview-v1\n    name: 前瞻\n    type: event\n    start: "2026-08-20T20:00:00+08:00"\n    related: [v1]\n    sources: ["https://example.com/preview"]\n`);
    const payload = loadTimelineData(root);
    expect(payload.groups).toHaveLength(1);
    expect(payload.groups[0].versions).toHaveLength(1);
    expect(payload.groups[0].events[0].end).toBeUndefined();
  });

  it("拒绝版本重叠", () => {
    const root = fixture(`${version}  - id: v2\n    name: V2\n    start: "2026-08-20T00:00:00+08:00"\n    end: "2026-10-01T00:00:00+08:00"\n    sources: ["https://example.com/v2"]\n`);
    expect(() => loadTimelineData(root)).toThrow(DataValidationError);
    expect(() => loadTimelineData(root)).toThrow(/时间重叠/);
  });

  it("拒绝不存在的关联版本", () => {
    const root = fixture(version, `events:\n  - id: bad-related\n    name: 错误关联\n    type: event\n    start: "2026-08-20T20:00:00+08:00"\n    related: [v2]\n    sources: ["https://example.com/event"]\n`);
    expect(() => loadTimelineData(root)).toThrow(/未找到版本 v2/);
  });

  it("拒绝缺少来源的数据", () => {
    const root = fixture(`versions:\n  - id: v1\n    name: V1\n    start: "2026-08-01T00:00:00+08:00"\n    end: "2026-09-01T00:00:00+08:00"\n    sources: []\n`);
    expect(() => loadTimelineData(root)).toThrow(/至少提供一个来源链接/);
  });

  it("YAML 语法错误只报一次，不追加 schema 解析错误", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "game-gantt-test-"));
    temporaryDirectories.push(root);
    fs.mkdirSync(path.join(root, "demo-game"));
    fs.writeFileSync(path.join(root, "event-types.yaml"), `types:\n  - id: event\n    name: 活动\n`);
    fs.writeFileSync(path.join(root, "demo-game", "meta.yaml"), `id: demo-game\nname: 示例游戏\nregions:\n  - id: cn\n    name: 国服\n`);
    fs.writeFileSync(path.join(root, "demo-game", "cn.yaml"), `game: demo-game\nregion: cn\nversions: [未闭合\n`);

    expect(() => loadTimelineData(root)).toThrow(/YAML 语法错误/);
    expect(() => loadTimelineData(root)).not.toThrow(/expected object|Invalid input/);
  });

  it("按游戏优先级排序并保留活动优先级", () => {
    const root = fixture(version, `events:\n  - id: featured-event\n    name: 重点活动\n    type: event\n    priority: 25\n    start: "2026-08-20T20:00:00+08:00"\n    sources: ["https://example.com/featured"]\n`);
    const pinnedDirectory = path.join(root, "pinned-game");
    fs.mkdirSync(pinnedDirectory);
    fs.writeFileSync(path.join(pinnedDirectory, "meta.yaml"), `id: pinned-game\nname: 置顶游戏\npriority: 10\nregions:\n  - id: cn\n    name: 国服\n`);
    fs.writeFileSync(path.join(pinnedDirectory, "cn.yaml"), `game: pinned-game\nregion: cn\nversions:\n  - id: v1\n    name: V1\n    start: "2026-08-01T00:00:00+08:00"\n    end: "2026-09-01T00:00:00+08:00"\n    sources: ["https://example.com/v1"]\n`);

    const payload = loadTimelineData(root);
    expect(payload.groups[0].game.id).toBe("pinned-game");
    const defaultGroup = payload.groups.find((group) => group.game.id === "demo-game");
    expect(defaultGroup?.game.priority).toBeUndefined();
    expect(defaultGroup?.events[0].priority).toBe(25);
  });
});
