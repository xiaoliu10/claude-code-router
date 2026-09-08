import path from "node:path";
import fs from "node:fs/promises";
import {
  HOME_DIR,
  getProjectConfigDir,
  getProjectConfigPath,
} from "./constants";
import {
  applyCcrProjectTakeover,
  removeCcrProjectTakeover,
  isCcrProjectTakeoverActive,
  applyPiProjectTakeover,
  removePiProjectTakeover,
  isPiProjectTakeoverActive,
  applyQwenProjectTakeover,
  removeQwenProjectTakeover,
  isQwenProjectTakeoverActive,
  applyOpencodeProjectTakeover,
  removeOpencodeProjectTakeover,
  isOpencodeProjectTakeoverActive,
  PROJECT_TAKEOVER_CLIENT_IDS,
  type ClientId,
} from "./client-integrations";

export interface ProjectConfig {
  projectPath?: string;
  Router?: Record<string, any>;
  [key: string]: any;
}

export interface ProjectConfigEntry {
  id: string;
  path: string;
  configPath: string;
  Router: Record<string, any>;
}

export interface ProjectTakeoverSyncResult {
  updated: number;
  skipped: number;
  failed: Array<{ id: string; path: string; error: string }>;
}

function isUsingGlobalRouter(router: Record<string, any> | undefined): boolean {
  return Object.keys(router || {}).length === 0;
}

function buildProjectTakeoverConfig(
  config: Record<string, any>,
  projectRouter: Record<string, any> | undefined,
): Record<string, any> {
  if (isUsingGlobalRouter(projectRouter)) return config;
  return { ...config, Router: projectRouter };
}

async function resolveProjectTakeoverConfig(
  projectPath: string,
  config: Record<string, any>,
  projectRouter?: Record<string, any>,
): Promise<Record<string, any>> {
  if (projectRouter !== undefined) {
    return buildProjectTakeoverConfig(config, projectRouter);
  }

  const projectConfig = await readProjectConfig(projectPath);
  return buildProjectTakeoverConfig(config, projectConfig?.Router);
}

/**
 * Read the project-level config for a given project path.
 * Returns null if no project-level config has been created yet.
 */
export async function readProjectConfig(projectPath: string): Promise<ProjectConfig | null> {
  const configPath = getProjectConfigPath(projectPath);
  try {
    const raw = await fs.readFile(configPath, "utf-8");
    const data = JSON.parse(raw);
    return data && typeof data === "object" ? data : null;
  } catch {
    return null;
  }
}

/**
 * Write the project-level config for a given project path.
 * Always stores `projectPath` alongside `Router` so the project can be
 * identified later (e.g. when listing all configured projects).
 */
export async function writeProjectConfig(projectPath: string, config: ProjectConfig): Promise<void> {
  const dir = getProjectConfigDir(projectPath);
  await fs.mkdir(dir, { recursive: true });
  const data: ProjectConfig = { ...config, projectPath, Router: config.Router || {} };
  await fs.writeFile(getProjectConfigPath(projectPath), JSON.stringify(data, null, 2), "utf-8");
}

/**
 * Delete the project-level config directory for a given project path.
 */
export async function deleteProjectConfig(projectPath: string): Promise<void> {
  await fs.rm(getProjectConfigDir(projectPath), { recursive: true, force: true });
}

/**
 * List all projects that have a project-level config under ~/.claude-code-router/.
 */
export async function listProjectConfigs(): Promise<ProjectConfigEntry[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(HOME_DIR);
  } catch {
    return [];
  }

  const projects: ProjectConfigEntry[] = [];
  for (const id of entries) {
    if (!id.startsWith("-")) continue;

    const configPath = path.join(HOME_DIR, id, "config.json");
    try {
      const raw = await fs.readFile(configPath, "utf-8");
      const data = JSON.parse(raw);
      if (!data || typeof data !== "object") continue;
      projects.push({
        id,
        path: typeof data.projectPath === "string" ? data.projectPath : id,
        configPath,
        Router: data.Router || {},
      });
    } catch {
      // Not a project config directory (or unreadable), skip
    }
  }

  return projects;
}

/**
 * Find a project config entry by its id (the directory name under HOME_DIR).
 */
export async function readProjectConfigById(id: string): Promise<ProjectConfigEntry | null> {
  const configPath = path.join(HOME_DIR, id, "config.json");
  try {
    const raw = await fs.readFile(configPath, "utf-8");
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object") return null;
    return {
      id,
      path: typeof data.projectPath === "string" ? data.projectPath : id,
      configPath,
      Router: data.Router || {},
    };
  } catch {
    return null;
  }
}

