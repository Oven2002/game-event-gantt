# Official crawler 维护说明

本文档只描述 Phase 1 crawler 的维护者操作。crawler 的目标是从国服公开官方公告生成可审阅的 raw、candidate、review 和 approved manifest；**Phase 1 不直接修改 `data/`，也不自动 commit 或 push。**

## 1. 基本边界

- 必须在仓库根目录执行命令。
- Node 版本要求：`>=22.6`；直接执行 TypeScript 使用 `node --experimental-strip-types`。
- 只抓取公开的国服官方公告。不要向 crawler 配置 Access Secret、Cookie、Authorization、API key 或其他凭据。
- API transport host 与最终写入 timeline 的 `sources` 不是一回事：API 只用于发现/读取公告，正式 source 必须是通过 source policy 校验的官方文章 URL。
- `tests/fixtures/crawler/` 是脱敏、固定的离线契约；`.runtime/crawl/` 是运行时缓存，必须保持被 Git 忽略。
- Phase 1 的顺序固定为：

  ```text
  fetch → parse → review → 人工选择 → approve → Phase 2 merge（另行计划）
  ```

  不要跳过 sourceHash/candidateHash 的重新计算，也不要把 candidate JSON 直接当成正式 YAML。

## 2. 选择 game adapter

CLI 的 `--game` 只接受下面五个 machine ID。米哈游三作使用 `mihoyo` adapter；明日方舟和终末地使用 `hypergryph` adapter。具体配置以 `mihoyo-config.ts`、`hypergryph-config.ts` 和对应 fixture sidecar 为准，不要因为站点看起来相似就复用另一个游戏的参数。

| game | adapter | 官方文章 URL | 实测响应/字段 | supportsVersions | checkpoint kind | 已冻结 fixture 的 blocker |
| --- | --- | --- | --- | --- | --- | --- |
| `genshin-impact` | Mihoyo | `https://ys.mihoyo.com/main/news/{iInfoId}` | `retcode/data/list/iTotal`; `iInfoId/sTitle/sContent/dtCreateTime/sChanId` | `true` | `null` | `null` |
| `honkai-star-rail` | Mihoyo | `https://sr.mihoyo.com/news/{iInfoId}` | `retcode/data/list/iTotal`; `iInfoId/sTitle/sContent/dtCreateTime/sChanId` | `true` | `null` | `null` |
| `zenless-zone-zero` | Mihoyo | `https://zzz.mihoyo.com/news/{iInfoId}` | `retcode/data/list/iTotal`; `iInfoId/sTitle/sContent/dtCreateTime/sChanId` | `true` | `null` | `null` |
| `arknights` | Hypergryph | `https://ak.hypergryph.com/news/{cid}` | `code/data/list`; `cid/title/tab/displayTime/brief`; `total/current/pageSize` | `false` | `null` | `null` |
| `arknights-endfield` | Hypergryph | `https://endfield.hypergryph.com/news/{cid}` | `code/data/list`; `cid/title/tab/displayTime/brief`; `total/current/pageSize` | `true` | `null` | `null` |

上述 blocker 是已提交 sidecar 中的 endpoint blocker 记录；当前固定 fixture 均为 `null`，不表示未来 endpoint 永远不会变化。若实测接口需要认证、浏览器渲染或未在计划中允许的能力，应停止受影响的 adapter，记录脱敏 blocker，不得猜测替代接口。

### 2.1 Mihoyo 三作的实测请求合同

列表请求统一为 `GET https://<transport-host>/content_v2_user/app/<appId>/getContentList`，参数为：

```text
iPage, iPageSize, sLangKey=zh-cn, isPreview=0, iChanId
```

原神额外带 `iAppId=43`。当前配置如下：

| game | transport host | appId | channel | 额外 list 参数 |
| --- | --- | --- | --- | --- |
| `genshin-impact` | `act-api-takumi-static.mihoyo.com` | `16471662a82d418a` | `719` | `iAppId=43` |
| `honkai-star-rail` | `act-api-takumi-static.mihoyo.com` | `1963de8dc19e461c` | `257` | 无 |
| `zenless-zone-zero` | `api-takumi-static.mihoyo.com` | `706fd13a87294881` | `278` | 无 |

列表响应必须是成功的 JSON envelope：`retcode === 0`、存在 object 类型的 `data`、存在数组 `data.list` 和非负整数 `data.iTotal`。列表项使用 `iInfoId`、`sTitle`、`dtCreateTime` 和 `sContent`；详情请求使用 `iInfoId`、`iPageSize=50`、`sLangKey=zh-cn`、`isPreview=0`，并再次确认详情中的 `iInfoId` 与请求 ID 一致。

