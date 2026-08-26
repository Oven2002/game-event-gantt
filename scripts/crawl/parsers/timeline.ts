import { parseExplicitInterval } from "../common/time.ts";

export interface TimelineParse {
  kind: "version" | "event";
  name: string;
  start?: string;
  end?: string;
  certainty?: "confirmed";
  status: "ready" | "needs_review";
  reason?: string;
}

export function parseTimelineText(text: string, input: { kind: "version" | "event"; name: string; referenceYear?: number }): TimelineParse {
  try {
    const interval = parseExplicitInterval(text, input.referenceYear);
    return { ...input, ...interval, status: "ready" };
  } catch (error) {
    return { kind: input.kind, name: input.name, status: "needs_review", reason: error instanceof Error ? error.message : "timeline could not be parsed" };
  }
}
