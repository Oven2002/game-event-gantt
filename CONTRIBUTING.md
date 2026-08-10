# 贡献指南

感谢帮助维护时间表。你可以直接修改 YAML 提交 Pull Request，也可以通过 Issue 提供资料，由维护者代为录入。

## 选择贡献方式

### GitHub 网页编辑

适合修正一个时间、名称、备注或来源：

1. 在 `data/` 中找到对应游戏和年份的 YAML 文件。
2. 点击文件右上角的铅笔图标 **Edit this file**。
3. 修改已有条目，或按下方示例新增条目。
4. 点击 **Propose changes**；GitHub 会引导你创建分支或 Fork。
5. 创建 Pull Request，填写修改内容和数据来源。
6. 等待 Actions 完成自动校验；失败日志会指出文件和字段。

不会编辑 YAML 时，请使用“新增或修正时间表条目”Issue 模板。Issue 可以填写普通北京时间，维护者会转换为严格格式。

### 本地 Git

适合新增游戏、批量数据或修改代码：

```bash
git clone https://github.com/<你的账号>/game-event-gantt.git
cd game-event-gantt
npm ci
git switch -c data/<简短主题>

npm run validate:data
npm test
npm run build
```

请让一个 Pull Request 只包含一组相关修改，不要混入无关格式化。

## 修正已有时间、名称或备注

1. 在仓库中搜索条目的 `id`，找到它当前所在的文件；本地可以使用 `rg 'id: banner-7-0-upper' data`。
2. 直接修改原条目，不要复制出一个新条目。
3. 保留原有 `id`；显示名称变化不是修改 ID 的理由。
4. 时间变更时新增或更新 `sources`。仅修改措辞时也应确保来源仍然有效。
5. 如果时间是预估值，在 `note` 中写明预估的是哪个字段、依据是什么以及等待什么官方信息。

只改备注时，仅修改 `note`，不要顺手调整未经核实的时间。例如：

```yaml
note: "end 为预估时间，按连续两个版本均为 42 天推算，等待官方更新公告"
```

## 新增活动或版本

先选择 `data/<game-id>/` 下对应服务器和年份的文件。推荐命名为 `<region>-<year>.yaml`；数据较多时可以继续按版本拆分。同一游戏和服务器的多个文件会在构建时自动合并。

### 新增版本

版本必须有结束时间，且不能与同服务器的其他版本重叠：

```yaml
game: genshin-impact
region: cn

versions:
  - id: "7.0"
    name: "7.0 无神怜爱的雪国"
    start: "2026-08-12T06:00:00+08:00"
    end: "2026-09-23T18:00:00+08:00"
    sources:
      - "https://ys.mihoyo.com/main/news/detail/165475"
```

### 新增区间活动

有 `end` 的活动会显示为横条：

```yaml
events:
  - id: banner-7-0-upper
    name: "7.0 上半卡池"
    type: banner
    start: "2026-08-12T06:00:00+08:00"
    end: "2026-09-01T17:59:00+08:00"
    related: ["7.0"]
    url: "https://ys.mihoyo.com/"
    sources:
      - "https://ys.mihoyo.com/main/news/detail/165472"
```

### 新增单点事件

直播等单点事件省略 `end`。单点在到达 `start` 后会进入“已结束”，不会持续显示为“进行中”：

```yaml
events:
  - id: preview-7-0
    name: "7.0 前瞻直播"
    type: preview
    start: "2026-07-31T20:00:00+08:00"
    related: ["7.0"]
    sources:
      - "https://ys.mihoyo.com/main/news/detail/165422"
```

## 新增游戏或服务器

### 新增游戏

1. 选择稳定的小写英文游戏 ID，例如 `demo-game`。
2. 创建同名目录 `data/demo-game/`。
3. 创建 `meta.yaml`：

```yaml
id: demo-game
name: "示例游戏"
regions:
  - id: cn
    name: "国服"
```

4. 创建至少一个包含非空 `versions` 或 `events` 的数据文件，例如 `cn-2026.yaml`。
5. 运行完整校验，确认目录名、游戏 ID 和 region 相互匹配。

