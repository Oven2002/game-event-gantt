import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, rename as fsRename, appendFile, writeFile, stat, rm, utimes } from "node:fs/promises";
import { createInterface } from "node:readline";
import { dirname } from "node:path";

export interface AtomicWriteOptions {
  rename?: (from: string, to: string) => Promise<void>;
}

const fileLocks = new Map<string, Promise<void>>();
export interface FileLockOptions {
  timeoutMs?: number;
  staleMs?: number;
  retryMs?: number;
}

export class FileLockTimeoutError extends Error {
  constructor(filePath: string) {
    super(`timed out waiting for file lock: ${filePath}`);
    this.name = "FileLockTimeoutError";
  }
}

interface ProcessLock {
  path: string;
  token: string;
  heartbeat: NodeJS.Timeout;
}

async function acquireProcessLock(filePath: string, options: FileLockOptions = {}): Promise<ProcessLock> {
  const lockPath = `${filePath}.lock`;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const staleMs = options.staleMs ?? 120_000;
  const retryMs = options.retryMs ?? 25;
  const deadline = Date.now() + timeoutMs;
  const token = `${process.pid}-${randomUUID()}`;
  await ensureParent(filePath);
  while (true) {
    try {
      const handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, token, acquiredAt: new Date().toISOString() }), "utf8");
        await handle.close();
      } catch (error) {
        await handle.close().catch(() => undefined);
        await rm(lockPath, { force: true }).catch(() => undefined);
        throw error;
      }
      const heartbeat = setInterval(() => {
        void utimes(lockPath, new Date(), new Date()).catch(() => undefined);
      }, Math.max(1_000, Math.floor(staleMs / 3)));
      return { path: lockPath, token, heartbeat };
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const lockStat = await stat(lockPath);
        if (Date.now() - lockStat.mtimeMs > staleMs) await rm(lockPath, { force: true });
      } catch (statError: unknown) {
        if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw statError;
      }
      if (Date.now() >= deadline) throw new FileLockTimeoutError(filePath);
      await new Promise((resolve) => setTimeout(resolve, retryMs));
    }
  }
}

async function releaseProcessLock(lock: ProcessLock): Promise<void> {
  clearInterval(lock.heartbeat);
  try {
    const owner = JSON.parse(await readFile(lock.path, "utf8")) as { token?: unknown };
    if (owner.token === lock.token) await rm(lock.path, { force: true });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function withFileLock<T>(filePath: string, operation: () => Promise<T>, options: FileLockOptions = {}): Promise<T> {
  const previous = fileLocks.get(filePath) ?? Promise.resolve();
  let releaseQueue!: () => void;
  const queued = new Promise<void>((resolve) => { releaseQueue = resolve; });
  fileLocks.set(filePath, queued);
  await previous;
  let lock: ProcessLock;
  try {
    lock = await acquireProcessLock(filePath, options);
  } catch (error) {
    releaseQueue();
    if (fileLocks.get(filePath) === queued) fileLocks.delete(filePath);
    throw error;
  }
  try {
    return await operation();
  } finally {
    await releaseProcessLock(lock);
    releaseQueue();
    if (fileLocks.get(filePath) === queued) fileLocks.delete(filePath);
  }
}

export async function tryFileLock<T>(filePath: string, operation: () => Promise<T>, options: FileLockOptions = {}): Promise<{ acquired: true; value: T } | { acquired: false }> {
  let lock: ProcessLock;
  try {
    lock = await acquireProcessLock(filePath, { ...options, timeoutMs: 0 });
  } catch (error: unknown) {
    if (error instanceof FileLockTimeoutError) return { acquired: false };
    throw error;
  }
  try {
    return { acquired: true, value: await operation() };
  } finally {
    await releaseProcessLock(lock);
  }
}

async function ensureParent(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
}

function tempPath(filePath: string): string {
  return `${filePath}.tmp-${process.pid}-${randomUUID()}`;
}

async function writeJsonAtomicUnlocked(filePath: string, value: unknown, options: AtomicWriteOptions = {}): Promise<void> {
  await ensureParent(filePath);
  const temporary = tempPath(filePath);
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, "utf8");
    await (options.rename ?? fsRename)(temporary, filePath);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function writeJsonAtomic(filePath: string, value: unknown, options: AtomicWriteOptions = {}): Promise<void> {
  return withFileLock(filePath, () => writeJsonAtomicUnlocked(filePath, value, options));
}

export async function updateJsonAtomic<T>(
  filePath: string,
  initialValue: T,
  updater: (current: T) => T | Promise<T>,
  options: AtomicWriteOptions = {},
): Promise<T> {
  return withFileLock(filePath, async () => {
    let current = initialValue;
    try {
      current = JSON.parse(await readFile(filePath, "utf8")) as T;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const nextValue = await updater(current);
    await writeJsonAtomicUnlocked(filePath, nextValue, options);
    return nextValue;
  });
}

async function writeJsonlAtomicUnlocked(filePath: string, values: readonly unknown[], options: AtomicWriteOptions = {}): Promise<void> {
  await ensureParent(filePath);
  const temporary = tempPath(filePath);
  try {
    await writeFile(temporary, values.map((value) => JSON.stringify(value)).join("\n") + (values.length > 0 ? "\n" : ""), "utf8");
    await (options.rename ?? fsRename)(temporary, filePath);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function writeJsonlAtomic(filePath: string, values: readonly unknown[], options: AtomicWriteOptions = {}): Promise<void> {
  return withFileLock(filePath, () => writeJsonlAtomicUnlocked(filePath, values, options));
}

export async function readJsonAtomic(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function appendJsonlUnlocked(filePath: string, value: unknown): Promise<void> {
  await ensureParent(filePath);
  let prefix = "";
  try {
    if ((await stat(filePath)).size > 0) prefix = "\n";
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await appendFile(filePath, `${prefix}${JSON.stringify(value)}\n`, "utf8");
}

export async function appendJsonl(filePath: string, value: unknown): Promise<void> {
  return withFileLock(filePath, () => appendJsonlUnlocked(filePath, value));
}

export async function appendJsonlIfUnique<T>(filePath: string, value: T, keyOf: (value: T) => string): Promise<boolean> {
  return withFileLock(filePath, async () => {
    try {
      const input = createReadStream(filePath, { encoding: "utf8" });
      const lines = createInterface({ input, crlfDelay: Infinity });
      try {
        for await (const line of lines) {
          if (line.trim().length > 0 && keyOf(JSON.parse(line)) === keyOf(value)) return false;
        }
      } finally {
        lines.close();
        input.destroy();
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await appendJsonlUnlocked(filePath, value);
    return true;
  });
}

export async function readJsonl(filePath: string): Promise<unknown[]> {
  const text = await readFile(filePath, "utf8");
  return text.split(/\r?\n/).filter((line) => line.trim().length > 0).map((line) => JSON.parse(line));
}
