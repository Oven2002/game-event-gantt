import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import type { NamedId, TimelineGroup, TimelineItem, TimelinePayload } from "./types.ts";

const machineId = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const entryId = /^[a-z0-9][a-z0-9._-]*$/;
const beijingTime = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):00\+08:00$/;

const httpUrl = z.url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "http:" || protocol === "https:";
}, "必须是 HTTP(S) URL");

const namedMachineIdSchema = z.object({
  id: z.string().regex(machineId, "必须是小写字母、数字和连字符组成的稳定 ID"),
  name: z.string().trim().min(1, "显示名不能为空"),
}).strict();

const metaSchema = z.object({
  id: z.string().regex(machineId),
  name: z.string().trim().min(1),
  priority: z.number().int().optional(),
  regions: z.array(namedMachineIdSchema).min(1),
}).strict();

const eventTypesSchema = z.object({
  types: z.array(namedMachineIdSchema).min(1),
}).strict();

const commonItemFields = {
  id: z.string().regex(entryId, "必须以小写字母或数字开头，只能包含小写字母、数字、点、下划线和连字符"),
  name: z.string().trim().min(1),
  url: httpUrl.optional(),
  sources: z.array(httpUrl).min(1, "至少提供一个来源链接"),
  note: z.string().trim().min(1).optional(),
};

const versionSchema = z.object({
  ...commonItemFields,
  start: z.string().regex(beijingTime, "必须为带引号的 YYYY-MM-DDTHH:mm:00+08:00"),
  end: z.string().regex(beijingTime, "必须为带引号的 YYYY-MM-DDTHH:mm:00+08:00"),
}).strict();

const periodSchema = z.object({
  start: z.string().regex(beijingTime, "必须为带引号的 YYYY-MM-DDTHH:mm:00+08:00"),
  end: z.string().regex(beijingTime, "必须为带引号的 YYYY-MM-DDTHH:mm:00+08:00"),
}).strict();

const eventSchema = z.object({
  ...commonItemFields,
  start: z.string().regex(beijingTime, "必须为带引号的 YYYY-MM-DDTHH:mm:00+08:00").optional(),
  type: z.string().regex(machineId),
  priority: z.number().int().optional(),
  end: z.string().regex(beijingTime, "必须为带引号的 YYYY-MM-DDTHH:mm:00+08:00").optional(),
  related: z.array(z.string().regex(entryId)).optional(),
  lifecycle: z.enum(["limited", "permanent"]).optional(),
  cadence: z.enum(["one_off", "rotating", "recurring"]).optional(),
  periods: z.array(periodSchema).min(1).optional(),
}).strict().refine(
  (value) => value.start !== undefined || value.periods !== undefined,
  { message: "必须提供 start，或提供 periods" },
).refine(
  (value) => value.type === "event" || (value.lifecycle === undefined && value.cadence === undefined && value.periods === undefined),
  { message: "lifecycle、cadence、periods 只允许用于 type: event" },
);

const dataFileSchema = z.object({
  game: z.string().regex(machineId),
  region: z.string().regex(machineId),
  versions: z.array(versionSchema).optional(),
  events: z.array(eventSchema).optional(),
}).strict().refine(
  (value) => (value.versions?.length ?? 0) + (value.events?.length ?? 0) > 0,
  { message: "versions 和 events 至少有一个非空集合" },
);

type ParsedMeta = z.infer<typeof metaSchema>;
type ParsedVersion = z.infer<typeof versionSchema>;
type ParsedEvent = z.infer<typeof eventSchema>;

export class DataValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`数据校验失败：\n${issues.map((issue) => `- ${issue}`).join("\n")}`);
    this.name = "DataValidationError";
    this.issues = issues;
  }
}