`priority` 可省略。数值越大，游戏越靠上；未填写时为 `0`，负数排在默认项之后。

### 新增服务器

先在游戏的 `meta.yaml` 的 `regions` 中注册服务器：

```yaml
regions:
  - id: cn
    name: "国服"
  - id: global
    name: "国际服"
```

然后创建 `global-2026.yaml`，并在文件根节点填写 `region: global`。不同服务器的数据和版本 ID 分别校验。

### 新增活动类型

优先复用 `data/event-types.yaml` 中已有的 `event`、`banner`、`preview` 和 `maintenance`。只有语义确实不适用时才新增全局类型：

```yaml
types:
  - id: rerun
    name: "复刻活动"
```

类型 ID 必须是稳定的小写英文 ID；新增后才能在活动的 `type` 中引用。

## YAML Schema 参考

### 数据文件根节点

| 字段 | 必填 | 说明 |
|---|---|---|
| `game` | 是 | 必须等于目录中 `meta.yaml` 的游戏 ID |
| `region` | 是 | 必须已在 `meta.yaml` 的 `regions` 中声明 |
| `versions` | 条件 | 版本数组 |
| `events` | 条件 | 活动数组 |

`versions` 和 `events` 至少有一个非空数组。

### 版本与活动字段

| 字段 | 版本 | 活动 | 说明 |
|---|---|---|---|
| `id` | 必填 | 必填 | 稳定且唯一的机器 ID |
| `name` | 必填 | 必填 | 页面显示名称 |
| `start` | 必填 | 必填 | 北京时间 |
| `end` | 必填 | 可选 | 活动省略时表示单点 |
| `type` | — | 必填 | 全局活动类型 ID |
| `sources` | 必填 | 必填 | 至少一个公开 HTTP(S) 核验链接 |
| `url` | 可选 | 可选 | 用户点击后打开的详情页 |
| `note` | 可选 | 可选 | 简短补充或预估说明 |
| `related` | — | 可选 | 同游戏、同服务器的版本 ID 数组 |
| `priority` | — | 可选 | 整数，越大轨道越靠上 |

版本轨道始终第一。卡池轨道未填写 priority 时按 `900` 排序，普通活动默认 `0`。

## 时间与 ID 规则

所有时间统一为北京时间并加引号：

```yaml
start: "2026-08-28T06:00:00+08:00"
```

- 必须包含 `+08:00`，秒固定为 `00`。
- 不接受 `Z`、其他时区、仅日期或无时区时间。
- `end` 必须晚于 `start`。
- 游戏、服务器和类型 ID 使用小写字母、数字和连字符。
- 条目 ID 以小写字母或数字开头，还可以包含点、下划线和连字符。
- 同一游戏、服务器内的版本 ID 和活动 ID 分别唯一。
- 前一版本的 `end` 可以等于后一版本的 `start`，但不能重叠。

## YAML 常见错误

- 使用两个空格缩进，禁止 Tab。
- 时间、版本号、URL 和包含特殊符号的名称建议始终加引号。
- 冒号后必须有空格，例如 `type: banner`。
- 数组项需要 `-`，不要把多个来源写成一个带换行的字符串。
- 不要添加 Schema 未声明的字段；数据对象采用严格校验。
- 不要在不同文件重复定义相同 ID。

## 数据来源与预估时间

- 优先使用官网、官方社区账号或游戏内公告等一手来源。
- 官方资料暂缺时，可以使用可靠且公开访问的二手来源，并在后续补充官方链接。
- `sources` 用于核验数据，至少一项；`url` 只是页面上的可选详情入口，不能替代 `sources`。
- 允许有依据的预估时间，但必须在 `note` 明确标注预估字段、推算依据和待确认信息。
- 官方时间公布后，应修改原条目、更新来源并移除过时的预估说明。
- `note` 只写必要摘要，不复制公告正文。

## 提交前检查

数据修改至少运行：

```bash
npm run validate:data
npm test
```

修改代码、页面或构建配置时还要运行：

```bash
npm run build
```

Pull Request 中请列出涉及的游戏、服务器、文件和来源。校验失败时，Actions 日志会显示具体文件、条目和字段。
