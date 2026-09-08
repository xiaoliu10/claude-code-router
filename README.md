![](blog/images/claude-code-router-img.png)

**[🇨🇳 中文文档](README.md)**  |  **[🇬🇧 English](README_en.md)**  |  [![npm version](https://badge.fury.io/js/@wengine-ai_claude-code-router-next.svg)](https://www.npmjs.com/package/@wengine-ai/claude-code-router-next)

> **说明**：原版 [claude-code-router](https://github.com/musistudio/claude-code-router) 仓库已不再活跃维护。本项目是基于原仓库 fork 的社区活跃版本，持续进行 Bug 修复、功能开发和长期维护。

<hr>

> [从CLI工具风格看工具渐进式披露](/blog/zh/从CLI工具风格看工具渐进式披露.md)

> 一款强大的工具，可将 Claude Code 和 Codex 请求路由到不同的模型，并自定义任何请求。 

![](blog/images/claude-code.png)


## ✨ 功能

-   **模型路由**: 根据您的需求将请求路由到不同的模型（例如，后台任务、思考、长上下文）。
-   **多提供商支持**: 支持 OpenRouter、DeepSeek、Ollama、Gemini、Volcengine 和 SiliconFlow 等各种模型提供商。
-   **Codex CLI 支持**: 通过 Responses API 协议转换，支持 Codex CLI 接入任意 LLM 提供商（Anthropic、DeepSeek、GLM 等），实现工具调用、文件修改等完整功能。
-   **请求/响应转换**: 使用转换器为不同的提供商自定义请求和响应。
-   **动态模型切换**: 在 Claude Code 中使用 `/model` 命令动态切换模型。
-   **GitHub Actions 集成**: 在您的 GitHub 工作流程中触发 Claude Code 任务。
-   **用量统计与限额监控**: 追踪请求的 Token 数、缓存命中率、首 Token 延迟 (TTFT) 和生成速度，并实时展示主流服务商（如智谱、Qwen 等）的限额使用情况。
-   **插件系统**: 使用自定义转换器扩展功能。

## 🚀 快速入门

### 1. 安装

您可以从 npm 官方仓库安装 Claude Code Router，或者直接从本 GitHub 仓库安装以获取最新的开发版本。

#### 选项 A：从 npm 官方仓库安装（稳定版）

首先，请确保您已安装 [Claude Code](https://docs.anthropic.com/en/docs/claude-code/quickstart)：

```shell
npm install -g @anthropic-ai/claude-code
```

然后，安装 Claude Code Router：

```shell
npm install -g @wengine-ai/claude-code-router-next
```

#### 选项 B：从 GitHub 安装（最新开发版）

如果您想直接使用源码中的最新功能和修复：

1. **先卸载已安装的全局版本**（以避免指令冲突）：
   ```shell
   npm uninstall -g @wengine-ai/claude-code-router-next @musistudio/claude-code-router @wengine-ai/claude-code-router
   ```

2. **克隆本仓库并在本地进行 Link**（推荐开发者使用）：
   ```shell
   git clone https://github.com/xiaoliu10/claude-code-router-next.git
   cd claude-code-router-next
   pnpm install
   pnpm build
   npm link
   ```

   *或者直接从 GitHub 进行全局安装：*
   ```shell
   npm install -g github:xiaoliu10/claude-code-router-next
   ```

#### 🔄 从官方原版社区版迁移 (@musistudio/claude-code-router)

如果您当前正在使用官方原版社区版本 `@musistudio/claude-code-router` 或之前的版本 `@wengine-ai/claude-code-router`，希望切换到 `@wengine-ai/claude-code-router-next`：

1. **先卸载旧版本**：
   ```shell
   npm uninstall -g @musistudio/claude-code-router @wengine-ai/claude-code-router
   ```

2. **安装本仓库增强版本**：
   ```shell
   npm install -g @wengine-ai/claude-code-router-next
   ```

> **说明**：卸载旧包**不会影响**您已有的配置文件 `~/.claude-code-router/config.json`，新版本会自动读取原有配置。

### 升级

```shell
npm install -g @wengine-ai/claude-code-router-next@latest && ccr restart
```

### 📅 升级功能列表 (Changelog)

| 版本 | 发布内容 |
| --- | --- |
| **v2.3.2403** | <ul><li>**修复 Pi 项目级路由未生效**: Pi 项目接管不再复用无法标识项目的全局 `ccr` provider；每个项目改用携带受管项目 ID 的独立 provider，服务端直接加载对应项目 Router。旧接管会自动迁移，关闭全局 Pi 接管不会破坏项目接管，无效映射也不会静默回落到全局模型。</li></ul> |
| **v2.3.2402** | <ul><li>**formatResponse SSE 识别放宽**: 之前仅对 `application/json` 头 peek,上游用非标准 Content-Type(`text/plain`/空)返回 SSE 仍会报 non-JSON;现对任何非流式响应都先 peek 判 SSE。</li></ul> |
| **v2.3.2400** | <ul><li>**SSE 误标 JSON 的多层彻底修复**: v2.3.2397–2399 只看首个 chunk,遇空首块/心跳(`: ping`)/分片(`ev`/`ent:`)仍误判报错;现改为累积多 chunk 判定,并统一修复 formatResponse、两个 transformer、hidden-error-check 与 validateStreamingResponse 四处,误标 SSE 全部按流式透传。</li></ul> |
| **v2.3.2399** | <ul><li>**bypass 模式下 SSE 误标 application/json 兜底修复**: bypass 的 provider 跳过 transformer 链后，SSE body + JSON 头的响应直达 formatResponse 仍会抛 non-JSON；现在 formatResponse 先 peek body 实际内容，SSE 按流式透传，作为该问题的最后一层兜底。</li></ul> |
| **v2.3.2398** | <ul><li>**修复 Codex 中转 SSE 被误标 application/json 时丢失内容**: 补齐 v2.3.2397 漏掉的 `OpenAIResponsesTransformer` 同类问题——上游返回 SSE body 但 Content-Type 标 `application/json` 时不再抛 `non-JSON` 错误，改为 peek body 实际内容后按 SSE 透传。</li></ul> |
| **v2.3.2397** | <ul><li>**修复 SSE 响应被误标 application/json 时丢失内容**: Codex 中转/OpenRouter 错误响应把 SSE body 标成 `application/json` 时，Anthropic transformer 此前按 Content-Type 当非流式 JSON 解析并抛错；现在先 peek body 实际内容，确为 SSE（`event:`/`data:`/`: ` 开头）则走流式转换，仅确为 JSON 才解析，行首匹配不误伤含 `event` 字段的 JSON。</li></ul> |
| **v2.3.2396** | <ul><li>**修复 OpenRouter SSE 被当作 JSON 解析**: 最终响应改为按实际 Content-Type 判断流式/非流式，并为 transformer 的 JSON 解析增加原始响应预览，`stealth/ox-alpha` 等返回 `: OPENROUTER PROCESSING` 时不再只报 `Unexpected token ':'`。</li><li>**修复 OpenCode Go 多轮 thinking 缓存断点**: 历史 assistant `thinking` 现在会回放为 `reasoning_content` + signature，避免缓存只能命中到首个 thinking turn 前（常见约 64k）及 `reasoning_content must be passed back` 400；直连 181k 请求验证上游可命中 99.88%。</li><li>**自定义 transformer 参数可直接编辑**: 参数行新增编辑按钮，以 key/value 回填输入框；嵌套 JSON/布尔/数字可修改后按同名 key 覆盖，无需删除重输。</li></ul> |
| **v2.3.2395** | <ul><li>**UI 转换器参数支持嵌套 JSON/布尔/数字**: 参数值此前一律按字符串保存，`customparams` 的 deep merge 无法应用字符串参数，结构化参数（如强制 reasoning 端点的 `{"enabled":true,"effort":"max"}`）在 UI 里配了也无效；现在按类型解析（畸形 JSON 保留原文），参数回显不再显示 `[object Object]`。</li></ul> |
| **v2.3.2394** | <ul><li>**严格项目路由不再因熔断目标返回 503**: 项目目标仅因 health fail-pool 不可用且无备用模型时，CCR 跳过健康检查继续请求项目配置的同一模型，让客户端收到真实上游结果；供应商/模型缺失、禁用、格式或额度错误仍拒绝，不逃逸项目边界。</li><li>**修复非流式 TTFT 与 token 速率统计**: 非流式响应不再把总耗时冒充 TTFT（显示 `-`），速率改为输出 token ÷ 总耗时，并阻止假 TTFT 污染平均值。</li></ul> |
| **v2.3.2393** | <ul><li>**项目接管按项目 Router 封顶上下文窗口**: 项目级接管此前只按全局 Router/ContextWindow 写 auto-compact 窗口，全局开 `[1m]` 而项目未启用扩展上下文时项目仍带 >200k 窗口，超 200k 后无可用模型；现在项目默认 family 或顶层 `enableExtendedContext` 未启用时窗口封顶 `min(ContextWindow, 200000)` 并清除陈旧 `[1m]` alias，保存项目 Router 与全局配置后都会刷新自定义 Router 项目的接管。用户手写窗口与 state 审计行为不变。</li><li>**opencode go 缓存命中从 0% 恢复**: zen 上游的提示词缓存以显式 `cache_control` 为前提（实测带标记第 2 次起 ≈98% 命中），transformer 此前把标记全部剥除导致永不缓存；现在保留标记，并在 `cached_tokens` 缺失时兜底映射 DeepSeek 风格 `prompt_cache_hit_tokens`。</li></ul> |

> 仅保留最近 10 个版本，更早版本的发布摘要见 [CHANGELOG-archive.md](./CHANGELOG-archive.md)，完整详细变更记录见 [CHANGELOG.md](./CHANGELOG.md)。

### 2. 配置

创建并配置您的 `~/.claude-code-router/config.json` 文件。有关更多详细信息，您可以参考 `config.example.json`。

> [!IMPORTANT]
> **重要提示**：手动修改 `config.json` 配置文件（如更新 API Key、百炼 Cookie 等）后，**必须重启后台服务才能使新配置生效**。请在保存文件后，在终端运行以下命令：
> ```shell
> ccr restart
> ```

`config.json` 文件有几个关键部分：
- **`PROXY_URL`** (可选): 您可以为 API 请求设置代理，例如：`"PROXY_URL": "http://127.0.0.1:7890"`。CCR 进程自身通过此地址连接代理端口，无需开启系统代理、TUN 或代理软件的全局模式。
- **`PROXY_GLOBAL_ENABLED`** (可选): 控制代理的作用范围。未配置或设为 `true`（默认）时，所有 provider 的出站请求均走代理，保持与旧配置的兼容性。设为 `false` 时，仅标记了 `proxy_enabled: true` 的 provider 走代理，其余 provider 直连。所有 provider 共用顶层 `PROXY_URL`，不支持为每个 provider 单独设置代理地址。如果 `PROXY_URL` 未设置（空地址），则所有代理开关均不生效，全部直连。provider 专属的出站请求（推理、fallback、健康探测、额度查询、wakeup 唤醒、provider API tokenizer 等）均遵循同一 provider 代理策略。
  > [!WARNING]
  > 代理可看到 API key 和请求内容，请仅配置可信代理。
- **`LOG`** (可选): 您可以通过将其设置为 `true` 来启用日志记录。当设置为 `false` 时，将不会创建日志文件。默认值为 `true`。
- **`LOG_LEVEL`** (可选): 设置日志级别。可用选项包括：`"fatal"`、`"error"`、`"warn"`、`"info"`、`"debug"`、`"trace"`。默认值为 `"error"`；仅在显式配置为 `"info"`、`"debug"` 或 `"trace"` 时输出详细日志。
- **日志系统**: Claude Code Router 使用两个独立的日志系统：
  - **服务器级别日志**: HTTP 请求、API 调用和服务器事件使用 pino 记录在 `~/.claude-code-router/logs/` 目录中，文件名类似于 `ccr-*.log`
  - **应用程序级别日志**: 路由决策和业务逻辑事件记录在 `~/.claude-code-router/claude-code-router.log` 文件中
- **`APIKEY`** (可选): 您可以设置一个密钥来进行身份验证。设置后，客户端请求必须在 `Authorization` 请求头 (例如, `Bearer your-secret-key`) 或 `x-api-key` 请求头中提供此密钥。例如：`"APIKEY": "your-secret-key"`。
- **`HOST`** (可选): 您可以设置服务的主机地址。如果未设置 `APIKEY`，出于安全考虑，主机地址将强制设置为 `127.0.0.1`，以防止未经授权的访问。例如：`"HOST": "0.0.0.0"`。
- **`NON_INTERACTIVE_MODE`** (可选): 当设置为 `true` 时，启用与非交互式环境（如 GitHub Actions、Docker 容器或其他 CI/CD 系统）的兼容性。这会设置适当的环境变量（`CI=true`、`FORCE_COLOR=0` 等）并配置 stdin 处理，以防止进程在自动化环境中挂起。例如：`"NON_INTERACTIVE_MODE": true`。
- **`Providers`**: 用于配置不同的模型提供商。
- **`Router`**: 用于设置路由规则。`default` 指定默认模型，如果未配置其他路由，则该模型将用于所有请求。
- **`API_TIMEOUT_MS`**: API 请求超时时间，单位为毫秒。

这是一个综合示例：

```json
{
  "APIKEY": "your-secret-key",
  "PROXY_URL": "http://127.0.0.1:7890",
  "PROXY_GLOBAL_ENABLED": false,
  "LOG": true,
  "LOG_LEVEL": "error",
  "API_TIMEOUT_MS": 600000,
  "NON_INTERACTIVE_MODE": false,
  "Providers": [
    {
      "name": "openrouter",
      "api_base_url": "https://openrouter.ai/api/v1/chat/completions",
      "api_key": "sk-xxx",
      "models": [
        "google/gemini-2.5-pro-preview",
        "anthropic/claude-sonnet-4",
        "anthropic/claude-3.5-sonnet",
        "anthropic/claude-3.7-sonnet:thinking"
      ],
      "transformer": {
        "use": ["openrouter"]
      },
      "proxy_enabled": true
    },
    {
      "name": "deepseek",
      "api_base_url": "https://api.deepseek.com/chat/completions",
      "api_key": "sk-xxx",
      "models": ["deepseek-chat", "deepseek-reasoner"],
      "transformer": {
        "use": ["deepseek"],
        "deepseek-chat": {
          "use": ["tooluse"]
        }
      }
    },
    {
      "name": "ollama",
      "api_base_url": "http://localhost:11434/v1/chat/completions",
      "api_key": "ollama",
      "models": ["qwen2.5-coder:latest"]
    },
    {
      "name": "gemini",
      "api_base_url": "https://generativelanguage.googleapis.com/v1beta/models/",
      "api_key": "sk-xxx",
      "models": ["gemini-2.5-flash", "gemini-2.5-pro"],
      "transformer": {
        "use": ["gemini"]
      }
    },
    {
      "name": "volcengine",
      "api_base_url": "https://ark.cn-beijing.volces.com/api/v3/chat/completions",
      "api_key": "sk-xxx",
      "models": ["deepseek-v3-250324", "deepseek-r1-250528"],
      "transformer": {
        "use": ["deepseek"]
      }
    },
    {
      "name": "modelscope",
      "api_base_url": "https://api-inference.modelscope.cn/v1/chat/completions",
      "api_key": "",
      "models": ["Qwen/Qwen3-Coder-480B-A35B-Instruct", "Qwen/Qwen3-235B-A22B-Thinking-2507"],
      "transformer": {
        "use": [
          [
            "maxtoken",
            {
              "max_tokens": 65536
            }
          ],
          "enhancetool"
        ],
        "Qwen/Qwen3-235B-A22B-Thinking-2507": {
          "use": ["reasoning"]
        }
      }
    },
    {
      "name": "dashscope",
      "api_base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
      "api_key": "",
      "models": ["qwen3-coder-plus"],
      "transformer": {
        "use": [
          [
            "maxtoken",
            {
              "max_tokens": 65536
            }
          ],
          "enhancetool"
        ]
      }
    },
    {
      "name": "aihubmix",
      "api_base_url": "https://aihubmix.com/v1/chat/completions",
      "api_key": "sk-",
      "models": [
        "Z/glm-4.5",
        "claude-opus-4-20250514",
        "gemini-2.5-pro"
      ]
    }
  ],
  "Router": {
    "default": "deepseek,deepseek-chat",
    "background": "ollama,qwen2.5-coder:latest",
    "think": "deepseek,deepseek-reasoner",
    "longContext": "openrouter,google/gemini-2.5-pro-preview",
    "longContextThreshold": 60000,
    "webSearch": "gemini,gemini-2.5-flash"
  }
}
```

### 🔑 阿里云百炼用量 Token (Cookie) 获取引导

如果您想让 Claude Code Router 的后台 Web UI 实时拉取并可视化展示您的 **Qwen Coding Plan（Qwen 编程时限套餐）** 剩余用量额度条，您需要获取控制台的浏览器 `Cookie` 作为 `quotaToken` 填入配置：

1. 登录 [阿里云百炼控制台](https://bailian.console.aliyun.com/)。
2. 按键盘 `F12` 打开浏览器开发者工具，并切换到 **Network (网络)** 标签页。
3. 点击页面用量模块右上角的 **用量刷新**（旋转循环箭头）按钮。
4. 在左侧网络请求列表中，找到一个以 `api.json?action=BroadScope...` 开头的接口调用请求并点击。
5. 在右侧 **Headers (标头)** 的 **Request Headers (请求头)** 中找到 **`Cookie`** 这一项，将其右侧的完整超长内容复制下来。
6. 在您的 `config.json` 中，将这个 cookie 填入阿里云 provider 下的 **`quotaToken`** 属性中即可！

配置成功后，Web UI 的 Provider 列表中将会实时展示您的套餐剩余用量额度条与刷新状态：

![阿里云用量 Cookie 获取方式](blog/images/aliyun-quota-auth.png)

![阿里云用量额度条展示](blog/images/aliyun-quota-display.png)

### 🔑 讯飞 Coding Plan 用量 Token (Cookie) 获取引导

如果您想让 Claude Code Router 的后台 Web UI 实时拉取并可视化展示您的 **讯飞 Coding Plan** 剩余用量额度条，您需要进入讯飞 Coding Plan 订阅查询页面，打开浏览器开发者工具的 Network 面板，刷新页面后复制请求中的 `Cookie` 作为 `quotaToken` 填入配置：

1. 登录讯飞 Coding Plan 订阅查询页面。
2. 按键盘 `F12` 打开浏览器开发者工具，并切换到 **Network (网络)** 标签页。
3. 刷新页面。
4. 在左侧网络请求列表中，找到订阅查询页面对应的用量查询请求并点击。
5. 在右侧 **Headers (标头)** 的 **Request Headers (请求头)** 中找到 **`Cookie`** 这一项，将其右侧的完整内容复制下来。
6. 在您的 `config.json` 中，将这个 cookie 填入讯飞 provider 下的 **`quotaToken`** 属性中，或者粘贴到 UI 的 **限额查询 Token** 输入框中即可。

> **注意**: 这个 token 不是长期有效的，可能会过期；过期后需要重新手动添加。

### 3. 使用 Router 运行 Claude Code

使用 router 启动 Claude Code：

```shell
ccr code
```

> **注意**: 修改配置文件后，需要重启服务使配置生效：
> ```shell
> ccr restart
> ```

### 4. UI 模式

为了获得更直观的体验，您可以使用 UI 模式来管理您的配置：

```shell
ccr ui
```

这将打开一个基于 Web 的界面，您可以在其中轻松查看和编辑您的 `config.json` 文件。

![UI](/blog/images/ui.png)

#### 用量统计

仪表盘在主页面底部内置了**用量统计**面板。当您的请求通过 Claude Code Router 进行路由时，系统会自动收集用量记录并在 UI 界面中展示。

您可以使用它来查看：

- 总请求数
- 输入和输出 Token 数
- 平均首 Token 延迟 (TTFT)
- 平均生成速度 (Tokens/秒)
- 请求成功率
- 每日用量图表
- 支持筛选和分页的详细请求历史记录

![用量统计](/blog/images/usage-statistics.png)

如何使用：

1. 使用 `ccr start` 启动路由器服务
2. 使用 `ccr ui` 打开 Web 界面
3. 通过 Claude Code Router 发送请求（例如使用 `ccr code`）
4. 返回主仪表盘，查看**用量统计**面板

用量数据保存在：

```shell
~/.claude-code-router/data/usage.jsonl
```

### 5. CLI 模型管理

对于偏好终端工作流的用户，可以使用交互式 CLI 模型选择器：

```shell
ccr model
```

该命令提供交互式界面来：

- 查看当前配置
- 查看所有配置的模型（default、background、think、longContext、webSearch、image）
- 切换模型：快速更改每个路由器类型使用的模型
- 添加新模型：向现有提供商添加模型
- 创建新提供商：设置完整的提供商配置，包括：
   - 提供商名称和 API 端点
   - API 密钥
   - 可用模型
   - Transformer 配置，支持：
     - 多个转换器（openrouter、deepseek、gemini 等）
     - Transformer 选项（例如，带自定义限制的 maxtoken）
     - 特定于提供商的路由（例如，OpenRouter 提供商偏好）

CLI 工具验证所有输入并提供有用的提示来引导您完成配置过程，使管理复杂的设置变得容易，无需手动编辑 JSON 文件。

### 6. 预设管理

预设允许您轻松保存、共享和重用配置。您可以将当前配置导出为预设，并从文件或 URL 安装预设。

```shell
# 将当前配置导出为预设
ccr preset export my-preset

# 使用元数据导出
ccr preset export my-preset --description "我的 OpenAI 配置" --author "您的名字" --tags "openai,生产环境"

# 从本地目录安装预设
ccr preset install /path/to/preset

# 列出所有已安装的预设
ccr preset list

# 显示预设信息
ccr preset info my-preset

# 删除预设
ccr preset delete my-preset
```

**预设功能：**
- **导出**：将当前配置保存为预设目录（包含 manifest.json）
- **安装**：从本地目录安装预设
- **敏感数据处理**：导出期间自动清理 API 密钥和其他敏感数据（标记为 `{{field}}` 占位符）
- **动态配置**：预设可以包含输入架构，用于在安装期间收集所需信息
- **版本控制**：每个预设包含版本元数据，用于跟踪更新

**预设文件结构：**
```
~/.claude-code-router/presets/
├── my-preset/
│   └── manifest.json    # 包含配置和元数据
```

### 7. Activate 命令（环境变量设置）

`activate` 命令允许您在 shell 中全局设置环境变量，使您能够直接使用 `claude` 命令或将 Claude Code Router 与使用 Agent SDK 构建的应用程序集成。

要激活环境变量，请运行：

```shell
eval "$(ccr activate)"
```

此命令会以 shell 友好的格式输出必要的环境变量，这些变量将在当前的 shell 会话中设置。激活后，您可以：

- **直接使用 `claude` 命令**：无需使用 `ccr code` 即可运行 `claude` 命令。`claude` 命令将自动通过 Claude Code Router 路由请求。
- **与 Agent SDK 应用程序集成**：使用 Anthropic Agent SDK 构建的应用程序将自动使用配置的路由器和模型。

`activate` 命令设置以下环境变量：

- `ANTHROPIC_AUTH_TOKEN`: 来自配置的 API 密钥
- `ANTHROPIC_BASE_URL`: 本地路由器端点（默认：`http://127.0.0.1:3456`）
- `NO_PROXY`: 设置为 `127.0.0.1` 以防止代理干扰
- `DISABLE_TELEMETRY`: 禁用遥测
- `DISABLE_COST_WARNINGS`: 禁用成本警告
- `API_TIMEOUT_MS`: 来自配置的 API 超时时间

> **注意**：在使用激活的环境变量之前，请确保 Claude Code Router 服务正在运行（`ccr start`）。环境变量仅在当前 shell 会话中有效。要使其持久化，您可以将 `eval "$(ccr activate)"` 添加到您的 shell 配置文件（例如 `~/.zshrc` 或 `~/.bashrc`）中。

#### Providers

`Providers` 数组是您定义要使用的不同模型提供商的地方。每个提供商对象都需要：

-   `name`: 提供商的唯一名称。
-   `api_base_url`: 聊天补全的完整 API 端点。
-   `api_key`: 您提供商的 API 密钥。
-   `models`: 此提供商可用的模型名称列表。
-   `transformer` (可选): 指定用于处理请求和响应的转换器。

#### Transformers

Transformers 允许您修改请求和响应负载，以确保与不同提供商 API 的兼容性。

-   **全局 Transformer**: 将转换器应用于提供商的所有模型。在此示例中，`openrouter` 转换器将应用于 `openrouter` 提供商下的所有模型。
    ```json
     {
       "name": "openrouter",
       "api_base_url": "https://openrouter.ai/api/v1/chat/completions",
       "api_key": "sk-xxx",
       "models": [
         "google/gemini-2.5-pro-preview",
         "anthropic/claude-sonnet-4",
         "anthropic/claude-3.5-sonnet"
       ],
       "transformer": { "use": ["openrouter"] }
     }
    ```
-   **特定于模型的 Transformer**: 将转换器应用于特定模型。在此示例中，`deepseek` 转换器应用于所有模型，而额外的 `tooluse` 转换器仅应用于 `deepseek-chat` 模型。
    ```json
     {
       "name": "deepseek",
       "api_base_url": "https://api.deepseek.com/chat/completions",
       "api_key": "sk-xxx",
       "models": ["deepseek-chat", "deepseek-reasoner"],
       "transformer": {
         "use": ["deepseek"],
         "deepseek-chat": { "use": ["tooluse"] }
       }
     }
    ```

-   **向 Transformer 传递选项**: 某些转换器（如 `maxtoken`）接受选项。要传递选项，请使用嵌套数组，其中第一个元素是转换器名称，第二个元素是选项对象。
    ```json
    {
      "name": "siliconflow",
      "api_base_url": "https://api.siliconflow.cn/v1/chat/completions",
      "api_key": "sk-xxx",
      "models": ["moonshotai/Kimi-K2-Instruct"],
      "transformer": {
        "use": [
          [
            "maxtoken",
            {
              "max_tokens": 16384
            }
          ]
        ]
      }
    }
    ```

**可用的内置 Transformer：**

-   `Anthropic`: 如果你只使用这一个转换器，则会直接透传请求和响应(你可以用它来接入其他支持Anthropic端点的服务商)。
-   `deepseek`: 适配 DeepSeek API 的请求/响应。
-   `gemini`: 适配 Gemini API 的请求/响应。
-   `openrouter`: 适配 OpenRouter API 的请求/响应。它还可以接受一个 `provider` 路由参数，以指定 OpenRouter 应使用哪些底层提供商。有关更多详细信息，请参阅 [OpenRouter 文档](https://openrouter.ai/docs/features/provider-routing)。请参阅下面的示例：
    ```json
      "transformer": {
        "use": ["openrouter"],
        "moonshotai/kimi-k2": {
          "use": [
            [
              "openrouter",
              {
                "provider": {
                  "only": ["moonshotai/fp8"]
                }
              }
            ]
          ]
        }
      }
    ```
-   `groq`: 适配 groq API 的请求/响应
-   `maxtoken`: 设置特定的 `max_tokens` 值。
-   `tooluse`: 优化某些模型的工具使用(通过`tool_choice`参数)。
-   `gemini-cli` (实验性): 通过 Gemini CLI [gemini-cli.js](https://gist.github.com/musistudio/1c13a65f35916a7ab690649d3df8d1cd) 对 Gemini 的非官方支持。
-   `reasoning`: 用于处理 `reasoning_content` 字段。
-   `sampling`: 用于处理采样信息字段，如 `temperature`、`top_p`、`top_k` 和 `repetition_penalty`。
-   `enhancetool`: 对 LLM 返回的工具调用参数增加一层容错处理（这会导致不再流式返回工具调用信息）。
-   `cleancache`: 清除请求中的 `cache_control` 字段。
-   `vertex-gemini`: 处理使用 vertex 鉴权的 gemini api。
-   `qwen-cli` (实验性): 通过 Qwen CLI [qwen-cli.js](https://gist.github.com/musistudio/f5a67841ced39912fd99e42200d5ca8b) 对 qwen3-coder-plus 的非官方支持。
-   `rovo-cli` (experimental): 通过 Atlassian Rovo Dev CLI [rovo-cli.js](https://gist.github.com/SaseQ/c2a20a38b11276537ec5332d1f7a5e53) 对 GPT-5 的非官方支持。

**自定义 Transformer:**

您还可以创建自己的转换器，并通过 `config.json` 中的 `transformers` 字段加载它们。

```json
{
  "transformers": [
      {
        "path": "/User/xxx/.claude-code-router/plugins/gemini-cli.js",
        "options": {
          "project": "xxx"
        }
      }
  ]
}
```

#### Router

`Router` 对象定义了在不同场景下使用哪个模型：

-   `default`: 用于常规任务的默认模型。
-   `background`: 用于后台任务的模型。这可以是一个较小的本地模型以节省成本。
-   `think`: 用于推理密集型任务（如计划模式）的模型。
-   `longContext`: 用于处理长上下文（例如，> 60K 令牌）的模型。
-   `longContextThreshold` (可选): 触发长上下文模型的令牌数阈值。如果未指定，默认为 60000。
-   `webSearch`: 用于处理网络搜索任务，需要模型本身支持。如果使用`openrouter`需要在模型后面加上`:online`后缀。
-   `image`(测试版): 用于处理图片类任务（采用CCR内置的agent支持），如果该模型不支持工具调用，需要将`config.forceUseImageAgent`属性设置为`true`。

您还可以使用 `/model` 命令在 Claude Code 中动态切换模型：
`/model provider_name,model_name`
示例: `/model openrouter,anthropic/claude-3.5-sonnet`

#### 自定义路由器

对于更高级的路由逻辑，您可以在 `config.json` 中通过 `CUSTOM_ROUTER_PATH` 字段指定一个自定义路由器脚本。这允许您实现超出默认场景的复杂路由规则。

在您的 `config.json` 中配置:

```json
{
  "CUSTOM_ROUTER_PATH": "/User/xxx/.claude-code-router/custom-router.js"
}
```

自定义路由器文件必须是一个导出 `async` 函数的 JavaScript 模块。该函数接收请求对象和配置对象作为参数，并应返回提供商和模型名称的字符串（例如 `"provider_name,model_name"`），如果返回 `null` 则回退到默认路由。

这是一个基于 `custom-router.example.js` 的 `custom-router.js` 示例：

```javascript
// /User/xxx/.claude-code-router/custom-router.js

/**
 * 一个自定义路由函数，用于根据请求确定使用哪个模型。
 *
 * @param {object} req - 来自 Claude Code 的请求对象，包含请求体。
 * @param {object} config - 应用程序的配置对象。
 * @returns {Promise<string|null>} - 一个解析为 "provider,model_name" 字符串的 Promise，如果返回 null，则使用默认路由。
 */
module.exports = async function router(req, config) {
  const userMessage = req.body.messages.find(m => m.role === 'user')?.content;

  if (userMessage && userMessage.includes('解释这段代码')) {
    // 为代码解释任务使用更强大的模型
    return 'openrouter,anthropic/claude-3.5-sonnet';
  }

  // 回退到默认的路由配置
  return null;
};
```

##### 子代理路由

对于子代理内的路由，您必须在子代理提示词的**开头**包含 `<CCR-SUBAGENT-MODEL>provider,model</CCR-SUBAGENT-MODEL>` 来指定特定的提供商和模型。这样可以将特定的子代理任务定向到指定的模型。

**示例：**

```
<CCR-SUBAGENT-MODEL>openrouter,anthropic/claude-3.5-sonnet</CCR-SUBAGENT-MODEL>
请帮我分析这段代码是否存在潜在的优化空间...
```

## Status Line (Beta)
为了在运行时更好的查看claude-code-router的状态，claude-code-router在v1.0.40内置了一个statusline工具，你可以在UI中启用它，
![statusline-config.png](/blog/images/statusline-config.png)

效果如下（包含全新的彩色渐变 Context 上下文占用进度条）：
![statusline](/blog/images/statusline-v2.png)

## 🤖 GitHub Actions

将 Claude Code Router 集成到您的 CI/CD 管道中。在设置 [Claude Code Actions](https://docs.anthropic.com/en/docs/claude-code/github-actions) 后，修改您的 `.github/workflows/claude.yaml` 以使用路由器：

```yaml
name: Claude Code

on:
  issue_comment:
    types: [created]
  # ... other triggers

jobs:
  claude:
    if: |
      (github.event_name == 'issue_comment' && contains(github.event.comment.body, '@claude')) ||
      # ... other conditions
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: read
      issues: read
      id-token: write
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4
        with:
          fetch-depth: 1

      - name: Prepare Environment
        run: |
          curl -fsSL https://bun.sh/install | bash
          mkdir -p $HOME/.claude-code-router
          cat << 'EOF' > $HOME/.claude-code-router/config.json
          {
            "log": true,
            "NON_INTERACTIVE_MODE": true,
            "OPENAI_API_KEY": "${{ secrets.OPENAI_API_KEY }}",
            "OPENAI_BASE_URL": "https://api.deepseek.com",
            "OPENAI_MODEL": "deepseek-chat"
          }
          EOF
        shell: bash

      - name: Start Claude Code Router
        run: |
          nohup ~/.bun/bin/bunx @wengine-ai/claude-code-router-next@latest start &
        shell: bash

      - name: Run Claude Code
        id: claude
        uses: anthropics/claude-code-action@beta
        env:
          ANTHROPIC_BASE_URL: http://localhost:3456
        with:
          anthropic_api_key: "any-string-is-ok"
```

这种设置可以实现有趣的自动化，例如在非高峰时段运行任务以降低 API 成本。

## 🎯 高级功能

### 模型族映射 (Family Routing)

Claude Code Router 支持**模型族映射**，将 Claude Code 的模型分级（opus/sonnet/haiku）映射到不同服务商的模型。这实现了智能成本控制：主进程保持相同模型以最大化缓存命中，子代理可自动降级。

#### 配置示例

```json
{
  "Router": {
    "enableFamilyRouting": true,
    "families": {
      "opus": {
        "default": "智谱 Coding Plan,glm-5",
        "think": "DeepSeek,deepseek-reasoner",
        "longContext": "阿里云,qwen3-plus",
        "webSearch": "Gemini,gemini-2.5-flash",
        "fallback": {
          "default": ["阿里云,glm-4", "DeepSeek,deepseek-chat"],
          "think": ["阿里云,qwen-plus", "DeepSeek,deepseek-reasoner"]
        }
      },
      "sonnet": {
        "default": "OpenRouter,deepseek/deepseek-v3",
        "think": "DeepSeek,deepseek-reasoner",
        "fallback": {
          "default": ["阿里云,qwen-turbo", "Gemini,gemini-2.0-flash"]
        }
      },
      "haiku": {
        "default": "阿里云,qwen-turbo",
        "fallback": {
          "default": ["Gemini,gemini-2.0-flash-lite"]
        }
      }
    }
  }
}
```

#### 场景说明

| 场景 | 触发条件 | 说明 |
|------|----------|------|
| `default` | 默认 | 日常对话和代码生成 |
| `think` | Plan Mode | 复杂推理、架构设计 |
| `longContext` | token > 60000 | 大文件分析 |
| `webSearch` | web_search tool | 网络搜索任务 |
| `background` | 后台任务 | 自动提交、简单检查 |

### Fallback 机制

当主模型失败时，Router 会自动尝试 fallback 链中的备用模型，确保请求不中断。

#### 工作流程

1. **健康检查**：每个 provider/model 维护健康状态
   - `closed`（健康）→ 绿色指示器
   - `open`（失败池）→ 红色指示器，自动跳过
   - `half-open`（恢复中）→ 黄色指示器

2. **供应商主开关 (Master Toggle)**：在管理面板中，每个供应商都拥有独立的开启/关闭开关：
   - **最高优先级**：当供应商关闭时，旗下所有模型将强制失效且不可选中，健康指示器置灰。
   - **智能 Fallback**：若主模型路由被关闭，系统立刻发起重试并直接进入 fallback 链；若 fallback 列表中的某备用模型所对应的供应商处于关闭状态，则系统自动跳过该模型。
   - **防冗余探测**：关闭的供应商会完全**免除**主动探测和健康恢复检查，避免无谓的网络调用和资源占用，直至开关重新开启。
   - **智能预警提示**：如果当前设置的某项主模型路由（如 `default` 等）所属的供应商已被关闭，控制台界面会实时显示醒目的警示红字，提醒及时更换模型配置。

3. **失败判定**：连续 3 次失败后进入 `open` 状态

4. **拖动排序**：UI 支持拖动 fallback 模型调整优先级，排序越靠前越先尝试

5. **Fallback Promotion**：当主模型失败且 fallback 成功时，临时"晋升" fallback 模型（TTL 10 分钟），后续请求直接使用晋升模型，避免重复尝试失败的主模型

6. **自动恢复**：每 5 分钟探测失败模型，成功后恢复为 `half-open`，再成功 2 次后恢复为 `closed`

![Provider 健康状态](/blog/images/provider-health-healthy.png)

#### Fallback 配置层级

```
family fallback → global fallback
```

优先使用模型族专属的 fallback 配置，其次使用全局 fallback。

```json
{
  "Router": {
    "enableFallback": true,
    "families": {
      "opus": {
        "fallback": {
          "default": ["阿里云,glm-4", "DeepSeek,deepseek-chat"]
        }
      }
    }
  },
  "fallback": {
    "default": ["OpenRouter,deepseek/deepseek-v3", "Gemini,gemini-2.5-flash"],
    "think": ["DeepSeek,deepseek-reasoner"]
  }
}
```

### 用量统计

Router 提供完善的用量统计功能：

#### Quota 监控

UI 界面实时显示各服务商的额度使用情况：

- **5h 额度**：短窗口限额（5 小时重置）
- **7d 额度**：周度限额（7 天重置）
- **重置时间**：显示下次额度重置时间

![Quota 用量条](/blog/images/provider-quota-usage.png)

支持的服务商：
- 智谱 GLM Coding Plan
- 阿里云 Qwen Coding Plan
- Kimi Coding Plan
- MiniMax Coding Plan
- DeepSeek
- OpenRouter
- SiliconFlow

#### Usage 记录

每次请求都会记录详细统计信息：

| 字段 | 说明 |
|------|------|
| `inputTokens` | 输入 token 数 |
| `outputTokens` | 输出 token 数 |
| `cacheReadInputTokens` | 缓存读取 token |
| `cacheCreationInputTokens` | 缓存创建 token |
| `ttft` | 首 token 时间 (ms) |
| `tokensPerSecond` | 输出速度 |
| `durationMs` | 请求耗时 |
| `status` | success / error |

数据存储位置：`~/.claude-code-router/data/usage.jsonl`

## 交流群
<img src="/blog/images/wechat_group.jpg" width="200" alt="wechat_group" />
