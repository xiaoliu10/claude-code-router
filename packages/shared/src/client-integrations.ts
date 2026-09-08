import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  HOME_DIR,
  CLIENT_STATE_FILE,
  CCR_PROJECT_HEADER,
  getClaudeProjectId,
  getProjectConfigDir,
} from "./constants";

export const CLIENT_IDS = ["claudeCode", "codex", "pi", "qwenCode", "opencode"] as const;
export type ClientId = (typeof CLIENT_IDS)[number];
export type ClientAction = "enable" | "disable" | "restore";

export interface ClientConfig {
  enabled?: boolean;
  managed?: boolean;
  configPath?: string;
  modelAlias?: string;
  quota?: {
    limit5h?: number;
    limit7d?: number;
  };
}

export type ClientsConfig = Partial<Record<ClientId, ClientConfig>>;

export interface ClientStatus {
  id: ClientId;
  name: string;
  enabled: boolean;
  managed: boolean;
  configPath: string;
  exists: boolean;
  activeModel?: string;
  modelAlias?: string;
  details?: string;
}

export interface ClientOperationResult {
  id: ClientId;
  action: ClientAction;
  success: boolean;
  status?: ClientStatus;
  error?: string;
}

export interface ClientApplyResult {
  success: boolean;
  results: ClientOperationResult[];
  clients: ClientStatus[];
  config: Record<string, any>;
}


interface ResolvedClientConfig extends Required<ClientConfig> {
}

interface ClientDefinition {
  id: ClientId;
  name: string;
  defaultConfig: ResolvedClientConfig;
}

interface ClientOperationOptions {
  updateEnabled?: boolean;
}

interface ClientAdapter {
  status(config: Record<string, any>): ClientStatus;
  enable(config: Record<string, any>): ClientStatus;
  disable(config: Record<string, any>): ClientStatus;
  restore(config: Record<string, any>): ClientStatus;
}

const CLIENT_DEFINITIONS: Record<ClientId, ClientDefinition> = {
  claudeCode: {
    id: "claudeCode",
    name: "Claude Code",
    defaultConfig: {
      enabled: false,
      managed: false,
      configPath: "~/.claude/settings.json",
      modelAlias: "",
      quota: {},
    },
  },
  codex: {
    id: "codex",
    name: "Codex",
    defaultConfig: {
      enabled: false,
      managed: false,
      configPath: "~/.codex/config.toml",
      modelAlias: "ccr-opus",
      quota: {},
    },
  },
  pi: {
    id: "pi",
    name: "pi",
    defaultConfig: {
      // pi (earendil-works) stores config under a directory, not a single
      // file; the takeover writes models.json + settings.json inside it.
      enabled: false,
      managed: false,
      configPath: "~/.pi/agent",
      modelAlias: "ccr-opus",
      quota: {},
    },
  },
  qwenCode: {
    id: "qwenCode",
    name: "Qwen Code",
    defaultConfig: {
      // qwen-code (@qwen-code/qwen-code) keeps user settings in
      // ~/.qwen/settings.json; the takeover writes a custom Anthropic
      // modelProvider pointing at the ccr proxy there.
      enabled: false,
      managed: false,
      configPath: "~/.qwen/settings.json",
      modelAlias: "ccr-opus",
      quota: {},
    },
  },
  opencode: {
    id: "opencode",
    name: "opencode",
    defaultConfig: {
      // opencode (opencode.ai) keeps its config in ~/.config/opencode/
      // opencode.json; the takeover injects a custom Anthropic `provider`
      // pointing at the ccr proxy there.
      enabled: false,
      managed: false,
      configPath: "~/.config/opencode/opencode.json",
      modelAlias: "ccr-opus",
      quota: {},
    },
  },
};

const CLIENT_BACKUP_DIR = path.join(HOME_DIR, "backups", "clients");
const LEGACY_STATUSLINE_BACKUP_PATH = path.join(HOME_DIR, ".statusline-backup.json");
const LEGACY_MODEL_BACKUP_PATH = path.join(HOME_DIR, ".model-env-backup.json");
const CLAUDE_MODEL_ENV_KEYS = [
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_REASONING_MODEL",
];
const CLAUDE_AUTO_COMPACT_ENV = {
  CLAUDE_CODE_AUTO_COMPACT_WINDOW: "200000",
  CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "90",
  CLAUDE_CODE_SIMPLE: "1",
};

// Default context window (in tokens) used to drive client-side auto-compaction
// when the user has not configured a global `ContextWindow`. It feeds both
// Claude Code's CLAUDE_CODE_AUTO_COMPACT_WINDOW and Codex's model_context_window,
// so compaction fires before the routed model overflows. A larger window is not
// always better: it raises cost and can cause context drift.
export const DEFAULT_CONTEXT_WINDOW = 200000;

function isObject(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Resolve the configured context window (in tokens) from the global config,
 * falling back to DEFAULT_CONTEXT_WINDOW. Accepts a number or a numeric string.
 */
export function getContextWindow(config: Record<string, any>): number {
  const value = config?.ContextWindow;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = parseInt(value.trim(), 10);
    if (parsed > 0) return parsed;
  }
  return DEFAULT_CONTEXT_WINDOW;
}

// --- CCR-managed state -----------------------------------------------------
// Records the exact values CCR last wrote into a client's settings file, so CCR
// can tell apart values it owns (safe to overwrite/clear when the global config
// changes) from values the user hand-edited (must be preserved). The global
// settings.json state lives in one file keyed by clientId; each project's state
// lives in its own ccr-state.json next to settings.local.backup.json.

interface ManagedState {
  autoCompactWindow?: string;
  // The window value CCR replaced when it re-adopted a managed value while the
  // state was missing. Recorded so a genuine user hand-written value that got
  // overwritten (e.g. after a disable->enable cycle or a pre-state-migration
  // install) stays recoverable/auditable. Not used by the apply/remove logic.
  previousAutoCompactWindow?: string;
}

/** State file path for a global client takeover (e.g. ~/.claude/settings.json). */
function getGlobalManagedStatePath(): string {
  return CLIENT_STATE_FILE;
}

/** State file path for a project-level takeover (.claude/settings.local.json). */
function getProjectManagedStatePath(projectPath: string): string {
  return path.join(getProjectConfigDir(projectPath), "ccr-state.json");
}

/** Read a per-project managed-state file (a flat ManagedState object). */
function readManagedState(statePath: string): ManagedState {
  return readJsonObject(statePath) as ManagedState;
}

/** Read one clientId's slot from the global managed-state file. */
function readGlobalManagedState(clientId: ClientId): ManagedState {
  const all = readJsonObject(getGlobalManagedStatePath()) as Record<string, ManagedState>;
  return (all && all[clientId]) || {};
}

/** Persist a per-project managed-state file. */
function writeManagedState(statePath: string, value: ManagedState): void {
  writeJsonObject(statePath, value);
}

/** Persist one clientId's slot in the global managed-state file. */
function writeGlobalManagedState(clientId: ClientId, value: ManagedState): void {
  const statePath = getGlobalManagedStatePath();
  const all = readJsonObject(statePath) as Record<string, ManagedState>;
  all[clientId] = value;
  writeJsonObject(statePath, all);
}

/** Clear a per-project managed-state file. */
function clearManagedState(statePath: string): void {
  try {
    if (fs.existsSync(statePath)) fs.unlinkSync(statePath);
  } catch {
    // Best-effort; stale state just makes CCR conservative next time.
  }
}

/** Clear one clientId's slot from the global managed-state file. */
function clearGlobalManagedState(clientId: ClientId): void {
  const statePath = getGlobalManagedStatePath();
  const all = readJsonObject(statePath) as Record<string, ManagedState>;
  if (all && all[clientId]) {
    delete all[clientId];
    if (Object.keys(all).length > 0) {
      writeJsonObject(statePath, all);
    } else {
      clearManagedState(statePath);
    }
  }
}

/**
 * Build a ManagedStateAccess backed by the global client-state file for a given
 * client. Used by the global enable/disable path (~/.claude/settings.json).
 */
function globalStateAccess(clientId: ClientId): ManagedStateAccess {
  return {
    read: () => readGlobalManagedState(clientId),
    write: (value) => writeGlobalManagedState(clientId, value),
    clear: () => clearGlobalManagedState(clientId),
  };
}

/**
 * Build a ManagedStateAccess backed by a project's ccr-state.json. Returns
 * undefined when projectPath is absent (no state tracked — apply/remove then
 * fall back to the conservative preserve-on-divergence behavior).
 */
