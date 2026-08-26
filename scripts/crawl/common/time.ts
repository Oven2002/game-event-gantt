export type ParsedTime =
  | { status: "confirmed"; value: string }
  | { status: "needs_review"; text: string; reason: string };

const timestampPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):00\+08:00$/;

export function parseBeijingTimestamp(value: string): string {
  const match = timestampPattern.exec(value);
  if (!match) throw new Error(`invalid Beijing timestamp: ${value}`);
  const [, year, month, day, hour, minute] = match;
  const date = new Date(0);
  date.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
  date.setUTCHours(Number(hour), Number(minute), 0, 0);
  if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() !== Number(month) - 1 || date.getUTCDate() !== Number(day) || date.getUTCHours() !== Number(hour) || date.getUTCMinutes() !== Number(minute)) {
    throw new Error(`invalid Beijing timestamp: ${value}`);
  }
  return value;
}

function iso(year: number, month: number, day: number, hour: number, minute: number): string {
  return parseBeijingTimestamp(`${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}T${hour.toString().padStart(2, "0")}:${minute.toString().padStart(2, "0")}:00+08:00`);
}

export function parseDateTimeText(text: string, referenceYear?: number): ParsedTime {
  if (/[zZ]|[+-]\d{2}:\d{2}/.test(text) || /:\d{2}(?!\s*$)/.test(text)) return { status: "needs_review", text, reason: "non-Beijing or non-minute timestamp" };
  const full = text.match(/(\d{4})[年/-](\d{1,2})[月/-](\d{1,2})(?:日)?\s*(\d{1,2}):(\d{2})/);
  const short = text.match(/(?:^(\d{1,2})月(\d{1,2})日|^(\d{1,2})\/(\d{1,2}))\s*(\d{1,2}):(\d{2})/);
  if (!full && !short) return { status: "needs_review", text, reason: referenceYear ? "unrecognized date format" : "missing year or minute" };
  if (!full && !referenceYear) return { status: "needs_review", text, reason: "missing year" };
  try {
    const year = full ? Number(full[1]) : referenceYear as number;
    const month = Number(full ? full[2] : short![1] ?? short![3]);
    const day = Number(full ? full[3] : short![2] ?? short![4]);
    const hour = Number(full ? full[4] : short![5]);
    const minute = Number(full ? full[5] : short![6]);
    return { status: "confirmed", value: iso(year, month, day, hour, minute) };
  } catch {
    return { status: "needs_review", text, reason: "invalid calendar time" };
  }
}

export interface ExplicitInterval {
  start: string;
  end: string;
  certainty: "confirmed";
}

export function parseExplicitInterval(text: string, referenceYear?: number): ExplicitInterval {
  const match = text.match(/^\s*(.*?)\s*(?:至|到|—|–|-)\s*(.*?)\s*$/);
  if (!match) throw new Error("explicit interval not found");
  const start = parseDateTimeText(match[1], referenceYear);
  const endText = match[2].trim();
  let end: ParsedTime;
  if (/^\d{1,2}:\d{2}$/.test(endText) && start.status === "confirmed") {
    end = { status: "confirmed", value: parseBeijingTimestamp(`${start.value.slice(0, 10)}T${endText}:00+08:00`) };
  } else {
    end = parseDateTimeText(endText, start.status === "confirmed" ? Number(start.value.slice(0, 4)) : referenceYear);
  }
  if (start.status !== "confirmed" || end.status !== "confirmed") throw new Error("interval needs review");
  const result = { start: start.value, end: end.value, certainty: "confirmed" as const };
  if (result.end <= result.start) throw new Error("interval end must be after start");
  return result;
}
