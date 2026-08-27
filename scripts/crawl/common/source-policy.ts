import { officialSourceAccounts } from "../source-accounts.ts";

export type SourceRole = "official" | "discovery" | "rejected";
export type SourcePlatform = "bilibili" | "weibo" | "miyoushe" | "taptap";
export interface SourceDecision { allowed: boolean; role: SourceRole; reason: string; }

const officialHosts: Record<string, string[]> = {
  "genshin-impact": ["ys.mihoyo.com", "act-api-takumi-static.mihoyo.com"],
  "honkai-star-rail": ["sr.mihoyo.com", "act-api-takumi-static.mihoyo.com"],
  "zenless-zone-zero": ["zenless.hoyoverse.com", "sg-public-api-static.hoyoverse.com"],
  arknights: ["ak.hypergryph.com"],
  "arknights-endfield": ["endfield.hypergryph.com"],
};
const rejectedHosts = new Set(["forum.gamer.com.tw", "news.17173.com", "m.ali213.net", "www.gamersky.com", "facebook.com", "www.facebook.com"]);

export function isDiscoveryOnlySource(rawUrl: string): boolean {
  try { return new URL(rawUrl).hostname.toLowerCase().split(".").slice(-2).join(".") === "zhihu.com"; } catch { return false; }
}

export function evaluateSource(game: string, rawUrl: string, context: { platform?: SourcePlatform; authorId?: string; authorProfileUrl?: string } = {}): SourceDecision {
  let url: URL;
  try { url = new URL(rawUrl); } catch { return { allowed: false, role: "rejected", reason: "invalid URL" }; }
  const host = url.hostname.toLowerCase();
  if (isDiscoveryOnlySource(rawUrl)) return { allowed: false, role: "discovery", reason: "Zhihu is discovery-only" };
  if (url.protocol !== "https:" || url.username || url.password || (url.port !== "" && url.port !== "443")) return { allowed: false, role: "rejected", reason: "HTTPS on the default port without credentials is required" };
  if (rejectedHosts.has(host) || host.endsWith("gamer.com.tw") || /(^|\/)zh-tw(?:\/|$)/i.test(url.pathname)) return { allowed: false, role: "rejected", reason: "foreign-server or third-party source" };
  const configured = officialHosts[game] ?? [];
  if (configured.includes(host)) return { allowed: true, role: "official", reason: "configured CN official host" };
  const platform = host === "www.bilibili.com" ? "bilibili" : host === "www.weibo.com" ? "weibo" : host === "www.miyoushe.com" ? "miyoushe" : host === "www.taptap.cn" ? "taptap" : undefined;
  if (platform) {
    const account = officialSourceAccounts.find((item) => item.platform === platform && item.game === game && item.region === "cn");
    if (!account) return { allowed: false, role: "rejected", reason: "official account is not configured" };
    if (context.platform !== platform || context.authorId !== account.accountId || context.authorProfileUrl !== account.profileUrl) return { allowed: false, role: "rejected", reason: "official account identity is not verified" };
    return { allowed: true, role: "official", reason: "configured official account identity" };
  }
  return { allowed: false, role: "rejected", reason: "host is not configured for this game" };
}
