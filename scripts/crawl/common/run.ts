import { access, lstat, mkdir, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const RUN_ARTIFACTS = ["raw", "errors", "rejections", "candidates", "reports", "selections", "approved"] as const;
export type RunArtifact = typeof RUN_ARTIFACTS[number];

const runIdPattern = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/;
const pathSegmentPattern = /^[a-z0-9][a-z0-9-]*$/;

function isWithin(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

async function nearestExisting(path: string): Promise<string> {
  let current = resolve(path);
  while (true) {
    try {
      await access(current);
      return current;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) return current;
      current = parent;
    }
  }
}

export async function assertRuntimeRootSafe(runtimeRoot: string, protectedRoot = resolve(process.cwd(), "data")): Promise<void> {
  const resolvedRoot = resolve(runtimeRoot);
  const protectedReal = await realpath(await nearestExisting(protectedRoot));
  const rootExisting = await nearestExisting(resolvedRoot);
  const rootReal = await realpath(rootExisting);
  try {
    if ((await lstat(resolvedRoot)).isSymbolicLink()) throw new Error(`runtime root must not be a symlink: ${resolvedRoot}`);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (isWithin(protectedReal, rootReal)) throw new Error(`runtime root is inside protected data: ${resolvedRoot}`);
}

export async function assertRuntimePathSafe(runtimeRoot: string, targetPath: string): Promise<void> {
  await assertRuntimeRootSafe(runtimeRoot);
  const resolvedRoot = resolve(runtimeRoot);
  const resolvedTarget = resolve(targetPath);
  if (!isWithin(resolvedRoot, resolvedTarget)) throw new Error(`runtime path is outside runtime root: ${resolvedTarget}`);
  try {
    if ((await lstat(resolvedTarget)).isSymbolicLink()) throw new Error(`runtime path must not be a symlink: ${resolvedTarget}`);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const rootReal = await realpath(await nearestExisting(resolvedRoot));
  const parentReal = await realpath(await nearestExisting(dirname(resolvedTarget)));
  if (!isWithin(rootReal, parentReal)) throw new Error(`runtime path escapes runtime root: ${resolvedTarget}`);
}

export function assertRunId(runId: string): void {
  const match = runIdPattern.exec(runId);
  if (!match) throw new Error(`invalid run-id: ${runId}`);
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const date = new Date(0);
  date.setUTCFullYear(Number(yearText), Number(monthText) - 1, Number(dayText));
  date.setUTCHours(Number(hourText), Number(minuteText), Number(secondText), 0);
  if (
    date.getUTCFullYear() !== Number(yearText)
    || date.getUTCMonth() !== Number(monthText) - 1
    || date.getUTCDate() !== Number(dayText)
    || date.getUTCHours() !== Number(hourText)
    || date.getUTCMinutes() !== Number(minuteText)
    || date.getUTCSeconds() !== Number(secondText)
  ) throw new Error(`invalid run-id: ${runId}`);
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
  if (!(RUN_ARTIFACTS as readonly string[]).includes(artifact as string)) throw new Error(`invalid artifact: ${String(artifact)}`);
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
  await assertRuntimeRootSafe(runtimeRoot);
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
