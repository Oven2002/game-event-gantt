# 二游版本活动时间表

一个社区数据驱动的**二次元手游版本、卡池与活动甘特图**。使用北京时间（UTC+8）精确到分钟展示排期，一眼看清现在与接下来会发生什么。

> 在线站点：<https://gameg.site/>

## 特性

- **甘特图时间轴**：按游戏分组，支持缩放、拖动和一键回到今天。
- **面向未来的默认视窗**：默认显示过去 7 天与未来 21 天。
- **精确到分钟**：所有时间使用带 `+08:00` 偏移的 ISO 8601 格式。
- **多维度筛选**：按游戏、服务器、活动类型和状态过滤。
- **记住浏览偏好**：在本地保存筛选和游戏分组的展开状态。
- **点击查看详情**：展示条目时间、备注、关联版本和数据来源。
- **社区维护**：数据存放在公开 YAML 文件中，通过 Issue 和 Pull Request 更新。

## 已收录游戏（国服）

| 游戏 | 厂商 |
|---|---|
| 原神 | 米哈游 |
| 崩坏：星穹铁道 | 米哈游 |
| 绝区零 | 米哈游 |
| 明日方舟 | 鹰角网络 |
| 明日方舟：终末地 | 鹰角网络 |
| 鸣潮 | 库洛游戏 |
| 碧蓝航线 | 蛮啾 / 悠星 |
| 异环 | 完美世界（幻塔工作室） |

## 我想贡献数据

小型修正可以直接使用 GitHub 网页编辑，不要求本地安装开发环境：

- [修正已有时间、名称或备注](./CONTRIBUTING.md#修正已有时间名称或备注)
- [新增活动或版本](./CONTRIBUTING.md#新增活动或版本)
- [新增游戏或服务器](./CONTRIBUTING.md#新增游戏或服务器)
- 不会编辑 YAML 时，使用仓库的“新增或修正时间表条目”Issue 模板提交资料。

完整字段、来源政策和提交流程见 **[CONTRIBUTING.md](./CONTRIBUTING.md)**。

## 项目结构

```text
data/       游戏、服务器、版本和活动 YAML 数据
src/        Astro 页面、时间轴脚本和数据校验逻辑
tests/      数据规则与时间轴工具单元测试
.github/    CI、Issue 和 PR 模板
```

每个游戏拥有独立的 `data/<game-id>/` 目录，数据可以按服务器、年份或版本拆成多个文件，以减少 Pull Request 冲突。

## 本地开发

需要 **Node.js 22+**。

```bash
npm ci
npm run dev            # 启动开发服务器
npm run validate:data  # 校验 YAML 和跨文件业务规则
npm test               # 运行单元测试
npm run build          # 数据校验 + 类型检查 + 生产构建
```

## 部署

线上站点由 **Cloudflare Pages** 托管（<https://gameg.site/>）。在 Cloudflare Pages 中关联本仓库后，推送到 `main` 会自动构建并部署：

- 构建命令：`npm run build`（包含数据校验与类型检查）
- 构建输出目录：`dist`

GitHub 侧的工作流（`.github/workflows/ci.yml`）负责把关：每个 Pull Request 以及推送到 `main` 的提交都会运行数据校验、单元测试与生产构建。站点部署本身由 Cloudflare Pages 完成，GitHub Actions 不参与发布。

## 技术栈

- [Astro](https://astro.build/) 7（静态站点）
- TypeScript + Zod（数据加载与校验）
- Vitest（单元测试）
- 原生 SVG 甘特图（无第三方图表库）

## 许可

代码基于 [MIT](./LICENSE) 许可。社区数据和时间仅供参考，请以游戏官方公告为准。

站点同时包含采用其他许可证发布的第三方字体、Live2D 组件、Cubism Core，以及 Mao Niziiro、Hibiki 官方示例模型；它们不适用本站 MIT 许可。完整来源、固定版本、版权声明和许可链接见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
