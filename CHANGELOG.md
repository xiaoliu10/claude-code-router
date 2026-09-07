# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

## [2.3.2403] - 2026-09-07

### Fixed

- **Pi 项目级接管真正使用项目 Router**: Pi 本身支持项目级 `.pi/settings.json`，但 CCR 此前让所有项目共同选择全局 `ccr` provider，请求里没有可供服务端识别项目的会话元数据，因此最终始终命中全局模型路由。现在每个已接管项目都会获得独立的 `ccr-project-*` provider，其请求通过受管 header 携带项目 ID；服务端校验该 ID 与已保存的 `projectPath` 后直接加载对应项目 Router，无需依赖 Claude transcript。旧版共享 `ccr` 项目配置会在启动、保存配置或切换客户端时自动迁移；关闭全局 Pi 接管也会保留仍被项目使用的 provider。无效、篡改或已删除的项目映射会显式报错，不再静默逃逸到全局 Router；内部项目 header 在进入转发层前即被剥离，不会泄露给上游。shared/core 全量 290 项测试通过，并以 Pi 0.85.1 实际请求验证项目设置和 header 透传。

## [2.3.2402] - 2026-08-25

### Fixed

- **formatResponse SSE 识别条件放宽至所有非流式响应**: 之前 peek 仅在 Content-Type 含 `application/json` 时触发,导致上游用非标准 Content-Type(如 `text/plain`、空 Content-Type)返回的 SSE body 绕过 peek、直接走 JSON 解析抛 `non-JSON` 错误。现在对任何 `!isStream` 响应都先 peek 判 SSE,覆盖 codex 中转及各类网关返回非标准头带 SSE body 的形态。隔离实例验证 `text/plain` Content-Type + SSE body(stream:true/false)全部 HTTP 200 透传、0 错误。

## [2.3.2400] - 2026-08-25

### Fixed

- **SSE 误标 application/json 的多层彻底修复(心跳/分片/空首块)**: v2.3.2397–2399 修复了 `AnthropicTransformer`、`OpenAIResponsesTransformer` 与 `formatResponse` 对 SSE body 标 JSON 头的识别,但三层校验都依赖"单次 read 首 chunk"判断。当上游首块是空 buffer、SSE 注释心跳(`: ping`)或分片(`ev`|`ent:`)时,SSE 识别失败,响应被误当 JSON 处理仍报 `non-JSON`/`malformed` 错误。本次将识别逻辑改为**累积多 chunk 再判定**(最多 8 次读取),并新增 `peekBodyForSSE`/`readBodyForSSE`/`looksLikeSSE` 共享工具,统一应用于: (1) `formatResponse` 兜底;(2) 两个 transformer 的 peek;(3) `sendRequestToProvider` 的 hidden-error-check(之前会把误标 SSE 的 200 响应 JSON.parse 失败误判为"empty or malformed response" 抛 400);(4) `validateStreamingResponse` 的 SSE data-lines 校验(之前首块只有心跳时误判"no SSE data lines"抛 400)。隔离实例 + mock(空首块/心跳/分片三种形态,stream:true/false 两种请求)端到端验证全部 HTTP 200 + SSE 完整透传,0 错误。

## [2.3.2399] - 2026-08-25

### Fixed

- **bypass 模式下 SSE 响应误标 application/json 时不再报错（formatResponse 兜底）**: v2.3.2397/2398 分别修复了 `AnthropicTransformer` 与 `OpenAIResponsesTransformer` 的同类问题，但 bypass 模式的 provider（单一 transformer 与主 transformer 匹配，如 codex 的 `["Anthropic"]`）会跳过整条 transformer 链，SSE body + `application/json` 头的响应直达 `formatResponse`，仍按 Content-Type 走 JSON 解析并抛 `non-JSON` 错误。现在 `formatResponse` 在非流式分支先 peek 首块：body 实际为 SSE 时按流式透传；真 JSON 则恢复未读 body 照常解析。这是该问题的最后一层兜底，覆盖所有 provider 形态。

## [2.3.2398] - 2026-08-25

### Fixed

- **Codex 中转 SSE 响应误标 application/json 时不再丢失内容**: v2.3.2397 修复了 `AnthropicTransformer.transformResponseIn` 的同类问题，但 `OpenAIResponsesTransformer.transformResponseOut`（codex 客户端场景必经）仍只按 Content-Type 判断——上游（如 Codex 中转）返回 SSE body 却标 `application/json` 时，走进 JSON 分支抛 `Upstream returned a non-JSON response (HTTP 200): event: message_start...`，客户端拿到空响应。现在该 transformer 入口先 peek 首块：body 实际为 SSE（`event:`/`data:`/`: ` 行首）时重建为 `text/event-stream` 并走原有 SSE 分支；真 JSON 则恢复未读 body 照常解析。行首匹配不影响含 `event` 字段的正常 JSON。

## [2.3.2397] - 2026-08-24

### Fixed

- **Anthropic 兼容上游把 SSE 响应误标 application/json 时不再丢失内容**: 部分上游（Codex 中转、OpenRouter 错误响应）对流式请求返回的响应体实为 SSE（`event: message_start\ndata:...` 或 `: OPENROUTER PROCESSING`），却带 `application/json` Content-Type。`AnthropicTransformer.transformResponseIn` 此前仅按 Content-Type 判断流式，遇此情形走进非流式分支对 SSE 文本调 JSON 解析，抛出 `Upstream returned a non-JSON response` 并令客户端收到空响应或触发无谓 fallback。现在非流式分支先 peek 响应体首块，若实际以 `event:`/`data:`/`: ` 开头则按流式走 `convertOpenAIStreamToAnthropic`，仅在确为 JSON 时才解析；检测只匹配行首，不影响含 `event` 字段的正常 JSON 响应。

## [2.3.2396] - 2026-08-24

### Fixed

- **OpenRouter 流式响应不再被错误当作 JSON 解析**: CCR 此前根据客户端请求里的 `stream` 判断最终响应类型，并在多个 transformer 的 `application/json` 分支直接调用 `response.json()`。当上游实际返回 SSE（例如以 `: OPENROUTER PROCESSING` 开头）或返回 Content-Type 与请求预期不一致的错误体时，会抛出无上下文的 `Unexpected token ':' ... is not valid JSON`。现在最终响应按实际 `Content-Type: text/event-stream` 判断流式转发；所有相关 transformer 使用统一的安全 JSON 解析器，兼容 BOM/首尾空白，并在非 JSON 响应时携带 HTTP 状态和截断后的原始 body 预览，方便定位真实上游错误。
- **OpenCode Go 多轮 thinking 请求恢复完整缓存前缀**: `OpenCodeTransformer` 此前把上游 `reasoning_content` 转成 Claude Code 的 `thinking` 后，下一轮请求没有把历史 assistant `thinking.content`/`signature` 转回 `reasoning_content`/`reasoning_content_signature`，导致上游只能匹配到首个 thinking turn 之前的前缀（长会话常固定命中约 64k），并可能返回 `The reasoning_content in the thinking mode must be passed back to the API`。现在完整回放 reasoning 内容与签名，thinking 模式下无显式 reasoning 的 assistant tool-call 也补兼容占位值；直连同一 181,211-token 请求两次验证上游可命中 180,992 tokens（约 99.88%），证明问题位于 CCR 转换链而非上游限制。
- **转换器自定义参数支持直接编辑**: Providers 页已有参数此前只能查看或删除，修改嵌套 JSON（如 `reasoning: {"enabled":true,"effort":"max"}`）必须删除后重新输入。现在 provider 级和 model 级参数行新增编辑按钮，点击后以 key/value 形式回填输入框；对象、数组、布尔和数字通过既有格式化/解析逻辑无损往返，同名 key 保存时覆盖原值。

## [2.3.2395] - 2026-08-22

### Fixed

- **UI 转换器参数支持嵌套 JSON / 布尔 / 数字类型**: Providers 页的转换器参数值此前一律按字符串保存，导致结构化参数在 UI 里根本配不了——输入 `{"reasoning":{"enabled":true,"effort":"max"}}` 存进 config.json 的是字符串，`customparams` 的 deep merge 无法应用（已有对象字段被保留、`enabled` 仍是 false），强制 reasoning 的端点（如 OpenRouter `stealth/ox-alpha`）在 UI 配置后依旧 400。现在参数值按类型解析：`true`/`false` → 布尔、数字字面量 → 数字、`{`/`[` 开头 → JSON 解析（畸形 JSON 保留原字符串，不会静默损坏配置），其余保持字符串；参数回显改用 `formatParamValue`，对象不再显示 `[object Object]`。provider 级与 model 级共 5 处参数写入路径全部接入。

## [2.3.2394] - 2026-08-21

### Fixed

