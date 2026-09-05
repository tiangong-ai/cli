---
docType: runbook
scope: repo
status: proposed
authoritative: true
owner: cli
language: zh-CN
whenToUse: "安排原子数据运行时的 TypeScript 7 升级、基础契约、connector、Skills 和 Research 联动实施时。"
whenToUpdate: "当阶段顺序、试点范围、PR 依赖、验证门槛、发布或回退策略变化时。"
checkPaths:
  - AGENTS.md
  - package.json
  - package-lock.json
  - tsconfig*.json
  - Dockerfile.clean-test
  - .github/workflows/**
  - docs/agents/data-runtime-architecture.md
  - src/data/**
  - src/research/workspace/data-evidence-adapter.ts
  - test/**
lastReviewedAt: 2026-09-05
lastReviewedCommit: 16b436927ca3967673b46be41135e415f87704d9
---

# 原子数据运行时实施计划

## 当前基线和停止点

- 计划基线：`origin/main` at
  `7b7fc682698778edf5b77d69f0fa3f944e6da4a6`。
- 计划分支：`codex/atomic-data-runtime-plan`，使用独立干净 worktree。
- 现有含未提交 Research 变更的 checkout 不做 pull、stash、reset、rebase 或复用。
- 本文和目标架构完成后停止；没有下一次明确确认，不开始工具链或业务代码改造。

## 总体顺序

```text
两仓计划同步评审
  -> CLI TypeScript 7 基线
  -> CLI 空数据运行时与机器契约
  -> CLI 试点 connectors
  -> 发布候选 CLI
  -> Skills 薄化迁移
  -> Research adapter
  -> 分批迁移剩余能力
```

CLI 是基座，因此实现和合并顺序以 CLI 为先。Skills 计划 PR 可以同时开放以评审触发
语义和迁移范围，但不能先合并一份引用不存在命令或未发布版本的生产 Skill。若必须
压缩为每仓一个 PR，则两个 PR 同时 draft/review，CLI PR 先合并并发布候选版本，Skills
PR 随后只更新已确认的 exact binding。

## 工作包 0：计划和迁移清单

交付：本仓两份 data runtime 文档，以及 Skills 仓对应架构/迁移 runbook。

- 冻结仓库所有权、公共命令候选、机器 envelope、回执和 Research 适配边界。
- 把旧 Python/OpenClaw 实现标记为只读知识来源；不合并历史，不直接翻译整文件。
- 对现有 fetch/search/download Skill 建立迁移分类：CLI connector、Research/KB 既有能力、
  继续独立、或退役。
- 确认首批候选为 AirNow Hourly Obs 与 Federal Register Documents：前者覆盖多文件时间窗
  和 CSV，后者覆盖分页 JSON 和元数据结果；两者无需生产凭证，适合先证明公共合同。
- 用仅测试用 synthetic connector 覆盖 credential injection/redaction；真实凭证来源
  NASA FIRMS 放在后续批次。

完成门槛：两个仓库的 docpact 路由、索引和计划校验通过；没有业务代码变更。

## 工作包 1：TypeScript 7 基线

状态：完成（2026-08-30）。

范围只包括工具链，不混入 `data` 业务行为：

- 将 `typescript` 升级到 7.x，并由 `package-lock.json` 锁定精确解析版本；保持 Node
  `>=24 <25`。
- 迁移不兼容的 `tsconfig` 选项、构建脚本和类型错误；不借机重写 Research/KB 行为。
- 确认 `tsx`、Node test、c8、Prettier、declaration/source map 和 npm pack 与 TS7
  协同。
- 更新 clean-test dependency layer 和四平台 CI 所需输入。

实际结果：

- `typescript` 升级为 `^7.0.2`，lockfile 固定 7.0.2 及官方平台二进制包；
- `tsconfig.json` 显式声明 Node 类型，不依赖 TypeScript 7 的空 `types` 默认值；
- 仓库未使用 7.0 暂不提供的 programmatic compiler API；
- 修复 5.9.3 基线上已经存在的 13 个测试类型标注/空值缩窄错误，不改变运行时；
- 全量 typecheck 加入四平台 CI 和 clean-container，在 coverage 之前强制执行。

验证：`npm run typecheck`、`npm run build`、`npm test`、`npm run test:platform`、
`npm run test:coverage`、`npm run test:clean:cold`、`npm pack --dry-run`，以及 docpact
门禁。任何现有命令 envelope 或退出码变化都视为回归。

回退：该工作包单独 commit/PR；若 TS7 在任一受支持平台不能通过，不开始工作包 2。

## 工作包 2：空运行时与公共机器契约

状态：完成（2026-08-30）。

先实现没有真实 provider 的骨架：

- 新建 `src/data/**` 分层和顶层路由；不继续扩张 `src/cli.ts` 的业务逻辑。
- 实现 manifest、catalog、describe、请求/结果/error/receipt Schema、canonical JSON 和
  digest。
- 实现静态 doctor、显式 live doctor 的权限边界和空 registry 行为。
- 提取/重写 bounded HTTP、endpoint scope、credential injection、重试、大小/时间上限和
  redaction。只复用 Research broker 中可证明通用的规则，不复制其 workspace 状态。
- 建立 connector conformance harness 和 synthetic connectors，覆盖无凭证、逻辑凭证、
  分页、部分结果、429、超时、超大响应、跨域重定向和 secret leak。
- 确保 JSON Schema 随 `dist/` 发布，并在 npm pack 测试中验证可发现性。

完成门槛：不注册真实来源也能稳定通过 catalog/describe/doctor/run 的成功与失败合同；
Windows/macOS/Linux/ARM 不因排序、路径或 locale 产生 digest 差异。

实际结果：

- 新增空的内置 registry、`data catalog/describe/doctor/run` 路由和成功/部分/阻断退出码；
- 发布 execution manifest、discovery、catalog、describe、doctor、run request/result、
  error 和 core receipt 九份闭合 JSON Schema，并由 TypeScript 构建复制到
  `dist/data/schemas/`；
- 建立 locale/路径无关的 canonical JSON、语义 digest 和把审计时间排除在外的核心回执；
- 建立只允许 DNS 主机 HTTPS scope 的 bounded HTTP，拒绝 IP literal、跨域重定向、
  credential-like query/body、超时、超限响应和 credential reflection；
- 凭证只按 manifest 的逻辑 ID 从精确环境变量解析并在 endpoint 校验后注入；`data`
  命令绕过 cwd dotenv 加载；
- synthetic conformance 覆盖无凭证、逻辑凭证、分页、部分结果、429、超时、响应超限、
  跨域重定向和 secret leak，且 pack 合同验证公共 Schema 可发现。

## 工作包 3：首批 connectors

### 3A AirNow Hourly Obs

- operation：有界 UTC 时间窗、bbox、pollutant 参数的 hourly file fetch。
- 证明：多小时文件计划、缺文件/部分失败、CSV header/值校验、bbox/time/parameter
  过滤、source-file lineage 和 preliminary-data 限制。
- fixture 从官方格式和现有 Skill 外部行为重建，不导入 Python runtime。

### 3B Federal Register Documents

- operation：term/date/agency/type/topic/docket/RIN 的 bounded document search。
- 证明：稳定 query 编码、分页/记录上限、空结果、provider metadata 校验和截断状态。
- 只返回文档搜索元数据，不抓取链接正文，也不做法律解释。

每个 connector 必须有独立 manifest、Schema、fixtures、contract tests、失败隔离和
license/source notes。connector 之间不得导入业务函数；共同代码只能上提到已评审的
runtime primitive。

完成门槛：各自可离线 catalog/describe/doctor，可用 fixture 完整测试 `run`，live smoke
为显式、非 CI 必需项；全仓门禁和 npm pack 通过。

实际结果：

- 注册 `airnow.hourly-observations/fetch-hourly`，按 UTC 小时生成最多 168 个官方文件
  路径，校验官方 CSV 字段并执行 bbox/time/pollutant 过滤；缺失或无效文件保留可用
  记录并返回显式 partial/file lineage；
- 注册 `federal-register.documents/search`，要求日期边界和收窄条件，稳定编码 term、
  agency、type、topic、docket、RIN，验证 provider pagination metadata，并明确区分
  complete、no-results、max-pages、max-records 与 later-page partial；
- 两个 connector 均使用独立 execution manifest、discovery metadata、闭合 input/output
  Schema、重建 fixture、来源/license 限制和 contract tests；实现仅依赖公共 data
  runtime，彼此无业务导入；
- 增加内置 registry 离线 catalog/describe/static-doctor 证明，并补强 public run request
  对 `undefined` 等非 JSON 值的 fail-closed 处理；
- 根据 PR #71 审阅意见补充 Data Source/Capability/Operation 三层发现语义；`catalog`
  投影 summary、provides/does-not-provide 和 operation summary，`describe` 返回完整
  Discovery Metadata、官方资料、覆盖范围、选择提示和带字段说明/示例的输入 Schema；
- discovery wording 使用独立 `discoveryDigest`，回归测试证明其变化不会改变 execution
  manifest 或 operation Schema binding；
- 本工作包已作为四个可独立审阅提交进入统一 CLI PR #71，审阅修订继续追加到同一 PR。

## 工作包 4：候选发布和 Skills 薄化

- 发布包含 TS7 基线、基础 data contract 和首批 connectors 的 CLI 候选版本。
- 从候选包导出 canonical execution manifest/Schema digest，作为 Skills 运行兼容绑定；
  Discovery Metadata 供 Agent 选择和内容审计，但说明文字漂移不阻断执行。
- Skills PR 删除首批 Python 执行脚本和 OpenClaw/eco-council 模板，只保留触发语义、
  参数说明、来源限制和 CLI 调用。
- Skills 离线测试拒绝缺失 capability、错误 digest、过低 CLI 版本和漂移命令面；安装
  smoke 使用隔离 HOME/project，不携带真实凭证。
- CLI 正式版本发布后更新 exact binding，再合并 Skills PR。

当前公共 `0.0.54` 不暴露 `data` 命令。完整十七项 capability 的本地发布候选统一使用
`0.0.55`，所有 capability manifest 的 `minimumCliVersion` 也设为 `0.0.55`，避免已发布
但不兼容的旧版本通过 Skills 的最低版本检查。

完成门槛：安装后的 Skill 调用已发布 CLI，且仓库中不再有第二份首批 connector
业务逻辑或 Schema。

## 工作包 5：Research adapter

- 在 CLI 内部直接调用 `src/data/**` 服务，不启动 `tiangong-ai data run` 子进程。
- 把 `CoreDataReceipt` 映射到 Research capability/evidence receipt，同时保留原始核心
  digest 和 connector 版本。
- Research 层继续拥有 capability lock、credential owner map、预算、candidate/role
  coverage、永久 evidence、journal、handoff 和 review。
- 对同一固定输入建立 parity test：独立 data 调用与 Research adapter 的核心结果和
  receipt digest 相同，Research 仅增加上层对象。
- 严格分离 connector acquisition、Evidence package 与 Agent context 三层预算；Research
  不把 `maxBrokerItems`/`maxBrokerResponseBytes` 隐式写入 `DataRunRequest`。调用者显式
  limits 原样保留，完整验证结果与 artifacts 受 package byte/file ceiling 约束，Agent
  视图再按 record、thread、time-series 或 artifact 形态投影。
- receipt、candidate 与 journal 分别报告 validation issues、request coverage 和 context
  projection，禁止把“上下文只显示前 100 条”表述成“采集结果只有 100 条”或无提示 complete。

完成门槛：现有 Research clean-container 门禁先观察针对新 adapter 的 RED，再在新容器
转 GREEN；不得让 data runtime 依赖项目目录或 stage 状态。

状态：已实现。adapter 动态投影内置 registry，在 native discover packet 中发布选择摘要与
精确运行命令，进程内复用 data runtime，并把核心 receipt digest、connector/operation
版本、永久结果对象、可选下载 artifacts、candidate、预算和 journal 绑定到 Research。
parity、credential 脱敏、动态投影和 packet 合同均有独立回归；隔离容器 RED/GREEN 证据
按本工作包门禁保留。Research 数据调用只从 owner-only workspace credential store 构造
当前 connector 所需的最小凭证环境，不继承或 fallback 到 CLI 宿主的 provider 环境变量；
缺失 workspace credential 时在 connector 和网络执行前返回 blocked，并由显式 ambient-key
回归冻结该边界。
对 144 条合成记录的回归确认：connector 仍执行其 1000 条/1 MiB 原生上限，Evidence 保存
完整 144 条，smoke Agent 视图按 `maxBrokerItems=100` 显示 100/144；矩形时间序列按所有
location 的对齐时间块分配，线程记录优先保留完整 group，attachment 使用 manifest 视图。

## 工作包 6：后续分批迁移

建议批次，不等于全部自动批准：

1. USGS Water IV：作为后续迁移首项，扩展时序、空间、多变量、provisional qualifier
   和 legacy provider 生命周期合同。
2. Open-Meteo 系列：继续扩展时序、空间和多变量合同。
3. NASA FIRMS、OpenAQ、Regulations.gov：验证真实 credential 和 provider auth 路径。
4. GDELT 系列、Bluesky/YouTube/RSS/fulltext：先判断是原子 connector、内容获取器还是
   Research/媒体工作流，避免把异构行为硬塞进一个 data Schema。
5. Tiangong KB search、academic paper/download、email 和本地文件能力：保持既有产品
   边界，除非单独评审证明应迁入 data runtime。

每一批都先更新迁移清单，只以真实价值、许可清晰度、API 稳定性、维护成本、fixture
可得性和 Research 需求决定是否迁移，不追求旧 Skill 数量对等。

### 后续迁移 1：USGS Water IV

- 新增 `usgs.water-instantaneous-values/fetch`，执行一个 bbox 或 sites、period 或显式
  window 的有界 WaterServices IV 请求；闭合输入 Schema 使用官方 100 sites 与 bbox
  25 平方度上限，并保留旧 Skill 的 `ST/active` 和 `00060/00065` 默认值。
- WaterML JSON 输出归一化为 series summary 与 observation records；坏 row/series 保留
  可用数据并返回 partial，整体 envelope 或安全上限错误返回 blocked，record cap 返回
  complete-but-truncated。
- fixture 为按官方 WaterML JSON 结构重建的合成数据；catalog、describe、static doctor、
  connector conformance 与 dist pack 合同全部离线验证。
- Discovery Metadata 明确该 endpoint 为计划在 2027 年第一季度下线的 legacy 服务，
  并指向现代 Water Data APIs；这项迁移完成当前 Skill 去重，但不假装解决长期 API
  迁移，现代 endpoint 需要单独 capability/operation 评审。

状态：CLI connector 与对应薄 Skill 已在本地完成并验证；正式 Skills binding 仍需等待
包含该 connector 的精确 npm 版本发布后替换候选包 digest。

### 后续迁移 2：Open-Meteo Air Quality

- 新增 `open-meteo.air-quality/fetch-hourly`，只使用无凭证的公开 non-commercial
  endpoint；显式移除旧 Skill 中会混淆 public/customer endpoint 的可选 API key，商业
  endpoint 如有需求必须作为独立受审阅合同加入。
- 输入限制为最多十个坐标、十六个已知 hourly variable 和 92 个闭合日期；坐标保持请求
  顺序，变量稳定排序，timezone 固定为 GMT，避免 locale/DST 进入执行合同。
- 输出按 location-hour 计数，保留 requested/grid coordinate、elevation、timezone、unit
  和 aligned nullable arrays；单坐标/变量异常返回 partial，record cap 对时间和值同步
  截断，整体 provider error 返回 blocked。requested series 缺失使用 `series-missing`；
  provider 返回合法长度的全 `null` series 使用 `series-all-null` 并保留该列。
- Discovery Metadata 区分 CAMS modeled background 与 station observation，记录 Europe/
  Global 分辨率和变量覆盖差异、公开端点非商业限制以及 Open-Meteo/CAMS attribution。
- fixture 为按官方响应形状重建的合成数据；connector、catalog、static doctor、
  conformance 与 dist pack 合同全部离线验证。

状态：CLI connector、对应薄 Skill 和候选 binding 已在本地完成并验证；正式 binding
等待包含全部 connector 的精确 npm 版本发布。

### 后续迁移 5：NASA FIRMS Active Fire

- 新增 `nasa-firms.active-fire/fetch-area`，要求一个 reviewed source、非跨日界线 bbox、
  最多 31 个闭合 UTC 日期和逻辑 `map-key`；可选先检查 provider source availability。
- 运行时把日期窗拆成最多七个、每个不超过五天的 FIRMS CSV 请求，并同时约束 bbox、
  estimated transactions、响应字节与 50,000 records。输出统一坐标、UTC acquisition
  minute、satellite/instrument、confidence、FRP、footprint 和 MODIS/VIIRS brightness
  字段；坏 row 或后续 chunk 作为明确 partial 隔离。
- 为 FIRMS 的 URL-path 认证新增通用 `path-segment` credential injection；manifest、输入
  JSON、安全 request digest、receipt 与错误只看到逻辑 placeholder，secret 仅在 endpoint
  校验后注入实际请求，且 provider reflection 继续触发泄漏阻断。
- Discovery Metadata 明确 hotspot/thermal anomaly 不等于 wildfire、perimeter、burned
  area、incident 或告警；NRT 为 provisional，历史一致性优先匹配的 Standard Processing
  source，并保留 NASA FIRMS/底层 dataset citation 要求。
- fixture 按官方 CSV 字段重建，不包含 live provider 数据或 MAP_KEY；connector、凭证
  防泄漏、catalog/describe/static doctor、conformance 和 dist pack 合同全部离线验证。

状态：CLI connector、对应薄 Skill 和候选 binding 已在本地完成并验证；正式 binding
等待包含全部 connector 的精确 npm 版本发布。

### 后续迁移 6：OpenAQ Air Quality

- 新增 `openaq.air-quality/search-locations` 与 `fetch-sensor-measurements` 两个封闭
  operation，替代旧 Skill 的任意 API path/query 透传；两者统一要求逻辑 `api-key`，由
  runtime 仅通过 `X-API-Key` header 注入。
- location search 至少要求一个 country/provider/parameter/license、monitor/mobile、
  center-radius 或 bbox 条件；measurement fetch 只接受一个 sensor、raw/hourly/daily
  粒度和最长 366 天的显式 RFC3339 窗口。输出保留 provider pagination、location/sensor
  provenance、license attribution、aggregate summary 与 coverage。
- 后续页失败保留已验证记录并返回 partial；page/record cap 产生明确 truncation，缺失
  credential、无界请求、冲突空间条件和过长窗口在网络访问前阻断。
- Discovery Metadata 明确 provider/source quality 和许可差异、raw 与预计算 aggregate
  的选择边界，以及非 AQI/健康/监管用途；旧 Skill 的 public S3 archive list/download
  不进入原子 JSON connector，留待 content/download 边界统一审计。
- fixture 按官方 v3 envelope 重建，不含 live provider 数据或 API key；connector、凭证
  防泄漏、双 operation conformance、catalog/describe/static doctor 和 dist pack 合同均
  离线验证。

状态：CLI connector、对应薄 Skill 和双 operation 候选 binding 已在本地完成并验证；
正式 binding 等待包含全部 connector 的精确 npm 版本发布。

### 后续迁移 7：Regulations.gov Comments

- 新增 `regulations-gov.comments/search` 与 `fetch-details` 两个只读 operation；前者要求
  posted 或 last-modified 二选一的最长 366 天窗口并使用稳定排序，后者只接受最多 100
  个显式 comment ID，可选择返回 attachment metadata，但不下载文件。
- 两个 operation 统一要求逻辑 `api-key`，runtime 只通过 `X-Api-Key` header 注入
  `REGGOV_API_KEY`；provider 分页限制为 20 页/5000 条，详情按 caller 顺序逐 ID 执行，
  后续页或部分 ID 失败保留已验证结果并返回明确 partial。
- 详情 normalization 采用 allowlist，只保留 comment/docket/document evidence、日期、
  withdrawal/restriction、组织/政府机构上下文、duplicate count 和 attachment metadata；
  不扩散姓名、邮箱、电话、地址、locality 等个人 profile 字段，自由文本仍按潜在个人和
  不安全内容处理。
- Discovery Metadata 明确 agency-configurable 字段、duplicate/mass-mail、withdrawn 和
  自选择边界；不提供 post/submit/modify、attachment download、代表性公众意见、统计
  sentiment 或法律判断。fixture 按官方 JSON:API 形状重建，不含 live provider 数据或
  API key；connector、凭证防泄漏、双 operation conformance、catalog/static doctor 和
  dist pack 合同均离线验证。

状态：CLI connector、两个对应薄 Skill 和候选 binding 已在本地完成并验证；正式 binding
等待包含全部 connector 的精确 npm 版本发布。

### 后续迁移 8：GDELT DOC、Events、GKG 与 Mentions

- 保留 `gdelt.doc-search/search`、`gdelt.events/fetch`、`gdelt.gkg/fetch` 与
  `gdelt.mentions/fetch` 四个独立 discovery/binding 单元；DOC 使用单独 query connector，
  三个 15-minute table capability 共享 ZIP、range planning 与 TSV normalization 核心。
- DOC 只开放 JSON article list 与五种 timeline mode，要求 rolling/absolute window 二选一，
  CLI 单次限制最长 366 天，并声明 provider 对长窗口 article-list 只考虑末端三个月；不再
  透传 arbitrary mode、format、provider parameter 或输出文件路径。
- table fetch 只开放 latest 或最多二十个精确对齐 15 分钟的 UTC timestamps；range 直接
  生成受限 HTTPS path，不下载大型 master file。latest 校验 provider size/MD5，所有 ZIP
  校验单 member、安全名称、header 一致性、解压上限、CRC32、UTF-8 和精确 codebook 列数。
- 输出在内存中归一化为闭合 named fields，并保留 file timestamp/name lineage；缺失后续文件
  返回 partial，record cap 在下载下一文件前停止。压缩 TSV/ZIP 展开为 named-field JSON 的
  结构放大不作为数据丢弃理由；完整结果交给 Research Evidence package，Agent context 另行
  生成 bounded table view。该原子合同不落盘、不下载 article body，也不把 automated coding
  当作代表性、事实或因果证据。
- fixtures 完全由测试生成并在 provenance note 中说明，不包含 live provider 响应；四个
  connector 的 field description、discovery boundary、range/ZIP failure、conformance、
  catalog/static doctor 与 dist pack 均离线验证。

状态：CLI connector、四个对应薄 Skill 和候选 binding 已在本地完成并验证；正式 binding
等待包含全部 connector 的精确 npm 版本发布。

### 后续迁移 9：Bluesky Cascades 与 YouTube Public Content

- 新增 `bluesky.public-posts/fetch-cascades`，完整保留旧 Skill 的 public search、author-feed、
  custom-feed、list-feed 与可选 reply-thread expansion 语义；source、UTC window、page size、
  max threads、depth 与 parent height 均进入闭合 Schema。CLI 不再接受 base URL、optional auth、
  输出路径、日志路径或任意环境配置；统一 bounded HTTP 负责 retry、endpoint scope 和 receipt。
- Bluesky 种子按 `record.createdAt`、缺失时 `indexedAt` 执行 optional inclusive/exclusive window；
  reply tree 输出 post、blocked、not-found 节点及 parent/depth，线程失败保留种子并返回 partial。
  Discovery Metadata 明确 AppView indexing/ranking/feed/moderation/counters 不是 archive、代表性样本、
  verified fact、identity 或 causal diffusion evidence。
- 新增 `youtube.public-content/search-videos` 与 `fetch-comments`。前者保留 channel/time/order/region/
  language/safe-search 与全部旧 video filters，并始终用 `videos.list` 补齐公开 details；后者只接受
  显式 video IDs，保留 comment UTC window、published/updated、thread order/search terms 与 replies。
- YouTube key 从 `YOUTUBE_API_KEY` 解析为 logical `api-key`，只经 `X-Goog-Api-Key` header 注入；
  `fetch-comments` 不信任 `commentThreads.list` 的 embedded replies，而对每个有回复的 thread 使用
  `comments.list` 分页。operation-wide request/record limits 叠加 per-video/per-thread page caps；后续
  video 或 detail batch 失败保留已验证结果并返回 partial。`commentsDisabled` 只通过通用 HTTP
  层保留的安全 provider reason 机器码识别，返回明确的 per-video partial；不得误报为 API key
  无效，也不得把 provider message 带入错误详情。
- 两个 provider 的 fixture 均为按官方 Lexicon/API 形状构造的虚构内容，不保留 live user data、
  provider response 或 API key。catalog/describe/static doctor、header secret boundary、pagination、
  partial/truncation、output Schema 与 dist pack 都需要离线验证。

状态：CLI connector、三个对应薄 Skill 和候选 binding 已在本地完成并验证；正式 binding
等待包含全部 connector 的精确 npm 版本发布。

### 后续迁移 10：USBR RISE

- 新增 `usbr.rise/discover-items` 与 `fetch-results`。前者按 provider 页序扫描有界
  `catalog-item` 页面，再按 title/location/parameter/source/terms 做 client-side
  filtering；输出候选 item ID、单位、timestep、transformation、时间覆盖、landing page、
  坐标和 source page，明确页序不是 relevance ranking 或 evidence weight。
- `fetch-results` 只接受最多二十个已由官方来源 grounded 的显式 item ID，可加
  location/parameter、RFC3339 UTC 时间窗、时间排序和 item metadata enrichment；每个
  item 独立分页，后续 item/page 失败保留已验证行并返回 partial。
- 两个 operation 共用官方 `https://data.usbr.gov/rise/api` keyless JSON-LD/JSON:API
  scope，但拥有独立闭合输入/输出 Schema。页数、记录、响应字节、重试和超时由公共
  runtime 统一限制；不接受任意 endpoint、输出路径或旧 Python 调参。
- Discovery Metadata 要求按 item 的 unit、timestep、transformation、source code、
  temporal coverage 和 disclaimer 解释数值；该 capability 不判断 shortage、drought、
  flood、operating/legal compliance、causality、governance responsibility 或 report
  readiness，也不提供 USBR 项目全文或跨来源连接。
- fixture 按 RISE catalog/result envelope 重建；先在 clean container 观察缺失 connector
  的有效 RED，再由 connector、双 operation conformance、catalog、dist pack 和
  clean-container GREEN 收口。

状态：CLI connector、对应薄 Skill 和双 operation 候选 binding 已在本地完成；当前正
在收口全量 clean-container、docpact 和提交门禁，正式 binding 仍须等待包含全部迁移
connector 的精确 npm 版本发布。

### 后续迁移 11：EPA EIS Database Records

- 新增 `epa.eis-records/search`，保留权威 EcoCouncil Skill 的 `lastWeek`、
  `openComment`、`last60Issued`、`last30Published` 四种官方 common search；同时接受
  调用者已在 EPA EIS Database UI 中构造的显式搜索 URL，但只允许
  `https://cdxapps.epa.gov/cdx-enepa-II/public/action/eis/search` 的精确 origin/path，
  拒绝凭证、custom port、fragment 和其他 host/path。
- 用无第三方运行时依赖的有界 HTML tokenizer 识别 `submissionsTable` 与 page banner，
  归一化 title、CEQ number、unique ID、document type、EPA comment-letter/Federal
  Register dates、lead/cooperating agencies、state、detail URL、download links/IDs，并
  按官方标识去重；链接只作为 availability cue 返回，不下载文件。
- common search 先于 explicit URL、两组内部均保持 caller order。运行时 page/record cap
  可继续收紧；到达上限不再发送下一请求，后续搜索失败保留已验证记录并返回 partial。
  明确报告 0-item 页面；缺失目标表或 banner 宣称有记录但无可解析行时 fail closed，避免
  把 provider HTML 漂移误报为真实空结果。
- Discovery Metadata 说明结果页最多 500 条且搜索面可能稀疏或过期；该 capability 只
  提供官方 metadata 和文档线索，不判断 NEPA/EIS adequacy、legal sufficiency、
  environmental effects、agency compliance、policy responsibility 或 report conclusion。
- fixture 完全为合成 HTML；先在新 clean container 中观察缺失 connector/schema 的有效
  typecheck RED，再由 parser、安全 URL、limit/partial、0-result/markup-drift、conformance、
  catalog 和 dist pack 测试转 GREEN。

状态：CLI connector 已在本地实现并通过 499 项 clean-container；薄 Skill、候选 binding、
`quick_validate.py` 与 thin-skill contract 已通过。统一 copy/symlink 安装 smoke 和两仓
cold gate 等全部缺失项落地后在最终树执行，正式 binding 等待精确 CLI 发布版本。

### 后续迁移 12：USBR Project Records

- 新增 `usbr.project-records/fetch`，只接受调用者已确认的精确
  `https://www.usbr.gov` 项目或计划页面 URL；拒绝其他 USBR subdomain、HTTP、凭证、
  custom port 和 fragment，不提供任意 endpoint、站内搜索或递归 crawling。
- 对每个调用者排序的页面保留 title、meta description、响应 digest/bytes，以及安全的
  `content-type`、`last-modified` 和 `etag`；只抽取同 origin 链接，移除 fragment、按 URL
  去重并保持 document order，以扩展名区分常见 PDF/HTML/Office/text 文档和普通 linked page。
- 链接只作为 availability cue 返回，不跟随、不下载、不散列链接内容。公共 runtime 继续
  负责 endpoint、redirect、响应字节、超时和 retry；operation 显式报告 page、global record、
  per-page link cap，并在后续页面失败时保留先前记录返回 partial。
- Discovery Metadata 将它与 `usbr.rise` 分开：前者适合已知 USBR 页面上的报告/通知候选
  清点，后者适合 catalog item 与 operational time series；两者都不输出法律、政策、运行、
  环境影响或治理责任结论。
- fixture 为合成 HTML；先在 clean container 观察缺失 connector/schema 的有效 RED，随后
  由 exact-origin、link normalization、limit/partial、conformance、catalog 和 dist pack
  测试收口。

状态：CLI connector 已在本地实现，目标测试和 TypeScript 7 typecheck 已通过；薄 Skill、
clean-container GREEN、统一安装 smoke、cold gate 与正式 binding 尚待完成。

### 后续迁移 13：Regulations.gov Attachments

- 新增 `regulations-gov.attachments/download`，只接受最多 20 个 exact public comment ID、
  可选 attachment-ID allowlist 以及显式 file/total-byte caps；metadata 严格通过官方
  `GET /v4/comments/{id}?include=attachments` 获取，不保留旧脚本中当前 OpenAPI 未定义的
  独立 attachment endpoint 假设。
- 新增 operation 级 `artifactOutput` execution contract 与 `--artifact-dir` out-of-band 参数。
  runtime 要求绝对、已存在、非 symlink 目录，隐藏暂存文件在 normalized output 和公共
  envelope 校验通过后才以 no-overwrite 语义 commit；blocked 则 rollback，绝对路径不进入
  request/result/receipt。
- 下载只允许精确 `https://downloads.regulations.gov` origin，不接受 arbitrary URL 或
  redirect，也不向下载端注入 `REGGOV_API_KEY`。输出保留 comment/attachment/file-format
  lineage、content type、provider/actual size comparison、SHA-256、relative filename 和
  hash-bound manifest。
- file failure 或不安全 provider URL 保留已验证文件并返回 explicit partial；manifest
  记录缺失项。connector 不扫描、打开、解析或解释 public-submission bytes，下游必须继续
  经过独立安全和 evidence extraction workflow。
- fixture 为合成 JSON:API metadata 与本地字节；clean container 已先观察缺失 connector、
  artifact runtime 参数和 conformance 参数的有效 RED。

状态：CLI connector 与 artifact transaction runtime 已在本地实现，定向测试和
TypeScript 7 typecheck 已通过；薄 Skill、binding、clean-container GREEN、统一安装 smoke
和 cold gate 尚待完成。

### 内容、下载与持久化候选的边界审计

- 四个 RSS/fulltext Skill 继续保持独立：RSS 核心包含任意 feed/OPML intake、SQLite subscription
  state、dedupe 与 incremental sync；fulltext 核心包含 HTML/body acquisition、retry queue、正文
  解析与持久化。把它们替换为 stateless JSON connector 会丢失核心语义，并会引入动态 URL/SSRF、
  内容安全和本地状态合同，必须在独立内容获取架构中评审。
- `figshare-data-download` 继续保持 browser/download Skill：其核心交付物是交互式文件下载与本地
  artifact，不是内存中的原子 JSON 记录。
- `academic-paper-download` 继续作为 Research companion：它拥有合法开放获取路径选择、浏览器
  handoff、PDF/manifest/hash/provenance 与下载失败语义，不应降格为 data connector。
- Tiangong KB、Dify/KB 辅助、email 和本地文件能力继续保持现有产品/隐私边界，除非未来单独
  评审证明其执行合同属于 data runtime。此决定是语义保真结论，不是尚未完成的迁移占位。

### 后续迁移 4：Open-Meteo Historical Weather

- 新增 `open-meteo.historical-weather/fetch`，只使用公开 non-commercial archive
  endpoint；输入限制为最多十个坐标、一个受控 model、十二个 curated hourly 与十二个
  curated numeric daily variables、366 个闭合日期。两个变量数组必须显式传入，至少一方
  非空。
- 请求固定 GMT、摄氏度、km/h 和 mm，坐标保持调用顺序、变量稳定排序；输出保存
  requested/model-grid coordinate、elevation、hourly/daily 时间轴、单位和 aligned nullable
  arrays。record cap 按 location 内 hourly 后 daily 的顺序同步截断时间和值。
- 单坐标/section/time axis/variable/unit 异常返回 partial，整体 provider error 返回
  blocked；requested series 缺失使用 `series-missing`，合法数组全为 `null` 使用
  `series-all-null`，两者均保留机器可读 issue code，且后者保留原始空序列。fixture 按
  官方响应形状重建。Discovery Metadata 区分 reanalysis/model-grid
  estimate 与 station observation，并提示多年代趋势使用 ERA5 或 ERA5-Land，避免 Best
  Match 的模型升级断点。
- 不透传旧 Skill 的 endpoint、API key、任意 model、timezone 或单位环境配置；商业
  customer endpoint 必须作为独立能力评审。

状态：CLI connector、对应薄 Skill 和候选 binding 已在本地完成并验证；正式 binding
等待包含全部 connector 的精确 npm 版本发布。

### 后续迁移 3：Open-Meteo Flood

- 新增 `open-meteo.flood/fetch-daily`，只使用公开 non-commercial endpoint；输入限制为
  最多十个坐标、七个官方 daily discharge variables、366 个闭合日期，以及可选
  ensemble members。ensemble 必须同时请求 `river_discharge`。
- 坐标保持调用顺序，变量稳定排序，timezone 固定 GMT；输出按 location-day 计数并保存
  requested/river-grid coordinate、unit、aligned nullable variables 与带 member identity
  的 ensemble series。
- 单坐标/变量/member 异常返回 partial，record cap 同步截断日期和所有 series，整体
  provider error 返回 blocked；requested series 缺失与合法全 `null` series 分别使用
  `series-missing` 和 `series-all-null`，后者原样保留；fixture 为按官方响应形状重建的
  合成数据。
- Discovery Metadata 明确 GloFAS 约 5 km simulated discharge、附近最大河流选择误差、
  forecast-only ensemble statistics、非站点观测/非告警边界、公开端点非商业限制与
  Open-Meteo/GloFAS attribution。

状态：CLI connector、对应薄 Skill 和候选 binding 已在本地完成并验证；正式 binding
等待包含全部 connector 的精确 npm 版本发布。

## 2026-09-02 可靠性与 Agent 消费补强

- Research data Evidence 增加 digest-bound opaque cursor 和只读 `data read` 入口；完整
  acquisition 结果仍只持久化一次，后续 Agent 视图不重取 provider、不消耗 provider quota
  或 evidence-call budget。native packet 明确要求需要逐行穷尽时读到 `nextCursor=null`，
  否则必须披露 presented/total 比例。
- Research communication 将 provider coverage、显式 limit coverage 与 context coverage
  分开；保留旧 `requestCoverage` 兼容投影，因此 provider partial 与 runtime bounded 不再
  相互覆盖。
- EPA EIS 的已声明 endpoint 单独启用 same-origin、memory-only cookie session，以通过官方
  初始重定向；cookie 不进入持久化、错误、摘要或跨域请求。该能力不扩展到其他 connector。
- AirNow 小时文件改为固定三路并发获取并保持稳定输出顺序；bounded HTTP 失败补充脱敏的
  attempt/retry/redirect/phase/status，便于区分 provider 响应、超时和 transport failure。
- YouTube comments 增加显式 `top-level-only|all-visible` reply 策略，并报告 thread/reply
  request 消耗、剩余预算与已知未展开线程；默认兼容既有 `includeReplies` 行为，不以
  embedded reply sample 冒充完整回复。
- Regulations.gov 的两个 capability 保留在 built-in registry，以 suspended availability
  发布原因和恢复标准；catalog/describe 可诊断，doctor/run 在网络前阻断，Auto Research 不投影。
  真实 key 下 production search 返回 503，旧 fetcher 同样超时，attachment origin 在当前执行
  环境返回 403；恢复 available 必须先通过 search、detail、attachment 三段 live gate。

## PR 与提交拆分

建议保持下列可独立审阅/回退单元：

1. CLI plan PR：本文、目标架构、docpact 路由；无运行时代码。
2. Skills plan PR：对应迁移架构、清单和 runbook；无 Skill 业务改动。
3. CLI TS7 PR：纯工具链和由此产生的兼容修复。
4. CLI foundation PR：空 registry、公共 Schema、runtime primitives 和 conformance。
5. CLI pilot PR：AirNow/Federal Register，可按 connector 再拆分。
6. Skills pilot PR：在 CLI 候选包可验证后开放，正式包发布后合并。
7. CLI Research adapter PR：在独立 data contract 稳定后进入。

本次实施按用户要求把 CLI 计划、TS7、foundation 和 pilot 保留为独立本地 commits，
最终统一进入一个 CLI PR；这不改变每个 commit 的独立审阅和回退边界。

计划 PR 先同步评审；实现 PR 不形成“Skills 先引用未存在的 CLI”或“CLI 发布时依赖
未合并 Skills pin”的循环。

## 每阶段通用验收

- 先写外部行为/安全回归并在要求的 clean container 中观察 RED，再实现 GREEN。
- `catalog`、`describe` 和默认 `doctor` 全程离线、确定、无副作用。
- 真实 provider live tests 明确 opt-in，不进入普通 CI，不携带个人凭证或用户数据。
- JSON fixtures 经过脱敏、大小审查和许可证/来源说明；错误、日志、回执无 secret。
- TypeScript 类型、JSON Schema、runtime validator 和文档示例由同一合同生成或交叉验证。
- 完成 AGENTS 列出的全仓门禁和 `npm pack --dry-run`；依赖/容器输入变化必须 cold gate。
- 每个 PR 记录兼容性、迁移/回退方式和未完成项，不以聊天记录作为事实来源。

## 准备完成定义

准备完成是指：两个仓库都从最新 `origin/main` 建立了不污染现有工作的干净分支，CLI
和 Skills 的权威边界、TypeScript 7 顺序、试点、PR 依赖和验收门槛已持久化并通过文档
治理检查。准备完成不代表已经授权修改 package、运行时或 Skill。
