export interface OfficialSourceAccount {
  platform: "bilibili" | "weibo" | "miyoushe" | "taptap";
  accountId: string;
  profileUrl: string;
  game: string;
  region: "cn";
}

export const officialSourceAccounts: OfficialSourceAccount[] = [
  { platform: "bilibili", accountId: "1265652806", profileUrl: "https://space.bilibili.com/1265652806", game: "arknights-endfield", region: "cn" },
  { platform: "bilibili", accountId: "626796832", profileUrl: "https://space.bilibili.com/626796832", game: "roco-world", region: "cn" },
  { platform: "bilibili", accountId: "3546636978489848", profileUrl: "https://space.bilibili.com/3546636978489848", game: "neverness-to-everness", region: "cn" },
  { platform: "weibo", accountId: "5770760941", profileUrl: "https://weibo.com/u/5770760941", game: "azur-lane", region: "cn" },
];