function projectStateAccess(projectPath?: string): ManagedStateAccess | undefined {
  if (!projectPath) return undefined;
  const statePath = getProjectManagedStatePath(projectPath);
  return {
    read: () => readManagedState(statePath),
    write: (value) => writeManagedState(statePath, value),
    clear: () => clearManagedState(statePath),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function expandHome(filePath: string): string {
  if (filePath === "~") return os.homedir();
  if (filePath.startsWith("~/")) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  return filePath;
}

function getClientDefinition(id: ClientId): ClientDefinition {
  return CLIENT_DEFINITIONS[id];
}

function getRawClientConfig(config: Record<string, any>, id: ClientId): ClientConfig {
  const clients = isObject(config.Clients) ? config.Clients : {};
  const value = clients[id];
  return isObject(value) ? value : {};
}

function hasFamiliesConfig(config: Record<string, any>): boolean {
  const families = config?.Router?.families;
  return isObject(families) && Object.keys(families).length > 0;
}

function getLegacyClaudeEnabled(config: Record<string, any>): boolean {
  return Boolean(config?.StatusLine?.enabled || hasFamiliesConfig(config));
}

export function getDefaultClientsConfig(): ClientsConfig {
  return {
    claudeCode: { ...CLIENT_DEFINITIONS.claudeCode.defaultConfig },
    codex: { ...CLIENT_DEFINITIONS.codex.defaultConfig },
    pi: { ...CLIENT_DEFINITIONS.pi.defaultConfig },
    qwenCode: { ...CLIENT_DEFINITIONS.qwenCode.defaultConfig },
    opencode: { ...CLIENT_DEFINITIONS.opencode.defaultConfig },
  };
}

export function getClientConfig(config: Record<string, any>, id: ClientId): ResolvedClientConfig {
  const definition = getClientDefinition(id);
  const rawConfig = getRawClientConfig(config, id);
  const hasExplicitEnabled = typeof rawConfig.enabled === "boolean";
  const enabled =
    hasExplicitEnabled
      ? Boolean(rawConfig.enabled)
      : id === "claudeCode" && !isObject(config.Clients)
        ? getLegacyClaudeEnabled(config)
        : definition.defaultConfig.enabled;

  return {
    ...definition.defaultConfig,
    ...rawConfig,
    enabled,
    managed: Boolean(rawConfig.managed),
    configPath: rawConfig.configPath || definition.defaultConfig.configPath,
    modelAlias: rawConfig.modelAlias || definition.defaultConfig.modelAlias,
  };
}

export function isClientId(value: string): value is ClientId {
  return (CLIENT_IDS as readonly string[]).includes(value);
}

export function isClientEnabled(config: Record<string, any>, id: ClientId): boolean {
  return getClientConfig(config, id).enabled;
}

function setClientConfig(
  config: Record<string, any>,
  id: ClientId,
  patch: Partial<ClientConfig>
): ResolvedClientConfig {
  const clients = isObject(config.Clients) ? { ...config.Clients } : {};
  const current = getClientConfig(config, id);
  const next = {
    ...current,
    ...patch,
  };
  clients[id] = next;
  config.Clients = clients;
  return next;
}

function getResolvedConfigPath(config: Record<string, any>, id: ClientId): string {
  return expandHome(getClientConfig(config, id).configPath);
}

function ensureParentDir(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function createBackup(clientId: string, filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;

  const backupDir = path.join(CLIENT_BACKUP_DIR, clientId);
  fs.mkdirSync(backupDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const ext = path.extname(filePath) || ".bak";
  const backupPath = path.join(backupDir, `${timestamp}${ext}`);
  fs.copyFileSync(filePath, backupPath);
  return backupPath;
}

function getLatestBackupPath(clientId: string): string | null {
  const backupDir = path.join(CLIENT_BACKUP_DIR, clientId);
  if (!fs.existsSync(backupDir)) return null;

  const files = fs
    .readdirSync(backupDir)
    .filter((file) => !file.startsWith("."))
    .sort();

  if (files.length === 0) return null;
  return path.join(backupDir, files[files.length - 1]);
}

function restoreLatestBackup(clientId: string, filePath: string): string | null {
  const backupPath = getLatestBackupPath(clientId);
  if (!backupPath) return null;

  ensureParentDir(filePath);
  fs.copyFileSync(backupPath, filePath);
  return backupPath;
}

function readJsonObject(filePath: string): Record<string, any> {
  if (!fs.existsSync(filePath)) return {};

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch {
    return {};
  }
  if (!raw.trim()) return {};

  // Tolerate a corrupted/truncated state file (user-writable location): treat
  // parse failures as "no state" so takeover/refresh/teardown still work and
  // CCR stays conservative rather than throwing mid-flow.
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  return isObject(parsed) ? parsed : {};
}

function writeJsonObject(filePath: string, value: Record<string, any>): void {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  if (fs.existsSync(filePath)) {
    try {
      if (fs.readFileSync(filePath, "utf-8") === serialized) return;
    } catch {
      // Fall through and replace unreadable content.
    }
  }
  ensureParentDir(filePath);
  fs.writeFileSync(filePath, serialized, "utf-8");
}

function getCcrBaseUrl(config: Record<string, any>, suffix = ""): string {
  const port = config.PORT || 3456;
  return `http://127.0.0.1:${port}${suffix}`;
}

function isCcrBaseUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return /^https?:\/\/(127\.0\.0\.1|localhost):\d+(?:\/.*)?$/i.test(value.trim());
}

function hasExtendedContext(familyConfig: any): boolean {
  return familyConfig?.enableExtendedContext === true;
}

// A family is only authoritative when family routing has not been explicitly
// disabled AND the entry is a supported alias family. When enableFamilyRouting is
// explicitly false the runtime bypasses family routing entirely, so a stale
// families.<x>.enableExtendedContext must NOT keep the managed window above
// 200000 — the request would fall through to a non-extended top-level route and
// overflow. An undefined enableFamilyRouting preserves the existing takeover
// behavior (families present ⇒ emit aliases), matching applyClaudeModelFamilies.
function getSupportedClaudeFamilyNames(config: Record<string, any>): string[] {
  if (config.Router?.enableFamilyRouting === false) return [];
  if (!hasFamiliesConfig(config)) return [];

  const families = config.Router.families;
  return Object.keys(families).filter(
    (family) => ["opus", "sonnet", "haiku"].includes(family) && isObject(families[family])
  );
}

function getDefaultClaudeFamily(config: Record<string, any>): string | null {
  const familyNames = getSupportedClaudeFamilyNames(config);
  if (familyNames.includes("opus")) return "opus";
  return familyNames[0] || null;
}

function getClaudeTakeoverContextWindow(config: Record<string, any>): number {
  const contextWindow = getContextWindow(config);
  const defaultFamily = getDefaultClaudeFamily(config);
  const extendedContextEnabled = defaultFamily
    ? hasExtendedContext(config.Router.families[defaultFamily])
    : hasExtendedContext(config.Router);

  return extendedContextEnabled
    ? contextWindow
    : Math.min(contextWindow, DEFAULT_CONTEXT_WINDOW);
}

function applyClaudeModelFamilies(settings: Record<string, any>, config: Record<string, any>): void {
  if (!isObject(settings.env)) settings.env = {};

  for (const key of CLAUDE_MODEL_ENV_KEYS) {
    if (typeof settings.env[key] === "string" && settings.env[key].startsWith("ccr-")) {
      delete settings.env[key];
    }
  }

  if (!hasFamiliesConfig(config)) return;

  const families = config.Router.families;
  const supportedFamilyNames = getSupportedClaudeFamilyNames(config);

  for (const family of supportedFamilyNames) {
    const familyConfig = families[family];
    const extendedSuffix = hasExtendedContext(familyConfig) ? "[1m]" : "";
    const ccrModel = `ccr-${family}${extendedSuffix}`;

    switch (family) {
      case "opus":
        settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL = ccrModel;
        break;
      case "sonnet":
        settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL = ccrModel;
        break;
      case "haiku":
        settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = ccrModel;
        break;
    }
  }

  const defaultFamily = getDefaultClaudeFamily(config);
  if (defaultFamily) {
    const defaultConfig = families[defaultFamily];
    const extendedSuffix = hasExtendedContext(defaultConfig) ? "[1m]" : "";
    settings.env.ANTHROPIC_MODEL = `ccr-${defaultFamily}${extendedSuffix}`;
  }

  const thinkFamily = supportedFamilyNames.find((family) => families[family]?.think);
  const reasoningFamily = thinkFamily || defaultFamily;
  if (reasoningFamily) {
    const reasoningConfig = families[reasoningFamily];
    const extendedSuffix = hasExtendedContext(reasoningConfig) ? "[1m]" : "";
    settings.env.ANTHROPIC_REASONING_MODEL = `ccr-${reasoningFamily}${extendedSuffix}`;
  }
}

/**
 * Accessor for the managed-state slot backing a given takeover target (global
 * settings.json keyed by clientId, or a per-project ccr-state.json). Lets
 * apply/remove read what CCR last wrote and update/clear it, without each call
 * site needing to know which storage layout is in use.
 */
interface ManagedStateAccess {
  read(): ManagedState;
  write(value: ManagedState): void;
  clear(): void;
}

function applyClaudeAutoCompactSettings(
  settings: Record<string, any>,
  config: Record<string, any>,
  state?: ManagedStateAccess,
  managedContextWindow?: number,
): void {
  settings.autoCompactEnabled = true;
  if (!isObject(settings.env)) settings.env = {};
  if (settings.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE === "0.8") {
    delete settings.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE;
  }

  // Auto-compact window: preserve a value the user hand-edited. CCR only
  // overwrites when the field is absent, still holds the value CCR last wrote,
  // or there is no recorded state for this target.
  //
  // The no-state case matters: ccr-state.json can be missing after a
  // disable->enable cycle, or simply because the target was taken over before
  // the state mechanism existed (pre-2.3.22). In both situations the on-disk
  // window may hold an old CCR-written value that no longer matches the current
  // global ContextWindow. Previously such a value was treated as a user
  // customization and frozen, so global ContextWindow changes never reached the
  // target again. Now, when there is no recorded state, CCR re-adopts the
  // window as managed: it writes the current global value and rebuilds the
  // state. To avoid silently losing a genuine hand-written value in this path,
  // the displaced old value is recorded into `previousAutoCompactWindow` for
  // audit/recovery. With a present state, a divergent value is still treated as
  // a user customization and left untouched (the original v2.3.22 guarantee).
  const managedWindow = String(managedContextWindow ?? getContextWindow(config));
  const currentWindow = settings.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
  const lastWrittenWindow = state?.read().autoCompactWindow;
  const isManaged =
    currentWindow === undefined ||
    currentWindow === lastWrittenWindow ||
    lastWrittenWindow === undefined;
  if (isManaged) {
    const displaced =
      lastWrittenWindow === undefined &&
      currentWindow !== undefined &&
      currentWindow !== managedWindow
        ? currentWindow
        : state?.read().previousAutoCompactWindow;
    settings.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = managedWindow;
    state?.write({
      autoCompactWindow: managedWindow,
      ...(displaced !== undefined ? { previousAutoCompactWindow: displaced } : {}),
    });
  }

  // PCT has a fixed CCR default, so a plain value comparison is enough to tell
  // CCR-managed from user-customized; no state file needed for it.
  const defaultPct = CLAUDE_AUTO_COMPACT_ENV.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE;
  if (
    settings.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE === undefined ||
    settings.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE === defaultPct
  ) {
    settings.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = defaultPct;
  }
}

function applyClaudeAttributionHeader(settings: Record<string, any>, config: Record<string, any>): void {
  if (!isObject(settings.env)) settings.env = {};
  // Strip Claude Code's dynamic attribution header (client version + prompt
  // fingerprint) while CCR is taking over, so the upstream prompt-cache prefix
  // stays stable. Enabled by default; opt out with `disableAttributionHeader: false`.
  if (config.disableAttributionHeader === false) {
    delete settings.env.CLAUDE_CODE_ATTRIBUTION_HEADER;
  } else {
    settings.env.CLAUDE_CODE_ATTRIBUTION_HEADER = "0";
  }
}

function restoreLegacyClaudeBackups(settings: Record<string, any>): void {
  if (settings.statusLine?.command === "ccr statusline" && fs.existsSync(LEGACY_STATUSLINE_BACKUP_PATH)) {
    try {
      const backup = JSON.parse(fs.readFileSync(LEGACY_STATUSLINE_BACKUP_PATH, "utf-8"));
      settings.statusLine = backup;
      fs.unlinkSync(LEGACY_STATUSLINE_BACKUP_PATH);
    } catch {
      delete settings.statusLine;
    }
  }

  if (fs.existsSync(LEGACY_MODEL_BACKUP_PATH)) {
    try {
      const backup = JSON.parse(fs.readFileSync(LEGACY_MODEL_BACKUP_PATH, "utf-8"));
      if (!isObject(settings.env)) settings.env = {};
      for (const [key, value] of Object.entries(backup)) {
        settings.env[key] = value;
      }
      fs.unlinkSync(LEGACY_MODEL_BACKUP_PATH);
    } catch {
      // Fall through to managed field cleanup below.
    }
  }
}

function removeClaudeManagedFields(settings: Record<string, any>, state?: ManagedStateAccess): void {
  restoreLegacyClaudeBackups(settings);

  if (isObject(settings.env)) {
    const baseUrlWasManaged = isCcrBaseUrl(settings.env.ANTHROPIC_BASE_URL);
    if (baseUrlWasManaged) {
      delete settings.env.ANTHROPIC_BASE_URL;
      delete settings.env.ANTHROPIC_AUTH_TOKEN;
    }

    for (const key of CLAUDE_MODEL_ENV_KEYS) {
      if (typeof settings.env[key] === "string" && settings.env[key].startsWith("ccr-")) {
        delete settings.env[key];
      }
    }

    // Auto-compact window: only remove it if it still holds the value CCR last
    // wrote. A divergent value is a user customization — keep it. Always clear
    // the recorded state for this target afterward.
    const lastWrittenWindow = state?.read().autoCompactWindow;
    if (settings.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW === lastWrittenWindow) {
      delete settings.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
    }
    state?.clear();
    for (const [key, value] of Object.entries(CLAUDE_AUTO_COMPACT_ENV)) {
      if (key === "CLAUDE_CODE_AUTO_COMPACT_WINDOW") continue;
      if (settings.env[key] === value) {
        delete settings.env[key];
      }
    }

    // Remove the attribution header override injected by CCR.
    delete settings.env.CLAUDE_CODE_ATTRIBUTION_HEADER;

    if (Object.keys(settings.env).length === 0) {
      delete settings.env;
    }
  }

  if (settings.statusLine?.command === "ccr statusline") {
    delete settings.statusLine;
  }

  if (settings.autoCompactEnabled === true) {
    delete settings.autoCompactEnabled;
  }
}

function getClaudeActiveModel(settings: Record<string, any>): string | undefined {
  const env = isObject(settings.env) ? settings.env : {};
  return (
    env.ANTHROPIC_MODEL ||
    env.ANTHROPIC_DEFAULT_SONNET_MODEL ||
    env.ANTHROPIC_DEFAULT_OPUS_MODEL ||
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL
  );
}

function isClaudeManaged(settings: Record<string, any>): boolean {
  const env = isObject(settings.env) ? settings.env : {};
  return Boolean(
    isCcrBaseUrl(env.ANTHROPIC_BASE_URL) ||
    CLAUDE_MODEL_ENV_KEYS.some((key) => typeof env[key] === "string" && env[key].startsWith("ccr-")) ||
    settings.statusLine?.command === "ccr statusline"
  );
}

function createClaudeStatus(config: Record<string, any>, settings?: Record<string, any>, details?: string): ClientStatus {
  const clientConfig = getClientConfig(config, "claudeCode");
  const filePath = getResolvedConfigPath(config, "claudeCode");
  const safeSettings = settings || {};

  return {
    id: "claudeCode",
    name: CLIENT_DEFINITIONS.claudeCode.name,
    enabled: clientConfig.enabled,
    managed: isClaudeManaged(safeSettings),
    configPath: clientConfig.configPath,
    exists: fs.existsSync(filePath),
    activeModel: getClaudeActiveModel(safeSettings),
    details,
  };
}

const claudeCodeAdapter: ClientAdapter = {
  status(config) {
    const filePath = getResolvedConfigPath(config, "claudeCode");
    try {
      return createClaudeStatus(config, readJsonObject(filePath));
    } catch (error) {
      return createClaudeStatus(config, {}, errorMessage(error));
    }
  },

  enable(config) {
    const filePath = getResolvedConfigPath(config, "claudeCode");
    const currentStatus = this.status(config);
    if (!currentStatus.managed) {
      createBackup("claudeCode", filePath);
    }

    const settings = readJsonObject(filePath);
    if (!isObject(settings.env)) settings.env = {};

    settings.env.ANTHROPIC_BASE_URL = getCcrBaseUrl(config);
    settings.env.ANTHROPIC_AUTH_TOKEN = config.APIKEY || "test";
    applyClaudeModelFamilies(settings, config);
    applyClaudeAutoCompactSettings(settings, config, globalStateAccess("claudeCode"));
    applyClaudeAttributionHeader(settings, config);

    if (config?.StatusLine?.enabled) {
      settings.statusLine = {
        type: "command",
        command: "ccr statusline",
        padding: 0,
      };
    } else if (settings.statusLine?.command === "ccr statusline") {
      delete settings.statusLine;
    }

    writeJsonObject(filePath, settings);
    return createClaudeStatus(config, settings);
  },

  disable(config) {
    const filePath = getResolvedConfigPath(config, "claudeCode");
    if (restoreLatestBackup("claudeCode", filePath)) {
      return this.status(config);
    }
    if (!fs.existsSync(filePath)) {
      return this.status(config);
    }

    const settings = readJsonObject(filePath);
    removeClaudeManagedFields(settings, globalStateAccess("claudeCode"));
    writeJsonObject(filePath, settings);
    return createClaudeStatus(config, settings);
  },

  restore(config) {
    return this.disable(config);
  },
};

/**
 * Apply ccr takeover settings (base URL, auth token, model family routing,
 * auto-compact, status line) to a project's `.claude/settings.local.json`,
 * mirroring what `claudeCodeAdapter.enable` does for `~/.claude/settings.json`.
 */
export function applyCcrProjectTakeover(
  settings: Record<string, any>,
  config: Record<string, any>,
  projectPath?: string,
): void {
  if (!isObject(settings.env)) settings.env = {};

  settings.env.ANTHROPIC_BASE_URL = getCcrBaseUrl(config);
  settings.env.ANTHROPIC_AUTH_TOKEN = config.APIKEY || "test";
  applyClaudeModelFamilies(settings, config);
  applyClaudeAutoCompactSettings(
    settings,
    config,
    projectStateAccess(projectPath),
    getClaudeTakeoverContextWindow(config),
  );
  applyClaudeAttributionHeader(settings, config);

  if (config?.StatusLine?.enabled) {
    settings.statusLine = {
      type: "command",
      command: "ccr statusline",
      padding: 0,
    };
  } else if (settings.statusLine?.command === "ccr statusline") {
    delete settings.statusLine;
  }
}

/**
 * Remove ccr-managed fields from a project's `.claude/settings.local.json`,
 * preserving any unrelated settings (permissions, hooks, etc.).
 */
export function removeCcrProjectTakeover(
  settings: Record<string, any>,
  projectPath?: string,
  config?: Record<string, any>,
): void {
  const state = projectStateAccess(projectPath);
  if (isObject(settings.env)) {
    if (isCcrBaseUrl(settings.env.ANTHROPIC_BASE_URL)) {
      delete settings.env.ANTHROPIC_BASE_URL;
      delete settings.env.ANTHROPIC_AUTH_TOKEN;
    }

    for (const key of CLAUDE_MODEL_ENV_KEYS) {
      if (typeof settings.env[key] === "string" && settings.env[key].startsWith("ccr-")) {
        delete settings.env[key];
      }
    }

    // Auto-compact window: remove it if it still holds the value CCR last wrote,
    // OR — when the state is missing (e.g. after a prior disable->enable cycle
    // failed to rebuild it) — if it matches the value CCR would write for the
    // current config. A divergent value is a user customization — keep it.
    // Always clear the recorded state for this project afterward.
    const lastWrittenWindow = state?.read().autoCompactWindow;
    const currentWindow = settings.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
    const managedWindow = config ? String(getClaudeTakeoverContextWindow(config)) : undefined;
    const shouldRemove =
      currentWindow === lastWrittenWindow ||
      (lastWrittenWindow === undefined && managedWindow !== undefined && currentWindow === managedWindow);
    if (shouldRemove) {
      delete settings.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
    }
    state?.clear();
    for (const [key, value] of Object.entries(CLAUDE_AUTO_COMPACT_ENV)) {
      if (key === "CLAUDE_CODE_AUTO_COMPACT_WINDOW") continue;
      if (settings.env[key] === value) {
        delete settings.env[key];
      }
    }

    // Remove the attribution header override injected by CCR.
    delete settings.env.CLAUDE_CODE_ATTRIBUTION_HEADER;

    if (Object.keys(settings.env).length === 0) {
      delete settings.env;
    }
  }

  if (settings.statusLine?.command === "ccr statusline") {
    delete settings.statusLine;
  }

  if (settings.autoCompactEnabled === true) {
    delete settings.autoCompactEnabled;
  }
}

/**
 * Whether a project's `.claude/settings.local.json` is currently taken over by ccr.
 */
export function isCcrProjectTakeoverActive(settings: Record<string, any>): boolean {
  return isClaudeManaged(settings);
}

function parseTomlString(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  const quoted = trimmed.match(/^"((?:\\.|[^"\\])*)"/);
  if (quoted) {
    return quoted[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  const singleQuoted = trimmed.match(/^'([^']*)'/);
  if (singleQuoted) return singleQuoted[1];
  const bare = trimmed.match(/^([^#\s]+)/);
  return bare?.[1];
}

function stripTomlComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" && inDouble) {
      escaped = true;
      continue;
    }
    if (char === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (char === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (char === "#" && !inSingle && !inDouble) {
      return line.slice(0, index);
    }
  }

  return line;
}

function getTopLevelTomlValue(content: string, key: string): string | undefined {
  let inSection = false;
  for (const line of content.split(/\r?\n/)) {
    const trimmed = stripTomlComment(line).trim();
    if (!trimmed) continue;
    if (/^\[[^\]]+\]$/.test(trimmed)) {
      inSection = true;
      continue;
    }
    if (inSection) continue;

    const match = trimmed.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (match?.[1] === key) {
      return parseTomlString(match[2]);
    }
  }
  return undefined;
}

function hasTomlSection(content: string, sectionName: string): boolean {
  return content
    .split(/\r?\n/)
    .some((line) => stripTomlComment(line).trim() === `[${sectionName}]`);
}

function quoteTomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// Numbers are emitted as bare TOML integers/floats; strings are quoted.
function formatTomlValue(value: string | number): string {
  return typeof value === "number" ? String(value) : quoteTomlString(value);
}

function setTopLevelTomlValues(content: string, values: Record<string, string | number>): string {
  const lines = content ? content.split(/\r?\n/) : [];
  const replaced = new Set<string>();
  const firstSectionIndex = lines.findIndex((line) => /^\s*\[[^\]]+\]\s*(?:#.*)?$/.test(line));
  const topLevelEnd = firstSectionIndex === -1 ? lines.length : firstSectionIndex;

  for (let index = 0; index < topLevelEnd; index += 1) {
    const match = stripTomlComment(lines[index]).trim().match(/^([A-Za-z0-9_.-]+)\s*=/);
    if (match && Object.prototype.hasOwnProperty.call(values, match[1])) {
      lines[index] = `${match[1]} = ${formatTomlValue(values[match[1]])}`;
      replaced.add(match[1]);
    }
  }

  const missing = Object.entries(values)
    .filter(([key]) => !replaced.has(key))
    .map(([key, value]) => `${key} = ${formatTomlValue(value)}`);

  if (missing.length > 0) {
    lines.splice(topLevelEnd, 0, ...missing, topLevelEnd === 0 ? "" : "");
  }

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}

function removeTomlSection(content: string, sectionName: string): string {
  const lines = content ? content.split(/\r?\n/) : [];
  const output: string[] = [];
  let inTargetSection = false;

  for (const line of lines) {
    const sectionMatch = stripTomlComment(line).trim().match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      const currentSection = sectionMatch[1];
      inTargetSection =
        currentSection === sectionName || currentSection.startsWith(`${sectionName}.`);
      if (inTargetSection) continue;
    }

    if (!inTargetSection) {
      output.push(line);
    }
  }

  return output.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}

function removeTopLevelTomlKeys(content: string, keys: Set<string>): string {
  const lines = content ? content.split(/\r?\n/) : [];
  const output: string[] = [];
  let inSection = false;

  for (const line of lines) {
    const trimmed = stripTomlComment(line).trim();
    if (/^\[[^\]]+\]$/.test(trimmed)) {
      inSection = true;
      output.push(line);
      continue;
    }

    const match = !inSection ? trimmed.match(/^([A-Za-z0-9_.-]+)\s*=/) : null;
    if (match && keys.has(match[1])) {
      continue;
    }

    output.push(line);
  }

  return output.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}

function getCodexContent(filePath: string): string {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : "";
}

function writeCodexContent(filePath: string, content: string): void {
  ensureParentDir(filePath);
  fs.writeFileSync(filePath, `${content.trimEnd()}\n`, "utf-8");
}


function isCodexManaged(content: string): boolean {
  const provider = getTopLevelTomlValue(content, "model_provider");
  const hasCcrProvider = hasTomlSection(content, "model_providers.ccr");
  return provider === "ccr" || hasCcrProvider;
}

function ensureCodexRouterMapping(config: Record<string, any>, alias: string): void {
  if (!isObject(config.Router)) {
    config.Router = {};
  }
  if (!isObject(config.Router.models)) {
    config.Router.models = {};
  }
  if (!config.Router.models[alias] && typeof config.Router.default === "string" && config.Router.default) {
    config.Router.models[alias] = config.Router.default;
  }
}

// Remove CCR-related keys from the [shell_environment_policy.set] section
function cleanShellEnvVars(content: string): string {
  const ccrEnvKeys = new Set([
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_MODEL",
    "ANTHROPIC_REASONING_MODEL",
    "CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS",
  ]);

  const lines = content ? content.split(/\r?\n/) : [];
  const output: string[] = [];
  let inShellSet = false;

  for (const line of lines) {
    const trimmed = stripTomlComment(line).trim();
    if (trimmed === "[shell_environment_policy.set]") {
      inShellSet = true;
      output.push(line);
      continue;
    }
    if (inShellSet && /^\[[^\]]+\]$/.test(trimmed)) {
      inShellSet = false;
    }
    if (inShellSet) {
      const kvMatch = trimmed.match(/^([A-Za-z0-9_.-]+)\s*=/);
      if (kvMatch && ccrEnvKeys.has(kvMatch[1])) {
        continue; // skip CCR env vars
      }
    }
    output.push(line);
  }

  return output.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}

function createCodexStatus(config: Record<string, any>, content?: string, details?: string): ClientStatus {
  const clientConfig = getClientConfig(config, "codex");
  const filePath = getResolvedConfigPath(config, "codex");
  const safeContent = content ?? "";
  const model = getTopLevelTomlValue(safeContent, "model");

  return {
    id: "codex",
    name: CLIENT_DEFINITIONS.codex.name,
    enabled: clientConfig.enabled,
    managed: isCodexManaged(safeContent),
    configPath: clientConfig.configPath,
    exists: fs.existsSync(filePath),
    activeModel: model,
    modelAlias: clientConfig.modelAlias,
    details,
  };
}

const codexAdapter: ClientAdapter = {
  status(config) {
    const filePath = getResolvedConfigPath(config, "codex");
    try {
      return createCodexStatus(config, getCodexContent(filePath));
    } catch (error) {
      return createCodexStatus(config, "", errorMessage(error));
    }
  },

  enable(config) {
    const filePath = getResolvedConfigPath(config, "codex");
    const clientConfig = getClientConfig(config, "codex");
    const alias = clientConfig.modelAlias || CLIENT_DEFINITIONS.codex.defaultConfig.modelAlias;
    const currentStatus = this.status(config);
    if (!currentStatus.managed) {
      createBackup("codex", filePath);
    }

    ensureCodexRouterMapping(config, alias);

    let content = getCodexContent(filePath);
    content = removeTomlSection(content, "model_providers.ccr");
    const contextWindow = getContextWindow(config);
    content = setTopLevelTomlValues(content, {
      model: alias,
      model_provider: "ccr",
      // Pin the context window so Codex triggers auto-compaction before the
      // routed (often third-party) model overflows. Codex's built-in catalogue
      // doesn't know the ccr alias and would otherwise fall back to a window
      // that doesn't match the real model, breaking compaction timing.
      model_context_window: contextWindow,
      model_auto_compact_token_limit: Math.floor(contextWindow * 0.9),
    });
    const apiKey = typeof config.APIKEY === "string" ? config.APIKEY : "";
    const authSection = apiKey
      ? `\n\n[model_providers.ccr.http_headers]\nAuthorization = ${quoteTomlString(`Bearer ${apiKey}`)}`
      : "";
    content = `${content.trimEnd()}\n\n[model_providers.ccr]\nname = "Claude Code Router"\nbase_url = "${getCcrBaseUrl(config, "/v1")}"\nwire_api = "responses"${authSection}`;

    writeCodexContent(filePath, content);
    return createCodexStatus(config, content);
  },

  disable(config) {
    const filePath = getResolvedConfigPath(config, "codex");
    if (restoreLatestBackup("codex", filePath)) {
      // Also clean up shell env vars that may have been added outside of CCR
      let content = getCodexContent(filePath);
      content = cleanShellEnvVars(content);
      writeCodexContent(filePath, content);
      return this.status(config);
    }
    if (!fs.existsSync(filePath)) {
      return this.status(config);
    }

    const clientConfig = getClientConfig(config, "codex");
    const alias = clientConfig.modelAlias || CLIENT_DEFINITIONS.codex.defaultConfig.modelAlias;
    let content = getCodexContent(filePath);
    const keysToRemove = new Set<string>();

    if (getTopLevelTomlValue(content, "model_provider") === "ccr") {
      keysToRemove.add("model_provider");
      keysToRemove.add("model_context_window");
      keysToRemove.add("model_auto_compact_token_limit");
    }

    const activeModel = getTopLevelTomlValue(content, "model");
    if (activeModel === alias || activeModel?.startsWith("ccr-")) {
      keysToRemove.add("model");
    }

    content = removeTopLevelTomlKeys(content, keysToRemove);
    content = removeTomlSection(content, "model_providers.ccr");
    // Also remove CCR-related shell environment variables
    content = cleanShellEnvVars(content);
    writeCodexContent(filePath, content);
    return createCodexStatus(config, content);
  },

  restore(config) {
    return this.disable(config);
  },
};

// ========================= pi (earendil-works) =========================
//
// pi keeps its config in a directory (~/.pi/agent by default) across three
// JSON files. To route pi through ccr we only touch two of them:
//   - models.json: register Anthropic-compatible CCR providers with family
//                  aliases. Global takeover uses "ccr"; project takeovers use
//                  dedicated "ccr-project-*" providers. API keys live here, so
//                  auth.json remains untouched.
//   - settings.json: select the relevant provider and default model.
// pi speaks the Anthropic /v1/messages protocol (like Claude Code), so no
// transformer is needed on the ccr side.

const PI_PROVIDER_NAME = "ccr";
const PI_PROJECT_PROVIDER_PREFIX = "ccr-project-";
// pi's Anthropic-messages API id; baseUrl is the root (the SDK appends
// /v1/messages), matching how Claude Code uses ANTHROPIC_BASE_URL.
const PI_ANTHROPIC_API = "anthropic-messages";

interface PiPaths {
  dir: string;
  settings: string;
  models: string;
}

function getPiPaths(config: Record<string, any>): PiPaths {
  const dir = expandHome(getClientConfig(config, "pi").configPath);
  return {
    dir,
    settings: path.join(dir, "settings.json"),
    models: path.join(dir, "models.json"),
  };
}

/**
 * Build the ccr family-alias models pi should expose, mirroring the model
 * family aliases Claude Code takeover uses (ccr-opus/ccr-sonnet/ccr-haiku).
 * Falls back to the configured modelAlias when no families are configured.
 * Returns the model definitions plus the id pi should default to.
 */
function getPiModels(config: Record<string, any>): { models: any[]; defaultModel: string } {
  const contextWindow = getContextWindow(config);
  const normalizePiAlias = (id: string) => id.replace(/\[1m\]$/i, "");
  const makeModel = (id: string, label: string) => ({
    id: normalizePiAlias(id),
    name: label,
    api: PI_ANTHROPIC_API,
    reasoning: true,
    input: ["text", "image"],
    contextWindow,
    maxTokens: 64000,
  });

  if (hasFamiliesConfig(config)) {
    const families = config.Router.families;
    const order = ["opus", "sonnet", "haiku"].filter((f) => families[f]);
    const models = order.map((family) =>
      makeModel(`ccr-${family}`, `CCR (${family})`)
    );
    if (models.length > 0) {
      return { models, defaultModel: models[0].id };
    }
  }

  const alias = normalizePiAlias(getClientConfig(config, "pi").modelAlias || "ccr-opus");
  return { models: [makeModel(alias, "CCR")], defaultModel: alias };
}

function isPiProviderManaged(models: Record<string, any>): boolean {
  const provider = isObject(models.providers) ? models.providers[PI_PROVIDER_NAME] : undefined;
  return isObject(provider) && isCcrBaseUrl(provider.baseUrl);
}

function isPiManaged(models: Record<string, any>, settings: Record<string, any>): boolean {
  return isPiProviderManaged(models) || settings.defaultProvider === PI_PROVIDER_NAME;
}

function createPiStatus(
  config: Record<string, any>,
  models?: Record<string, any>,
  settings?: Record<string, any>,
  details?: string
): ClientStatus {
  const clientConfig = getClientConfig(config, "pi");
  const paths = getPiPaths(config);
  const safeModels = models || {};
  const safeSettings = settings || {};

  return {
    id: "pi",
    name: CLIENT_DEFINITIONS.pi.name,
    enabled: clientConfig.enabled,
    managed: isPiManaged(safeModels, safeSettings),
    configPath: clientConfig.configPath,
    exists: fs.existsSync(paths.dir),
    activeModel:
      typeof safeSettings.defaultModel === "string" ? safeSettings.defaultModel : undefined,
    details,
  };
}

const piAdapter: ClientAdapter = {
  status(config) {
    const paths = getPiPaths(config);
    try {
      return createPiStatus(config, readJsonObject(paths.models), readJsonObject(paths.settings));
    } catch (error) {
      return createPiStatus(config, {}, {}, errorMessage(error));
    }
  },

  enable(config) {
    const paths = getPiPaths(config);
    const currentStatus = this.status(config);
    if (!currentStatus.managed) {
      createBackup("pi/models", paths.models);
      createBackup("pi/settings", paths.settings);
    }

    const { defaultModel } = ensurePiCcrProvider(config);
    const models = readJsonObject(paths.models);

    const settings = readJsonObject(paths.settings);
    settings.defaultProvider = PI_PROVIDER_NAME;
    settings.defaultModel = defaultModel;
    writeJsonObject(paths.settings, settings);

    return createPiStatus(config, models, settings);
  },

  disable(config) {
    const paths = getPiPaths(config);

    // Project-scoped providers are independent of the global Pi switch. Keep
    // exactly the currently registered project providers while restoring the
    // user's pre-takeover global models file.
    const currentModels = readJsonObject(paths.models);
    const projectProviders = isObject(currentModels.providers)
      ? Object.fromEntries(
          Object.entries(currentModels.providers)
            .filter(([name]) => isPiProjectProviderName(name))
        )
      : {};

    // models.json: restore the pre-takeover file, or just drop the global ccr
    // provider. Never remove providers still used by project takeovers.
    let models: Record<string, any>;
    if (restoreLatestBackup("pi/models", paths.models)) {
      models = readJsonObject(paths.models);
      if (!isObject(models.providers)) models.providers = {};
      for (const name of Object.keys(models.providers)) {
        if (isPiProjectProviderName(name)) delete models.providers[name];
      }
      delete models.providers[PI_PROVIDER_NAME];
      Object.assign(models.providers, projectProviders);
      writeJsonObject(paths.models, models);
    } else {
      models = currentModels;
      if (isObject(models.providers) && models.providers[PI_PROVIDER_NAME]) {
        delete models.providers[PI_PROVIDER_NAME];
        writeJsonObject(paths.models, models);
      }
    }

    // settings.json: restore backup, or clear the ccr default selection.
    let settings: Record<string, any>;
    if (restoreLatestBackup("pi/settings", paths.settings)) {
      settings = readJsonObject(paths.settings);
    } else {
      settings = readJsonObject(paths.settings);
      if (settings.defaultProvider === PI_PROVIDER_NAME) {
        delete settings.defaultProvider;
        delete settings.defaultModel;
        writeJsonObject(paths.settings, settings);
      }
    }

    return createPiStatus(config, models, settings);
  },

  restore(config) {
    return this.disable(config);
  },
};

/**
 * Register (or refresh) a CCR provider in pi's global `models.json`.
 *
 * pi has no project-level `models.json` — only `.pi/settings.json` overrides
 * are project-scoped — so both the shared global provider and dedicated
 * project providers live globally. They remain inactive until a settings file
 * selects them. Returns the model id callers should set as `defaultModel`.
 */
function ensurePiCcrProvider(
  config: Record<string, any>,
  providerName = PI_PROVIDER_NAME,
  headers?: Record<string, string>,
): { defaultModel: string } {
  const paths = getPiPaths(config);
  const { models: ccrModels, defaultModel } = getPiModels(config);

  const models = readJsonObject(paths.models);
  if (!isObject(models.providers)) models.providers = {};
  models.providers[providerName] = {
    name: "Claude Code Router",
    baseUrl: getCcrBaseUrl(config),
    api: PI_ANTHROPIC_API,
    apiKey: config.APIKEY || "test",
    ...(headers ? { headers } : {}),
    models: ccrModels,
  };
  writeJsonObject(paths.models, models);
  return { defaultModel };
}

/** Stable provider id used by one Pi project takeover. */
export function getPiProjectProviderName(projectPath: string): string {
  const digest = createHash("sha256")
    .update(getClaudeProjectId(projectPath))
    .digest("hex")
    .slice(0, 16);
  return `${PI_PROJECT_PROVIDER_PREFIX}${digest}`;
}

function isPiProjectProviderName(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(PI_PROJECT_PROVIDER_PREFIX);
}

/**
 * Path to a project's `.pi/settings.json` (pi's project-scoped settings, which
 * override the global `~/.pi/agent/settings.json`).
 */
function getPiProjectSettingsPath(projectPath: string): string {
  return path.join(projectPath, ".pi", "settings.json");
}

/** Path to pi's global trust ledger (`~/.pi/agent/trust.json`). */
function getPiTrustPath(config: Record<string, any>): string {
  return path.join(getPiPaths(config).dir, "trust.json");
}

/**
 * Mark a project folder as trusted in pi's `trust.json`. pi only loads a
 * project's `.pi/settings.json` (and other project resources) for trusted
 * folders; non-interactive modes (`-p`/json/rpc) never prompt, so without this
 * the takeover's override would be silently ignored there.
 */
function addPiProjectTrust(projectPath: string, config: Record<string, any>): void {
  const trustPath = getPiTrustPath(config);
  const trust = readJsonObject(trustPath);
  if (trust[projectPath] !== true) {
    trust[projectPath] = true;
    writeJsonObject(trustPath, trust);
  }
}

/**
 * Enable ccr takeover for a single project's pi configuration: register its
 * dedicated global provider (idempotent), trust the project folder, and point
 * the project's `.pi/settings.json` at that provider. Other settings are
 * preserved.
 */
export function applyPiProjectTakeover(projectPath: string, config: Record<string, any>): void {
  const providerName = getPiProjectProviderName(projectPath);
  const { defaultModel } = ensurePiCcrProvider(config, providerName, {
    [CCR_PROJECT_HEADER]: getClaudeProjectId(projectPath),
  });
  addPiProjectTrust(projectPath, config);

  const settingsPath = getPiProjectSettingsPath(projectPath);
  const settings = readJsonObject(settingsPath);
  settings.defaultProvider = providerName;
  settings.defaultModel = defaultModel;
  writeJsonObject(settingsPath, settings);
}

/**
 * Disable ccr takeover for a project's pi configuration by clearing the ccr
 * `defaultProvider`/`defaultModel` from `.pi/settings.json` (removing the file
 * if nothing else remains) and removing its dedicated global provider. The
 * legacy shared provider and trust entry are left in place.
 */
export function removePiProjectTakeover(
  projectPath: string,
  config: Record<string, any>,
): void {
  const expectedProviderName = getPiProjectProviderName(projectPath);
  const settingsPath = getPiProjectSettingsPath(projectPath);
  if (fs.existsSync(settingsPath)) {
    const settings = readJsonObject(settingsPath);
    const providerName = settings.defaultProvider;
    if (providerName === PI_PROVIDER_NAME || providerName === expectedProviderName) {
      delete settings.defaultProvider;
      delete settings.defaultModel;
      if (Object.keys(settings).length === 0) {
        fs.unlinkSync(settingsPath);
      } else {
        writeJsonObject(settingsPath, settings);
      }
    }
  }

  const paths = getPiPaths(config);
  const models = readJsonObject(paths.models);
  if (isObject(models.providers) && models.providers[expectedProviderName]) {
    delete models.providers[expectedProviderName];
    writeJsonObject(paths.models, models);
  }
}

/** Whether a project's `.pi/settings.json` currently routes pi through ccr. */
export function isPiProjectTakeoverActive(projectPath: string): boolean {
  const settings = readJsonObject(getPiProjectSettingsPath(projectPath));
  return settings.defaultProvider === PI_PROVIDER_NAME
    || settings.defaultProvider === getPiProjectProviderName(projectPath);
}

// ========================= qwen-code (Alibaba) =========================
//
// qwen-code (@qwen-code/qwen-code) keeps settings in a single JSON file
// (~/.qwen/settings.json for the user scope, <project>/.qwen/settings.json for
// the workspace scope). The takeover registers a custom Anthropic
// `modelProvider` pointed at the ccr proxy and selects it. qwen speaks the
// Anthropic /v1/messages protocol (like Claude Code / pi), so no transformer is
// needed on the ccr side. The provider's api key lives in `settings.env` and is
// referenced by `envKey`.

const QWEN_PROTOCOL = "anthropic";
const QWEN_ENV_KEY = "QWEN_CCR_API_KEY";

function getQwenSettingsPath(config: Record<string, any>): string {
  return expandHome(getClientConfig(config, "qwenCode").configPath);
}

// qwen stores baseUrl with a trailing slash (matching its own UI output).
function getQwenBaseUrl(config: Record<string, any>): string {
  return `${getCcrBaseUrl(config)}/`;
}

/**
 * Build the ccr family-alias model providers qwen should expose
 * (ccr-opus/ccr-sonnet/ccr-haiku), mirroring the Claude Code / pi takeover.
 * Each entry shares the single env-key holding the ccr api key. Returns the
 * provider entries plus the id qwen should default to.
 */
function getQwenModels(config: Record<string, any>): { providers: any[]; defaultModel: string } {
  const baseUrl = getQwenBaseUrl(config);
  const make = (id: string) => ({ id, name: id, baseUrl, envKey: QWEN_ENV_KEY });

  if (hasFamiliesConfig(config)) {
    const families = config.Router.families;
    const order = ["opus", "sonnet", "haiku"].filter((f) => families[f]);
    const providers = order.map((family) => {
      const extendedSuffix = hasExtendedContext(families[family]) ? "[1m]" : "";
      return make(`ccr-${family}${extendedSuffix}`);
    });
    if (providers.length > 0) {
      return { providers, defaultModel: providers[0].id };
    }
  }

  const alias = getClientConfig(config, "qwenCode").modelAlias || "ccr-opus";
  return { providers: [make(alias)], defaultModel: alias };
}

function isQwenManaged(settings: Record<string, any>): boolean {
  const model = isObject(settings.model) ? settings.model : {};
  if (isCcrBaseUrl(model.baseUrl)) return true;
  const providers = isObject(settings.modelProviders) ? settings.modelProviders[QWEN_PROTOCOL] : undefined;
  return Array.isArray(providers) && providers.some((p) => isObject(p) && isCcrBaseUrl(p.baseUrl));
}

/**
 * Point a qwen `settings.json` object at ccr: write the api key into `env`,
 * register the ccr Anthropic providers (replacing any previous ccr entries
 * while preserving the user's other Anthropic providers), select the Anthropic
 * auth type, and set the active model. Other settings are preserved.
 */
function applyQwenTakeover(settings: Record<string, any>, config: Record<string, any>): void {
  const { providers, defaultModel } = getQwenModels(config);
  const baseUrl = getQwenBaseUrl(config);

  if (!isObject(settings.env)) settings.env = {};
  settings.env[QWEN_ENV_KEY] = config.APIKEY || "test";

  if (!isObject(settings.modelProviders)) settings.modelProviders = {};
  const existing = Array.isArray(settings.modelProviders[QWEN_PROTOCOL])
    ? settings.modelProviders[QWEN_PROTOCOL].filter((p: any) => !(isObject(p) && isCcrBaseUrl(p.baseUrl)))
    : [];
  settings.modelProviders[QWEN_PROTOCOL] = [...existing, ...providers];

  if (!isObject(settings.security)) settings.security = {};
  if (!isObject(settings.security.auth)) settings.security.auth = {};
  settings.security.auth.selectedType = QWEN_PROTOCOL;

  settings.model = { name: defaultModel, baseUrl };
  if (typeof settings.$version !== "number") settings.$version = 4;
}

/**
 * Remove the ccr-managed fields written by {@link applyQwenTakeover}, leaving
 * the user's unrelated settings (and non-ccr Anthropic providers) intact.
 */
function removeQwenManagedFields(settings: Record<string, any>): void {
  if (isObject(settings.env)) {
    delete settings.env[QWEN_ENV_KEY];
    if (Object.keys(settings.env).length === 0) delete settings.env;
  }

  if (isObject(settings.modelProviders) && Array.isArray(settings.modelProviders[QWEN_PROTOCOL])) {
    const remaining = settings.modelProviders[QWEN_PROTOCOL].filter(
      (p: any) => !(isObject(p) && isCcrBaseUrl(p.baseUrl))
    );
    if (remaining.length > 0) {
      settings.modelProviders[QWEN_PROTOCOL] = remaining;
    } else {
      delete settings.modelProviders[QWEN_PROTOCOL];
      if (Object.keys(settings.modelProviders).length === 0) delete settings.modelProviders;
    }
  }

  if (isObject(settings.model) && isCcrBaseUrl(settings.model.baseUrl)) {
    delete settings.model;
  }

  // Clear the Anthropic auth selection we set, but only once no Anthropic
  // providers remain (so a user's own Anthropic provider keeps its selection).
  if (
    isObject(settings.security) &&
    isObject(settings.security.auth) &&
    settings.security.auth.selectedType === QWEN_PROTOCOL
  ) {
    const anthropicProviders = isObject(settings.modelProviders)
      ? settings.modelProviders[QWEN_PROTOCOL]
      : undefined;
    if (!Array.isArray(anthropicProviders) || anthropicProviders.length === 0) {
      delete settings.security.auth.selectedType;
      if (Object.keys(settings.security.auth).length === 0) delete settings.security.auth;
      if (Object.keys(settings.security).length === 0) delete settings.security;
    }
  }
}

function createQwenStatus(config: Record<string, any>, settings?: Record<string, any>, details?: string): ClientStatus {
  const clientConfig = getClientConfig(config, "qwenCode");
  const filePath = getQwenSettingsPath(config);
  const safeSettings = settings || {};

  return {
    id: "qwenCode",
    name: CLIENT_DEFINITIONS.qwenCode.name,
    enabled: clientConfig.enabled,
    managed: isQwenManaged(safeSettings),
    configPath: clientConfig.configPath,
    exists: fs.existsSync(filePath),
    activeModel:
      isObject(safeSettings.model) && typeof safeSettings.model.name === "string"
        ? safeSettings.model.name
        : undefined,
    details,
  };
}

const qwenCodeAdapter: ClientAdapter = {
  status(config) {
    const filePath = getQwenSettingsPath(config);
    try {
      return createQwenStatus(config, readJsonObject(filePath));
    } catch (error) {
      return createQwenStatus(config, {}, errorMessage(error));
    }
  },

  enable(config) {
    const filePath = getQwenSettingsPath(config);
    if (!this.status(config).managed) {
      createBackup("qwenCode", filePath);
    }
    const settings = readJsonObject(filePath);
    applyQwenTakeover(settings, config);
    writeJsonObject(filePath, settings);
    return createQwenStatus(config, settings);
  },

  disable(config) {
    const filePath = getQwenSettingsPath(config);
    if (restoreLatestBackup("qwenCode", filePath)) {
      return this.status(config);
    }
    if (!fs.existsSync(filePath)) {
      return this.status(config);
    }
    const settings = readJsonObject(filePath);
    removeQwenManagedFields(settings);
    writeJsonObject(filePath, settings);
    return createQwenStatus(config, settings);
  },

  restore(config) {
    return this.disable(config);
  },
};

/** Path to a project's workspace-scoped `.qwen/settings.json`. */
function getQwenProjectSettingsPath(projectPath: string): string {
  return path.join(projectPath, ".qwen", "settings.json");
}

/** Path to qwen's global trust ledger (`~/.qwen/trustedFolders.json`). */
function getQwenTrustPath(config: Record<string, any>): string {
  return path.join(path.dirname(getQwenSettingsPath(config)), "trustedFolders.json");
}

/**
 * Trust a project folder in qwen's `trustedFolders.json`. qwen ignores a
 * workspace's `.qwen/settings.json` unless the folder is trusted, so the
 * project-level takeover must record the trust decision.
 */
function addQwenProjectTrust(projectPath: string, config: Record<string, any>): void {
  const trustPath = getQwenTrustPath(config);
  const trust = readJsonObject(trustPath);
  if (trust[projectPath] !== "TRUST_FOLDER") {
    trust[projectPath] = "TRUST_FOLDER";
    writeJsonObject(trustPath, trust);
  }
}

/**
 * Enable ccr takeover for a project's qwen configuration: trust the folder and
 * write the ccr Anthropic provider/model selection into the project's
 * workspace-scoped `.qwen/settings.json` (self-contained — unlike pi, qwen's
 * workspace settings carry the provider definition too).
 */
export function applyQwenProjectTakeover(projectPath: string, config: Record<string, any>): void {
  addQwenProjectTrust(projectPath, config);
  const settingsPath = getQwenProjectSettingsPath(projectPath);
  const settings = readJsonObject(settingsPath);
  applyQwenTakeover(settings, config);
  writeJsonObject(settingsPath, settings);
}

/**
 * Disable ccr takeover for a project's qwen configuration by removing the
 * ccr-managed fields from its workspace `.qwen/settings.json` (deleting the file
 * when nothing meaningful remains). The global trust entry is left in place.
 */
export function removeQwenProjectTakeover(projectPath: string): void {
  const settingsPath = getQwenProjectSettingsPath(projectPath);
  if (!fs.existsSync(settingsPath)) return;

  const settings = readJsonObject(settingsPath);
  if (!isQwenManaged(settings)) return;

  removeQwenManagedFields(settings);
  // `$version` alone is not meaningful content, so treat it as empty.
  const meaningfulKeys = Object.keys(settings).filter((k) => k !== "$version");
  if (meaningfulKeys.length === 0) {
    fs.unlinkSync(settingsPath);
  } else {
    writeJsonObject(settingsPath, settings);
  }
}

/** Whether a project's `.qwen/settings.json` currently routes qwen through ccr. */
export function isQwenProjectTakeoverActive(projectPath: string): boolean {
  return isQwenManaged(readJsonObject(getQwenProjectSettingsPath(projectPath)));
}

// ========================= opencode (opencode.ai) =========================
//
// opencode keeps its config in a single JSON file (~/.config/opencode/
// opencode.json for the global scope, <project>/opencode.json — merged up to the
// git root — for the project scope). The takeover injects a custom `provider`
// using the Anthropic AI SDK (`@ai-sdk/anthropic`) pointed at the ccr proxy and
// selects it as the default `model`. opencode speaks the Anthropic /v1/messages
// protocol, so no transformer is needed on the ccr side; the api key is inlined
// in the provider's `options`.

const OPENCODE_PROVIDER_ID = "ccr";
const OPENCODE_NPM = "@ai-sdk/anthropic";

function getOpencodeSettingsPath(config: Record<string, any>): string {
  return expandHome(getClientConfig(config, "opencode").configPath);
}

// The @ai-sdk/anthropic SDK appends "/messages" to baseURL, so it must end in
// the ccr "/v1" path (mirroring opencode's own Anthropic provider entries).
function getOpencodeBaseUrl(config: Record<string, any>): string {
  return `${getCcrBaseUrl(config)}/v1`;
}

/**
 * Build the ccr family-alias models opencode should expose
 * (ccr-opus/ccr-sonnet/ccr-haiku). Returns the `models` map plus the
 * "<provider>/<model>" id opencode should default to.
 */
function getOpencodeModels(config: Record<string, any>): { models: Record<string, any>; defaultModel: string } {
  const models: Record<string, any> = {};
  let firstId = "";

  const add = (id: string, label: string) => {
    models[id] = { name: label };
    if (!firstId) firstId = id;
  };

  if (hasFamiliesConfig(config)) {
    const families = config.Router.families;
    for (const family of ["opus", "sonnet", "haiku"].filter((f) => families[f])) {
      const extendedSuffix = hasExtendedContext(families[family]) ? "[1m]" : "";
      add(`ccr-${family}${extendedSuffix}`, `CCR (${family})`);
    }
  }
  if (!firstId) {
    add(getClientConfig(config, "opencode").modelAlias || "ccr-opus", "CCR");
  }

  return { models, defaultModel: `${OPENCODE_PROVIDER_ID}/${firstId}` };
}

function isOpencodeManaged(settings: Record<string, any>): boolean {
  const provider = isObject(settings.provider) ? settings.provider[OPENCODE_PROVIDER_ID] : undefined;
  if (isObject(provider) && isObject(provider.options) && isCcrBaseUrl(provider.options.baseURL)) {
    return true;
  }
  return typeof settings.model === "string" && settings.model.startsWith(`${OPENCODE_PROVIDER_ID}/`);
}

/**
 * Point an opencode config object at ccr: register the ccr Anthropic provider
 * (api key inlined) and select it as the default model. Other settings (the
 * user's own providers, `$schema`, etc.) are preserved.
 */
function applyOpencodeTakeover(settings: Record<string, any>, config: Record<string, any>): void {
  const { models, defaultModel } = getOpencodeModels(config);

  if (!isObject(settings.provider)) settings.provider = {};
  settings.provider[OPENCODE_PROVIDER_ID] = {
    npm: OPENCODE_NPM,
    name: "Claude Code Router",
    options: {
      baseURL: getOpencodeBaseUrl(config),
      apiKey: config.APIKEY || "test",
    },
    models,
  };

  settings.model = defaultModel;
}

/** Remove the ccr-managed fields written by {@link applyOpencodeTakeover}. */
function removeOpencodeManagedFields(settings: Record<string, any>): void {
  if (isObject(settings.provider) && isObject(settings.provider[OPENCODE_PROVIDER_ID])) {
    const provider = settings.provider[OPENCODE_PROVIDER_ID];
    if (isObject(provider.options) && isCcrBaseUrl(provider.options.baseURL)) {
      delete settings.provider[OPENCODE_PROVIDER_ID];
      if (Object.keys(settings.provider).length === 0) delete settings.provider;
    }
  }
  if (typeof settings.model === "string" && settings.model.startsWith(`${OPENCODE_PROVIDER_ID}/`)) {
    delete settings.model;
  }
}

function createOpencodeStatus(config: Record<string, any>, settings?: Record<string, any>, details?: string): ClientStatus {
  const clientConfig = getClientConfig(config, "opencode");
  const filePath = getOpencodeSettingsPath(config);
  const safeSettings = settings || {};

  return {
    id: "opencode",
    name: CLIENT_DEFINITIONS.opencode.name,
    enabled: clientConfig.enabled,
    managed: isOpencodeManaged(safeSettings),
    configPath: clientConfig.configPath,
    exists: fs.existsSync(filePath),
    activeModel: typeof safeSettings.model === "string" ? safeSettings.model : undefined,
    details,
  };
}

const opencodeAdapter: ClientAdapter = {
  status(config) {
    const filePath = getOpencodeSettingsPath(config);
    try {
      return createOpencodeStatus(config, readJsonObject(filePath));
    } catch (error) {
      return createOpencodeStatus(config, {}, errorMessage(error));
    }
  },

  enable(config) {
    const filePath = getOpencodeSettingsPath(config);
    if (!this.status(config).managed) {
      createBackup("opencode", filePath);
    }
    const settings = readJsonObject(filePath);
    applyOpencodeTakeover(settings, config);
    writeJsonObject(filePath, settings);
    return createOpencodeStatus(config, settings);
  },

  disable(config) {
    const filePath = getOpencodeSettingsPath(config);
    if (restoreLatestBackup("opencode", filePath)) {
      return this.status(config);
    }
    if (!fs.existsSync(filePath)) {
      return this.status(config);
    }
    const settings = readJsonObject(filePath);
    removeOpencodeManagedFields(settings);
    writeJsonObject(filePath, settings);
    return createOpencodeStatus(config, settings);
  },

  restore(config) {
    return this.disable(config);
  },
};

/** Path to a project's project-scoped `opencode.json` (merged up to the git root). */
function getOpencodeProjectSettingsPath(projectPath: string): string {
  return path.join(projectPath, "opencode.json");
}

/**
 * Enable ccr takeover for a project's opencode configuration by writing the ccr
 * Anthropic provider/model into the project's `opencode.json`. opencode has no
 * trust gate, so nothing else is needed.
 */
export function applyOpencodeProjectTakeover(projectPath: string, config: Record<string, any>): void {
  const settingsPath = getOpencodeProjectSettingsPath(projectPath);
  const settings = readJsonObject(settingsPath);
  if (typeof settings.$schema !== "string") settings.$schema = "https://opencode.ai/config.json";
  applyOpencodeTakeover(settings, config);
  writeJsonObject(settingsPath, settings);
}

/**
 * Disable ccr takeover for a project's opencode configuration by removing the
 * ccr-managed fields from its `opencode.json` (deleting the file when nothing
 * meaningful remains).
 */
export function removeOpencodeProjectTakeover(projectPath: string): void {
  const settingsPath = getOpencodeProjectSettingsPath(projectPath);
  if (!fs.existsSync(settingsPath)) return;

  const settings = readJsonObject(settingsPath);
  if (!isOpencodeManaged(settings)) return;

  removeOpencodeManagedFields(settings);
  // `$schema` alone is not meaningful content, so treat it as empty.
  const meaningfulKeys = Object.keys(settings).filter((k) => k !== "$schema");
  if (meaningfulKeys.length === 0) {
    fs.unlinkSync(settingsPath);
  } else {
    writeJsonObject(settingsPath, settings);
  }
}

/** Whether a project's `opencode.json` currently routes opencode through ccr. */
export function isOpencodeProjectTakeoverActive(projectPath: string): boolean {
  return isOpencodeManaged(readJsonObject(getOpencodeProjectSettingsPath(projectPath)));
}

/**
 * Clients that support *project-level* ccr takeover (writing a project-scoped
 * config file). Claude Code uses `.claude/settings.local.json`; pi uses
 * `.pi/settings.json`; qwen-code uses `.qwen/settings.json`; opencode uses
 * `opencode.json`. Codex is intentionally excluded — its config
 * (`~/.codex/config.toml`) is global-only, so it can only be taken over from the
 * Clients page, not per project.
 */
export const PROJECT_TAKEOVER_CLIENT_IDS: ClientId[] = ["claudeCode", "pi", "qwenCode", "opencode"];

/** Type guard for {@link PROJECT_TAKEOVER_CLIENT_IDS}. */
export function isProjectTakeoverClient(value: string): value is ClientId {
  return (PROJECT_TAKEOVER_CLIENT_IDS as string[]).includes(value);
}

const CLIENT_ADAPTERS: Record<ClientId, ClientAdapter> = {
  claudeCode: claudeCodeAdapter,
  codex: codexAdapter,
  pi: piAdapter,
  qwenCode: qwenCodeAdapter,
  opencode: opencodeAdapter,
};

export function listClientStatuses(config: Record<string, any>): ClientStatus[] {
  return CLIENT_IDS.map((id) => CLIENT_ADAPTERS[id].status(config));
}

function runClientOperation(
  config: Record<string, any>,
  id: ClientId,
  action: ClientAction,
  options: ClientOperationOptions = {}
): ClientOperationResult {
  const updateEnabled = options.updateEnabled !== false;
  const adapter = CLIENT_ADAPTERS[id];
  const status = adapter[action](config);
  const patch: Partial<ClientConfig> = {
    managed: action === "enable",
    configPath: status.configPath,
  };

  if (status.modelAlias) {
    patch.modelAlias = status.modelAlias;
  }

  if (updateEnabled) {
    patch.enabled = action === "enable";
  } else {
    patch.enabled = getClientConfig(config, id).enabled;
  }

  setClientConfig(config, id, patch);
  const updatedStatus = adapter.status(config);

  return {
    id,
    action,
    success: true,
    status: updatedStatus,
  };
}

export function enableClient(
  config: Record<string, any>,
  id: ClientId,
  options?: ClientOperationOptions
): ClientOperationResult {
  return runClientOperation(config, id, "enable", options);
}

export function disableClient(
  config: Record<string, any>,
  id: ClientId,
  options?: ClientOperationOptions
): ClientOperationResult {
  return runClientOperation(config, id, "disable", options);
}

export function restoreClient(
  config: Record<string, any>,
  id: ClientId,
  options?: ClientOperationOptions
): ClientOperationResult {
  return runClientOperation(config, id, "restore", options);
}

export function applyClientSelection(
  config: Record<string, any>,
  enabledIds: string[]
): ClientApplyResult {
  const selected = new Set(enabledIds);
  const results: ClientOperationResult[] = [];

  for (const id of selected) {
    if (!isClientId(id)) {
      results.push({
        id: id as ClientId,
        action: "enable",
        success: false,
        error: `Unknown client: ${id}`,
      });
    }
  }

  for (const id of CLIENT_IDS) {
    try {
      results.push(
        selected.has(id)
          ? enableClient(config, id, { updateEnabled: true })
          : disableClient(config, id, { updateEnabled: true })
      );
    } catch (error) {
      results.push({
        id,
        action: selected.has(id) ? "enable" : "disable",
        success: false,
        error: errorMessage(error),
      });
    }
  }

  return {
    success: results.every((result) => result.success),
    results,
    clients: listClientStatuses(config),
    config,
  };
}

export function enableConfiguredClients(config: Record<string, any>): ClientApplyResult {
  const results: ClientOperationResult[] = [];

  for (const id of CLIENT_IDS) {
    if (!isClientEnabled(config, id)) continue;

    try {
      results.push(enableClient(config, id, { updateEnabled: false }));
    } catch (error) {
      results.push({
        id,
        action: "enable",
        success: false,
        error: errorMessage(error),
      });
    }
  }

  return {
    success: results.every((result) => result.success),
    results,
    clients: listClientStatuses(config),
    config,
  };
}

export function disableConfiguredClients(config: Record<string, any>): ClientApplyResult {
  const results: ClientOperationResult[] = [];

  for (const id of CLIENT_IDS) {
    if (!isClientEnabled(config, id)) continue;

    try {
      results.push(disableClient(config, id, { updateEnabled: false }));
    } catch (error) {
      results.push({
        id,
        action: "disable",
        success: false,
        error: errorMessage(error),
      });
    }
  }

  return {
    success: results.every((result) => result.success),
    results,
    clients: listClientStatuses(config),
    config,
  };
}