分页是 page-number 语义：列表耗尽或达到 `iTotal` 后停止。列表中的 `sUrl` 不作为权威 URL，详情 URL 按上表的官方文章模板派生。

### 2.2 Hypergryph 两个游戏的实测请求合同

列表统一请求：

```text
GET https://web-news.hypergryph.com/api/bulletin
    ?lang=zh-cn&code=<apiCode>&page=<page>&pageSize=<pageSize>
```

`apiCode` 为：

| game | apiCode | detail host | 版本能力 |
| --- | --- | --- | --- |
| `arknights` | `arknights` | `ak.hypergryph.com` | 不支持 version candidate |
| `arknights-endfield` | `endfield_web` | `endfield.hypergryph.com` | 支持 version candidate |

响应必须满足 `code === 0`、`data.list` 为数组，且 `data.total`、`data.current`、`data.pageSize` 为合法整数。列表项使用 `cid`、`title`、`tab`、`displayTime` 和可选 `brief`；`cid` 必须为数字字符串，`displayTime` 必须是秒级且整分钟。详情响应在 transport 层为 `text/html`，运行时以 `{ status, contentType, body }` envelope 交给 parser；parser 会校验文章内嵌 `cid`、标题、日期和正文。

### 2.3 国服区域硬校验

`zh-cn` 只表示语言，不单独代表服务器区域。每次 fetch 必须同时满足：

- Mihoyo：使用配置中的 CN `apiHost`、`appId`、请求 channel 和 `articleHost`；list/detail 的 `sChanId` 必须属于该游戏的 CN 内容频道集合；正式 source 只能使用配置的 CN 文章 host。
- Hypergryph：使用 `lang=zh-cn` 和该游戏的 CN `apiCode`；详情 HTML 必须有 `html[lang="zh-cn"]`；若存在 `data-oversea`，其值必须为 `false`；文章 host 必须是该游戏的 CN 官方 host。
- API transport host、CDN CNAME、DNS 地址和 CDN POP 只说明网络承载，不得单独作为 region 判据。
- `zh-tw`、`en-us`、`api-os-*`、`sg-public-*`、HoYoverse 国际文章 host 和不匹配的 channel 必须 fail closed。

当前五个游戏的正常 source host 为：`ys.mihoyo.com`、`sr.mihoyo.com`、`zzz.mihoyo.com`、`ak.hypergryph.com`、`endfield.hypergryph.com`。旧的 ZZZ HoYoverse 样本保留在 fixture 目录中，但 sidecar 标为 `blocker`，不参与正常 fetch/parse 合同。

### 2.4 checkpoint 现状

五个游戏当前都记录：

```text
checkpoint.kind = null
checkpoint.reusable = false
reason = No stable cross-run checkpoint was verified.
```

因此不能把某个 API 的页码、文章 ID 或显示时间擅自当成持久 cursor。当前 state 的有效字段是：

- `schemaVersion: 1`；
- `games[game].checkpoint`，目前为 `null`；
- `games[game].sourceHashes[sourceId]`，用于跨运行记录已见内容 hash。

未提供 `--since` 时，各游戏默认回看 30 天；`--full` 扫描全部分页；`--since` 与 `--full` 互斥。没有稳定 checkpoint 并不是失败，失败的是伪造一个未验证的 checkpoint。

## 3. 运行位置与采集周期

### 3.1 爬虫的定位

crawler 的主要目的，是在收集公告时用确定性代码完成批量列表请求、详情请求、字段校验、正文规范化和初步时间解析，从而减少需要交给模型或人工阅读的原始文本量。`fetch` 和 `parse` 本身不调用模型，也不是正式数据写入器；它们只生成可追溯的 runtime artifact。

Cloudflare Pages 只托管静态站点，不能作为 crawler 的运行环境。当前 `.github/workflows/ci.yml` 也只执行测试和 build，不执行实时官网请求。因此实际收集必须在本地或独立 runner（例如 NAS/Docker、服务器或专用 CI runner）执行，并为 `.runtime/crawl` 提供持久目录或上传运行 artifact。

### 3.2 一次采集周期和五个游戏

一次 `fetch` 只负责一个 `--game`，但会自动请求该游戏的全部列表分页和每条详情，不需要按页手动重复。五个游戏的一轮采集需要五次独立 `fetch`，每次有自己的 run ID：

