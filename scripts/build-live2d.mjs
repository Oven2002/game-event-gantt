import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const widgetRoot = path.join(root, "vendor/live2d-widget");
const sourceDist = path.join(widgetRoot, "dist");
const publicDist = path.join(root, "public/vendor/live2d-widget/dist");

const npmCli = process.env.npm_execpath;
if (!npmCli) {
  throw new Error("npm_execpath is unavailable; run this script through npm run build:live2d");
}

execFileSync(process.execPath, [npmCli, "run", "build:runtime"], {
  cwd: widgetRoot,
  stdio: "inherit",
});

const artifacts = [
  "waifu-tips.js",
  "waifu-tips.js.map",
  "chunk/logger.js",
  "chunk/logger.js.map",
];

for (const artifact of artifacts) {
  const destination = path.join(publicDist, artifact);
  mkdirSync(path.dirname(destination), { recursive: true });
  copyFileSync(path.join(sourceDist, artifact), destination);
}

execFileSync(process.execPath, [path.join(root, "scripts/patch-live2d-cubism.mjs")], {
  cwd: root,
  stdio: "inherit",
});

console.log(`Synced ${artifacts.length} Live2D runtime artifacts to public/.`);
