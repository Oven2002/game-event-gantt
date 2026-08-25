import { createReadStream } from "node:fs";
import { mkdir, readFile, rename as fsRename, appendFile, writeFile, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { dirname } from "node:path";

interface AtomicWriteOptions {
  rename?: (from: string, to: string) => Promise<void>;
}

async function ensureParent(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
}

function tempPath(filePath: string): string {
  return `${filePath}.tmp-${process.pid}-${Date.now()}`;
}

export async function writeJsonAtomic(filePath: string, value: unknown, options: AtomicWriteOptions = {}): Promise<void> {
  await ensureParent(filePath);
  const temporary = tempPath(filePath);
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, "utf8");
    await (options.rename ?? fsRename)(temporary, filePath);
  } catch (error) {
    await import("node:fs/promises").then(({ rm }) => rm(temporary, { force: true })).catch(() => undefined);
    throw error;
  }
}

export async function readJsonAtomic(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, "utf8"));
}

export async function appendJsonl(filePath: string, value: unknown): Promise<void> {
  await ensureParent(filePath);
  let prefix = "";
  try {
    if ((await stat(filePath)).size > 0) prefix = "\n";
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await appendFile(filePath, `${prefix}${JSON.stringify(value)}\n`, "utf8");
}

export async function appendJsonlIfUnique<T>(filePath: string, value: T, keyOf: (value: T) => string): Promise<boolean> {
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
  await appendJsonl(filePath, value);
  return true;
}

export async function readJsonl(filePath: string): Promise<unknown[]> {
  const text = await readFile(filePath, "utf8");
  return text.split(/\r?\n/).filter((line) => line.trim().length > 0).map((line) => JSON.parse(line));
}