```text
fetch --game genshin-impact
fetch --game honkai-star-rail
fetch --game zenless-zone-zero
fetch --game arknights
fetch --game arknights-endfield
```

随后每个 run 分别执行 `parse`、`review` 和（人工确认后）`approve`。某一个游戏失败时，只用新的 run ID 重跑该游戏；同一 run 的 artifact 不覆盖复用。

### 3.3 “全量”和“增量”的含义

- **首次全历史采集**：五个游戏各运行一次 `fetch --full`。每次命令内部会遍历该游戏的全部分页。
- **按时间获取增量**：五个游戏各运行一次 `fetch --since YYYY-MM-DD`（也可以带到分钟的北京时间），每次命令会抓取该时间点之后的列表项及其详情。
- **默认日常窗口**：不提供 `--since` 或 `--full` 时，每个游戏默认回看最近 30 天。
- **单点前瞻时间**：前瞻类公告若正文明确写出唯一的“将于某日某时开启/开播”，可形成 `confirmed` 的 `start`；公告没有明确结束时间时不填 `end`，不做推算。

当前五个游戏都没有经过验证的持久 cursor，`checkpoint.kind` 为 `null`。`state.json` 中的 `sourceHashes` 用于记录已经看到的内容和辅助变化比对，不是 API 页码游标。因此，“每个游戏运行一次”只表示**每一轮采集各运行一次**，不是首次运行后永久不再运行；日常增量仍需要下一轮再次运行五个游戏。为了捕捉公告修订，时间窗口可以保留适当重叠，再交给 hash/review 去识别新增和变化。

### 3.4 直接运行 CLI

默认 runtime root 为仓库内的 `.runtime/crawl`。CLI 没有把 runtime root 暴露成命令行 flag；测试和程序调用方可通过 API options 注入临时 root。

#### 3.4.1 Fetch

```bash
node --experimental-strip-types scripts/crawl/cli.ts fetch \
  --game genshin-impact
```

可选扫描边界：

```bash
node --experimental-strip-types scripts/crawl/cli.ts fetch \
  --game arknights \
  --since 2026-08-01

node --experimental-strip-types scripts/crawl/cli.ts fetch \
  --game arknights-endfield \
  --full
```

无参数时使用默认 30 天回看；日期或不带时区的分钟时间按北京时间解释。`--since` 和 `--full` 不能同时使用。CLI 自动生成 `YYYYMMDD-HHMMSS` 格式的 run ID，生成逻辑使用 UTC；输出会给出 `rawPath`、条目数和分页数。

Fetch 的行为：

- 只访问 adapter 的 HTTPS allowlist；检查状态、Content-Type、大小、canonical URL 和 canonical content；
- 每个游戏写入单独的临时 JSONL，所有分页和 schema 校验成功后才 atomic rename 到最终 raw 文件；
- 失败时删除临时 raw，写入 errors artifact，不推进 state；
- 成功后才更新 `state.json` 的 source hash；
- 同 run 任何现有 artifact 都会拒绝复用，不提供 `--force`。

#### 3.4.2 Parse、Review、Approve

```bash
node --experimental-strip-types scripts/crawl/cli.ts parse \
  --run 20260827-000001

node --experimental-strip-types scripts/crawl/cli.ts review \
  --run 20260827-000001

node --experimental-strip-types scripts/crawl/cli.ts approve \
  --run 20260827-000001 \
  --selection .runtime/crawl/selections/20260827-000001.selection.json
```

Parse 会读取该 run 的全部 raw JSONL，输出 ready/needs_review candidates 和 rejections。Review 会生成人类可读的 diff 报告与 selection template。Approve 不信任 template 或 selection 中的 hash，而会重新读取并校验 raw、candidate、source policy、当前 `data/` 索引、旧值和相关引用；成功后只生成 approved manifest，绝不写 YAML。

同一个 run 的阶段 artifact 是不可覆盖的。若需要重新抓取或重新解析，使用新的 run ID；不要删除一个仍有待处理 selection 的 run 的 raw/candidate 来“绕过” stale 检查。

## 4. Artifact 生命周期与边界

默认目录结构如下：

```text
.runtime/crawl/
├── state.json
├── runs/<run-id>/state-transaction.json
├── raw/<run-id>/<game>.jsonl
├── errors/<run-id>.jsonl
├── rejections/<run-id>.jsonl
├── candidates/<run-id>/<game>.json
├── reports/<run-id>.md
├── selections/<run-id>.template.json
├── selections/<run-id>.selection.json       # 人工另存的 strict selection，可选命名
└── approved/<run-id>.json
```