- **严格项目路由：熔断目标改为照发请求而非 503**: 项目配置的目标进入 health fail-pool（连续 3 次失败熔断）后，严格项目模式此前直接拒绝请求（503 `model_unhealthy`），请求永远到不了供应商——会话陷入重试死循环，且熔断器因收不到真实请求记录成功而永不恢复。现在 `throwStrictProjectError` 判定诊断为 `model_unhealthy` 时（供应商与模型均真实存在、仅被熔断，属非配置错误），跳过健康检查重试项目自己配置的同一目标：上游真挂时客户端看到真实供应商错误，已恢复时成功请求经 `recordSuccess` 自然闭合熔断器。未更换任何模型、不逃逸项目边界，严格语义不变。配置错误类（`provider_not_found`/`provider_disabled`/`model_not_found`/`invalid_model_format`/`quota_exhausted`）仍照常拒绝。
- **非流式请求的 TTFT 与 token 速率统计失真**: 非流式响应整包一次性返回，不存在可观测的首 token 时刻。此前 token-speed 插件把总时长记为非流式 TTFT，usage 落库时 decode 窗口（时长−TTFT）塌缩到 1 秒下限，导致每条非流式记录的 `tokens_per_second` 等于输出 token 总数（实测 109 秒的请求被记成 3674 tok/s），且假 TTFT 污染 `avgTtft` 聚合。现在非流式记录 TTFT 一律记 null（UI 显示 `-`），速率为输出 token 数 ÷ 总时长；`normalizeUsageRecord` 对 `stream=false` 记录强制剥离 TTFT（覆盖 jsonl 迁移等所有写入路径），`avgTtft` 仅聚合真实流式 TTFT。

## [2.3.2393] - 2026-08-18

### Fixed

- **项目接管按项目 Router 计算上下文窗口，未启用扩展上下文时封顶 200k**: 项目级 Claude Code 接管此前写 `.claude/settings.local.json` 只读全局 Router 与全局 `ContextWindow`，从不参考项目自己的权威 Router。当全局默认 family 启用 `[1m]` 且 `ContextWindow > 200000`、而项目 Router 未启用扩展上下文时，项目仍带着 `[1m]` alias 与超过 200k 的 auto-compact 窗口；上下文超过 200k 后严格项目路由又不能逃逸到全局扩展模型，最终无可用模型。现在接管使用「全局连接/界面参数 + 项目 Router」的有效配置：默认 family（opus 优先，`enableFamilyRouting` 显式为 false 时忽略 family、回退顶层开关）或顶层 `enableExtendedContext` 未启用时，CCR 管理的 `CLAUDE_CODE_AUTO_COMPACT_WINDOW` 封顶为 `min(ContextWindow, 200000)`，启用时保留全局值；family 未启用扩展时同时移除陈旧 `[1m]` alias。用户手写的 divergent 窗口继续保留，`ccr-state.json` 管理与 `previousAutoCompactWindow` 审计行为不变。保存非空项目 Router（`PUT /api/projects/:id`）与全局配置保存（`syncGlobalProjectTakeovers`）现在都会刷新自定义 Router 项目的 Claude Code 接管，全局连接/上下文变更得以传递，且不把全局 Router 泄漏进项目、不扩大到 pi/qwen/opencode 的项目语义。
- **opencode go 缓存命中从 0% 恢复（保留 cache_control + DeepSeek 风格用量映射）**: opencode zen 上游的提示词缓存以显式 `cache_control` 标记为前提（直连实测：无标记时 ~16k token 相同前缀连发永不缓存；带标记第 2 次起命中 15616/15885 ≈ 98%），而 `OpenCodeTransformer` 此前把所有 `cache_control` 剥除（依据「GLM/OpenAI 兼容 API 不支持该字段」，对 zen 后端不成立），导致上游永远收不到标记、永不缓存。现在 transformer 保留 `cache_control`，仅继续清理 Anthropic 特有的 `image_url.media_type`。同时 `AnthropicTransformer` 的用量映射在 `prompt_tokens_details.cached_tokens` 缺失时兜底读取 DeepSeek 风格的 `prompt_cache_hit_tokens`（流式 `message_delta` 合并与非流式 OpenAI→Anthropic 转换两处），DeepSeek 风格上游的缓存读取量得以正确计入 `cache_read_input_tokens`。

## [2.3.2392] - 2026-08-08

> 注：2.3.2391 发布时未重新构建，实际发出的是 2.3.239 的代码（缺少本修复、版本号错位，导致更新检查持续提示新版本）；此版本为正确重建后的重新发布。

### Fixed

- **用量按日统计按本地时区分组**: `byDay` 此前用 `substr(timestamp,1,10)` 取 UTC 日期，本地 0:00–8:00 的请求（UTC 仍是昨天）被归到前一天——表现为"过了零点后昨天的消耗还在涨、今天的偏少"。改用 `date(timestamp,'localtime')` 按进程时区分组。聚合在查询时实时计算，历史记录无需迁移即自动按本地日期重新归类。

## [2.3.239] - 2026-08-03

### Added

- **供应商网络慢探测与黄色 ⚠️ 告警**: `ActiveProbeService` 现在为每次供应商 `/models` 可达性探测记录延迟与状态（healthy/slow/error/timeout），存于内存中按 provider 维护（不持久化，重启后等下次探测自然填充）。延迟超过 `PROBE_SLOW_THRESHOLD_MS`（默认 3000ms）判为 slow，`GET /api/providers/health` 追加 `probes` 字段，手动探测 `POST /api/providers/probe` 与 `probe-all` 返回 `latencyMs/status/isSlow/errorKind`。慢但成功的探测只告警、不打开熔断器，不影响路由。新增配置项 `PROBE_SLOW_THRESHOLD_MS` 与已有的 `PROBE_TIMEOUT_MS`（默认 15s）配合。Provider 卡片状态派生优先级：disabled → breaker open → half-open → 探测 timeout/error → 探测 slow（黄色 ⚠️）→ healthy。
- **用量模型列显示完整路由链**: Usage 页模型列统一为 `请求模型 → ccr 路由模型 → 上游实际返回`，相邻相同段自动去重、上游未偷换时省略末段；provider 单列展示，路由标签（family/场景）独立成列并在 tooltip 给出完整注解链。

### Changed

- **路由优先级：模型族优先于 explicit `provider,model`**: 开启 family routing 时，请求先走模型族映射（`extractModelFamily` 命中 opus/sonnet/haiku），命中即用；只有 family 未命中时才解析客户端显式指定的 `provider,model`，最后才落默认/scenario 路由。此前 explicit 格式无条件最高优先级、绕过 family。strict project 模式行为不变（explicit 本就被跳过）。
- **UI 刷新循环重做，杜绝请求重叠**: Providers 的 health/quota 此前为固定 30s `setInterval`，慢响应会重叠堆积；改为前一次 settled 后才排下一次的 60s 自调度 single-flight（in-flight + pending flag 合并并发触发），health/quota 用 `Promise.allSettled` 互不影响并保留各自上次成功数据，页面隐藏暂停、重新可见且数据超过 30s 立即刷新。Usage 自动刷新改为 30s **串行队列**：同一时刻最多 1 个 `/api/usage` 在途，筛选/翻页/手动刷新触发时若在途只置 pending、settle 后用最新参数补发一次，stale 响应按 generation 守卫丢弃。`/api/clients` 取消 30s 固定轮询，改为按需刷新（仅 mount，enable/disable/restore/apply 直接复用响应）；可见且超过 60s 的补拉已一并移除，停留或切回 Settings 页都不再触发请求。
- **移除已弃用的 Codex 多账号管理**: 删除账号列表、导入、切换、后台自动维护、请求热路径切号及其 API（7 个 `/api/clients/codex/accounts*`）、CLI 子命令（`ccr clients codex ...`）、UI tab/handlers/types/i18n。`auth/Codex` 管道阶段更名为 `auth/client`。Codex 仍作为普通 provider/client 完整支持：客户端检测、`/v1/responses` 归一化、Responses transformer、takeover 配置注入、`client_type:"codex"` 用量归属全部保留。历史数据保留策略：`~/.claude-code-router/codex-accounts/`、SQLite 遗留列与 `~/.codex/auth.json` 不做迁移、不清除、不再读写。

### Fixed

- **Image 路由按客户端原始模型，不再丢失 originalModel**: image agent 此前在路由前把 `req.body.model` 改写为 `Router.image`，导致用量记录把客户端真实模型（如 Pi 的 `ccr-opus`）误记为 `Router.image`、`scenario_type` 误记为 default，并绕过 family image 路由。现按 `req.originalModel` 识别 family，优先 family image 路由、不可用时回退全局 image，且 family default 与 image 同模型时也正确标记 image 场景；force-agent 内部调用仍用全局 `Router.image` 避免二次路由丢 family。同时修复 `promoteToolResultImages()` 与 `reqHandler` tool_result 分支把所有数组型 `tool_result.content` 整体替换为占位字符串、丢失纯文本/结构化内容的问题——现在只提取并提升 image block，保留其余内容。
- **用量汇总下推 SQL 聚合，解除 event loop 随机阻塞**: `query()`/`querySummary()` 此前用 `readFilteredRecords`（`SELECT *` 全量）+ `computeSummary`（JS 逐行聚合），better-sqlite3 同步调用阻塞 event loop，是 health/quota 随机卡顿的共享根因。新增 `computeSummarySQL`/`readSummaryBuckets` 用 `COUNT/SUM/AVG/GROUP BY` 只返回小结果集，语义严格对齐旧实现（token 只计 success 行、byFamily 用 `family/scenario` key 且仅非空、byClient 把空/NULL 归为 unknown、AVG 取整无数据置 null）。
- **用量查询 pageSize 加上限**: `query()` 此前接受任意 `pageSize`，单次请求可 `LIMIT` 整张 usage 表（行很宽、含 response body）；现强制上限 `MAX_PAGE_SIZE=200`（UI 每页 20 行），防止无界查询物化全表。


## [2.3.238] - 2026-07-28

### Fixed

