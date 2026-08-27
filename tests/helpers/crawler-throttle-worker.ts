import { fetchOfficial } from "../../scripts/crawl/common/http.ts";

const [label] = process.argv.slice(2);
if (!label) throw new Error("throttle worker requires a label");
await fetchOfficial("https://example.com/throttle", {
  allowedHosts: ["example.com"],
  lookup: async () => ["93.184.216.34"],
  minHostIntervalMs: 250,
  retryDelaysMs: [],
  fetchImpl: async () => new Response("ok", { status: 200, headers: { "content-type": "application/json" } }),
});
process.stdout.write(`${label}:${Date.now()}\n`);
