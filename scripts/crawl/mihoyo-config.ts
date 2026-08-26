export interface MihoyoGameConfig {
  game: "genshin-impact" | "honkai-star-rail" | "zenless-zone-zero";
  appId: string;
  channels: number[];
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
    appId: "16471662a82d418a",
    channels: [719],
    officialHosts: ["act-api-takumi-static.mihoyo.com", "ys.mihoyo.com"],
    supportsVersions: true,
    checkpoint: { checkpointKind: null, defaultLookbackDays: 30 },
  },
  "honkai-star-rail": {
    game: "honkai-star-rail",
    appId: "1963de8dc19e461c",
    channels: [257],
    officialHosts: ["act-api-takumi-static.mihoyo.com", "sr.mihoyo.com"],
    supportsVersions: true,
    checkpoint: { checkpointKind: null, defaultLookbackDays: 30 },
  },
  "zenless-zone-zero": {
    game: "zenless-zone-zero",
    appId: "3e9196a4b9274bd7",
    channels: [295],
    officialHosts: ["sg-public-api-static.hoyoverse.com", "zenless.hoyoverse.com"],
    supportsVersions: true,
    checkpoint: { checkpointKind: null, defaultLookbackDays: 30 },
  },
};