- **更新成功后服务自动重启**: `performUpdate` 此前跑完 `npm install -g` 只返回一句“请手动重启”，从不触发重启，运行中的进程仍是旧代码，导致页面刷新后 `checkForUpdates` 持续判定有新版本，必须手动 `ccr restart` 才能恢复。现在 `npm install -g` 成功后，复用已有的 `/api/restart` 自重启模式（detached `ccr restart`）自动重启服务加载新代码；前端在服务重启回来后轮询 `checkForUpdates`，一旦 `hasUpdate:false` 即自动刷新页面加载新前端 bundle。
- **更新请求并发锁**: 新增模块级 `updateInProgress` 守卫，刷新页面丢失 in-flight UI 状态后再次点击“立即更新”不会再触发第二次 `npm install -g`，直接返回“Update already in progress”。

### Changed

- **更新超时提示补全包名**: `app.update_timeout` 文案由“手动执行 `npm install -g`”改为“手动执行 `npm install -g @wengine-ai/claude-code-router-next@latest`”，用户照抄即可成功。

## [2.3.237] - 2026-07-28

### Fixed

- **更新操作现在有明确进度反馈且不会无限挂起**: 点击“立即更新”后，弹窗按钮会进入禁用状态并显示旋转图标与“更新中…”文案，防止重复触发并发安装；前端请求与后端 `npm install -g` 均设置 5 分钟上限，后端同时将输出缓冲提高到 4 MB。超时会显示可读错误而非让界面永久等待。

### Docs

- **精简常驻 Claude 项目指引**: 从 `CLAUDE.md` 删除可直接由 `package.json` scripts、CLI `--help` 与仓库结构推导的构建命令、CLI 命令和依赖布局说明，保留非显然的安全约束、发布约定与架构注意事项，降低每次会话的固定上下文开销。

## [2.3.236] - 2026-07-22

### Added

- **阿里云 Token Plan 用量查询（5h/7d 额度）**: 为 `*.maas.aliyuncs.com`（如 `token-plan.cn-beijing.maas.aliyuncs.com`）的 Anthropic 兼容网关新增专用 `AliyunTokenPlanQuotaAdapter`，与 DashScope Coding Plan 适配器分离。它向 Token Plan 专用用量接口 `zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage` 发起 BroadScope `POST` 请求（表单 `params`+`region`，Cookie 鉴权、无 Bearer），解析确认的 `DataV2` 响应字段 `per5HourPercentage` / `per1WeekPercentage`（用量分数）与 `per5HourResetTime` / `per1WeekResetTime`（重置时间），并把分数映射为 5h/7d 百分比展示，与智谱 TOKENS_LIMIT 百分比路径一致。
- **`quota_sec_token` 配置项与官方网关**: provider 新增可选 `quota_sec_token`（映射到 `LLMProvider.quotaSecToken`）与 Web UI 密码输入框（仅 `maas.aliyuncs.com` 主机显示）。配置后切换到官方 `bailian-cs.console.aliyun.com` BroadScope 网关，form body 携带 `sec_token`、`region=cn-beijing` 与对齐真实控制台请求的 `cornerstoneParam`（字面 `_v=undefined`、稳定路由字段、动态 `feTraceId`、从 `cna` cookie 派生的 `X-Anonymous-Id`，不含会话级 `spm` 跟踪参数）。
- **无匹配 adapter 的安全诊断日志**: `active-probe` 在 provider 无对应 quota adapter 时输出 debug 日志，且只记录从 baseUrl 推导的 hostname，绝不输出 `apiKey` / `quotaToken` / `quotaSecToken` 等凭据字段。

### Changed

- **pi 扩展上下文触发统一为绝对阈值**: pi 不再按自身 `contextWindow` × `extendedContextRatio` 推导 `extendedContextThreshold`，改为与 Claude Code / Codex 等一致地继承绝对阈值链（family → Router → 200000）。移除失效的 pi `models.json` contextWindow 缓存与 `Clients.pi.routing.extendedContextRatio` 配置面（UI 输入与 i18n），`longContext` 绝对阈值（默认 60000）不变；存量配置中残留的 `Clients.pi.routing` 被忽略而非报错。

### Fixed

- **官方 Token Plan 请求对齐真实控制台载荷与降级回退**: official 网关请求改为已确认的字面 `_v=undefined` 与稳定 `cornerstoneParam`；网关级登录错误信封（`success:false` / `errorCode`，如 `BailianGateway.Login.NotLogined`）不再被误采为用量；HTTP 错误、网络异常、解析为 null、甚至 malformed `cna` cookie 触发的 `decodeURIComponent` URIError 等 setup 异常都会安全降级到 legacy `cs-data.qianwenai.com` 端点（不带 `sec_token`），全链路静默返回 null、绝不输出凭据。
- **测试 HOME 隔离真正到达 vitest worker**: 此前 `globalSetup` 通过 `process.env` 设置 `CCR_CONFIG_DIR`，但 vitest 配置里 `env: { CCR_CONFIG_DIR: '' }` 会覆盖 `process.env`，worker 看到的是空串，`HOME_DIR` 回退到真实 `~/.claude-code-router`，导致 core/shared 测试套件运行在用户真实配置目录、`POST /api/config` 类集成测试甚至会对真实项目配置做 takeover 同步。改为在 config-load 时创建临时 HOME 并把真实路径经 env 透传给 worker，确保隔离生效、不再写真实配置目录。

## [2.3.235] - 2026-07-18

### Fixed

- **修复 npm 全局安装因已发布 core 包残留 `workspace:*` 而静默失败**: `scripts/release.sh` 此前直接用 `npm publish` 发布 `@wengine-ai/llms`，导致其运行时依赖 `@wengine-ai/claude-code-router-shared` 仍以 pnpm workspace 协议 `workspace:*` 出现在 npm manifest；npm 无法解析该协议，安装 `@wengine-ai/claude-code-router-next` 时会在依赖树解析阶段 exit 1，通常只留下 debug log 而没有明确错误码。现在 npm 发布顺序调整为 shared → core → CLI：先独立发布同版本 `@wengine-ai/claude-code-router-shared`，再为 core 构造临时发布 manifest，将所有 `workspace:` 范围转换为真实 npm version range（如 `workspace:*` → `^2.3.235`），发布后自动恢复源文件；shared/core/CLI 三个发布 manifest 均新增 `workspace:` 拦截校验，CLI 发布 manifest 同时移除仅用于 monorepo 构建的 `devDependencies`，避免再次发布 npm 无法安装的包。

## [2.3.234] - 2026-07-17

### Fixed

- **修复全局 ContextWindow 变更不传递到已接管项目（auto-compact 窗口冻结）**: 项目在 v2.3.22（state 机制引入）之前被接管、或经历过 disable→enable 循环导致 `ccr-state.json` 缺失时，`.claude/settings.local.json` 里的 `CLAUDE_CODE_AUTO_COMPACT_WINDOW` 会停留在旧值（如 200000）。旧版守门在「state 缺失且当前值 ≠ 当前全局 ContextWindow」时把该旧值误判为用户手写值并永久保留，导致之后任何全局 `ContextWindow` 变更都不再生效，UI 重开关 takeover 也无法刷新。现在 `applyClaudeAutoCompactSettings` 在 state 缺失时重新将该字段视为 CCR-managed，写入当前全局值并重建 state；被覆盖的旧值记入 `previousAutoCompactWindow` 字段留痕，便于追溯。state 存在时仍保留原 v2.3.22 保证：与记录不符的值视为用户手写值、保持不变。新增 `auto-compact-state` 单元测试覆盖各边界。

## [2.3.233] - 2026-07-16

### Fixed

- **修复「立即更新」点击失败（404）**: UI `ApiClient` 的 `baseUrl` 已是 `/api`，但更新方法 `performUpdate()` 又传入 `/api/update/perform`，实际请求变成 `/api/api/update/perform`，服务端找不到路由而返回 404；现改为 `/update/perform`，与 `checkForUpdates`、`restartService` 等同文件正确写法一致，请求重新落到 `/api/update/perform`。
- **修复更新弹窗永远显示「暂无更新日志」**: `checkForUpdates` 此前只返回 npm latest 版本号、`changelog` 恒为空字符串。现在当检测到新版本时，优先从已发布 npm 包对应版本的 README changelog 表提取该版本摘要并转为可读文本；README 取不到时再 fallback 到 GitHub `CHANGELOG.md` 的对应版本段，两级来源都失败才回退到原有「暂无更新日志」兜底文案。网络错误不会中断版本检查。

### Docs

- **更新系统约定写入 CLAUDE.md**: 记录 UI `ApiClient` 的 `/api` baseUrl 约定（endpoint 不得重复 `/api`，否则产生 `/api/api/...` 404）、更新检查必须返回非空 changelog 的数据来源与 fallback、发布后端到端验证清单，以及 `packages/cli|core/README.md` 是发布时生成的副本、不应纳入发布提交。

## [2.3.232] - 2026-07-16

### Added

