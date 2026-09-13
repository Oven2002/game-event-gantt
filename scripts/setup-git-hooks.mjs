import { execFileSync } from "node:child_process";

try {
  execFileSync("git", ["rev-parse", "--show-toplevel"], { stdio: "ignore" });
  execFileSync("git", ["config", "core.hooksPath", ".githooks"], { stdio: "inherit" });
  console.log("git hooks: .githooks enabled");
} catch {
  console.log("git hooks: skipped outside a Git worktree");
}
