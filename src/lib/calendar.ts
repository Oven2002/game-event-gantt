export const DAY = 86_400_000;
export const MINUTE = 60_000;

const BEIJING_OFFSET = 8 * 60 * MINUTE;
const TIME_ZONE = "Asia/Shanghai";

const dateFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const shortDateFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: TIME_ZONE,
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const tickDateFormatter = new Intl.DateTimeFormat("zh-CN", { timeZone: TIME_ZONE, month: "numeric", day: "numeric" });
const dayKeyFormatter = new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" });
const tickMonthFormatter = new Intl.DateTimeFormat("zh-CN", { timeZone: TIME_ZONE, year: "2-digit", month: "short" });
const tickTimeFormatter = new Intl.DateTimeFormat("zh-CN", { timeZone: TIME_ZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const tickWeekdayFormatter = new Intl.DateTimeFormat("zh-CN", { timeZone: TIME_ZONE, weekday: "short" });
const weekdayFormatter = new Intl.DateTimeFormat("en-US", { timeZone: TIME_ZONE, weekday: "short" });

export function formatBeijingDate(timestamp: number, includeYear = true): string {
  return (includeYear ? dateFormatter : shortDateFormatter).format(timestamp);
}

export function beijingDayStart(timestamp: number): number {
  return Math.floor((timestamp + BEIJING_OFFSET) / DAY) * DAY - BEIJING_OFFSET;
}

export function beijingDayKey(timestamp: number): string {
  return dayKeyFormatter.format(timestamp);
}

export function isBeijingWeekend(timestamp: number): boolean {
  const weekday = weekdayFormatter.format(timestamp);
  return weekday === "Sat" || weekday === "Sun";
}

export interface TimelineTickLabel {
  primary: string;
  secondary?: string;
}

export function formatTimelineTick(timestamp: number, span: number): TimelineTickLabel {
  if (span <= 2 * DAY) {
    return {
      primary: tickWeekdayFormatter.format(timestamp),
      secondary: tickTimeFormatter.format(timestamp),
    };
  }
  if (span <= 120 * DAY) {
    return {
      primary: tickDateFormatter.format(timestamp),
      secondary: tickWeekdayFormatter.format(timestamp),
    };
  }
  return { primary: tickMonthFormatter.format(timestamp) };
}
