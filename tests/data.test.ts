import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DataValidationError, loadTimelineData, parseBeijingTimestamp } from "../src/lib/data.ts";
import { statusAt } from "../src/lib/types.ts";

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
});
