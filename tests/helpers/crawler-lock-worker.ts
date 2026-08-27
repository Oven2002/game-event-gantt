import { appendFile } from "node:fs/promises";
import { withFileLock } from "../../scripts/crawl/common/files.ts";

const [lockPath, outputPath, id, delayText] = process.argv.slice(2);
if (!lockPath || !outputPath || !id || !delayText) throw new Error("lock worker requires lock path, output path, id, and delay");
const delay = Number(delayText);
await withFileLock(lockPath, async () => {
  await new Promise((resolve) => setTimeout(resolve, delay));
  await appendFile(outputPath, `${id}\n`, "utf8");
});
process.stdout.write(`${id}:${Date.now()}\n`);
