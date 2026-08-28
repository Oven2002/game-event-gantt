export interface HypergryphGameConfig {
  game: "arknights" | "arknights-endfield";
  region: "cn";
  language: "zh-cn";
  apiCode: "arknights" | "endfield_web";
  officialHost: string;
  supportsVersions: boolean;
  checkpoint: { checkpointKind: string | null; defaultLookbackDays: number };
}

export const hypergryphGames: Record<HypergryphGameConfig["game"], HypergryphGameConfig> = {
  arknights: {
    game: "arknights",
    region: "cn",
    language: "zh-cn",
    apiCode: "arknights",
    officialHost: "ak.hypergryph.com",
    supportsVersions: false,
    checkpoint: { checkpointKind: null, defaultLookbackDays: 30 },
  },
  "arknights-endfield": {
    game: "arknights-endfield",
    region: "cn",
    language: "zh-cn",
    apiCode: "endfield_web",
    officialHost: "endfield.hypergryph.com",
    supportsVersions: true,
    checkpoint: { checkpointKind: null, defaultLookbackDays: 30 },
  },
};
