import path from "node:path";
import os from "node:os";

export const HOME_DIR = process.env.CCR_CONFIG_DIR
  || path.join(os.homedir(), ".claude-code-router");

export const CONFIG_FILE = path.join(HOME_DIR, "config.json");

export const PLUGINS_DIR = path.join(HOME_DIR, "plugins");

export const PRESETS_DIR = path.join(HOME_DIR, "presets");

export const PID_FILE = path.join(HOME_DIR, '.claude-code-router.pid');

// Managed clients can attach this header when they have a reliable project
// identity but no Claude Code-compatible session metadata. The router validates
// the value against the stored project config before using it.
export const CCR_PROJECT_HEADER = "x-ccr-project";

// CCR-managed client state: records the values CCR last wrote into a client's
// settings file (e.g. ~/.claude/settings.json), so CCR can distinguish values it
// wrote (safe to update/remove with the global config) from values the user hand-
// edited (must be preserved). Per-project state lives under getProjectConfigDir().
export const CLIENT_STATE_FILE = path.join(HOME_DIR, "client-state.json");

export const REFERENCE_COUNT_FILE = path.join(os.tmpdir(), "claude-code-reference-count.txt");

// Claude projects directory
export const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");

/**
 * Convert an absolute project path to the Claude Code project folder id
 * (matches the directory naming convention used under ~/.claude/projects/<id>).
 */
export function getClaudeProjectId(projectPath: string): string {
  return projectPath.replace(/[\\/.]/g, "-");
}

/**
 * Get the CCR project-level config directory for a given project path.
 * This is where per-project Router overrides are stored:
 * ~/.claude-code-router/<project-id>/config.json
 */
export function getProjectConfigDir(projectPath: string = process.cwd()): string {
  return path.join(HOME_DIR, getClaudeProjectId(projectPath));
}

/**
 * Get the CCR project-level config file path for a given project path.
 */
export function getProjectConfigPath(projectPath: string = process.cwd()): string {
  return path.join(getProjectConfigDir(projectPath), "config.json");
}


export interface DefaultConfig {
  LOG: boolean;
  OPENAI_API_KEY: string;
  OPENAI_BASE_URL: string;
  OPENAI_MODEL: string;
}

export const DEFAULT_CONFIG: DefaultConfig = {
  LOG: false,
  OPENAI_API_KEY: "",
  OPENAI_BASE_URL: "",
  OPENAI_MODEL: "",
};
