import { canonicalizeUrl } from "./hash.ts";

export function mergeSources(oldSources: readonly string[], candidateSources: readonly string[]): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const source of oldSources) {
    const canonical = canonicalizeUrl(source);
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    merged.push(source);
  }
  for (const source of candidateSources) {
    const canonical = canonicalizeUrl(source);
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    merged.push(canonical);
  }
  return merged;
}