- **严格项目级路由边界**: 命中非空项目级 `Router` 后，该 Router 现在是请求的权威路由边界；目标 provider/model 不存在、格式错误、被禁用、不健康或额度耗尽时，不再静默逃逸到全局路由，而是返回稳定的 `ProjectRoutingError` 错误码与对应 HTTP 状态。项目自己显式配置的 fallback 仍可用，同时关闭全局 Router、`CUSTOM_ROUTER_PATH`、全局 fallback 继承与 promotion、客户端 `provider,model` override、subagent model override 和运行时二次 fallback 等项目外逃逸路径。
- **Provider 级代理策略**: 新增顶层 `PROXY_GLOBAL_ENABLED` 与 provider 级 `proxy_enabled`。未配置或设为 `true` 时所有 provider 继续使用共享的 `PROXY_URL`，保持旧配置兼容；设为 `false` 时仅显式启用的 provider 走代理，其余直连。推理、fallback、健康探测、额度查询、wakeup、provider API tokenizer 等出站请求统一遵循同一 provider 代理策略。
- **代理 URL 保存前校验与 UI 配置入口**: 配置 API、设置页和 JSON 编辑器现在只接受 `http://`、`https://`、空值或环境变量占位符形式的代理地址；`socks5://`、`ftp://` 或畸形 URL 会逐项报错且不会覆盖已有配置。设置页新增「全局生效」开关，provider 卡片新增独立代理开关，并提示代理可读取 API key 与请求内容、应仅使用可信代理。
- **pi 扩展上下文触发比例**: 新增 `Clients.pi.routing.extendedContextRatio`（默认 80%）及设置页配置，用模型 `contextWindow` 的比例控制 pi 何时进入 `extendedContext`；`longContext` 仍使用 family → 全局 → 60000 的绝对阈值链。

### Changed

- **CCR runtime 下沉到 core**: 将请求管线、路由、认证、用量、provider 服务与客户端识别等运行时能力集中到 `@wengine-ai/llms` core，`@wengine-ai/claude-code-router-server` 收敛为兼容 facade，并通过 per-client adapters 统一 Claude Code、Codex、pi、qwen-code 与 opencode 的差异化路由上下文。
- **pi 上下文路由语义修正**: pi 不再生成或消费 `[1m]` 模型后缀；旧接管配置中的 `ccr-*[1m]` 别名会被规范化剥离，`longContext` 不再按 `contextWindow` 比例计算。
- **代理连接池化与脱敏**: provider 出站请求统一复用按 URL 缓存的 `ProxyAgent`，服务关闭时集中释放；含凭据的代理 URL 与请求头在日志中脱敏，API tokenizer 缓存也按 provider 隔离。

### Fixed

- **修复 Codex Responses 请求被误识别为 Claude Code**: `/v1/responses` 端点与 Codex User-Agent 现在先于 `metadata.user_id` 启发式判断，避免跳过 Codex 账号选择并标错客户端和用量。
- **修复用量与上游模型记录回归**: 非流式响应从已解析 body 提取 `upstreamModel`；HTTP 失败请求不再复用上一成功请求的 input/cache tokens；Responses 的 `response.completed` 尾帧不再以零值重置 merge base；项目路由失败也不再清除下一请求所需的会话用量基线。
- **修复 runtime 生命周期与错误处理**: `createCcrServer({ port })` 现在正确采用传入端口，401/403 认证路径不再留下挂起 Promise，provider/transformer/tokenizer 初始化完成后才开始监听，preset 注册失败会被明确记录而不再静默吞掉，畸形项目路由目标会返回 `invalid_model_format` 而非逃逸到全局模型。

## [2.3.231] - 2026-07-04

### Added

- **发布确认点闸门（release gate）**: `scripts/release.sh` 新增 `validate_release_docs`，在任何发布动作前（npm/docker/all 所有模式，含 dry-run）强制校验：① 6 个 `package.json`（root + 5 包）版本一致且等于待发布版本；② `CHANGELOG.md` 存在该版本的非空 `## [x.y.z]` 段落；③ 两份 README 更新日志表格均有 `| **vx.y.z** |` 行；④ 版本号严格大于 npm 已发布的 latest（逐段数字比较，registry 不可达时警告跳过）。任何一项不满足即中止发布，把 CLAUDE.md 的 Release checklist 从人工约定变为自动确认点。
- **版本号策略：支持多位 patch 的日常小迭代**: 自本版本起，日常小迭代在 patch 段追加一位数字（`2.3.23` → `2.3.231` → `2.3.232`），避免每日发布把主版本数字推得过快。patch 按数字比较（CLI 更新检查与发布闸门同一规则），因此用过 `2.3.23x` 后下一个功能版本是 `2.3.240`（而非 `2.3.24`，会被闸门当降级拦截），或直接升 `2.4.0`。

### Changed

- **项目级接管默认仅接管 Claude Code**: 此前在 UI 打开项目「CCR 接管」开关（或 API 只传 `enabled: true`）会默认接管全部受支持客户端（Claude Code、pi、qwen-code、opencode），导致 pi/qwen/opencode 的项目级配置文件（`.pi/settings.json`、`.qwen/settings.json`、`opencode.json`）被写进项目目录（opencode 首次运行还会自行生成 `AGENTS.md`），污染项目根目录。现在所有默认路径（主开关开启、多选清空、legacy `enabled: true`、添加项目时的自动接管）都只接管 Claude Code；pi / qwen-code / opencode 改为在「接管的客户端」多选中显式勾选后才接管，UI 文案同步更新。

### Fixed

- **修复「检查更新」永远提示已是最新（双重 bug）**: ① 后端 `checkForUpdates`/`performUpdate`（`packages/cli/src/utils/update.ts`）硬编码了已从 npm unpublish 的旧包名 `claude-code-router-next`，`npm view` 返回 404 后被 catch 静默吞掉、恒返回 `hasUpdate: false`，UI 点「检查更新」永远提示已是最新，「立即更新」也会因同样的错包名安装失败；现改为从 `package.json` 动态读取包名（`@wengine-ai/claude-code-router-next`），与 `version` 的取法一致，今后改包名不会再失效。② 前端 `App.tsx` 的更新弹窗条件要求 `changelog` 非空，而后端该字段恒为空字符串，即使修复①后有新版本也不会弹窗；现去掉对 `changelog` 的强制判断（弹窗内已有「暂无更新日志」兜底文案）。

## [2.3.23] - 2026-07-04

### Changed

- **状态栏默认改为无图标表格风格**: 默认主题（CLI `DEFAULT_THEME`/`SIMPLE_THEME` 与 UI `createDefaultStatusLineConfig`）不再带装饰图标，模块之间改用细竖线 `│`（U+2502）分隔，呈简洁表格样式；默认模块与顺序调整为「模型 │ 工作目录 │ git 分支 │ 上下文进度条 │ token 速率 │ 会话总 token」。动机是歧义宽度的 emoji 图标（如闪电 `⚡` U+26A1）会让 Claude Code 误算状态栏显示宽度、在交互（如双击）重绘时产生数字重影/位移；改用定宽字符或不带图标可避免。图标仍支持在 UI 中自定义，通过 UI 新增的模块默认不带图标。
- **`build:ui` 构建后同步产物到 CLI/根 dist**: `pnpm build:ui` 改为经 `scripts/build-ui.js`，在构建 UI 后把 `index.html` 同步到已存在的 `packages/cli/dist` 与根 `dist`，使单独运行 `build:ui` 也能更新本地运行中的 ccr 实际读取的包（此前仅 `build:cli` 会拷贝，导致单跑 `build:ui` 后本地界面仍是旧包）。

### Fixed

- **修复状态栏 token 速率虚高（常显示几百、极端撞到 999 上限）**: `ccr statusline` 展示的 token 速率与「用量统计」页对不上——用量统计一般只有几十 t/s，状态栏却常显示几百、极端时撞到 999 上限。根因是 token-speed 插件在流式过程中每秒上报的是一个**滑动窗口值**（最近 1 秒内到达的 token 数），而 SSE delta 常成批到达（代理/网络缓冲会把一批 token 打上同一时间戳），使这个瞬时计数飙高，并不反映真实的持续解码速率；只有响应结束时的最终上报才用了正确的解码平均公式。现在流式过程中的每次上报也统一改用解码平均公式（`输出 token 数 ÷ (总耗时 − TTFT)`，与「用量统计」`usage-store` 记录速率完全同一套机制、同样的 1 秒最小解码时长兜底），状态栏速率会随流式逐步收敛到最终值，与用量统计维度一致，正常为几十 t/s。同时移除了不再使用的滑动窗口记账（`tokenTimestamps` 字段与逐 token 时间戳记录），消除长响应下该数组无限增长的隐患。
- **状态栏 token 速率流式衰减细化（停顿时向真实速率衰减）**: 流式过程中的每秒上报改用 `performance.now()` 作为解码结束边界，而非只在文本 delta 时才推进的 `lastTokenTime`。此前一次 SSE 突发后若发生停顿，上报速率会冻结在突发时的均值；现在会随停顿向真实持续速率衰减，最终上报仍以 `lastTokenTime` 作为真实解码结束（`now() >= lastTokenTime`，永不虚高）。
- **修复 UI statusline 配置中图标无法删除**: 切换所选模块时，图标搜索输入框（`IconSearchInput`）此前只在挂载时初始化内部输入状态、不随 `value` 变化同步，导致输入框与模块真实图标脱节、图标看似删不掉。现在在 `value`（所选模块）变化时同步内部输入状态。
- **UI 迁移旧版 `contextCircle` 上下文模块为 `contextBar`**: 加载配置时把旧的 `contextCircle` 模块迁移为 `contextBar`（与 CLI 渲染时的自动升级一致），使配置弹窗显示长条进度条而非旧圆圈图标，保存时顺带持久化该升级；实时预览也补充了 `contextBar` 示例值与 `│` 分隔符渲染。

## [2.3.22] - 2026-06-29

### Added

- **状态栏按用户配置的压缩阈值显示上下文上限**: `ccr statusline` 此前直接用 Claude Code 传入的 `context_window.context_window_size`（模型完整窗口，标准 claude 为 200000、扩展上下文为 1000000）作为分母计算百分比与显示上限，即使用户通过 `CLAUDE_CODE_AUTO_COMPACT_WINDOW` 设了更低的压缩阈值（如 400000），状态栏仍显示 1M/200k，与实际压缩时机脱节。现在优先读取 `CLAUDE_CODE_AUTO_COMPACT_WINDOW` 环境变量（即 CCR 从顶层 `ContextWindow` 写入的值）作为上限，未设时才回退到 Claude Code 的窗口值，使状态栏百分比与实际 auto-compact 触发点对齐。

