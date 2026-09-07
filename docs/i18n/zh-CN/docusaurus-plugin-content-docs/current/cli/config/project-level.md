# 项目级配置

除了全局配置，`ccr` 还支持为特定项目设置不同的路由规则。项目级配置只会覆盖 `Router` 部分，
其引用的 `Providers`（包括模型和凭证）始终来自全局配置。

项目的 `Router` 对象要么是**空的**（项目完全继承全局 `Router`，包括 `fallback`、`background`
和模型族路由），要么是**完整配置的**（它会完全替换全局 `Router`——项目 `Router` 中未设置的
场景不会回退到全局 `Router` 中对应的字段，而是直接视为未配置）。项目与全局 `Router` 之间没有
按字段合并的机制，所以如果只想覆盖少数几个场景，建议从全局 `Router` 的完整副本开始修改（Web UI
正是这样做的，详见下文）。

## 项目配置文件

项目配置文件位于：

```
~/.claude-code-router/<project-id>/config.json
```

其中 `<project-id>` 由项目目录的绝对路径生成：将路径中的 `/`、`\` 和 `.` 全部替换为 `-`。例如：

```
/Users/jason/projects/my-app  ->  ~/.claude-code-router/-Users-jason-projects-my-app/config.json
```

## 项目配置结构

```json5
{
  "Router": {
    "default": "openai,gpt-4",
    "background": "openai,gpt-3.5-turbo",
    "enableFallback": true,
    "fallback": {
      "default": ["openai,gpt-3.5-turbo"]
    },
    "enableFamilyRouting": true,
    "families": {
      "opus": {
        "default": "anthropic,claude-3-opus-20240229"
      }
    }
  }
}
```

只会读取 `Router` 字段，其中引用的模型（`provider,model`）必须已经存在于全局
`~/.claude-code-router/config.json` 的某个 Provider 中。

空的 `Router: {}`（或缺失/为空的配置文件）表示该项目完全继承全局 `Router`——包括
`fallback`、`background` 和模型族路由。这是已配置项目的默认且最安全的状态。

`fallback` 和 `families` 嵌套在项目 `Router` 对象内部（与全局配置不同，全局配置中
`fallback` 是一个独立的顶层字段）——当项目定义了自己的 `Router` 时，会使用该项目
`Router.fallback` / `Router.families`，而不是全局的对应字段。

## 在 Web UI 中管理项目配置

Web UI（`ccr ui`）的设置页中提供了一个 **Projects（项目配置）** 标签页，可以：

- 查看当前所有已配置项目级路由的项目列表
- 通过输入项目的绝对路径来添加新项目
- 切换**使用全局配置**开关（默认开启）——开启时项目完全继承全局 `Router`，不会写入任何
  覆盖内容
- 关闭该开关后，可使用与全局 Router 标签页相同的编辑器，配置完整的项目专属 `Router`，
  包括各场景模型（`default`、`background`、`think`、`longContext`、`webSearch`、`image`、
  `extendedContext`）、备用模型链以及模型族（opus/sonnet/haiku）路由。编辑器会预填入当前
  全局 `Router` 的副本，作为修改的起点，确保现有行为保持不变
- 删除某个项目的项目级配置

这与在该项目目录下运行 `ccr model --project` 效果相同，但可以在一个页面中集中管理所有已配置的项目，无需为每个项目单独打开终端。

### 项目接管与 Pi

在项目接管客户端列表中勾选 **Pi** 后，Pi 支持项目级路由。CCR 会写入
`<project>/.pi/settings.json`，并在 Pi 的全局 `~/.pi/agent/models.json` 中注册该项目专用的
`ccr-project-*` provider。该 provider 会在每次请求中携带受管项目标识，因此 CCR 无需依赖
Claude Code 会话记录，就能直接加载对应项目的 `Router`。

每个项目的 provider 都是独立的，请勿将其改回共享的全局 `ccr` provider。旧版共享 provider
接管会在 CCR 启动或刷新客户端配置时自动迁移；关闭全局 Pi 接管也不会关闭仍处于接管状态的
Pi 项目。

## 使用 `ccr model --project` 管理项目配置

推荐使用交互式 CLI 来管理项目级路由：

```bash
# 在需要配置的项目目录中运行
cd /path/to/your/project
ccr model --project
```

该命令会：

- 显示当前项目的有效配置（项目覆盖值 vs. 继承自全局的值）
- 让你从全局已配置的 Provider 中，为 `default`、`background`、`think`、`longContext`、
  `webSearch`、`image` 选择模型
- 将选择写入 `~/.claude-code-router/<project-id>/config.json`，**不会修改全局配置**
- 支持移除已设置的项目级覆盖项

注意：该命令不支持新增 Provider 或模型——新增 Provider/模型请使用不带 `--project` 的
`ccr model`，因为 Provider 始终是全局管理的。

## 查看当前项目

```bash
ccr status
```

会输出当前工作目录，以及（如果存在）对应的项目级配置文件路径。

## 手动创建

```bash
mkdir -p ~/.claude-code-router/-Users-jason-projects-my-app

