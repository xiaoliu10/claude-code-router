---
title: Project-Level Configuration
---

# Project-Level Configuration

In addition to the global configuration, `ccr` also supports setting different routing rules
for specific projects. Project-level configuration only overrides the `Router` section — it
always reuses the `Providers` (and their models/credentials) defined in your global
configuration.

A project's `Router` object is either **empty** (the project fully inherits the global
`Router`, including `fallback`, `background`, and model family routing) or **fully populated**
(it completely replaces the global `Router` — any scenario not set in the project's `Router`
is simply unconfigured, it does *not* fall back to the matching field in the global `Router`).
There is no per-key merge between the project and global `Router` objects, so when you want to
override only a couple of scenarios, start from a full copy of your global `Router` and change
just what you need (this is exactly what the Web UI does, see below).

## Project Configuration File

The project configuration file is located at:

```
~/.claude-code-router/<project-id>/config.json
```

Where `<project-id>` is derived from the absolute path of your project directory, by replacing
every `/`, `\` and `.` character with `-`. For example:

```
/Users/jason/projects/my-app  ->  ~/.claude-code-router/-Users-jason-projects-my-app/config.json
```

## Project Configuration Structure

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

Only the `Router` field is read. Any model referenced here (`provider,model`) must already
exist in a provider defined in your global `~/.claude-code-router/config.json`.

An empty `Router: {}` (or a missing/empty config file) means the project fully inherits the
global `Router` — including `fallback`, `background`, and model family routing. This is the
default and safest state for a configured project.

`fallback` and `families` are nested inside the project's `Router` object (unlike the global
configuration, where `fallback` is a separate top-level field) — when a project defines its
own `Router`, its own `Router.fallback`/`Router.families` are used instead of the global ones.

## Managing Project Configuration from the Web UI

The Web UI (`ccr ui`) has a **Projects** tab in Settings where you can:

- See every project that currently has a project-level configuration
- Add a new project by entering its absolute directory path
- Toggle **Use global configuration** (on by default) — when enabled, the project fully
  inherits the global `Router` and no override file content is written
- When toggled off, edit a full project-specific `Router` configuration using the same editor
  as the global Router tab, including per-scenario models (`default`, `background`, `think`,
  `longContext`, `webSearch`, `image`, `extendedContext`), fallback chains, and model family
  (opus/sonnet/haiku) routing. The editor is pre-filled with a copy of your current global
  `Router` so existing behavior is preserved as your starting point
- Remove a project's configuration entirely

This is equivalent to running `ccr model --project` from that project's directory, but lets
you manage all configured projects from one place without needing a terminal open in each
project.

### Project takeover and Pi

Project-level routing is supported for Pi when **Pi** is selected in the project's takeover
client list. CCR writes `<project>/.pi/settings.json` and registers a dedicated
`ccr-project-*` provider in Pi's global `~/.pi/agent/models.json`. That provider carries the
managed project identity on each request, so CCR can load the matching project `Router`
without relying on Claude Code session transcripts.

The provider is intentionally unique per project; do not replace it with the shared global
`ccr` provider. Existing shared-provider takeovers are migrated automatically when CCR starts
or refreshes client configuration. Disabling global Pi takeover does not disable active Pi
project takeovers.

## Managing Project Configuration with `ccr model --project`

The easiest way to manage project-level routing is the interactive CLI:

```bash
# Run inside the project directory you want to configure
cd /path/to/your/project
ccr model --project
```

This will:

- Show the current effective configuration for the project (project override vs. inherited
  global value)
- Let you pick a model (from your existing global providers) for `default`, `background`,
  `think`, `longContext`, `webSearch`, or `image`
- Save the selection to `~/.claude-code-router/<project-id>/config.json` **without modifying
  your global configuration**
- Let you remove a previously-set project override

It does not let you add new providers or models — use `ccr model` (without `--project`) for
that, since providers are always managed globally.

## Checking the Current Project

```bash
ccr status
```

This prints the current working directory and, if one exists, the path to its project-level
config file.

## Manual Creation

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

## Configuration Priority

Routing configuration priority (from high to low):

1. **Custom routing function** (`CUSTOM_ROUTER_PATH`)
2. **Project-level configuration** (`~/.claude-code-router/<project-id>/config.json`)
3. **Global configuration** (`~/.claude-code-router/config.json`)
4. **Built-in routing rules**

A non-empty project `Router` object completely replaces the global `Router` for that project —
any scenario you don't set (e.g. `background`) is simply unconfigured, it does not fall back to
the global configuration's value for that scenario. An empty (or missing) project `Router`
fully inherits the global configuration.

## Use Cases

### Scenario 1: Different Projects Use Different Default Models

```json5
// Web project: ~/.claude-code-router/-Users-jason-projects-web-app/config.json
{
  "Router": {
    "default": "openai,gpt-4",
    "background": "openai,gpt-3.5-turbo"
  }
}

// AI project: ~/.claude-code-router/-Users-jason-projects-ai-app/config.json
{
  "Router": {
    "default": "anthropic,claude-3-5-sonnet-20241022",
    "background": "openai,gpt-3.5-turbo"
  }
}
```

Since a non-empty project `Router` fully replaces the global one, copy over any other scenario
(such as `background` here) you still want to keep, rather than relying on it to be inherited.

### Scenario 2: Test Projects Use Low-Cost Models

```json5
{
  "Router": {
    "default": "openai,gpt-3.5-turbo",
    "background": "openai,gpt-3.5-turbo"
  }
}
```

### Scenario 3: Long-Context Projects

```json5
{
  "Router": {
    "default": "anthropic,claude-3-opus-20240229",
    "longContext": "anthropic,claude-3-opus-20240229"
  }
}
```

## Verify Project Configuration

```bash
# View project-level config status
ccr status

# Check logs to confirm routing decisions
tail -f ~/.claude-code-router/claude-code-router.log
```

## Delete Project Configuration

```bash
rm -rf ~/.claude-code-router/<project-id>
```

After deletion, the project falls back to the global configuration.

## Complete Example

Assume you have two projects, both relying on the same global providers:

### Global Configuration (`~/.claude-code-router/config.json`)

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

### Web Project (`ccr model --project` run inside the web project)

```json5
{
  "Router": {
    "default": "openai,gpt-4",
    "background": "openai,gpt-3.5-turbo"
  }
}
```

### AI Project (`ccr model --project` run inside the AI project)

```json5
{
  "Router": {
    "default": "anthropic,claude-3-5-sonnet-20241022",
    "think": "anthropic,claude-3-5-sonnet-20241022",
    "background": "openai,gpt-3.5-turbo"
  }
}
```

With this setup:
- The web project uses GPT-4 as its default model
- The AI project uses Claude as its default and think model
- Both projects' `background` tasks use GPT-3.5-turbo (explicitly set in each project's
  `Router`, since a non-empty project `Router` does not fall back to the global configuration
  per scenario)