### Changed

- **接管时保留用户手写的 auto-compact 自定义值**: CCR 接管 Claude Code（全局 `~/.claude/settings.json` 或项目 `.claude/settings.local.json`）时，`applyClaudeAutoCompactSettings` 此前无条件用全局 `ContextWindow` 覆盖 `CLAUDE_CODE_AUTO_COMPACT_WINDOW`，会把用户为某项目手写的自定义值（如 400000）打回默认 200000；卸载时则无条件删除该字段。现在 CCR 用状态文件精确区分「自己写入的值」与「用户手写的值」：全局状态存于 `~/.claude-code-router/client-state.json`（按 clientId 分键），项目状态存于 `~/.claude-code-router/<project-id>/ccr-state.json`。接管/刷新时，仅当字段缺失或仍等于 CCR 上次写入值才随 `ContextWindow` 更新并刷新状态记录；与记录不符的值视为用户自定义予以保留。卸载时只清除仍等于 CCR 写入值的字段并清空状态记录，用户自定义值保留。状态文件缺失时退化为保守策略（已存在的值一律保留，绝不误覆盖）。正常用户在 UI 改 `ContextWindow` 后刷新仍能生效（此时字段值==记录值，会被更新）。

### Fixed

- **UI 上下文窗口配置项补充与扩展上下文的配合提示**: 顶层「上下文窗口 (ContextWindow)」配置项此前未说明：设为大于 200000 时必须同时在该模型家族的路由中启用「扩展上下文 (1M)」（使模型名带 `[1m]` 后缀），否则 Claude Code 会把 `CLAUDE_CODE_AUTO_COMPACT_WINDOW` 封顶至 200000、配置不生效。现在在该输入框下方补充配合说明，并在 `ContextWindow > 200000` 且对应模型家族未启用扩展上下文时显示红色警告条；「扩展上下文 (1M)」开关的描述也同步补充了与顶层上下文窗口的配合关系。
- **修复状态栏百分比按 1M 计算的问题**: `ccr statusline` 的子进程不一定继承项目级 settings 的环境变量，导致写在项目 `.claude/settings.local.json` 里的 `CLAUDE_CODE_AUTO_COMPACT_WINDOW` 被漏读，百分比回退到模型完整窗口（如 1M）。现在依次从 `process.env`、项目 `settings.local.json`、全局 `settings.json` 读取该值，都没有才回退到 Claude Code 报告的窗口值。
- **修复状态栏上下文百分比偶发闪 0%**: 状态栏分子取自 `current_usage`（Claude Code 的当前一轮快照），在请求进行中或 auto-compact 刚触发后这一瞬为空，导致百分比短暂显示 0%。现在在快照为空时回退到 transcript 中最近一条 assistant 消息的上下文用量（`input + cache_creation + cache_read`，与原计算同口径），保持百分比稳定。
- **修复项目接管 disable→enable 循环后 auto-compact 窗口冻结**: 项目级接管的 `ccr-state.json`（记录 CCR 上次写入值）在 disable 时被清除，而再 enable 时从备份恢复的旧 managed 窗口被误判为用户手写值、状态不重建，导致后续 `ContextWindow` 变更无法通过刷新生效；更严重的，一旦状态文件丢失，CCR 无法识别自己写入的窗口，关闭接管时该字段作为残留遗留（用户报告的 400000 残留即此）。现在状态缺失时用「值等于当前 `ContextWindow`」兜底识别 CCR-managed：enable 重建状态、disable 清除残留；真正的用户手写值（与配置不符）仍予以保留。

## [2.3.21] - 2026-06-27

### Added

- **新增 pi (earendil-works) 客户端接管**: 在客户端接管能力中新增 pi 作为第三个接管目标（与 Claude Code、Codex 并列）。pi 使用 Anthropic `/v1/messages` 协议，ccr 直连无需 transformer。pi 的配置存放在目录 `~/.pi/agent`，接管会写入两个文件并备份原文件以便关闭时还原：`models.json` 注册一个自定义 `ccr` provider（`api: "anthropic-messages"`，`baseUrl` 指向 ccr 代理，apiKey 放在 provider 上）暴露 `ccr-opus`/`ccr-sonnet`/`ccr-haiku` 族别名（不触碰 `auth.json`）；`settings.json` 把 `defaultProvider`/`defaultModel` 指向该 ccr provider，保留用户其它设置。通过 `piAdapter` 复用既有 `ClientAdapter` 模式实现，服务端 `/api/clients` 端点与 UI Clients 列表已由 `CLIENT_IDS` 驱动，仅做配置注入式接管（不含账号管理）。用量统计也会把 pi 识别为独立客户端：pi 与 Claude Code 共用 `ccr-opus/sonnet/haiku` 别名，此前 pi 请求会被误并入 Claude Code，现在通过 pi system prompt 特征（`operating inside pi` / `a coding agent harness`）优先正向识别、辅以 Anthropic SDK 请求头（`Anthropic/JS` UA、`x-stainless-*`）兜底来区分（Claude Code 仍以 `claude-cli` UA / `cc_version` 头识别），用量统计页新增「pi」客户端类型。
- **项目级接管支持多客户端多选（Claude Code + pi + qwen-code + opencode）**: 「项目级配置」页的「CCR 接管」此前写死只接管 Claude Code（写项目 `.claude/settings.local.json`）。现在改为多选：接管开关旁新增客户端多选下拉框，可分别选择对该项目接管 Claude Code、pi、qwen-code、opencode；不选则默认接管全部受支持的客户端（「不选 = 全部」）。pi 的项目级接管利用其项目级配置能力——在项目目录写 `.pi/settings.json` 把 `defaultProvider`/`defaultModel` 指向全局注册的 ccr provider，并在 `~/.pi/agent/trust.json` 中信任该项目目录（否则非交互模式 `-p`/json/rpc 不会加载 `.pi/settings.json`）；ccr provider 定义因 pi 无项目级 `models.json` 仍注册在全局（幂等、无副作用，本身不路由任何请求，只有 settings 指向它才生效）。接管状态完全从各客户端的项目级配置文件实时推导，无需额外存储字段，自动兼容既有项目；保存全局配置时会一并刷新已接管项目的 pi/qwen/opencode 字段。Codex 因配置（`~/.codex/config.toml`）为全局-only，不纳入项目级接管。
- **新增 qwen-code (Alibaba) 客户端接管**: 在客户端接管能力中新增 qwen-code（`@qwen-code/qwen-code`）作为第四个接管目标。qwen-code 使用 Anthropic `/v1/messages` 协议（ccr 直连无需 transformer），配置在 `~/.qwen/settings.json`（用户级）与 `<项目>/.qwen/settings.json`（项目级 workspace，覆盖用户级）。接管会注册一个自定义 Anthropic `modelProvider`（`modelProviders.anthropic[]`，`baseUrl` 指向 ccr 代理，暴露 `ccr-opus`/`ccr-sonnet`/`ccr-haiku`，apiKey 放在 `settings.env[envKey]`）、设 `security.auth.selectedType=anthropic` 并选定 `model`，备份原文件以便关闭时还原，保留用户其它 provider 与设置；项目级接管还会在 `~/.qwen/trustedFolders.json` 中把项目目录标记为 `TRUST_FOLDER`（否则 qwen 会忽略 workspace 配置）。用量统计也会把 qwen-code 识别为独立客户端：qwen 经代理（非 anthropic 官方域名）时会把 `useProxyIdentity` 置真、**伪装成 Claude Code 的 `claude-cli` User-Agent**，因此检测改为优先用 qwen system prompt 特征（`You are Qwen Code, an interactive CLI agent`）正向识别、Claude Code 改以 `cc_version` 头与 `metadata.user_id` 强信号识别（伪装者均不带）、ccr-* 子请求按 UA 兜底区分（`Anthropic/JS`→pi、`claude-cli`→qwen-code），用量统计页新增「Qwen Code」客户端类型。
- **新增 opencode (opencode.ai) 客户端接管**: 在客户端接管能力中新增 opencode 作为第五个接管目标。opencode 使用 Anthropic `/v1/messages` 协议（ccr 直连无需 transformer），配置在 `~/.config/opencode/opencode.json`（全局）与 `<项目>/opencode.json`（项目级，向上合并到 git root）。接管会注入一个自定义 `provider`（`npm: "@ai-sdk/anthropic"`，`options.baseURL` 指向 `http://127.0.0.1:3456/v1`、apiKey 内联，`models` 暴露 `ccr-opus`/`ccr-sonnet`/`ccr-haiku`）并把默认 `model` 设为 `ccr/ccr-opus`，备份原文件以便关闭时还原，保留用户其它 provider 与设置；opencode 无 trust 机制，项目级接管直接写 `opencode.json` 即可。用量统计也会把 opencode 识别为独立客户端：opencode 每个请求（含子请求）都带 `opencode/<版本> ai-sdk/…` 的 User-Agent 且不伪装，因此直接按 UA 识别（并以 system prompt `You are opencode` 特征兜底），用量统计页新增「opencode」客户端类型。

## [2.3.20] - 2026-06-26

### Fixed

