# 二游版本活动时间表

一个由社区数据驱动的静态甘特图站点，用北京时间展示多个游戏、服务器的版本、活动和单点日程。

## 本地开发

需要 Node.js 22 或更新版本。

```bash
npm install
npm run validate:data
npm run dev
```

完整检查：

```bash
npm test
npm run build
```

数据格式和提交流程见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

## 部署

仓库包含 GitHub Pages 工作流。启用方式：

1. 在仓库 Settings → Pages 中将 Source 设为 **GitHub Actions**。
2. 合并到 `main` 后，工作流会校验、构建并部署站点。

Astro 会在 GitHub Actions 中根据 `GITHUB_REPOSITORY` 自动设置项目站点的 `base` 路径。
