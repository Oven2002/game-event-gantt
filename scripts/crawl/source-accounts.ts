export interface OfficialSourceAccount {
  platform: "bilibili" | "weibo" | "miyoushe" | "taptap";
  accountId: string;
  profileUrl: string;
  game: string;
  region: "cn";
}

export const officialSourceAccounts: OfficialSourceAccount[] = [
  { platform: "bilibili", accountId: "1265652806", profileUrl: "https://space.bilibili.com/1265652806", game: "arknights-endfield", region: "cn" },
];
