import { parseBeijingTimestamp } from "../common/time.ts";

export interface MaintenanceParse {
  start?: string;
  end?: string;
  certainty?: "confirmed" | "inferred";
  note?: string;
  status: "ready" | "needs_review";
}

export function parseMaintenanceText(text: string, context: { maintenanceEnd?: string } = {}): MaintenanceParse {
  if (/下次维护前/.test(text)) return { status: "needs_review", note: "end is not announced" };
  if (/维护结束后|维护后/.test(text)) {
    if (!context.maintenanceEnd) return { status: "needs_review", note: "maintenance end is missing" };
    return { status: "ready", start: parseBeijingTimestamp(context.maintenanceEnd), certainty: "inferred", note: "start inferred from the official maintenance end" };
  }
  return { status: "needs_review", note: "maintenance wording is not supported" };
}
