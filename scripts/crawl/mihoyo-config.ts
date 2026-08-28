export interface MihoyoGameConfig {
  game: "genshin-impact" | "honkai-star-rail" | "zenless-zone-zero";
  region: "cn";
  language: "zh-cn";
  appId: string;
  listAppId?: string;
  channels: number[];
  contentChannels: number[];
  apiHost: string;
  articleHost: string;
  officialHosts: string[];
  supportsVersions: true;
  checkpoint: {
    checkpointKind: string | null;
    defaultLookbackDays: number;
  };
}

export const mihoyoGames: Record<"genshin-impact" | "honkai-star-rail" | "zenless-zone-zero", MihoyoGameConfig> = {
  "genshin-impact": {
    game: "genshin-impact",
    region: "cn",
    language: "zh-cn",
    appId: "16471662a82d418a",
    listAppId: "43",
    channels: [719],
    contentChannels: [719, 720, 721, 723],
    apiHost: "act-api-takumi-static.mihoyo.com",
    articleHost: "ys.mihoyo.com",
    officialHosts: ["act-api-takumi-static.mihoyo.com", "ys.mihoyo.com"],
    supportsVersions: true,
    checkpoint: { checkpointKind: null, defaultLookbackDays: 30 },
  },
  "honkai-star-rail": {
    game: "honkai-star-rail",
    region: "cn",
    language: "zh-cn",
    appId: "1963de8dc19e461c",
    channels: [257],
    contentChannels: [257],
    apiHost: "act-api-takumi-static.mihoyo.com",
    articleHost: "sr.mihoyo.com",
    officialHosts: ["act-api-takumi-static.mihoyo.com", "sr.mihoyo.com"],
    supportsVersions: true,
    checkpoint: { checkpointKind: null, defaultLookbackDays: 30 },
  },
  "zenless-zone-zero": {
    game: "zenless-zone-zero",
    region: "cn",
    language: "zh-cn",
    appId: "706fd13a87294881",
    channels: [278],
    contentChannels: [278],
    apiHost: "api-takumi-static.mihoyo.com",
    articleHost: "zzz.mihoyo.com",
    officialHosts: ["api-takumi-static.mihoyo.com", "zzz.mihoyo.com"],
    supportsVersions: true,
    checkpoint: { checkpointKind: null, defaultLookbackDays: 30 },
  },
};
