export interface PostroomGameConfig {
  game: "light-and-night";
  region: "cn";
  language: "zh-cn";
  transport: {
    host: string;
    /** Static JSON list endpoint; `{channelId}/{releaseId}.list.json` shape. */
    listPath: string;
    /** Per-article metadata; `{publishId}.preview.json` shape. */
    previewPath: string;
    /** Per-article full HTML body; `{publishId}.content.json` shape. */
    contentPath: string;
  };
  articleHost: string;
  officialHosts: string[];
  supportsVersions: boolean;
  checkpoint: { checkpointKind: string | null; defaultLookbackDays: number };
}

export const postroomGames: Record<PostroomGameConfig["game"], PostroomGameConfig> = {
  "light-and-night": {
    game: "light-and-night",
    region: "cn",
    language: "zh-cn",
    transport: {
      host: "press-static-love.aurora.qq.com",
      listPath: "/6lvxlBd9id/latest.list.json",
      previewPath: "/{publishId}.preview.json",
      contentPath: "/{publishId}.content.json",
    },
    articleHost: "love.qq.com",
    officialHosts: ["press-static-love.aurora.qq.com", "love.qq.com"],
    supportsVersions: true,
    checkpoint: { checkpointKind: null, defaultLookbackDays: 30 },
  },
};
