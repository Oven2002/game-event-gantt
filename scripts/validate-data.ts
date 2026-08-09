import { loadTimelineData } from "../src/lib/data.ts";

try {
  const payload = loadTimelineData();
  const itemCount = payload.groups.reduce(
    (total, group) => total + group.versions.length + group.events.length,
    0,
  );
  console.log(`数据校验通过：${payload.groups.length} 个游戏/服务器分组，${itemCount} 个条目。`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