- **清理改名/删除模型后残留的僵尸熔断记录**: 当从某 provider 的 `models` 中重命名或删除模型（如把 `ollama,glm-5.2` 改为 `ollama,glm-5.2:cloud`）后，旧模型名在 `~/.claude-code-router/runtime/provider-health.json` 中的熔断记录会成为僵尸：UI 上该供应商一直显示 `Failed`，且因熔断状态持久化落盘，`ccr restart` 也无法清除；点击 UI 刷新触发的 probe 成功后只会 `recover` 当前配置的模型名，清不掉旧名字那条。现在新增 `utils/health-reconcile.ts` 工具做三层清理：① 服务启动时按当前配置对账，清掉不可路由的残留记录；② 保存配置后（热重载）立即清理被本次改动移除的 provider/model；③ probe 成功时清掉该 provider 名下全部熔断记录（probe 检测的是端点级 `/v1/models` 可达性，成功即代表可达，真正失效的模型会在下次真实请求时重新熔断）。「可路由模型」集合由各 provider 的 `models` 与 Router/fallback 中引用的所有 `provider,model` 共同构成，避免误删 `models` 为空但仅通过 Router 路由的模型（如 `阿里云 Coding Plan,glm-5`）的健康状态。新增 7 个针对可达集合计算的单元测试。

## [2.3.19] - 2026-06-25

### Added

- **新增 OpenCode (opencode.ai) Transformer**: 为 OpenCode 这类暴露 OpenAI 兼容 `/v1/chat/completions`、底层由 GLM/智谱模型驱动的 provider 新增专用 transformer。它显式声明 `endPoint="/v1/chat/completions"`，避免某 provider 唯一解析到的 transformer 是 `AnthropicTransformer` 时触发 bypass 模式，把 Anthropic 格式工具（`{name,description,input_schema}`）直接发给只认 `{type:"function",function:{…}}` 的 OpenAI 兼容接口；同时清理 GLM 不识别的 `cache_control` 与 Anthropic 专有的 `image_url`/`media_type` 字段，将流式与非流式响应中的 `reasoning_content` 转换为 Claude Code 期望的 thinking 格式，并把纯数字的 `tool_call` ID 替换为 UUID 以避免下游解析问题。在 `config.json` 的 provider `transformer` 中配置 `"opencode"` 即可启用。

### Fixed

- **设置页代理地址与 API 密钥输入框禁用浏览器自动填充**: Web UI 设置页（弹窗版 `SettingsDialog` 与整页版 `SettingsPage`）的「代理地址」「API 密钥」输入框此前会被 Chrome 用已保存的表单数据/密码自动填充，覆盖真实配置值。现在通过 `Input` 组件新增的 `disableAutofill` 提供三重防护：每次挂载生成随机 `name` 让浏览器无法匹配已保存数据、初始 `readOnly` 至首次聚焦后再解除以跳过自动填充、设置 `autoComplete="off"` 及 `data-lpignore`/`data-1p-ignore`/`data-form-type` 标记忽略主流密码管理器；并在表单顶部放置隐藏 honeypot 字段吸收凭据填充。

## [2.3.18] - 2026-06-24

### Fixed

- **模型族长上下文阈值继承主路由配置**: `ccr-opus`/`ccr-sonnet`/`ccr-haiku` 进入 family routing 后，此前只读取 `Router.families.<family>.longContextThreshold`，未配置时会回退到代码默认 `60000`，导致即使主路由 `Router.longContextThreshold` 配成 `100000`，约 70k token 的请求仍被判为 `<family>/longContext`。现在 family 未单独配置阈值时会继承主路由 `Router.longContextThreshold`，最后才回退到 `60000`。
- **fallback 候选模型也执行 Double-Check 重试**: v2.3.15 的同模型快速重试只覆盖主模型，fallback 链路中某个候选模型第一次 `fetch failed`/空 SSE/隐藏错误后会直接切到下一个候选。现在每个 fallback 候选也会先重试一次，第二次仍失败才记录失败并继续下一个；同时修正 fallback 失败 usage 记录的 `originalModel`，避免 UI 显示成上一跳模型到 fallback 模型的误导链路。
- **全局配置保存后同步项目级 CCR 接管字段**: 项目启用 “CCR Takeover” 且 “使用全局配置” 时，运行时路由会读取最新全局 Router，但项目 `.claude/settings.local.json` 中的 CCR 托管字段（模型族别名、auto-compact 窗口、状态栏、代理地址/token 等）此前只在启用接管时写入一次，后续全局配置修改不会自动刷新。现在保存全局配置后会自动刷新所有仍跟随全局配置且已接管的项目；项目切回使用全局配置并保存时，也会立即刷新该项目的接管字段。
- **默认降低日志量并保留最近 7 天**: 服务器日志默认级别从 `debug` 调整为 `error`，正常运行只记录错误；需要排查问题时可显式配置 `LOG_LEVEL` 为 `info`/`debug`/`trace` 获取详细日志。同时 `~/.claude-code-router/logs/ccr-*.log` 启动时和运行中每日自动清理一次，默认只保留最近 7 天的服务器日志。

## [2.3.17] - 2026-06-19

### Fixed

- **忽略已删除模型的残留路由，防止健康池污染**: 运行中从 provider 配置删除某个模型后，路由和 fallback 路径中残留的 `provider,model` 字符串仍会被当作有效候选，反复请求失败后进入健康池（fail pool），导致无关的 fallback 模型也被跳过。现在 `resolveConfiguredModel` 对无法在当前 provider 注册表中匹配到的 `provider,model` 直接返回 `null`，主路由保留客户端原始 model 而非传递失效字符串；fallback 循环在尝试请求前即校验模型是否存在于 provider 配置，跳过不存在的候选；`ProviderHealthStore` 所有公开方法统一在 `getKey` 层拦截空 provider/model，防止 `",model"` 等畸形 key 污染池数据。同时修复 fallback catch 块与成功路径使用不同变量（raw vs canonical）导致 `recordSuccess`/`recordFailure` 可能记录不同 key 的问题；抽取 `findProviderModel` 共用函数消除 `routes.ts` 与 `router.ts` 之间的重复 provider/model 查找逻辑。
- **修复 fallback 触发时所有备用模型报 Invalid URL**: 主模型限流（如智谱套餐）触发 fallback 后，此前所有备用模型都报 `Invalid URL`。根因是 fallback 路径用 `configService.get("providers")` 取到的是原始 `ConfigProvider[]`（字段 `api_base_url`，无 `baseUrl`），而 `sendRequestToProvider` 用 `provider.baseUrl` 构造上游 URL，`new URL(undefined)` 对每个备用模型都抛 `Invalid URL`。改为用 `providerService.getProviders()`（已注册的 `LLMProvider[]`，带 `baseUrl`）。新增回归测试断言匹配到的 provider 保留 `baseUrl`（LLMProvider 契约），且原始 `ConfigProvider` 数组不会被凭空赋予 `baseUrl`。
- **修复 fireworks 托管上游的用量统计全 0（input 有值、output 与缓存命中为 0）**: fireworks 流式把真实 usage 放在 `finish_reason` 之后的一个 `choices: []` 空 chunk 里，且 `finish_reason` chunk 自身 `usage=null`。流式 transformer 两处缺陷导致丢失：① `finish_reason` 块用 finish chunk 自己的（null）usage 整体覆盖了已按字段 merge 的真实 usage，把 `output_tokens`/`cache_read_input_tokens` 清成 0；② `finish_reason` 后 `break` 跳出读取循环，之后的 `choices:[]` 真实 usage chunk 永远读不到。修复：循环守卫去掉 `hasFinished` 以便 finish 后继续读取后续 chunk（content 生成路径已有 `!hasFinished` 守卫，不会重复输出内容）；`finish_reason` 块只设 `stop_reason` 不碰 usage，usage 统一交给 `if (chunk.usage)` 的按字段 merge；`break` 改为 `hasFinished = true`。同时修复下游 `index.ts` 三层用量捕获（transformer 覆盖、SSE 帧逐帧 spread merge、`??` 对 0 不 fallback）——抽出 `normalizeUsagePayload`/`mergeUsageCapture` 到 `utils/usage-merge.ts` 并改为 `||` fallback，零值 usage 帧不再清空 input。新增 server vitest 配置 + 10 个用量 merge 测试 + 流式 transformer harness 测试（覆盖 fireworks chunk 顺序、标准 provider 对照、finish 后迟到内容不重复）。

## [2.3.16] - 2026-06-18

### Fixed

- **修复 system 消息顺序兼容 DeepSeek/vLLM**: OpenAI 兼容提供商（DeepSeek V4、GLM、vLLM）要求消息按 `[system, user, assistant]` 顺序排列。此前 CCR 在 `routes.ts` 与 `anthropic.transformer.ts` 两处会把 system 消息排在 user/assistant 之后，导致这些上游返回乱码输出。现在统一将 system 消息前置到数组开头并对完全重复的 system 内容去重。

### Added

- **接管时去除 Claude Code Attribution 动态头以提升缓存命中**: CCR 接管 Claude Code 时（`ccr code` 运行时环境、写入全局 `~/.claude/settings.json`、以及项目级 `.claude/settings.local.json` 接管）默认注入 `CLAUDE_CODE_ATTRIBUTION_HEADER=0`，去掉系统提示词开头随每次请求变化的 attribution 头（客户端版本 + prompt fingerprint）。该动态头每条请求都不一样，会破坏上游 prompt-cache 的稳定前缀，导致通过 CCR 网关路由的请求几乎无法命中缓存、每次都重新计费整段上下文。去掉它与本版本的「system 消息前置 + 去重」配合，可在保证 vLLM/DeepSeek/GLM 兼容的同时稳定命中上游 prompt 缓存，显著降低重复请求的 token 用量与延迟。新增顶层配置项 `disableAttributionHeader`（默认开启），可在 Web UI 设置页或配置文件中设为 `false` 关闭；项目级接管会与最大上下文（`CLAUDE_CODE_AUTO_COMPACT_WINDOW`）、自动压缩（`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`）一并从全局配置继承该设置；关闭接管（全局 `removeClaudeManagedFields` 与项目级 `removeCcrProjectTakeover`）时会自动清理该环境变量。

