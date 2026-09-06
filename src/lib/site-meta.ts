// Shared shape for the generated footer metadata plus the two consumers it
// supports: the build script writes site-meta.json, the page reads it.
import fs from "node:fs";

export interface SiteMeta {
  dataUpdatedAtLabel: string;
  groups: number;
  items: number;
  dataCommit: string;
}

// Read the generated JSON defensively so fresh clones without the file (or a
// broken build output) degrade to null instead of crashing astro check/build.
export function readSiteMeta(file: string): SiteMeta | null {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (typeof value !== "object" || value === null) return null;
    const raw = value as Record<string, unknown>;
    if (
      typeof raw.dataUpdatedAtLabel !== "string"
      || typeof raw.groups !== "number"
      || typeof raw.items !== "number"
      || typeof raw.dataCommit !== "string"
    ) {
      return null;
    }
    return {
      dataUpdatedAtLabel: raw.dataUpdatedAtLabel,
      groups: raw.groups,
      items: raw.items,
      dataCommit: raw.dataCommit,
    };
  } catch {
    return null;
  }
}

// Full text of the footer data-updated line; null omits rendering entirely so
// the site never guesses a timestamp it does not have.
export function renderDataMetaLine(meta: SiteMeta | null): string | null {
  if (meta === null) return null;
  return `数据更新：${meta.dataUpdatedAtLabel} · ${meta.groups} 组 ${meta.items} 条 · ${meta.dataCommit}`;
}