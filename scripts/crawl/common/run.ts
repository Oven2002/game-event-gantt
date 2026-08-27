import { mkdir, access } from "node:fs/promises";
import { join } from "node:path";

export const RUN_ARTIFACTS = ["raw", "errors", "rejections", "candidates", "reports", "selections", "approved"] as const;
export type RunArtifact = typeof RUN_ARTIFACTS[number];

export function runRoot(runtimeRoot: string, runId: string): string { return join(runtimeRoot, "runs", runId); }
export function artifactPath(runtimeRoot: string, runId: string, artifact: RunArtifact, suffix = "jsonl"): string {
  return join(runRoot(runtimeRoot, runId), `${artifact}.${suffix}`);
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function createRun(runtimeRoot: string, runId: string): Promise<string> {
  const root = runRoot(runtimeRoot, runId);
  await mkdir(join(runtimeRoot, "runs"), { recursive: true });
  try { await mkdir(root); } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`run already exists: ${runId}`);
    throw error;
  }
  return root;
}

export async function assertRunArtifactsAbsent(runtimeRoot: string, runId: string, artifacts: readonly RunArtifact[]): Promise<void> {
  const paths = artifacts.flatMap((artifact) => [artifactPath(runtimeRoot, runId, artifact), artifactPath(runtimeRoot, runId, artifact, "json")]);
  const present = [] as string[];
  for (const path of paths) if (await exists(path)) present.push(path);
  if (present.length > 0) throw new Error(`run artifacts already exist: ${present.join(", ")}`);
}

export async function assertRunExists(runtimeRoot: string, runId: string): Promise<void> {
  if (!(await exists(runRoot(runtimeRoot, runId)))) throw new Error(`run does not exist: ${runId}`);
}