### Changed

- **设置页布局紧凑化**: Web UI 设置页将「日志级别」下拉从独占整行移入两列网格，与「API 密钥」并排显示，减少页面纵向高度，避免单独半行留白。

## [2.3.15] - 2026-06-17

### Added

- **Fallback 前同模型重试一次（Double-Check）**: 此前模型调用出现一次异常（网络抖动、偶发限流、空 SSE 响应等）就立即切换到备用模型。现在先对同一模型自动重试一次请求，重试成功则正常返回，避免不必要的模型切换；重试仍失败才走原有的 fallback 流程。
- **用量统计显示上游真实模型**: 部分上游网关会在 ccr 不知情的情况下将请求偷偷路由/降级到另一个后端模型（如请求 glm-5 实际返回 MiniMax-M2.5）。用量统计的模型映射显示现在追加上游返回的真实模型，格式为 `originalModel → routedModel → upstreamModel`（如 `ccr-opus → glm-5 → minimax-m2.5`），上游未偷换时与路由模型相同则自动省略。后端在三种响应形态（Anthropic SSE `message_start`、Responses API `response.completed`、非流式 JSON）下捕获上游返回的 model 字段，存入 `usage_records.upstream_model` 列（走 `user_version` v2 迁移，旧库自动 ALTER TABLE 加列）。

## [2.3.14] - 2026-06-16

### Fixed

- **状态栏显示 `<synthetic>` 而非真实模型名**: Claude Code 在 auto-compact 自动压缩、中断恢复等场景会向 transcript 写入 `model: "<synthetic>"` 的合成 assistant 消息（并非真实 LLM 响应）。ccr 状态栏从后往前取「最后一条 assistant 消息的 model」时未排除这类合成消息，导致状态栏模型段直接显示 `<synthetic>`（从 Claude 账号会话切换到 ccr 接管、或发生自动压缩后尤其常见）。现在过滤掉 `<...>` 形式的合成标识，正确显示实际调用的模型名，同时不再把合成消息的 usage 计入 token 统计。

## [2.3.13] - 2026-06-15

### Fixed

- **删除项目配置未清理项目 `settings.local.json`**: 添加项目时会自动启用 ccr takeover，把代理地址、模型族路由环境变量、auto-compact、statusline 等 ccr 托管字段写入项目的 `.claude/settings.local.json`；但删除项目时此前只删除了 `~/.claude-code-router/<project-id>/` 配置目录，未反向清理 `settings.local.json`，导致 ccr 相关配置残留。现在删除项目前会先关闭 takeover，移除这些托管字段。

## [2.3.12] - 2026-06-15

### Fixed

- **定时唤醒未真正触发计费周期**: `wakeupProvider()` 此前使用 `max_tokens: 1` 和 `content: "ping"` 发送极简 dummy 请求，部分 Coding Plan 类提供商（如智谱）会接受请求但不产生实际 token 消耗，导致日额度周期未被激活。现在改用真实推理 prompt 并将 `max_tokens` 提高到 `10`，确保唤醒请求被计入实际使用。
- **Codex 等 `/messages` 端点提供商唤醒 404**: `wakeupProvider()` 此前仅通过 URL 是否包含 `anthropic` 或模型名是否包含 `claude` 判断 Anthropic 协议，Codex 等使用 `gpt-*` 模型但 baseUrl 以 `/messages` 结尾的提供商被误判为 OpenAI 协议，URL 被错误拼接为 `/v1/messages/chat/completions`。现在以 `baseUrl` 是否包含 `/messages` 作为 Anthropic 协议判定依据，且 `baseUrl` 作为完整路径直接使用，不再拼接任何后缀。
- **唤醒/探测请求缺少来源标识**: 为唤醒和独立探测请求增加 `x-claude-code-router-source` 与 `x-claude-code-router-version` 请求头，方便上游服务识别这是 CCR 内部发起的探测/唤醒流量。

## [2.3.11] - 2026-06-14

### Fixed

- **新会话首个请求绕过项目级路由（会话/项目检测竞态）**: 新会话的第一个请求（如 Claude Code 的标题生成元请求，通常比主请求早到约十几毫秒）到达时，对应的 session 转写文件 `~/.claude/projects/<project>/<sessionId>.jsonl` 可能尚未落盘，导致 `searchProjectBySession()` 通过 `stat` 找不到文件、回退到全局 `Router`，使这一个请求绕过项目级路由（例如项目已关闭 `enableFamilyRouting`，却仍走了全局模型族路由）。现在缓存未命中时会进行有限次短延迟重试（最多 3 次、每次 50ms），给文件落盘留出时间；并用 `sessionRetryAttempted` 标记保证每个 session 仅重试一次，避免真正非托管会话的每个请求都被附加延迟。命中后仍只缓存成功结果（保持 v2.3.8 的“不缓存未命中”语义）。

## [2.3.10] - 2026-06-13

### Fixed

- **`thinking: {type: "disabled"}` 误触发 `think` 场景路由**: `resolveFamilyModel()` 与 `getUseModel()` 判断是否进入 `think` 场景时，此前仅检查 `req.body.thinking` 是否存在；但 Claude Code 标题生成等元请求会固定携带 `thinking: {type: "disabled"}`，作为真值对象会被误判为"已开启思考"，导致即使项目关闭了模型族路由（`enableFamilyRouting: false`）也会被路由到全局 `think` 模型。现在仅当 `req.body.thinking?.type === "enabled"` 时才进入 `think` 场景路由。
- **主模型熔断且无可用 fallback 时返回空模型**: `getUseModel()` 此前在 `Router.default` 因健康检查（fail-pool 熔断）不可用、且未启用 fallback 或所有 fallback 均不可用时，直接返回空模型，导致下游抛出合成的 "provider not found" 错误而非真实上游响应。现在会作为最后兜底，跳过健康检查重新尝试 `Router.default`（仍遵循 `enabled: false` 与配额耗尽限制），让请求送达上游获得真实响应，便于 Claude Code 自行重试。

## [2.3.9] - 2026-06-13

### Added

- **Codex 代管理账号令牌自动刷新**: 新增后台调度器（启动 60 秒后首次执行，之后每 30 分钟一次），自动检查所有 Codex 代管理账号——无论是否为当前激活账号——当 `access_token` 距过期不足 24 小时，或自上次刷新已超过 7 天时，使用 `refresh_token` 自动换取新 token 并写回账号存储；若为当前激活账号，同时备份并同步覆盖 `~/.codex/auth.json`。换取前会优先比对 `~/.codex/auth.json` 中是否存在更新的 `last_refresh`（如官方 Codex CLI 自行刷新过），避免用过期的 refresh_token 换取失败。可通过 `Clients.codex.autoRefreshTokens` 关闭（默认开启）。

### Fixed

- **运行时 fallback 重试未遵循项目级 `enableFallback`**: 请求实际发出后失败（如限流）触发的重试 fallback（`handleFallback`）此前直接读取全局 `Router.enableFallback` 与全局顶层 `fallback` 配置，忽略项目级路由的 `enableFallback: false` 与项目自定义的 `Router.fallback`；现在 `router()` 会将解析出的项目级 `enableFallback`/`fallback` 通过请求上下文传递给运行时重试逻辑，确保两处 fallback 判定使用同一份配置。

## [2.3.8] - 2026-06-13

### Added

- **可配置上下文窗口**: 设置页新增 `ContextWindow` 配置项，用于控制 Claude Code / Codex 接管时的自动压缩上下文窗口，默认 `200000` tokens。

### Changed

- **接管配置同步上下文窗口**: Claude Code 接管时根据全局 `ContextWindow` 写入 `CLAUDE_CODE_AUTO_COMPACT_WINDOW`；Codex 接管时写入 `model_context_window` 与 `model_auto_compact_token_limit`（约 90%），确保 CCR 模型别名也能在真实模型溢出前触发自动压缩。

### Fixed

- **项目路由会话识别修复**: 兼容 `metadata.user_id` 为 JSON 字符串（`{"session_id":"..."}`）、对象（`{session_id: "..."}`）和 legacy（`user_..._session_<id>`）三种格式；对 session id 增加安全校验（仅允许 `[A-Za-z0-9_-]+`），防止路径穿越。
- **项目 session 缓存修复**: `searchProjectBySession()` 仅缓存成功命中的 session → project 映射，不再缓存未命中和错误结果，避免 Claude Code 首次请求时 session 文件尚未创建导致项目级路由被长期判定为未命中。
- **关闭模型族路由后别名映射旁路修复**: 当项目 `enableFamilyRouting` 为 `false` 时，`ccr-opus`/`ccr-sonnet`/`ccr-haiku` 等 CCR 注入的族路由别名不再被 `Router.models` 中遗留的别名映射（如接管 Codex 时写入的 `ccr-opus -> <旧 default>`）拦截，正确回退到项目自定义的 scenario 路由（`default`/`background`/`think`/`longContext` 等）。

## [2.3.7] - 2026-06-13

