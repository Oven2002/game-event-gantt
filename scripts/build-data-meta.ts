// Reads data/meta.yaml and the timeline payload, then emits
// src/generated/site-meta.json consumed by the Astro footer.
// The pure core (buildSiteMeta) is exported for unit tests; the I/O shell is
// the only part that touches the filesystem and git-free sources.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatBeijingDate } from "../src/lib/calendar.ts";
import { loadDataMeta, loadTimelineData } from "../src/lib/data.ts";
import type { DataMetaValue } from "../src/lib/data.ts";
import type { SiteMeta } from "../src/lib/site-meta.ts";
import type { TimelinePayload } from "../src/lib/types.ts";

// Pure projection: meta + payload -> footer values. Returns null when the
// tracked meta is unavailable so the page can omit the line instead of
// guessing a timestamp.
export function buildSiteMeta(meta: DataMetaValue | null, payload: TimelinePayload): SiteMeta | null {
  if (meta === null) return null;
  const timestamp = Date.parse(meta.dataUpdatedAt);
  if (!Number.isFinite(timestamp)) return null;
  const items = payload.groups.reduce(
    (total, group) => total + group.versions.length + group.events.length,
    0,
  );
  return {
    dataUpdatedAtLabel: formatBeijingDate(timestamp),
    groups: payload.groups.length,
    items,
    dataCommit: meta.dataCommit,
  };
}

function main(): void {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const dataRoot = path.join(root, "data");
  let meta: DataMetaValue | null = null;
  try {
    meta = loadDataMeta(dataRoot);
  } catch {
    // The footer degrades gracefully when data/meta.yaml is missing.
    meta = null;
  }

  const payload = loadTimelineData(dataRoot);
  const siteMeta = buildSiteMeta(meta, payload);
  if (siteMeta === null) {
    console.warn("site-meta: data/meta.yaml unavailable; footer data-updated line will be omitted.");
    return;
  }

  const outDir = path.join(root, "src/generated");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "site-meta.json"), `${JSON.stringify(siteMeta, null, 2)}\n`);
  console.log(`site-meta: ${siteMeta.groups} groups, ${siteMeta.items} items, data updated ${siteMeta.dataUpdatedAtLabel}`);
}

main();