cat > ~/.claude-code-router/-Users-jason-projects-my-app/config.json << 'EOF'
{
  "Router": {
    "default": "anthropic,claude-3-5-sonnet-20241022",
    "background": "openai,gpt-3.5-turbo"
  }
}
EOF
```

## 配置优先级

路由配置的优先级（从高到低）：

1. **自定义路由函数** (`CUSTOM_ROUTER_PATH`)
2. **项目级配置** (`~/.claude-code-router/<project-id>/config.json`)
3. **全局配置** (`~/.claude-code-router/config.json`)
4. **内置路由规则**

项目 `Router` 一旦非空，就会完全替换全局 `Router`——其中未设置的字段（例如 `background`）
不会回退到全局配置，而是直接视为未配置。空的（或缺失的）项目 `Router` 会完全继承全局配置。

## 使用场景

### 场景一：不同项目使用不同的默认模型

```json5
// Web 项目: ~/.claude-code-router/-Users-jason-projects-web-app/config.json
{
  "Router": {
    "default": "openai,gpt-4",
    "background": "openai,gpt-3.5-turbo"
  }
}

// AI 项目: ~/.claude-code-router/-Users-jason-projects-ai-app/config.json
{
  "Router": {
    "default": "anthropic,claude-3-5-sonnet-20241022",
    "background": "openai,gpt-3.5-turbo"
  }
}
```

由于非空的项目 `Router` 会完全替换全局 `Router`，如果还想保留其他场景（例如这里的
`background`），需要把它也一并复制过来，而不能依赖自动继承。

### 场景二：测试项目使用低成本模型

```json5
{
  "Router": {
    "default": "openai,gpt-3.5-turbo",
    "background": "openai,gpt-3.5-turbo"
  }
}
```

### 场景三：长上下文项目

```json5
{
  "Router": {
    "default": "anthropic,claude-3-opus-20240229",
    "longContext": "anthropic,claude-3-opus-20240229"
  }
}
```

## 验证项目配置

```bash
# 查看项目级配置状态
ccr status

# 查看日志确认路由决策
tail -f ~/.claude-code-router/claude-code-router.log
```

## 删除项目配置

```bash
rm -rf ~/.claude-code-router/<project-id>
```

删除后会回退到全局配置。

## 完整示例

假设你有两个项目，都依赖同一份全局 Provider 配置：

### 全局配置（`~/.claude-code-router/config.json`）

```json5
{
  "Providers": [
    {
      "name": "openai",
      "api_base_url": "https://api.openai.com/v1/chat/completions",
      "api_key": "$OPENAI_API_KEY",
      "models": ["gpt-4", "gpt-3.5-turbo"]
    },
    {
      "name": "anthropic",
      "api_base_url": "https://api.anthropic.com/v1/messages",
      "api_key": "$ANTHROPIC_API_KEY",
      "models": ["claude-3-5-sonnet-20241022"]
    }
  ],
  "Router": {
    "default": "openai,gpt-4",
    "background": "openai,gpt-3.5-turbo"
  }
}
```

### Web 项目（在该项目目录运行 `ccr model --project`）

```json5
{
  "Router": {
    "default": "openai,gpt-4",
    "background": "openai,gpt-3.5-turbo"
  }
}
```

### AI 项目（在该项目目录运行 `ccr model --project`）

```json5
{
  "Router": {
    "default": "anthropic,claude-3-5-sonnet-20241022",
    "think": "anthropic,claude-3-5-sonnet-20241022",
    "background": "openai,gpt-3.5-turbo"
  }
}
```

这样：
- Web 项目的 `default` 使用 GPT-4
- AI 项目的 `default` 和 `think` 使用 Claude
- 两个项目的 `background` 任务都使用 GPT-3.5-turbo（在各自项目的 `Router` 中显式设置，因为
  非空的项目 `Router` 不会按场景回退到全局配置）