| artifact | 生产阶段 | 内容与用途 | 是否正式数据 |
| --- | --- | --- | --- |
| `raw` | fetch | canonical `RawArticle` JSONL、`contentHash`、source identity | 否；保留作为 source evidence |
| `errors` | fetch 失败 | 结构化失败原因 | 否 |
| `candidates` | parse | candidate、`candidateHash`、`sourceHash`、evidence、review 状态 | 否；不能直接写 YAML |
| `rejections` | parse | CandidateRejection 及 reasonCode | 否；不得进入 approval |
| `reports` | review | 逐字段 evidence/diff 的 Markdown 报告 | 否 |
| `selections/*.template.json` | review | 机器生成的建议和 target options | 否；不是 approve 输入 |
| `selections/*.selection.json` | 人工确认 | strict `ApprovalSelection` | 是 approval 输入，但仍是运行时文件 |
| `approved` | approve | strict manifest、旧值、实际 patch、正式 Schema value、proposalHash | 否；只供后续 Phase 2 merge |

`.runtime/crawl/` 已列入 `.gitignore`，任何抓取缓存、候选缓存、selection、manifest、state 或临时文件都不得提交。`candidate-target-map.json` 是仓库中的 durable registry，不属于 runtime cache；Phase 1 approve 不更新它，只有后续成功应用的 Phase 2 流程才可以更新。

### 4.1 raw、candidate、review 和 approved 的区别

- **raw** 是官方响应经过 canonical content 处理后的证据记录，身份由 game/source/sourceId 等字段和内容 hash 组成。
- **candidate** 是 parser 根据 raw 形成的内部候选，包含 `candidateKey`、semantic slot、evidence、review 状态和 hash。它不是正式 timeline entry。
- **review report/template** 面向人工审阅。`suggestedOperation`、target options 和 match reasons 只是建议；template 与 strict selection Schema 分离，不能把 template 直接传给 `approve`。
- **selection** 是人工明确选择后的 strict JSON。人工必须决定 add/update、kind、targetId、targetFile、旧值 hash 和允许的 patch。
- **approved manifest** 是经过整批 revalidation 后的不可覆盖 proposal。它保存实际 patch、旧值、hash 和已通过正式 event/version Schema 的 `yamlValue`，但不会应用到 `data/`。

## 5. 人工确认规则

只有 `review: "ready"` 且 kind 为 `event` 或 `version` 的 candidate 才能进入 selection。`needs_review`、`unknown`、CandidateRejection、无法形成 candidate 的结果和不支持的 version 能力都必须留在相应 artifact 中。

人工确认至少检查：

1. 公告确实来自当前游戏的国服官方文章；知乎只能作为 discovery 线索，第三方转载、台服路径和未经配置的账号不得进入 `sources`。
2. 时间是正文中可复核的北京时间分钟。图片-only、无明确时间、多窗口、无法确定的结束时间和未支持的措辞不能靠猜测填充。
3. “维护结束后开启”最多形成带 note 的 `inferred` start，仍需人工确认；“下次维护前结束”没有明确 end，应保持 needs_review。
4. `targetId`、`targetFile` 和 operation 与当前 timeline 一致。add 只能写入已存在且属于同 game/region 的正式 YAML 文件，不能创建新文件；update 必须唯一命中现有 entry。
5. update 的 `expectedOldValueHash` 必须来自 review 时的真实旧值。review 后如果 YAML 发生变化，approve 应 fail closed，不能手工把 hash 改成新的值绕过复核。
6. `relatedCandidateKeys` 只能解析到同 game/region 的正式 version ID；跨游戏、跨 region、event、未选择、缺失或 stale mapping 都必须拒绝。

selection 的最小示意如下；`<64 位小写十六进制>` 只是文档占位符，不能原样执行：

```json
{
  "schemaVersion": 1,
  "runId": "20260827-000001",
  "selections": [
    {
      "candidateKey": "genshin-impact/165690/primary",
      "candidateHash": "sha256:<64 位小写十六进制>",
      "sourceHash": "sha256:<64 位小写十六进制>",
      "kind": "event",
      "operation": "add",
      "expectedOldValueHash": null,
      "targetId": "event-id",
      "targetFile": "data/genshin-impact/cn-2026.yaml"
    }
  ]
}
```