### Fixed

- **项目级 fallback 复制丢失**: 关闭「使用全局配置」自定义项目路由时，正确将全局顶层 `fallback`（全局配置中 `fallback` 是 `Router` 的同级字段）合并进项目 `Router` 的嵌套 `fallback`，避免复制全局配置时丢失备用模型链；同时回填已受影响的存量项目配置。
- **CCR 接管后模型配置不同步**: 切换 CCR 接管开关时，无论是否存在历史备份，都会基于*当前*全局配置重新生成 ccr 托管字段（`ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`、模型族路由环境变量、auto-compact、状态栏命令），确保全局配置变更后重新接管能同步最新模型路由，同时保留备份中的 `permissions`/`hooks` 等非托管字段。

### Changed

- **新增项目默认接管并跟随全局**: 在「项目配置」页添加项目时，默认开启「CCR 接管」与「使用全局配置」——自动将 ccr 代理配置写入该项目的 `.claude/settings.local.json`，并保持项目 `Router` 为空以实时跟随全局路由，新项目无需手动操作即可开箱即用（接管写入失败不影响项目添加，返回的 `ccrTakeover` 如实反映结果）。

## [2.3.6] - 2026-06-12

### Added

- **项目级 CCR 接管**: Web UI 项目配置页新增「CCR 接管」开关，开启后会将 `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`、模型族路由环境变量（`ANTHROPIC_DEFAULT_OPUS_MODEL`/`ANTHROPIC_DEFAULT_SONNET_MODEL`/`ANTHROPIC_DEFAULT_HAIKU_MODEL`/`ANTHROPIC_MODEL`/`ANTHROPIC_REASONING_MODEL`）、auto-compact 相关配置（`CLAUDE_CODE_AUTO_COMPACT_WINDOW`/`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`/`autoCompactEnabled`）以及状态栏 `statusLine: ccr statusline` 同步写入该项目的 `.claude/settings.local.json`，使该项目的 Claude Code CLI 无需 `ccr code` 即可直接通过 CCR 路由，同时保留原有的 `permissions`/`hooks` 等配置。
- **接管开关备份/还原机制**: 关闭接管时会将当前 ccr 管理的配置备份到 `~/.claude-code-router/<project-id>/settings.local.backup.json`，并从 `.claude/settings.local.json` 中移除 ccr 相关字段；重新开启接管时优先恢复备份，没有备份则按当前全局配置重新生成，避免个性化配置丢失。
- **项目配置页改进**: 项目卡片支持折叠/展开；关闭「使用全局配置」后正确同步全局路由的 fallback 与模型族配置；保存/新增项目接口返回结果中包含 `ccrTakeover` 状态，修复保存后接管状态短暂显示为关闭的问题。

## [2.3.5] - 2026-06-10

### Added

- **讯飞 Coding Plan 用量查询**: 支持将讯飞 MaaS 控制台订阅查询页面的 `Cookie` 作为 `quotaToken`，在 Web UI 中自动查询并展示 5h / 7d 限额；该 token 可能会过期，过期后需要重新手动添加。

## [2.3.4] - 2026-06-10

### Fixed

- **Raw config round-trip**: 添加 `readConfigFileRaw()` 读取未插值的原始配置，确保 UI 保存时 `$VAR` 环境变量占位符不被替换；保存/切换/删除 provider 后从服务端重新拉取配置，避免乐观更新导致 UI 状态与服务端不一致；移除 UI 中未使用的 API 方法（`getProviders`、`addProvider` 等）

## [2.3.3] - 2026-06-09

### Fixed

- **状态栏 token 速率上限**: 修复 token 速率显示异常大数字（如 7000）的问题，统一限幅最大 999 t/s；调整速率来源优先级为插件实测值 > SQLite usage 记录 > 累计 token 估算；仅在主题需要 speed 相关变量时才执行 token-speed I/O 和 usage fallback，避免不必要的文件/数据库读取

## [2.3.2] - 2026-06-09

### Fixed

- **状态栏 token 速率显示**: 状态栏支持读取 timestamped token-speed 临时文件，并在 Claude Code 未提供当前输出 token 时回退使用插件记录的 `tokensPerSecond`

## [2.3.1] - 2026-06-08

### Fixed

- **CLI 发布包 Node peer 依赖**: 移除发布包中的 `peerDependencies.node`，只保留 `engines.node`，避免 npm 自动安装 `node` 包导致 `better-sqlite3` 使用错误 Node ABI 编译
- **CLI stale dist 发布风险**: CLI 构建前会清理 `packages/cli/dist`，防止旧的 `dist/index.js`、`dist/package.json` 混入 npm 发布包
- **发布前校验**: `scripts/release.sh` 增加 `PUBLISH_DRY_RUN=1` 和 npm pack preflight，发布前校验必需产物、拒绝 stale dist 文件并确保不会生成 `peerDependencies.node`

## [2.3.0] - 2026-06-08

### Added

- **SQLite 用量存储**: 将本地用量数据从 JSONL 文件迁移到 SQLite 单文件数据库（`~/.claude-code-router/data/usage.sqlite`），提升查询性能和数据管理能力
  - 采用 `better-sqlite3` 嵌入式数据库，对用户透明无感
  - WAL 模式 + 索引优化，支持按时间、供应商、模型、场景、客户端类型等多维度高效查询
  - 自动一次性迁移：首次启动时从旧 `usage.jsonl` 导入历史记录（`INSERT OR IGNORE` 保证幂等），迁移完成后不再重复导入
  - 旧 `usage.jsonl` 保留为备份，不会被删除或截断
- **180 天自动保留策略**: 自动清理超过 180 天的用量记录，在数据库初始化时和定期追加时执行，减少磁盘占用
- **优雅关闭**: 新增 `close()` 函数支持 WAL checkpoint 和数据库连接清理

### Changed

- **数据库 schema 版本管理**: 通过 `PRAGMA user_version` 跟踪 schema 版本，为未来数据库迁移预留扩展路径
- **Docker 构建**: Alpine 镜像增加 `python3`、`make`、`g++`（构建）和 `libstdc++`（运行时）依赖以支持 `better-sqlite3` 原生模块
- **发布包**: CLI 发布依赖新增 `better-sqlite3`，确保用户安装后原生模块可正常解析
- **Usage API 文档**: 新增 `docs/docs/server/api/usage-api.md`，完整记录存储位置、迁移行为、保留策略和 API 端点

### Fixed

- **用量统计浮点精度**: `ttft` 和 `tokensPerSecond` 字段使用 `parseFloat` 替代 `parseInt`，保留小数精度

## [2.2.1] - 2026-06-07

### Fixed

- **Codex 用量统计缺少缓存数据**: 补齐 Responses API 与服务端 usage 归一化链路，正确统计并展示 `cache hit`、`cache creation` 与缓存命中率
  - 兼容 `input_tokens_details.cached_tokens`
  - 兼容 `input_tokens_details.cache_creation_tokens` / `cache_write_tokens`
  - 兼容 `prompt_tokens_details.cached_tokens` / `cache_creation_tokens`
  - 保证流式 `response.completed` 与非流式响应都能写入缓存统计
- **Codex 客户端 TTFT 统计缺失**: `token-speed` 插件补充 `/v1/responses` 监听与 Responses API SSE 事件解析；避免用 `ccr-opus` 等模型族别名判断客户端类型，防止 Claude Code 请求被误判为 Codex 客户端

## [2.2.0] - 2026-06-06

### Added

- **Codex CLI 完整支持**: 通过 Responses API (`/v1/responses`) 协议转换，支持 Codex CLI 接入任意 LLM 提供商
  - Anthropic SSE → Responses API SSE 流式转换（工具调用、文本、推理）
  - OpenAI Chat SSE → Responses API SSE 流式转换
  - 完整的工具调用链路：`response.output_item.added` → `response.function_call_arguments.delta` → `response.function_call_arguments.done` → `response.output_item.done` → `response.completed`
- CCR 模型族别名路由（`ccr-opus`、`ccr-sonnet`、`ccr-haiku`）支持 Codex 请求
- `normalizeResponsesBody`: 自动将 Codex Responses API 请求体转为统一聊天格式
- Codex 客户端检测：支持 User-Agent 和请求路径双重识别
- Codex 账户管理 API (`/api/clients/codex/accounts`)

### Fixed

- **Codex 工具调用不执行**: `response.function_call_arguments.done` 事件使用了错误的 `delta` 字段名，改为符合 OpenAI Responses API 规范的 `arguments` 字段
- **Codex 收到响应但无动作**: Responses API SSE 事件缺少必需字段（`object`、`status`、`output`、`usage`），导致 Codex SDK 无法正确解析响应
- **缺少 `response.output_item.done` 事件**: Codex SDK 需要此事件确认输出项已完成
- **Anthropic SSE 经 `transformResponseOut` 损坏**: 当上游返回 Anthropic SSE 时，`transformResponseOut` 不再尝试转为 Chat 格式，直接透传给 `transformResponseIn` 处理
- **`response.completed` 事件不保证发出**: 添加 `completedEmitted` 标志，在 `message_delta`、`message_stop`、流结束三处保证发出
- UI 设置页面客户端状态显示：接管开关打开时状态显示"已关闭"的问题

## [2.1.38] - 2026-06-06

### Fixed

- 保留 Anthropic 原始响应给 Claude Code 客户端，避免不必要的转换

## [2.1.35] - 2026-06-05

### Fixed

- 修复 macOS 休眠/唤醒后健康探针调度异常
- 改进 Codex 账户管理
