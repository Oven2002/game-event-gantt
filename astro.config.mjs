import { defineConfig } from "astro/config";

const [owner, repository] = (process.env.GITHUB_REPOSITORY ?? "/").split("/");
const onGitHubPages = process.env.GITHUB_ACTIONS === "true" && owner && repository;

export default defineConfig({
  output: "static",
  site: onGitHubPages ? `https://${owner}.github.io` : undefined,
  base: onGitHubPages ? `/${repository}` : "/",
});
