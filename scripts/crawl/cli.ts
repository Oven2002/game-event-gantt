export type CrawlGame = "genshin-impact" | "honkai-star-rail" | "zenless-zone-zero" | "arknights" | "arknights-endfield";
export type CrawlCommand = "fetch" | "parse" | "review" | "approve";
export interface CliArgs { command: CrawlCommand; game?: CrawlGame; since?: string; full?: boolean; run?: string; selection?: string; }

const games = new Set<CrawlGame>(["genshin-impact", "honkai-star-rail", "zenless-zone-zero", "arknights", "arknights-endfield"]);
const runPattern = /^\d{8}-\d{6}$/;

export function createRunId(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
}

function valueAfter(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

export function parseCliArgs(argv: string[]): CliArgs {
  const command = argv[0] as CrawlCommand | undefined;
  if (!command || !["fetch", "parse", "review", "approve"].includes(command)) throw new Error("unknown command");
  const result: CliArgs = { command, full: false };
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--game") {
      const game = valueAfter(argv, index, flag) as CrawlGame;
      if (!games.has(game)) throw new Error("unknown game");
      result.game = game; index += 1;
    } else if (flag === "--since") {
      result.since = valueAfter(argv, index, flag); index += 1;
    } else if (flag === "--full") {
      result.full = true;
    } else if (flag === "--run") {
      const run = valueAfter(argv, index, flag);
      if (!runPattern.test(run)) throw new Error("invalid run-id");
      result.run = run; index += 1;
    } else if (flag === "--selection") {
      result.selection = valueAfter(argv, index, flag); index += 1;
    } else {
      throw new Error(`unknown flag: ${flag}`);
    }
  }
  if (result.since && result.full) throw new Error("--since and --full are mutually exclusive");
  if (command === "fetch") {
    if (!result.game) throw new Error("fetch requires --game");
    if (!result.since && !result.full) throw new Error("fetch requires --since or --full");
  } else if (!result.run) {
    throw new Error(`${command} requires --run`);
  }
  if (command === "approve" && !result.selection) throw new Error("approve requires --selection");
  return result;
}