export function parseBeijingTimestamp(value: string): number {
  const match = beijingTime.exec(value);
  if (!match) throw new Error("必须为 YYYY-MM-DDTHH:mm:00+08:00");
  const [, yearText, monthText, dayText, hourText, minuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const daysInMonth = month >= 1 && month <= 12
    ? new Date(Date.UTC(year, month, 0)).getUTCDate()
    : 0;
  // JS 会把 0000-0099 年份静默解释为 1900-1999（Date.parse 的世纪回退），
  // 必须显式拒绝，否则错误数据会通过校验。
  if (year < 1970 || day < 1 || day > daysInMonth || hour > 23 || minute > 59) {
    throw new Error("日期或时间数值无效");
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error("无法解析时间");
  return timestamp;
}

// 解析失败时返回 undefined 并把语法错误写入 issues；调用方应跳过 schema 校验，
// 避免同一个文件同时报「YAML 语法错误」和「expected object」两条重复错误。
function readYaml(file: string, issues: string[]): unknown {
  try {
    return parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    issues.push(`${file}: YAML 语法错误：${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

function formatZodIssues(file: string, error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const location = issue.path.length ? issue.path.join(".") : "文件根节点";
    return `${file} [${location}]: ${issue.message}`;
  });
}

function duplicateIssues(items: NamedId[], label: string, file: string): string[] {
  const seen = new Set<string>();
  const issues: string[] = [];
  for (const item of items) {
    if (seen.has(item.id)) issues.push(`${file}: ${label} ID 重复：${item.id}`);
    seen.add(item.id);
  }
  return issues;
}

function normalizeItem(
  raw: ParsedVersion | ParsedEvent,
  kind: "version" | "event",
  gameId: string,
  regionId: string,
  sourceFile: string,
  eventTypeMap: Map<string, string>,
  issues: string[],
): TimelineItem | undefined {
  const event = kind === "event" ? raw as ParsedEvent : undefined;
  const rawPeriods = event?.periods;
  const firstStart = raw.start ?? rawPeriods?.[0]?.start;
  if (!firstStart) {
    issues.push(`${sourceFile} [${kind}.${raw.id}]: 缺少 start 或 periods`);
    return undefined;
  }
  let start: number;
  let end: number | undefined;
  try {
    start = parseBeijingTimestamp(firstStart);
    end = raw.end ? parseBeijingTimestamp(raw.end) : undefined;
  } catch (error) {
    issues.push(`${sourceFile} [${kind}.${raw.id}]: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
  const periods: Array<{ start: number; end: number }> = [];
  if (rawPeriods) {
    for (const period of rawPeriods) {
      try {
        const periodStart = parseBeijingTimestamp(period.start);
        const periodEnd = parseBeijingTimestamp(period.end);
        if (periodEnd <= periodStart) {
          issues.push(`${sourceFile} [${kind}.${raw.id}.periods]: end 必须晚于 start`);
        } else {
          periods.push({ start: periodStart, end: periodEnd });
        }
      } catch (error) {
        issues.push(`${sourceFile} [${kind}.${raw.id}.periods]: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } else if (end !== undefined) {
    periods.push({ start, end });
  }
  if (periods.length) {
    start = Math.min(...periods.map((period) => period.start));
    end = Math.max(...periods.map((period) => period.end));
  }
  if (end !== undefined && end <= start) {
    issues.push(`${sourceFile} [${kind}.${raw.id}.end]: end 必须晚于 start`);
  }
  const typeId = kind === "version" ? "version" : (raw as ParsedEvent).type;
  const typeName = kind === "version" ? "版本" : eventTypeMap.get(typeId);
  if (!typeName) {
    issues.push(`${sourceFile} [event.${raw.id}.type]: 未声明的活动类型 ${typeId}`);
  }
  return {
    key: `${gameId}/${regionId}/${kind}/${raw.id}`,
    id: raw.id,
    kind,
    name: raw.name,
    typeId,
    typeName: typeName ?? typeId,
    start,
    end,
    periods,
    lifecycle: event?.lifecycle,
    cadence: event?.cadence,
    related: event?.related ?? [],
    url: raw.url,
    sources: raw.sources,
    note: raw.note,
    priority: event?.priority,
    sourceFile,
  };
}

export function loadTimelineData(dataRoot = path.resolve(process.cwd(), "data")): TimelinePayload {
  const issues: string[] = [];
  const relative = (file: string) => path.relative(dataRoot, file).replaceAll("\\", "/");
  const eventTypesFile = path.join(dataRoot, "event-types.yaml");
  const eventTypesValue = readYaml(eventTypesFile, issues);
  const eventTypesResult = eventTypesValue === undefined ? undefined : eventTypesSchema.safeParse(eventTypesValue);
  if (eventTypesResult && !eventTypesResult.success) issues.push(...formatZodIssues(relative(eventTypesFile), eventTypesResult.error));
  const eventTypes = eventTypesResult?.success ? eventTypesResult.data.types : [];
  issues.push(...duplicateIssues(eventTypes, "活动类型", relative(eventTypesFile)));
  const eventTypeMap = new Map(eventTypes.map((item) => [item.id, item.name]));

  const groups = new Map<string, TimelineGroup>();
  const gameIds = new Set<string>();
  const directories = fs.existsSync(dataRoot)
    ? fs.readdirSync(dataRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory())
    : [];

  for (const directory of directories) {
    const gameDirectory = path.join(dataRoot, directory.name);
    const metaFile = path.join(gameDirectory, "meta.yaml");
    const metaValue = readYaml(metaFile, issues);
    if (metaValue === undefined) continue;
    const metaResult = metaSchema.safeParse(metaValue);
    if (!metaResult.success) {
      issues.push(...formatZodIssues(relative(metaFile), metaResult.error));
      continue;
    }
    const meta: ParsedMeta = metaResult.data;
    if (directory.name !== meta.id) issues.push(`${relative(metaFile)}: 目录名必须等于游戏 ID ${meta.id}`);
    if (gameIds.has(meta.id)) issues.push(`${relative(metaFile)}: 游戏 ID 重复：${meta.id}`);
    gameIds.add(meta.id);
    issues.push(...duplicateIssues(meta.regions, "服务器", relative(metaFile)));
    const regionMap = new Map(meta.regions.map((region) => [region.id, region.name]));

    const files = fs.readdirSync(gameDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.ya?ml$/i.test(entry.name) && entry.name !== "meta.yaml")
      .map((entry) => path.join(gameDirectory, entry.name));

    for (const file of files) {
      const fileName = relative(file);
      const fileValue = readYaml(file, issues);
      if (fileValue === undefined) continue;
      const result = dataFileSchema.safeParse(fileValue);
      if (!result.success) {
        issues.push(...formatZodIssues(fileName, result.error));
        continue;
      }
      const raw = result.data;
      if (raw.game !== meta.id) issues.push(`${fileName} [game]: 必须为 ${meta.id}`);
      const regionName = regionMap.get(raw.region);
      if (!regionName) {
        issues.push(`${fileName} [region]: 未在 meta.yaml 声明的服务器 ${raw.region}`);
        continue;
      }
      const groupKey = `${meta.id}/${raw.region}`;
      const group = groups.get(groupKey) ?? {
        key: groupKey,
        game: { id: meta.id, name: meta.name, priority: meta.priority },
        region: { id: raw.region, name: regionName },
        versions: [],
        events: [],
      };
      for (const version of raw.versions ?? []) {
        const item = normalizeItem(version, "version", meta.id, raw.region, fileName, eventTypeMap, issues);
        if (item) group.versions.push(item);
      }
      for (const event of raw.events ?? []) {
        const item = normalizeItem(event, "event", meta.id, raw.region, fileName, eventTypeMap, issues);
        if (item) group.events.push(item);
      }
      groups.set(groupKey, group);
    }
  }

  for (const group of groups.values()) {
    for (const [kind, items] of [["版本", group.versions], ["活动", group.events]] as const) {
      const seen = new Map<string, string>();
      for (const item of items) {
        const previous = seen.get(item.id);
        if (previous) issues.push(`${item.sourceFile}: ${kind} ID ${item.id} 已在 ${previous} 中定义`);
        else seen.set(item.id, item.sourceFile);
      }
    }
    group.versions.sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
    group.events.sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
    for (let index = 1; index < group.versions.length; index += 1) {
      const previous = group.versions[index - 1];
      const current = group.versions[index];
      if ((previous.end ?? previous.start) > current.start) {
        issues.push(`${current.sourceFile}: 版本 ${current.id} 与版本 ${previous.id} 时间重叠`);
      }
    }
    const versionIds = new Set(group.versions.map((version) => version.id));
    for (const event of group.events) {
      for (const relatedId of event.related) {
        if (!versionIds.has(relatedId)) {
          issues.push(`${event.sourceFile} [event.${event.id}.related]: 未找到版本 ${relatedId}`);
        }
      }
    }
  }

  if (directories.length === 0) issues.push("data: 至少需要一个游戏目录");
  if (groups.size === 0) issues.push("data: 没有可用的游戏时间表数据");
  if (issues.length) throw new DataValidationError(issues);

  const sortedGroups = [...groups.values()].sort((a, b) =>
    (b.game.priority ?? 0) - (a.game.priority ?? 0)
    || a.game.name.localeCompare(b.game.name, "zh-CN")
    || a.region.name.localeCompare(b.region.name, "zh-CN")
  );
  const allItems = sortedGroups.flatMap((group) => [...group.versions, ...group.events]);
  const min = Math.min(...allItems.map((item) => item.start));
  const max = Math.max(...allItems.map((item) => item.end ?? item.start));
  return {
    generatedAt: Date.now(),
    eventTypes,
    groups: sortedGroups,
    bounds: { start: min, end: max },
  };
}
