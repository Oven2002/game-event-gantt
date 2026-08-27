import { access, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";

export const RUN_ARTIFACTS = ["raw", "errors", "rejections", "candidates", "reports", "selections", "approved"] as const;
export type RunArtifact = typeof RUN_ARTIFACTS[number];

const runIdPattern = /^\d{8}-\d{6}$/;
const pathSegmentPattern = /^[a-z0-9][a-z0-9-]*$/;

export function assertRunId(runId: string): void {
  if (!runIdPattern.test(runId)) throw new Error(`invalid run-id: ${runId}`);
}

function assertPathSegment(value: string, label: string): void {
  if (!pathSegmentPattern.test(value)) throw new Error(`invalid ${label}: ${value}`);
}

function extension(suffix: string): string {
  const value = suffix.startsWith(".") ? suffix.slice(1) : suffix;
  if (!/^[a-z0-9]+$/.test(value)) throw new Error(`invalid suffix: ${suffix}`);
  return value;
}

export function runRoot(runtimeRoot: string, runId: string): string {
  assertRunId(runId);
  return join(runtimeRoot, "runs", runId);
}

export function artifactDirectory(runtimeRoot: string, runId: string, artifact: RunArtifact): string {
  assertRunId(runId);
  return artifact === "raw" || artifact === "candidates"
    ? join(runtimeRoot, artifact, runId)
    : join(runtimeRoot, artifact);
}

export function artifactPath(runtimeRoot: string, runId: string, artifact: RunArtifact, suffix = "jsonl", game?: string): string {
  const ext = extension(suffix);
  if (artifact === "raw" || artifact === "candidates") {
    if (!game) throw new Error(`${artifact} artifact requires game`);
    assertPathSegment(game, "game");
    return join(artifactDirectory(runtimeRoot, runId, artifact), `${game}.${ext}`);
  }
  const directory = artifactDirectory(runtimeRoot, runId, artifact);
  if (artifact === "selections") return join(directory, `${runId}.template.${ext}`);
  return join(directory, `${runId}.${ext}`);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function artifactExists(runtimeRoot: string, runId: string, artifact: RunArtifact): Promise<string | undefined> {
  if (artifact === "raw" || artifact === "candidates") {
    const directory = artifactDirectory(runtimeRoot, runId, artifact);
    try {
      return (await readdir(directory, { withFileTypes: true })).length > 0 ? directory : undefined;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
  const suffixes = artifact === "reports" ? ["md", "json"] : artifact === "selections" ? ["json", "jsonl"] : ["jsonl", "json"];
  for (const suffix of suffixes) {
    const path = artifactPath(runtimeRoot, runId, artifact, suffix);
    if (await exists(path)) return path;
  }
  return undefined;
}

export async function createRun(runtimeRoot: string, runId: string): Promise<string> {
  assertRunId(runId);
  await assertRunArtifactsAbsent(runtimeRoot, runId, RUN_ARTIFACTS);
  const root = runRoot(runtimeRoot, runId);
  await mkdir(join(runtimeRoot, "runs"), { recursive: true });
  try {
    await mkdir(root);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`run already exists: ${runId}`);
    throw error;
  }
  return root;
}

export async function assertRunArtifactsAbsent(runtimeRoot: string, runId: string, artifacts: readonly RunArtifact[]): Promise<void> {
  assertRunId(runId);
  const present: string[] = [];
  for (const artifact of artifacts) {
    const path = await artifactExists(runtimeRoot, runId, artifact);
    if (path) present.push(path);
  }
  if (present.length > 0) throw new Error(`run artifacts already exist: ${present.join(", ")}`);
}

export async function assertRunExists(runtimeRoot: string, runId: string): Promise<void> {
  if (!(await exists(runRoot(runtimeRoot, runId)))) throw new Error(`run does not exist: ${runId}`);
}
