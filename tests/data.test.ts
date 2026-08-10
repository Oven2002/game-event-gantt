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