/**
 * Path to a project's `.claude/settings.local.json` file.
 */
export function getClaudeSettingsLocalPath(projectPath: string): string {
  return path.join(projectPath, ".claude", "settings.local.json");
}

/**
 * Read a project's `.claude/settings.local.json`, returning `{}` if missing or invalid.
 */
export async function readClaudeSettingsLocal(projectPath: string): Promise<Record<string, any>> {
  try {
    const raw = await fs.readFile(getClaudeSettingsLocalPath(projectPath), "utf-8");
    const data = JSON.parse(raw);
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

/**
 * Whether the project's `.claude/settings.local.json` currently routes
 * Claude Code traffic through ccr.
 */
export async function getCcrTakeoverStatus(projectPath: string): Promise<boolean> {
  const settings = await readClaudeSettingsLocal(projectPath);
  return isCcrProjectTakeoverActive(settings);
}

/**
 * Path to the backup of a project's ccr-managed `.claude/settings.local.json`,
 * taken when takeover is disabled so it can be restored on the next takeover.
 */
function getCcrTakeoverBackupPath(projectPath: string): string {
  return path.join(getProjectConfigDir(projectPath), "settings.local.backup.json");
}

/**
 * Enable or disable "ccr takeover" for a project's `.claude/settings.local.json`.
 *
 * When enabling, this restores a previous takeover backup if one exists
 * (preserving any customizations made while ccr was managing the project,
 * such as `permissions`/`hooks`), then re-applies the ccr-managed fields
 * (`ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`, model family routing env vars,
 * auto-compact settings, and the status line command) from the *current*
 * global config, so model routing stays in sync even if the global config
 * changed since the backup was taken.
 *
 * When disabling, the ccr-managed fields are removed first, then the remaining
 * (user-customized) settings are backed up, so re-enabling takeover later
 * restores those personalizations instead of losing them. Ccr-managed fields
 * are not backed up — they are re-applied from the current global config on the
 * next enable.
 */
export async function setCcrTakeover(projectPath: string, enabled: boolean, config: Record<string, any>): Promise<void> {
  const settingsPath = getClaudeSettingsLocalPath(projectPath);
  const backupPath = getCcrTakeoverBackupPath(projectPath);
  const takeoverConfig = await resolveProjectTakeoverConfig(projectPath, config);
  let settings = await readClaudeSettingsLocal(projectPath);

  if (enabled) {
    try {
      const backupRaw = await fs.readFile(backupPath, "utf-8");
      const backupSettings = JSON.parse(backupRaw);
      if (backupSettings && typeof backupSettings === "object") {
        settings = backupSettings;
      }
    } catch {
      // No usable backup, start from the current settings.
    }
    applyCcrProjectTakeover(settings, takeoverConfig, projectPath);
  } else {
    // Snapshot the pre-removal active state, then strip ccr-managed fields
    // (including the auto-compact window CCR owns) before backing up. The backup
    // is meant to preserve *user* customizations (permissions, hooks, a
    // hand-edited auto-compact window) — ccr-managed fields are re-applied fresh
    // from the current global config on the next enable, so stripping them here
    // avoids a stale managed window being restored later and mistaken for a user
    // value (which would freeze it and stop ContextWindow changes from applying).
    const wasActive = isCcrProjectTakeoverActive(settings);
    removeCcrProjectTakeover(settings, projectPath, takeoverConfig);
    if (wasActive) {
      await fs.mkdir(path.dirname(backupPath), { recursive: true });
      await fs.writeFile(backupPath, JSON.stringify(settings, null, 2), "utf-8");
    }
  }

  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
}

/**
 * Refresh ccr-managed fields in a project's active `.claude/settings.local.json`
 * from the current global config. Returns false when the project is not
 * currently under ccr takeover.
 */
export async function refreshCcrProjectTakeover(
  projectPath: string,
  config: Record<string, any>,
  projectRouter?: Record<string, any>,
): Promise<boolean> {
  const settings = await readClaudeSettingsLocal(projectPath);
  if (!isCcrProjectTakeoverActive(settings)) {
    return false;
  }

  const takeoverConfig = await resolveProjectTakeoverConfig(projectPath, config, projectRouter);
  applyCcrProjectTakeover(settings, takeoverConfig, projectPath);
  const settingsPath = getClaudeSettingsLocalPath(projectPath);
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
  return true;
}

/**
 * List which project-takeover-capable clients (Claude Code, pi, qwen-code,
 * opencode) currently route a given project through ccr. Derived directly from each
 * client's project-scoped config file, so it needs no separately stored flag
 * and is always consistent with the real on-disk state.
 */
export async function getProjectTakeoverClients(projectPath: string): Promise<ClientId[]> {
  const active: ClientId[] = [];
  for (const id of PROJECT_TAKEOVER_CLIENT_IDS) {
    if (id === "claudeCode") {
      if (await getCcrTakeoverStatus(projectPath)) active.push(id);
    } else if (id === "pi") {
      if (isPiProjectTakeoverActive(projectPath)) active.push(id);
    } else if (id === "qwenCode") {
      if (isQwenProjectTakeoverActive(projectPath)) active.push(id);
    } else if (id === "opencode") {
      if (isOpencodeProjectTakeoverActive(projectPath)) active.push(id);
    }
  }
  return active;
}

/**
 * Apply ccr takeover for exactly the given set of clients on a project:
 * enable each listed client and disable every other supported one. An empty
 * list removes takeover for all of them. Returns the resulting active set.
 */
export async function setProjectTakeover(
  projectPath: string,
  clients: ClientId[],
  config: Record<string, any>
): Promise<ClientId[]> {
  const want = new Set(clients.filter((id) => PROJECT_TAKEOVER_CLIENT_IDS.includes(id)));
  const piTakeoverConfig = want.has("pi")
    ? await resolveProjectTakeoverConfig(projectPath, config)
    : config;
  for (const id of PROJECT_TAKEOVER_CLIENT_IDS) {
    if (id === "claudeCode") {
      await setCcrTakeover(projectPath, want.has(id), config);
    } else if (id === "pi") {
      if (want.has(id)) applyPiProjectTakeover(projectPath, piTakeoverConfig);
      else removePiProjectTakeover(projectPath, config);
    } else if (id === "qwenCode") {
      if (want.has(id)) applyQwenProjectTakeover(projectPath, config);
      else removeQwenProjectTakeover(projectPath);
    } else if (id === "opencode") {
      if (want.has(id)) applyOpencodeProjectTakeover(projectPath, config);
      else removeOpencodeProjectTakeover(projectPath);
    }
  }
  return getProjectTakeoverClients(projectPath);
}

/** Refresh an active Pi takeover with the effective Router for this project. */
export async function refreshPiProjectTakeover(
  projectPath: string,
  config: Record<string, any>,
  projectRouter?: Record<string, any>,
): Promise<boolean> {
  if (!isPiProjectTakeoverActive(projectPath)) return false;
  const takeoverConfig = await resolveProjectTakeoverConfig(projectPath, config, projectRouter);
  applyPiProjectTakeover(projectPath, takeoverConfig);
  return true;
}

/**
 * Refresh ccr-managed fields for whichever clients currently take over a
 * project, pulling fresh values (proxy URL/token, model aliases, context
 * window) from the current global config. Returns true if any client was
 * refreshed.
 */
export async function refreshProjectTakeovers(
  projectPath: string,
  config: Record<string, any>
): Promise<boolean> {
  let refreshed = false;
  if (await refreshCcrProjectTakeover(projectPath, config)) {
    refreshed = true;
  }
  if (await refreshPiProjectTakeover(projectPath, config)) {
    refreshed = true;
  }
  if (isQwenProjectTakeoverActive(projectPath)) {
    applyQwenProjectTakeover(projectPath, config);
    refreshed = true;
  }
  if (isOpencodeProjectTakeoverActive(projectPath)) {
    applyOpencodeProjectTakeover(projectPath, config);
    refreshed = true;
  }
  return refreshed;
}

/**
 * Refresh project-scoped takeover settings after the global config changes.
 * Projects following the global Router refresh every active client. Projects
 * with an authoritative local Router refresh Claude Code and Pi, so global
 * connection/context settings propagate without leaking global model aliases
 * into the project. The other clients retain their existing project semantics.
 */
export async function syncGlobalProjectTakeovers(config: Record<string, any>): Promise<ProjectTakeoverSyncResult> {
  const result: ProjectTakeoverSyncResult = { updated: 0, skipped: 0, failed: [] };
  const projects = await listProjectConfigs();

  for (const project of projects) {
    try {
      let updated: boolean;
      if (isUsingGlobalRouter(project.Router)) {
        updated = await refreshProjectTakeovers(project.path, config);
      } else {
        const claudeUpdated = await refreshCcrProjectTakeover(project.path, config, project.Router);
        const piUpdated = await refreshPiProjectTakeover(project.path, config, project.Router);
        updated = claudeUpdated || piUpdated;
      }
      if (!updated) {
        result.skipped++;
        continue;
      }

      result.updated++;
    } catch (error: any) {
      result.failed.push({
        id: project.id,
        path: project.path,
        error: error?.message || String(error),
      });
    }
  }

  return result;
}
