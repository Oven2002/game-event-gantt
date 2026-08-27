import { updateStateAtomic } from "../../scripts/crawl/common/state.ts";
import { sha256Utf8 } from "../../scripts/crawl/common/hash.ts";
import type { Sha256 } from "../../scripts/crawl/types.ts";

const [statePath, game, sourceId] = process.argv.slice(2);
if (!statePath || !game || !sourceId) throw new Error("state worker requires state path, game, and source id");
const contentHash = sha256Utf8(`${game}:${sourceId}`) as Sha256;
await updateStateAtomic(statePath, { schemaVersion: 1, games: {} }, (current) => ({
  schemaVersion: 1,
  games: {
    ...current.games,
    [game]: {
      checkpoint: null,
      sourceHashes: { ...(current.games[game]?.sourceHashes ?? {}), [sourceId]: contentHash },
    },
  },
}), {
  checkpointSchemas: {},
  knownGames: { "genshin-impact": null, "honkai-star-rail": null },
});
process.stdout.write(`${game}:${sourceId}\n`);