update 的 `expectedOldValueHash` 必须是非 null 的真实 hash；若使用 patch，patch 的 `kind` 必须一致。当前 allowlist 为：version 只允许 `url`，event 只允许 `url`/`priority`；`set` 和 `unset` 不能交集，add 不能 unset。Candidate 原生字段由 approve 显式投影，不能通过 selection patch 重复修改；event 的 `periods` 只能原样保留已有旧值，不能被 Candidate 或 patch 设置/删除。没有 patch 时 approved manifest 记录 JSON `null`，不是空对象。

## 6. 官方来源政策

正式 `sources` 只允许：

- 当前 game 配置的国服官方文章 host；
- 已配置并能校验 platform、account ID 和 profile URL 的官方第三方账号文章，目前配置的第三方账号以 `source-accounts.ts` 为准。

所有 source URL 必须：

- 使用 HTTPS；
- 使用默认端口；
- 不含用户名、密码或凭据；
- 通过 canonical URL 规则；
- 与当前 game/region 的官方 host 或配置账号身份匹配。

以下内容不能进入正式 `sources`：知乎、17173、游民/游侠等转载站、Facebook、台服/繁中路径、未配置的 Bilibili/微博/米游社/TapTap 账号，以及 API transport URL。知乎若被发现，只能标记为 discovery-only；它不能因为人工 patch 或旧值合并而绕过 policy。

update 的 source union 规则是：保留旧 sources 的原始顺序，再追加 candidate 中尚未出现的 canonical URL，稳定去重；union 后会再次执行正式 URL Schema 和 source policy。旧 YAML 中已存在的非法 source 不会被静默删除或放行，必须拒绝 approve，另行人工处理。

## 7. 清理 `.runtime/crawl/`

没有待处理 selection、没有需要保留的 approved manifest、并确认不需要 state 的历史 source hash 后，维护者可以自行清理运行时缓存：

```bash
rm -rf .runtime/crawl
```

若只放弃某个 run，必须同时清理该 run 的 raw、candidate、transaction、errors、rejections、report、selection 和 approved 文件；不要删除 `candidate-target-map.json`，也不要在仍等待人工确认时清理 raw/candidates。清理后只能重新执行：

```text
fetch → parse → review → 新的 selection → approve
```

不能跳过 fetch 或依赖旧 selection 中的 sourceHash。raw 缺失时 approve 必须报错并 fail closed，这是预期的安全行为。删除命令具有破坏性，由维护者确认后自行执行；本文档不会自动执行清理。

## 8. 本地离线验证与 CI

固定 response fixture 和 `.meta.json` sidecar 位于 `tests/fixtures/crawler/`。fixture 测试会校验：

- 每个 list/detail 的配对、请求参数、pagination 和 response format；
- game、source ID、最终 URL、redirect 和 Content-Type；
- fixture 不含 authorization、cookie、token、secret、password 或 credential；
- Mihoyo/Hypergryph request builder 与冻结请求事实一致。

本地完整验证：

```bash
NODE_OPTIONS='--localstorage-file=/tmp/gameg-vitest-localstorage.json' \
  node node_modules/.bin/vitest run
node --experimental-strip-types scripts/validate-data.ts
node node_modules/.bin/astro check
node node_modules/.bin/astro build
git diff --check
if ! git check-ignore -q .runtime/crawl/probe; then
  echo "ERROR: .runtime/crawl is not ignored" >&2
  exit 1
fi
if [ -n "$(git status --porcelain=v1 --untracked-files=all -- data/)" ]; then
  echo "ERROR: Phase 1 modified data/" >&2
  git status --short -- data/ >&2
  exit 1
fi
```

CI (`.github/workflows/ci.yml`) 只执行：

```text
npm ci
npm test
npm run build
```

其中 `npm test` 覆盖 crawler fixture/unit tests，`npm run build` 先执行 `npm run validate:data`，再执行 Astro check/build。CI 不调用 `fetch`、`parse`、`review` 或 `approve` CLI，不请求官方 API，不依赖实时官网状态。新增 crawler 测试必须继续使用固定 fixture 或注入的 fake fetcher；不要在 CI 中加入 live endpoint probe。

## 9. Phase 1 明确不做

- 不把 candidate 或 approved manifest 自动 merge 到 YAML；
- 不创建新的 YAML 文件；
- 不做图片 OCR、复杂关系推断或 AI 自动写 YAML；
- 不把知乎、第三方转载或台服来源写入 sources；
- 不在 GitHub Actions 中实时抓官网；
- 不自动 commit、push 或更新 durable applied-target registry；
- 不用未来周期规则生成未官宣活动。

YAML merge、注释/引号/字段顺序保持、原子替换、回滚、merge 后全量校验和变更白名单属于单独的 Phase 2 计划。
