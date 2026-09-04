export interface BluepochGameConfig {
  game: "reverse-1999";
  region: "cn";
  language: "zh-cn";
  transport: {
    host: string;
    /** Official-site announcement query endpoint (POST JSON, no credentials). */
    path: string;
    method: "POST";
  };
  articleHost: string;
  officialHosts: string[];
  supportsVersions: boolean;
  checkpoint: { checkpointKind: string | null; defaultLookbackDays: number };
}

export const bluepochGames: Record<BluepochGameConfig["game"], BluepochGameConfig> = {
  "reverse-1999": {
    game: "reverse-1999",
    region: "cn",
    language: "zh-cn",
    transport: {
      host: "re.bluepoch.com",
      path: "/activity/official/websites/information/query",
      method: "POST",
    },
    articleHost: "re.bluepoch.com",
    officialHosts: ["re.bluepoch.com"],
    supportsVersions: true,
    checkpoint: { checkpointKind: null, defaultLookbackDays: 30 },
  },
};
