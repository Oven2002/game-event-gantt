# 贡献数据

感谢帮助维护时间表。所有时间必须能由公开来源核实；不确定的时间请先提交 Issue 讨论。

## 目录结构

每个游戏使用独立目录，目录名是稳定英文 ID：

```text
data/
  event-types.yaml
  genshin-impact/
    meta.yaml
    cn-2026.yaml
```

`meta.yaml` 声明游戏和服务器：

```yaml
id: genshin-impact
name: 原神
priority: 10
regions:
  - id: cn
    name: 国服
```

游戏和服务器 ID 使用小写字母、数字和连字符。目录名必须与游戏 ID 相同。新增活动类型前，先在 `data/event-types.yaml` 中声明其稳定 ID 和显示名。

## 时间格式

所有时间统一换算为北京时间，并使用带引号的完整格式：

```yaml
start: "2026-08-28T06:00:00+08:00"
```

- 必须包含 `+08:00`。
- 精确到分钟，秒固定为 `00`。
- 不接受 `Z`、其他时区、仅日期或无时区时间。
- 区间的 `end` 必须晚于 `start`。

## 数据文件

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

events:
  - id: banner-7-0-upper
    name: "7.0 上半卡池（奥黛塔+阿蕾奇诺 含阿罗夏）"
    type: banner
    start: "2026-08-12T06:00:00+08:00"
    end: "2026-09-01T17:59:00+08:00"
    related: ["7.0"]
    sources:
      - "https://ys.mihoyo.com/main/news/detail/165472"

  - id: preview-7-0
    name: 7.0 前瞻直播
    type: preview
    start: "2026-07-31T20:00:00+08:00"
    related: ["7.0"]
    sources:
      - "https://ys.mihoyo.com/main/news/detail/165422"
```

### 字段规则

- 版本必填：`id`、`name`、`start`、`end`、`sources`。
- 活动必填：`id`、`name`、`type`、`start`、`sources`。
- 游戏 `meta.yaml` 和活动均可填写整数 `priority`，数值越大显示越靠上。
- 未填写的游戏和普通活动按 `0` 排序；正数排在默认项之前，负数排在默认项之后。
- 版本轨道始终排第一；卡池轨道默认优先级为 `900`，活动只有显式设置更高优先级时才会排到卡池之前。
- 活动省略 `end` 时表示单点事件；需要显示“进行中”时必须提供 `end`。
- `related` 填写同一游戏、服务器下的版本 ID，只是展示标签。
- `url` 是面向用户的官方详情页；`sources` 是核实时间的公开来源，至少一项。
- `note` 只写简短补充，不复制公告正文。
- 条目 ID 以小写字母或数字开头，可包含点、下划线和连字符；发布后不要因显示名称变化而修改 ID。
- 同一游戏、服务器内的版本 ID 和活动 ID 分别唯一。
- 版本不能重叠，但允许前一版本的 `end` 等于后一版本的 `start`。

数据可按服务器、年份或版本拆成多个文件；校验会先合并同一游戏、服务器的所有文件，再检查重复、引用和版本重叠。

## 提交前检查

```bash
npm install
npm run validate:data
npm test
npm run build
```

Pull Request 请只包含一组相关的数据修改，并在说明中列出来源。校验失败时，日志会指出文件、条目和字段。若不会编辑 YAML，可使用“新增或修正时间表条目”Issue 模板提交资料。
