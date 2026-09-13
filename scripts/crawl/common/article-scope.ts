export type ArticleScopeSkipCode =
  | "character_profile"
  | "music"
  | "wallpaper"
  | "merchandise"
  | "production_report";

export interface ArticleScopeSkip {
  code: ArticleScopeSkipCode;
  label: string;
}

interface ScopeRule {
  code: ArticleScopeSkipCode;
  label: string;
  pattern: RegExp;
}

// These rules intentionally match only high-confidence non-timeline article headings.
const scopeRules: readonly ScopeRule[] = [
  { code: "character_profile", label: "角色档案/生日/角色媒体", pattern: /代理人档案|角色档案|生日快乐|角色头像|代理人机制介绍|代理人未归档影像|轶事|侧记|近闻/ },
  { code: "music", label: "音乐/配音媒体", pattern: /音乐平台|音乐|配音演员|(?:^|[^A-Za-z])EP(?:$|[^A-Za-z])/i },
  { code: "wallpaper", label: "壁纸/视频媒体", pattern: /壁纸|表情包|过场动画|剧情PV|版本PV|PV[：:]/ },
  { code: "merchandise", label: "周边/手办/商品", pattern: /新品情报|周边(?:上新|旗舰店|预售|贩售)|手办|粘土人|服饰.*上新/ },
  { code: "production_report", label: "制作组/研发通讯", pattern: /制作组(?:通讯|播报)|研发通讯/ },
];

function headingText(title: string, content: string): string {
  // Some Hypergryph pages expose a generic list title; use only the first two
  // non-empty content lines as a bounded fallback, not the full article body.
  const contentHeadings = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 2);
  return [title.trim(), ...contentHeadings].filter(Boolean).join("\n");
}

export function classifyArticleScope(title: string, content = ""): ArticleScopeSkip | undefined {
  const normalizedTitle = title.trim();
  const titleMatch = scopeRules.find((rule) => rule.pattern.test(normalizedTitle));
  if (titleMatch) return titleMatch;
  // Some Hypergryph pages expose a generic list title such as "官方网站".
  // Only then inspect the bounded content heading fallback.
  if (/官方网站/.test(normalizedTitle)) return scopeRules.find((rule) => rule.pattern.test(headingText(normalizedTitle, content)));
  return undefined;
}
