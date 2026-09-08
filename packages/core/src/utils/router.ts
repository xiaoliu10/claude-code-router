import { get_encoding } from "tiktoken";
import { sessionUsageCache, Usage } from "./cache";
import { readFile } from "fs/promises";
import { opendir, stat } from "fs/promises";
import { join } from "path";
import {
  CLAUDE_PROJECTS_DIR,
  HOME_DIR,
  getClaudeProjectId,
} from "@wengine-ai/claude-code-router-shared";
import { ConfigService } from "../services/config";
import { TokenizerService } from "../services/tokenizer";
import { getHealthStore } from "../services/provider-health";
import { getQuotaResult } from "../services/quota-store";
import { getFallbackPromotionStore } from "./fallback-promotion";
import { normalizeSessionId } from "./session-id";
import { applyClientAdapter, type ClientContext } from "../clients/adapters";

/**
 * Error thrown when a project-level Router is authoritative but the configured
 * target provider/model cannot be resolved (missing, disabled, unhealthy,
 * quota-exhausted). Carries a stable error code and HTTP statusCode so the
 * Fastify errorHandler can surface it directly instead of swallowing it into
 * the generic default-routing fallback.
 */
const PROJECT_ROUTING_STATUS_CODES: Record<string, number> = {
  provider_not_found: 404,
  model_not_found: 404,
  invalid_model_format: 400,
  provider_disabled: 503,
  model_unhealthy: 503,
  quota_exhausted: 503,
  resolution_failed: 502,
  project_config_error: 500,
  invalid_project_id: 400,
  project_config_not_found: 404,
};

export class ProjectRoutingError extends Error {
  statusCode: number;
  code: string;
  type: string;
  sessionId?: string;
  configuredTarget?: string;

  constructor(
    message: string,
    opts?: {
      sessionId?: string;
      configuredTarget?: string;
      code?: string;
      statusCode?: number;
    }
  ) {
    super(message);
    this.name = "ProjectRoutingError";
    this.statusCode = opts?.statusCode || PROJECT_ROUTING_STATUS_CODES[opts?.code || ""] || 502;
    this.code = opts?.code || "project_routing_error";
    this.type = "api_error";
    this.sessionId = opts?.sessionId;
    this.configuredTarget = opts?.configuredTarget;
  }
}

/**
 * Build and throw a ProjectRoutingError for a failed scenario in strict
 * project-routing mode. Includes session id and configured target in the
 * message so users can see what went wrong without inspecting error fields.
 */
function throwStrictProjectError(
  req: any,
  configuredModel: string,
  providers: any[],
  scenarioType: string
): string | never {
  const diagnosis = diagnoseResolutionFailure(configuredModel, providers);

  // A fail-pool hit is NOT a configuration error: the provider and model are
  // both real and configured by the project — the model is just circuit-broken
  // after recent failures. Rejecting with 503 traps the session (CC keeps
  // retrying, the fail-pool never recovers because active probes may also be
  // failing). Instead, honor the project's own configured target and send the
  // request anyway, letting the client see the real upstream error. This does
  // not violate strict project routing — no other model is involved.
  if (diagnosis.code === "model_unhealthy") {
    const lastResort = resolveConfiguredModel(configuredModel, providers, true);
    if (lastResort) {
      req.log.warn(
        `Strict project target ${configuredModel} is in the health fail-pool; retrying it anyway (no fallback available). scenario=${scenarioType}`
      );
      return lastResort;
    }
  }

  const sessionId = req.sessionId || req.clientContext?.stableSessionId;
  const statusCode = PROJECT_ROUTING_STATUS_CODES[diagnosis.code] || 502;
  throw new ProjectRoutingError(
    `Project routing error (${scenarioType}): ${diagnosis.reason}. Project-level Router target: "${configuredModel}". Session: "${sessionId || "unknown"}".`,
    {
      sessionId,
      configuredTarget: configuredModel,
      code: diagnosis.code,
      statusCode,
    }
  );
}

// Types from @anthropic-ai/sdk
interface Tool {
  name: string;
  description?: string;
  input_schema: object;
}

interface ContentBlockParam {
  type: string;
  [key: string]: any;
}

interface MessageParam {
  role: string;
  content: string | ContentBlockParam[];
}

interface MessageCreateParamsBase {
  messages?: MessageParam[];
  system?: string | any[];
  tools?: Tool[];
  [key: string]: any;
}

const enc = get_encoding("cl100k_base");

export const calculateTokenCount = (
  messages: MessageParam[],
  system: any,
  tools: Tool[]
) => {
  let tokenCount = 0;
  if (Array.isArray(messages)) {
    messages.forEach((message) => {
      if (typeof message.content === "string") {
        tokenCount += enc.encode(message.content).length;
      } else if (Array.isArray(message.content)) {
        message.content.forEach((contentPart: any) => {
          if (contentPart.type === "text") {
            tokenCount += enc.encode(contentPart.text).length;
          } else if (contentPart.type === "tool_use") {
            tokenCount += enc.encode(JSON.stringify(contentPart.input)).length;
          } else if (contentPart.type === "tool_result") {
            tokenCount += enc.encode(
              typeof contentPart.content === "string"
                ? contentPart.content
                : JSON.stringify(contentPart.content)
            ).length;
          }
        });
      }
    });
  }
  if (typeof system === "string") {
    tokenCount += enc.encode(system).length;
  } else if (Array.isArray(system)) {
    system.forEach((item: any) => {
      if (item.type !== "text") return;
      if (typeof item.text === "string") {
        tokenCount += enc.encode(item.text).length;
      } else if (Array.isArray(item.text)) {
        item.text.forEach((textPart: any) => {
          tokenCount += enc.encode(textPart || "").length;
        });
      }
    });
  }
  if (tools) {
    tools.forEach((tool: Tool) => {
      if (tool.description) {
        tokenCount += enc.encode(tool.name + tool.description).length;
      }
      if (tool.input_schema) {
        tokenCount += enc.encode(JSON.stringify(tool.input_schema)).length;
      }
    });
  }
  return tokenCount;
};

const getProjectSpecificRouter = async (
  req: any,
  _configService: ConfigService
) => {
  // Session-based discovery remains the Claude Code path. Clients such as Pi
  // that do not send Claude session metadata use a managed provider header.
  const hasExplicitProject = req.clientContext?.projectHeaderPresent === true;
  const explicitProject = req.clientContext?.projectId;
  if (
    hasExplicitProject
    && (
      typeof explicitProject !== "string"
      || explicitProject.length === 0
      || explicitProject.length > 1024
      || explicitProject === "."
      || explicitProject === ".."
      || /[/\\\0]/.test(explicitProject)
    )
  ) {
    throw new ProjectRoutingError(
      `Project routing error: invalid managed project id "${String(explicitProject)}".`,
      {
        configuredTarget: String(explicitProject),
        code: "invalid_project_id",
      }
    );
  }

  const project = hasExplicitProject
    ? explicitProject
    : req.sessionId
      ? await searchProjectBySession(req.sessionId)
      : null;
  if (project) {
    req.projectId = project;
    const projectConfigPath = join(HOME_DIR, project, "config.json");

    // Only session-discovered clients have per-session Router overrides.
    if (!hasExplicitProject && req.sessionId) {
      const sessionConfigPath = join(
        HOME_DIR,
        project,
        `${req.sessionId}.json`
      );
      try {
        const sessionConfig = JSON.parse(await readFile(sessionConfigPath, "utf8"));
        if (sessionConfig && sessionConfig.Router && Object.keys(sessionConfig.Router).length > 0) {
          return sessionConfig.Router;
        }
      } catch {}
    }

    // A managed explicit project id must resolve to the exact stored project.
    // Fail closed instead of silently escaping to the global Router when the
    // provider is stale, malformed, or has been tampered with.
    try {
      const projectConfig = JSON.parse(await readFile(projectConfigPath, "utf8"));
      if (
        hasExplicitProject
        && (
          typeof projectConfig?.projectPath !== "string"
          || getClaudeProjectId(projectConfig.projectPath) !== explicitProject
        )
      ) {
        throw new ProjectRoutingError(
          `Project routing error: managed project id "${explicitProject}" does not match its stored project path.`,
          {
            configuredTarget: projectConfigPath,
            code: "invalid_project_id",
          }
        );
      }
      if (projectConfig && projectConfig.Router && Object.keys(projectConfig.Router).length > 0) {
        return projectConfig.Router;
      }
    } catch (e: any) {
      if (e instanceof ProjectRoutingError) throw e;
      if (hasExplicitProject && e?.code === "ENOENT") {
        throw new ProjectRoutingError(
          `Project routing error: managed project "${explicitProject}" no longer has a project config.`,
          {
            configuredTarget: projectConfigPath,
            code: "project_config_not_found",
          }
        );
      }
      if (!e || e.code !== "ENOENT") {
        const sessionId = req.sessionId || req.clientContext?.stableSessionId;
        throw new ProjectRoutingError(
          `Project routing error: project config.json is malformed or unreadable in project "${project}". ${e.message}. Session: "${sessionId || "unknown"}".`,
          {
            sessionId,
            configuredTarget: projectConfigPath,
            code: "project_config_error",
            statusCode: 500,
          }
        );
      }
    }
  }
  return undefined; // Return undefined to use original configuration
};

function normalizeModelName(modelName: string): string {
  let normalized = modelName || "";
  if (normalized.includes(",")) {
    normalized = normalized.split(",").pop() || normalized;
  }
  if (normalized.includes("/")) {
    normalized = normalized.split("/").pop() || normalized;
  }
  if (normalized.includes(":")) {
    normalized = normalized.split(":")[0];
  }
  return normalized.trim().toLowerCase();
}

export function extractModelFamily(modelName: string): { family: string | null; extended: boolean; isCcrAlias: boolean } {
  const normalized = normalizeModelName(modelName);

  // Check for [1m] suffix for extended context
  const extended = normalized.includes("[1m]") || normalized.endsWith("[1m");
  const cleanModel = normalized.replace(/\[1m\]|\[1m$/g, "");

  // Match ccr-opus, ccr-sonnet, ccr-haiku format (injected by CCR into Claude Code settings)
  const ccrMatch = cleanModel.match(/^ccr-(opus|sonnet|haiku)$/i);
  if (ccrMatch) {
    return { family: ccrMatch[1].toLowerCase(), extended, isCcrAlias: true };
  }

  // Match standard Claude model names: claude-opus-4-20250514, claude-sonnet-4-20250514, etc.
  const claudeMatch = cleanModel.match(
    /claude-(?:\d+-\d+-|\d+-)?(sonnet|opus|haiku)(?:-|$)/i
  ) || cleanModel.match(/claude-(sonnet|opus|haiku)(?:-|$)/i);
  if (claudeMatch) {
    return { family: claudeMatch[1].toLowerCase(), extended, isCcrAlias: false };
  }
  return { family: null, extended, isCcrAlias: false };
}

function lookupModelMapping(
  modelName: string,
  mapping?: Record<string, string>
): string | null {
  if (!mapping || !modelName) return null;

  const normalized = normalizeModelName(modelName);
  if (mapping[modelName]) {
    return mapping[modelName];
  }
  if (mapping[normalized]) {
    return mapping[normalized];
  }

  const { family } = extractModelFamily(modelName);
  if (family && mapping[family]) {
    return mapping[family];
  }

  for (const [key, value] of Object.entries(mapping)) {
    const normalizedKey = normalizeModelName(key);
    if (normalizedKey && normalized.includes(normalizedKey)) {
      return value;
    }
  }

  return null;
}

function getUsageInputTokens(usage?: Usage): number {
  if (!usage) {
    return 0;
  }

  return (usage.input_tokens || 0) +
    (usage.cache_read_input_tokens || 0) +
    (usage.cache_creation_input_tokens || 0);
}

function parseConfiguredRoute(modelName: string): { providerName: string; routeModel: string } | null {
  if (!modelName?.includes(",")) {
    return null;
  }

  const [provider, ...modelParts] = modelName.split(",");
  const providerName = provider.trim();
  const routeModel = modelParts.join(",").trim();

  if (!providerName || !routeModel) {
    return null;
  }

  return { providerName, routeModel };
}

/**
 * Look up a provider and model by name in the current provider list.
 * Returns canonical (case-matched) values or null when the provider is
 * missing, disabled, or the model is not listed under it.
 */
export function findProviderModel(
  providers: any[],
  providerName: string,
  modelName: string
): { provider: any; model: string } | null {
  const provider = providers.find(
    (p: any) => p.name.toLowerCase() === providerName.toLowerCase()
  );
  if (!provider || provider.enabled === false) {
    return null;
  }

  const model = provider.models?.find(
    (m: any) => String(m).toLowerCase() === modelName.toLowerCase()
  );
  if (!model) {
    return null;
  }

  return { provider, model: String(model) };
}

/**
 * Diagnose why a "provider,model" route string fails to resolve.
 * Returns a human-readable reason and a stable error code so the
 * ProjectRoutingError can carry actionable diagnostic info.
 */
export function diagnoseResolutionFailure(
  configuredModel: string,
  providers: any[]
): { reason: string; code: string } {
  const route = parseConfiguredRoute(configuredModel);
  if (!route) {
    return {
      reason: `invalid model format "${configuredModel}" (expected "provider,model")`,
      code: "invalid_model_format",
    };
  }
  const { providerName, routeModel } = route;
  const provider = providers.find(
    (p: any) => p.name?.toLowerCase() === providerName.toLowerCase()
  );
  if (!provider) {
    return {
      reason: `provider "${providerName}" not found`,
      code: "provider_not_found",
    };
  }
  if (provider.enabled === false) {
    return {
      reason: `provider "${providerName}" is disabled`,
      code: "provider_disabled",
    };
  }
  const model = provider.models?.find(
    (m: any) => String(m).toLowerCase() === routeModel.toLowerCase()
  );
  if (!model) {
    return {
      reason: `model "${routeModel}" not found in provider "${providerName}"`,
      code: "model_not_found",
    };
  }
  const healthStore = getHealthStore();
  if (!healthStore.isAvailable(provider.name, String(model))) {
    return {
      reason: `model "${routeModel}" in provider "${providerName}" is temporarily unavailable (health fail-pool)`,
      code: "model_unhealthy",
    };
  }
  const quotaResult = getQuotaResult(provider.name);
  if (quotaResult) {
    const is5hExhausted =
      quotaResult.limitDaily !== undefined &&
      quotaResult.usedDailyBalance !== undefined &&
      quotaResult.usedDailyBalance >= quotaResult.limitDaily;
    const is7dExhausted =
      quotaResult.totalBalance !== undefined &&
      quotaResult.usedBalance !== undefined &&
      quotaResult.usedBalance >= quotaResult.totalBalance;
    if (is5hExhausted || is7dExhausted) {
      return {
        reason: `provider "${providerName}" quota is exhausted`,
        code: "quota_exhausted",
      };
    }
  }
  return {
    reason: `unable to resolve model "${configuredModel}"`,
    code: "resolution_failed",
  };
}

function resolveConfiguredModel(
  modelName: string,
  providers: any[],
  skipHealthCheck?: boolean,
  scenarioType?: string,
  enableFallback?: boolean,
  allowPromotion?: boolean,
  requireRoute?: boolean
): string | null {
  const route = parseConfiguredRoute(modelName);
  if (!route) {
    // A non-"provider,model" string is normally passed through unchanged (a
    // bare model name). In strict project-routing mode a configured target
    // MUST be a valid route — returning it as-is would let a malformed project
    // target (e.g. Router.default = "model-only") escape the project boundary
    // and be silently resolved by global provider routes. Return null so the
    // caller's strict-error path surfaces invalid_model_format instead.
    return requireRoute ? null : modelName;
  }

  const { providerName, routeModel } = route;

  const found = findProviderModel(providers, providerName, routeModel);

  // Provider disabled or missing — skip immediately
  if (!found) {
    // Still need to check fallback promotion even when the primary is stale,
    // because a previously promoted fallback may still be valid.
    // In strict project mode, allowPromotion is false to prevent global
    // promotion entries from routing to models not configured by the project.
    if (enableFallback === true && scenarioType && !skipHealthCheck && allowPromotion !== false) {
      const fallbackPromotion = getFallbackPromotionStore();
      const promoted = fallbackPromotion.getPromotion(providerName, routeModel, scenarioType, providers);
      if (promoted) {
        const promotedRoute = parseConfiguredRoute(promoted);
        if (promotedRoute) {
          const promotedFound = findProviderModel(providers, promotedRoute.providerName, promotedRoute.routeModel);
          if (promotedFound) {
            return `${promotedFound.provider.name},${promotedFound.model}`;
          }
        }
        // Promoted model no longer valid, clear it and proceed normally
        fallbackPromotion.clear(providerName, routeModel, scenarioType);
      }
    }
    return null;
  }

  // Check if there is an active fallback promotion for this primary model
  // If a fallback succeeded globally, use the promoted model instead.
  // In strict project mode, allowPromotion is false to prevent global
  // promotion entries from routing to models not configured by the project.
  if (enableFallback === true && scenarioType && !skipHealthCheck && allowPromotion !== false) {
    const fallbackPromotion = getFallbackPromotionStore();
    const promoted = fallbackPromotion.getPromotion(providerName, routeModel, scenarioType, providers);
    if (promoted) {
      const promotedRoute = parseConfiguredRoute(promoted);
      if (promotedRoute) {
        const promotedFound = findProviderModel(providers, promotedRoute.providerName, promotedRoute.routeModel);
        if (promotedFound) {
          return `${promotedFound.provider.name},${promotedFound.model}`;
        }
      }
      // Promoted model no longer valid, clear it and proceed normally
      fallbackPromotion.clear(providerName, routeModel, scenarioType);
    }
  }

  // Check health status - skip if model is in fail pool
  if (!skipHealthCheck) {
    const healthStore = getHealthStore();
    if (!healthStore.isAvailable(found.provider.name, found.model)) {
      return null; // Model is unavailable, return null to signal skip
    }
  }

  // Check quota status - skip if provider quota is exhausted
  const quotaResult = getQuotaResult(found.provider.name);
  if (quotaResult) {
    const is5hExhausted = quotaResult.limitDaily !== undefined &&
      quotaResult.usedDailyBalance !== undefined &&
      quotaResult.usedDailyBalance >= quotaResult.limitDaily;
    const is7dExhausted = quotaResult.totalBalance !== undefined &&
      quotaResult.usedBalance !== undefined &&
      quotaResult.usedBalance >= quotaResult.totalBalance;

    if (is5hExhausted || is7dExhausted) {
      return null; // Quota exhausted, skip this provider
    }
  }

  return `${found.provider.name},${found.model}`;
}

function resolveScenarioFallbackModel(
  scenarioType: RouterScenarioType,
  providers: any[],
  familyFallback?: Record<string, string[] | undefined>,
  globalFallback?: Record<string, string[] | undefined>,
  family?: string,
  requireRoute?: boolean
): string | null {
  const healthStore = getHealthStore();

  // Iterate through fallback stages: family-specific first, then global
  const fallbackStages = [familyFallback?.[scenarioType], globalFallback?.[scenarioType]];

  for (const fallbackList of fallbackStages) {
    if (!Array.isArray(fallbackList) || fallbackList.length === 0) {
      continue;
    }

    // Queue-based fallback: iterate in configured order, return first available model
    // Models in fail pool (open state) are automatically skipped
    // This ensures consistent fallback selection without rotation
    for (const fallbackModel of fallbackList) {
      const model = resolveConfiguredModel(fallbackModel, providers, false, scenarioType, undefined, undefined, requireRoute);
      if (model) {
        return model;
      }
    }
  }

  return null;
}

function requestHasImages(req: any): boolean {
  return req.body.messages?.some(
    (msg: any) =>
      msg.role === "user" &&
      Array.isArray(msg.content) &&
      msg.content.some(
        (item: any) =>
          item.type === "image" ||
          item.type === "image_url" ||
          (Array.isArray(item?.content) &&
            item.content.some(
              (sub: any) => sub.type === "image" || sub.type === "image_url"
            ))
      )
  );
}

export function modelSupportsImages(modelName: string): boolean {
  const normalized = normalizeModelName(modelName);
  const imageModelPatterns = [
    /claude/i,
    /gemini/i,
    /gpt-4o/i,
    /gpt-4\.1/i,
    /gpt-4-vision/i,
    /qwen.*vl/i,
    /glm-4v/i,
    /grok.*vision/i,
    /pixtral/i,
    /llava/i,
  ];

  return imageModelPatterns.some((pattern) => pattern.test(normalized));
}

interface RouterFamilyConfig {
  default: string;
  background?: string;
  think?: string;
  longContext?: string;
  longContextThreshold?: number;
  extendedContext?: string;
  extendedContextThreshold?: number;
  enableExtendedContext?: boolean; // Whether to append [1m] in managed client settings
  webSearch?: string;
  image?: string;
  fallback?: Record<string, string[]>;
}

export function getEffectiveTokenCount(
  tokenCount: number,
  lastUsage: Usage | undefined,
  clientContext?: ClientContext
): number {
  if (clientContext?.usageScope !== "session") {
    return tokenCount;
  }
  return Math.max(tokenCount, getUsageInputTokens(lastUsage));
}

export function getExtendedContextThreshold(
  clientContext: ClientContext | undefined,
  familyConfig?: RouterFamilyConfig,
  globalExtendedContextThreshold?: number
): number {
  return clientContext?.extendedContextThreshold ??
    familyConfig?.extendedContextThreshold ??
    globalExtendedContextThreshold ??
    200000;
}

function resolveFamilyModel(
  req: any,
  tokenCount: number,
  familyConfig: RouterFamilyConfig,
  providers: any[],
  lastUsage?: Usage,
  modelExtended?: boolean,
  globalFallback?: RouterFallbackConfig,
  enableFallback?: boolean,
  globalLongContextThreshold?: number,
  globalExtendedContextThreshold?: number,
  isStrictProject?: boolean,
  allowPromotion?: boolean
): { model: string; scenarioType: RouterScenarioType; isFallback: boolean } | null {
  const clientContext = req.clientContext as ClientContext | undefined;
  const longContextThreshold = clientContext?.longContextThreshold ??
    familyConfig.longContextThreshold ??
    globalLongContextThreshold ??
    60000;
  const effectiveTokenCount = getEffectiveTokenCount(tokenCount, lastUsage, clientContext);
  const family = req.modelFamily;

  // Extended routing is triggered by the adapter-approved explicit suffix or by
  // the adapter/family/global/default token threshold, in that precedence order.
  const extendedThreshold = getExtendedContextThreshold(
    clientContext,
    familyConfig,
    globalExtendedContextThreshold
  );
  const explicitExtended = clientContext?.supportsExplicitExtendedContext !== false && modelExtended === true;
  const shouldUseExtended = explicitExtended || effectiveTokenCount > extendedThreshold;
  if (shouldUseExtended && familyConfig.extendedContext) {
    const model = resolveConfiguredModel(familyConfig.extendedContext, providers, false, 'extendedContext', enableFallback, allowPromotion, isStrictProject);
    if (model) {
      req.log.info(`Family: using extended context model (1M+), tokens: ${effectiveTokenCount}, estimated: ${tokenCount}, explicit: ${explicitExtended}, threshold: ${extendedThreshold}`);
      return { model, scenarioType: 'extendedContext', isFallback: false };
    }

    const fallbackResult = enableFallback
      ? resolveScenarioFallbackModel('extendedContext', providers, familyConfig.fallback, globalFallback, family, isStrictProject)
      : null;
    if (fallbackResult) {
      req.log.info(`Family: using extended context fallback model (1M+), tokens: ${effectiveTokenCount}, estimated: ${tokenCount}, explicit: ${explicitExtended}, threshold: ${extendedThreshold}`);
      return { model: fallbackResult, scenarioType: 'extendedContext', isFallback: true };
    }

    // Strict project mode: scenario triggered but target unavailable and no
    // project fallback → throw instead of falling through to other scenarios.
    // (model_unhealthy targets are retried as a last resort by
    // throwStrictProjectError itself.)
    if (isStrictProject) {
      const lastResort = throwStrictProjectError(req, familyConfig.extendedContext, providers, 'extendedContext');
      if (lastResort) return { model: lastResort, scenarioType: 'extendedContext', isFallback: false };
    }
    req.log.warn(`Family: extendedContext model unavailable (fail pool), skipping`);
  }

  const tokenCountThreshold = effectiveTokenCount > longContextThreshold;

  if (
    tokenCountThreshold &&
    (familyConfig.longContext || familyConfig.fallback?.longContext?.length || globalFallback?.longContext?.length)
  ) {
    const primary = familyConfig.longContext
      ? resolveConfiguredModel(familyConfig.longContext, providers, false, 'longContext', enableFallback, allowPromotion, isStrictProject)
      : null;
    if (primary) {
      req.log.info(`Family: using long context model, tokens: ${effectiveTokenCount}, estimated: ${tokenCount}`);
      return { model: primary, scenarioType: 'longContext', isFallback: false };
    }

    const fallbackResult = enableFallback
      ? resolveScenarioFallbackModel('longContext', providers, familyConfig.fallback, globalFallback, family, isStrictProject)
      : null;
    if (fallbackResult) {
      req.log.info(`Family: using long context fallback model, tokens: ${effectiveTokenCount}, estimated: ${tokenCount}`);
      return { model: fallbackResult, scenarioType: 'longContext', isFallback: true };
    }

    if (isStrictProject && familyConfig.longContext) {
      const lastResort = throwStrictProjectError(req, familyConfig.longContext, providers, 'longContext');
      if (lastResort) return { model: lastResort, scenarioType: 'longContext', isFallback: false };
    }
    // No healthy longContext model available - fall through to other scenarios
    req.log.warn(`Family: no healthy longContext model available, falling through to other scenarios`);
  }

  if (
    Array.isArray(req.body.tools) &&
    req.body.tools.some((tool: any) => tool.type?.startsWith("web_search")) &&
    familyConfig.webSearch
  ) {
    const model = resolveConfiguredModel(familyConfig.webSearch, providers, false, 'webSearch', enableFallback, allowPromotion, isStrictProject);
    if (model) {
      return { model, scenarioType: 'webSearch', isFallback: false };
    }

    const fallbackResult = enableFallback
      ? resolveScenarioFallbackModel('webSearch', providers, familyConfig.fallback, globalFallback, family, isStrictProject)
      : null;
    if (fallbackResult) {
      req.log.info(`Family: using webSearch fallback model`);
      return { model: fallbackResult, scenarioType: 'webSearch', isFallback: true };
    }

    if (isStrictProject) {
      const lastResort = throwStrictProjectError(req, familyConfig.webSearch, providers, 'webSearch');
      if (lastResort) return { model: lastResort, scenarioType: 'webSearch', isFallback: false };
    }
    req.log.warn(`Family: webSearch model unavailable (fail pool), skipping`);
  }

  if (req.body.thinking?.type === "enabled" && familyConfig.think) {
    const model = resolveConfiguredModel(familyConfig.think, providers, false, 'think', enableFallback, allowPromotion, isStrictProject);
    if (model) {
      return { model, scenarioType: 'think', isFallback: false };
    }

    const fallbackResult = enableFallback
      ? resolveScenarioFallbackModel('think', providers, familyConfig.fallback, globalFallback, family, isStrictProject)
      : null;
    if (fallbackResult) {
      req.log.info(`Family: using think fallback model`);
      return { model: fallbackResult, scenarioType: 'think', isFallback: true };
    }

    if (isStrictProject) {
      const lastResort = throwStrictProjectError(req, familyConfig.think, providers, 'think');
      if (lastResort) return { model: lastResort, scenarioType: 'think', isFallback: false };
    }
    req.log.warn(`Family: think model unavailable (fail pool), skipping`);
  }

  if (familyConfig.default) {
    const model = resolveConfiguredModel(familyConfig.default, providers, false, 'default', enableFallback, allowPromotion, isStrictProject);
    if (model) {
      return { model, scenarioType: 'default', isFallback: false };
    }

    const fallbackResult = enableFallback
      ? resolveScenarioFallbackModel('default', providers, familyConfig.fallback, globalFallback, family, isStrictProject)
      : null;
    if (fallbackResult) {
      req.log.info(`Family: using default fallback model`);
      return { model: fallbackResult, scenarioType: 'default', isFallback: true };
    }

    if (isStrictProject) {
      const lastResort = throwStrictProjectError(req, familyConfig.default, providers, 'default');
      if (lastResort) return { model: lastResort, scenarioType: 'default', isFallback: false };
    }
    req.log.warn(`Family: default model unavailable (fail pool), skipping`);
  }

  return null;
}

const getUseModel = async (
  req: any,
  tokenCount: number,
  configService: ConfigService,
  lastUsage?: Usage | undefined,
  resolvedProjectRouter?: any,
  isStrictProject?: boolean
): Promise<{ model: string | undefined; scenarioType: RouterScenarioType }> => {
  const providers = configService.get<any[]>("providers") || [];
  const Router = resolvedProjectRouter || configService.get("Router");
  const enableFallback = Router?.enableFallback === true;
  // Strict project mode: fallback must come ONLY from the project Router, not
  // the global config fallback. This prevents the project from inheriting
  // global fallback models it never configured.
  const projectFallback = enableFallback
    ? (Router?.fallback as RouterFallbackConfig | undefined)
    : undefined;
  const globalFallback = enableFallback && !isStrictProject
    ? projectFallback || configService.get<RouterFallbackConfig>('fallback')
    : projectFallback;
  // In strict project mode, disable the global fallback promotion store so
  // promotion entries created by global/other-project requests cannot route
  // this project's requests to models it never configured.
  const allowPromotion = !isStrictProject;

  // Subagent model override: parse and strip the <CCR-SUBAGENT-MODEL> tag
  // EARLY so it is never sent to the upstream, even when a later branch
  // (family/modelMapping/extended/longContext) returns early.
  // In non-strict mode the override is still consumed at its original priority
  // position (after longContext, before background). In strict project mode
  // the tag is stripped but the model is never used — routing continues
  // through the project Router's own scenario routing.
  let subagentOverrideModel: string | null = null;
  if (
    req.body?.system?.length > 1 &&
    req.body?.system[1]?.text?.includes("<CCR-SUBAGENT-MODEL>")
  ) {
    const subagentMatch = req.body?.system[1].text.match(
      /<CCR-SUBAGENT-MODEL>(.*?)<\/CCR-SUBAGENT-MODEL>/s
    );
    if (subagentMatch) {
      req.body.system[1].text = req.body.system[1].text.replace(
        `<CCR-SUBAGENT-MODEL>${subagentMatch[1]}</CCR-SUBAGENT-MODEL>`,
        ""
      );
      subagentOverrideModel = subagentMatch[1];
    }
  }

  // Routing precedence: model family first, then explicit "provider,model",
  // then default/scenario routing. Family routing takes priority so an enabled
  // family mapping always wins; only when no family matches do we honor a
  // fully-qualified "provider,model" override from the client. Strict project
  // mode still skips the explicit shortcut below (project Router authoritative).
  //
  // Model family routing: extract opus/sonnet/haiku and use family-specific config
  const { family, extended: modelExtended, isCcrAlias } = extractModelFamily(req.body.model);
  const familyConfig = Router?.families?.[family || ''] as RouterFamilyConfig | undefined;
  if (familyConfig && Router?.enableFamilyRouting) {
    req.log.info(`Using model family routing for: ${family}${modelExtended ? ' (1M)' : ''}`);
    req.modelFamily = family;
    req.familyFallback = familyConfig.fallback;
    const familyResult = resolveFamilyModel(
      req,
      tokenCount,
      familyConfig,
      providers,
      lastUsage,
      modelExtended,
      globalFallback,
      enableFallback,
      Router?.longContextThreshold,
      Router?.extendedContextThreshold,
      isStrictProject,
      allowPromotion
    );
    if (familyResult) {
      return { model: familyResult.model, scenarioType: familyResult.scenarioType };
    }
  }

  // Handle explicit provider,model format (only when family routing did not match).
  // In strict project mode, skip this shortcut — the project Router is
  // authoritative and must decide the target, not the client's explicit override.
  if (req.body.model.includes(",") && !isStrictProject) {
    const model = resolveConfiguredModel(req.body.model, providers, false, 'default', enableFallback, allowPromotion, isStrictProject);
    if (model) {
      return { model, scenarioType: 'default' };
    }
    req.log.warn(`Explicit model ${req.body.model} unavailable (fail pool), trying fallback`);
    const fallbackResult = enableFallback
      ? resolveScenarioFallbackModel('default', providers, undefined, globalFallback, undefined, isStrictProject)
      : null;
    if (fallbackResult) {
      req.log.info(`Using fallback for explicit model: ${fallbackResult}`);
      return { model: fallbackResult, scenarioType: 'default' };
    }
    req.log.warn(`No fallback available for explicit model ${req.body.model}, continuing through routing logic`);
  }

  // ccr-opus/ccr-sonnet/ccr-haiku are aliases CCR injects for family routing.
  // When family routing is disabled, treat them as plain unmapped models so
  // they fall through to scenario-based default routing, rather than being
  // intercepted by a Router.models[alias] entry written during client takeover.
  const mappedModel = isCcrAlias && !Router?.enableFamilyRouting
    ? null
    : lookupModelMapping(req.body.model, Router?.models as Record<string, string> | undefined);
  if (mappedModel) {
    const model = resolveConfiguredModel(mappedModel, providers, false, 'modelMapping', enableFallback, allowPromotion, isStrictProject);
    if (model) {
      req.log.info(`Using mapped model for ${req.body.model}: ${mappedModel}`);
      return { model, scenarioType: 'modelMapping' };
    }
    const fallbackResult = enableFallback
      ? resolveScenarioFallbackModel('modelMapping', providers, undefined, globalFallback, undefined, isStrictProject)
      : null;
    if (fallbackResult) {
      return { model: fallbackResult, scenarioType: 'modelMapping' };
    }
    // Strict: mapped model is a configured target; if it fails + no fallback, throw
    // (model_unhealthy targets are retried as a last resort by
    // throwStrictProjectError itself.)
    if (isStrictProject) {
      const lastResort = throwStrictProjectError(req, mappedModel, providers, 'modelMapping');
      if (lastResort) return { model: lastResort, scenarioType: 'modelMapping' };
    }
    req.log.warn(`Mapped model ${mappedModel} unavailable (fail pool), skipping`);
  }

  const clientContext = req.clientContext as ClientContext | undefined;
  const effectiveTokenCount = getEffectiveTokenCount(tokenCount, lastUsage, clientContext);

  // Check extended context (1M+) first
  const extendedContextThreshold = getExtendedContextThreshold(
    clientContext,
    undefined,
    Router?.extendedContextThreshold
  );
  if (effectiveTokenCount > extendedContextThreshold && Router?.extendedContext) {
    req.log.info(
      `Using extended context (1M) model due to token count: ${effectiveTokenCount}, estimated: ${tokenCount}, threshold: ${extendedContextThreshold}`
    );
    const model = resolveConfiguredModel(Router.extendedContext, providers, false, 'extendedContext', enableFallback, allowPromotion, isStrictProject);
    if (model) {
      return { model, scenarioType: 'extendedContext' };
    }
    req.log.warn(`Extended context model ${Router.extendedContext} unavailable (fail pool), trying fallback`);
    const fallbackResult = enableFallback
      ? resolveScenarioFallbackModel('extendedContext', providers, undefined, globalFallback, undefined, isStrictProject)
      : null;
    if (fallbackResult) {
      return { model: fallbackResult, scenarioType: 'extendedContext' };
    }
    if (isStrictProject) {
      const lastResort = throwStrictProjectError(req, Router.extendedContext, providers, 'extendedContext');
      if (lastResort) return { model: lastResort, scenarioType: 'extendedContext' };
    }
  }

  // if tokenCount is greater than the configured threshold, use the long context model
  const longContextThreshold = clientContext?.longContextThreshold ?? Router?.longContextThreshold ?? 60000;
  const tokenCountThreshold = effectiveTokenCount > longContextThreshold;
  if (tokenCountThreshold && Router?.longContext) {
    req.log.info(
      `Using long context model due to token count: ${effectiveTokenCount}, estimated: ${tokenCount}, threshold: ${longContextThreshold}`
    );
    const model = resolveConfiguredModel(Router.longContext, providers, false, 'longContext', enableFallback, allowPromotion, isStrictProject);
    if (model) {
      return { model, scenarioType: 'longContext' };
    }
    req.log.warn(`Long context model ${Router.longContext} unavailable (fail pool), trying fallback`);
    const fallbackResult = enableFallback
      ? resolveScenarioFallbackModel('longContext', providers, undefined, globalFallback, undefined, isStrictProject)
      : null;
    if (fallbackResult) {
      return { model: fallbackResult, scenarioType: 'longContext' };
    }
    if (isStrictProject) {
      const lastResort = throwStrictProjectError(req, Router.longContext, providers, 'longContext');
      if (lastResort) return { model: lastResort, scenarioType: 'longContext' };
    }
  }

  // Subagent model override (original priority position: after longContext,
  // before background/webSearch/think/default). The tag was already stripped
  // early so it never reaches the upstream. In non-strict mode, consume the
  // override here. In strict project mode, the override is ignored — routing
  // continues through the project Router's own scenario routing.
  if (!isStrictProject && subagentOverrideModel) {
    return { model: subagentOverrideModel, scenarioType: 'default' };
  }
  // Use the background model for any Claude Haiku variant
  if (
    req.body.model?.includes("claude") &&
    req.body.model?.includes("haiku") &&
    Router?.background
  ) {
    req.log.info(`Using background model for ${req.body.model}`);
    const bgModel = resolveConfiguredModel(Router.background, providers, false, 'background', enableFallback, allowPromotion, isStrictProject);
    if (bgModel) {
      return { model: bgModel, scenarioType: 'background' };
    }
    const fallbackResult = enableFallback
      ? resolveScenarioFallbackModel('background', providers, undefined, globalFallback, undefined, isStrictProject)
      : null;
    if (fallbackResult) {
      return { model: fallbackResult, scenarioType: 'background' };
    }
    if (isStrictProject) {
      const lastResort = throwStrictProjectError(req, Router.background, providers, 'background');
      if (lastResort) return { model: lastResort, scenarioType: 'background' };
    }
    req.log.warn(`Background model ${Router.background} unavailable (fail pool), falling through`);
  }
  // The priority of websearch must be higher than thinking.
  if (
    Array.isArray(req.body.tools) &&
    req.body.tools.some((tool: any) => tool.type?.startsWith("web_search")) &&
    Router?.webSearch
  ) {
    const model = resolveConfiguredModel(Router.webSearch, providers, false, 'webSearch', enableFallback, allowPromotion, isStrictProject);
    if (model) {
      return { model, scenarioType: 'webSearch' };
    }
    req.log.warn(`WebSearch model ${Router.webSearch} unavailable (fail pool), trying fallback`);
    const fallbackResult = enableFallback
      ? resolveScenarioFallbackModel('webSearch', providers, undefined, globalFallback, undefined, isStrictProject)
      : null;
    if (fallbackResult) {
      return { model: fallbackResult, scenarioType: 'webSearch' };
    }
    if (isStrictProject) {
      const lastResort = throwStrictProjectError(req, Router.webSearch, providers, 'webSearch');
      if (lastResort) return { model: lastResort, scenarioType: 'webSearch' };
    }
  }
  // if extended thinking is enabled, use the think model
  if (req.body.thinking?.type === "enabled" && Router?.think) {
    req.log.info(`Using think model for ${req.body.thinking}`);
    const model = resolveConfiguredModel(Router.think, providers, false, 'think', enableFallback, allowPromotion, isStrictProject);
    if (model) {
      return { model, scenarioType: 'think' };
    }
    req.log.warn(`Think model ${Router.think} unavailable (fail pool), trying fallback`);
    const fallbackResult = enableFallback
      ? resolveScenarioFallbackModel('think', providers, undefined, globalFallback, undefined, isStrictProject)
      : null;
    if (fallbackResult) {
      return { model: fallbackResult, scenarioType: 'think' };
    }
    if (isStrictProject) {
      const lastResort = throwStrictProjectError(req, Router.think, providers, 'think');
      if (lastResort) return { model: lastResort, scenarioType: 'think' };
    }
  }
  // Default routing with health check
  if (Router?.default) {
    const model = resolveConfiguredModel(Router.default, providers, false, 'default', enableFallback, allowPromotion, isStrictProject);
    if (model) {
      return { model, scenarioType: 'default' };
    }
    req.log.warn(`Default model ${Router.default} unavailable (fail pool), trying fallback`);
    const fallbackResult = enableFallback
      ? resolveScenarioFallbackModel('default', providers, undefined, globalFallback, undefined, isStrictProject)
      : null;
    if (fallbackResult) {
      return { model: fallbackResult, scenarioType: 'default' };
    }
    // Last resort: no fallback (or none available) and the default model is
    // only unavailable due to the fail-pool circuit breaker. Applies to both
    // modes now — in strict mode this only happens when the target resolves
    // (same model, no boundary escape), so the retry honors strict semantics.
    const unhealthyDefault = resolveConfiguredModel(Router.default, providers, true, 'default', enableFallback, allowPromotion, isStrictProject);
    if (unhealthyDefault) {
      req.log.warn(`No fallback available; retrying default model ${Router.default} despite fail-pool state (strict=${isStrictProject})`);
      return { model: unhealthyDefault, scenarioType: 'default' };
    }
  }
  // Strict project routing: the project Router is authoritative. If no model
  // could be resolved after exhausting all configured scenarios, surface a
  // clear error instead of returning undefined. (model_unhealthy targets are
  // retried as a last resort by throwStrictProjectError itself.)
  if (isStrictProject) {
    const lastResort = throwStrictProjectError(req, Router?.default || req.body.model, providers, 'default');
    if (lastResort) return { model: lastResort, scenarioType: 'default' };
  }
  return { model: undefined, scenarioType: 'default' };
};

export interface RouterContext {
  configService: ConfigService;
  tokenizerService?: TokenizerService;
  event?: any;
}

export type RouterScenarioType = 'default' | 'background' | 'think' | 'longContext' | 'extendedContext' | 'webSearch' | 'modelMapping' | 'image';

export interface RouterFallbackConfig {
  [key: string]: string[] | undefined;
  default?: string[];
  background?: string[];
  think?: string[];
  longContext?: string[];
  extendedContext?: string[];
  webSearch?: string[];
  modelMapping?: string[];
  image?: string[];
}

export const router = async (req: any, _res: any, context: RouterContext) => {
  const { configService, event } = context;
  // Preserve the model captured before any agent/router mutation so usage
  // records always reflect what the client actually sent.
  if (!req.originalModel && req.body.model) req.originalModel = req.body.model;

  // The adapter must run before project routing and token-threshold decisions so
  // all downstream logic consumes one client-specific request context.
  if (!req.clientContext || !req.usageCacheKey || !req.usageSessionId) {
    applyClientAdapter(req, configService.getAll());
  }
  const projectSpecificRouter = await getProjectSpecificRouter(req, configService);
  const routerConfig = projectSpecificRouter || configService.get("Router");
  const enableFallback = routerConfig?.enableFallback === true;
  const providers = configService.get<any[]>("providers") || [];

  // Expose the resolved (project-aware) fallback settings on req so that
  // handleFallback() in routes.ts honors the same enableFallback flag and
  // fallback chain that the routing decision above used, instead of
  // re-reading the global config and ignoring project-level overrides.
  // Strict project mode: fallback must come ONLY from the project Router.
  const isStrictProject = !!projectSpecificRouter;
  req.enableFallback = enableFallback;
  req.strictProjectRouting = isStrictProject;
  req.fallbackConfig = isStrictProject
    ? (routerConfig?.fallback as RouterFallbackConfig | undefined)
    : (routerConfig?.fallback as RouterFallbackConfig | undefined) || configService.get<RouterFallbackConfig>('fallback');
  const lastMessageUsage = req.clientContext?.usageScope === "session"
    ? req.previousUsage ?? sessionUsageCache.get(req.usageCacheKey)
    : undefined;
  const { messages, system = [], tools }: MessageCreateParamsBase = req.body;
  const rewritePrompt = configService.get("REWRITE_SYSTEM_PROMPT");
  if (
    rewritePrompt &&
    system.length > 1 &&
    system[1]?.text?.includes("<env>")
  ) {
    const prompt = await readFile(rewritePrompt, "utf-8");
    system[1].text = `${prompt}<env>${system[1].text.split("<env>").pop()}`;
  }

  try {
    // Try to get tokenizer config for the current model
    const [providerName, modelName] = req.body.model.split(",");
    const tokenizerConfig = context.tokenizerService?.getTokenizerConfigForModel(
      providerName,
      modelName
    );

    // Use TokenizerService if available, otherwise fall back to legacy method
    let tokenCount: number;

    if (context.tokenizerService) {
      const result = await context.tokenizerService.countTokens(
        {
          messages: messages as MessageParam[],
          system,
          tools: tools as Tool[],
        },
        tokenizerConfig,
        providerName
      );
      tokenCount = result.tokenCount;
    } else {
      // Legacy fallback
      tokenCount = calculateTokenCount(
        messages as MessageParam[],
        system,
        tools as Tool[]
      );
    }

    req.tokenCount = tokenCount;

    let model;
    // In strict project mode, skip the global custom router — the project
    // Router is authoritative. Non-project mode preserves existing behavior.
    const customRouterPath = !isStrictProject ? configService.get("CUSTOM_ROUTER_PATH") : undefined;
    if (customRouterPath) {
      try {
        const customRouter = require(customRouterPath);
        model = await customRouter(req, configService.getAll(), {
          event,
        });
      } catch (e: any) {
        req.log.error(`failed to load custom router: ${e.message}`);
      }
    }
    if (!model) {
      const result = await getUseModel(req, tokenCount, configService, lastMessageUsage, projectSpecificRouter, !!projectSpecificRouter);
      model = result.model;
      req.scenarioType = result.scenarioType;
    } else {
      // Custom router doesn't provide scenario type, default to 'default'
      req.scenarioType = 'default';
    }

    const { family: originalFamily } = extractModelFamily(
      req.originalModel || req.body.model
    );
    const imageFamilyConfig = routerConfig?.enableFamilyRouting && originalFamily
      ? routerConfig.families?.[originalFamily] as RouterFamilyConfig | undefined
      : undefined;
    const configuredImageModels = [
      imageFamilyConfig?.image,
      routerConfig?.image,
    ].filter((value, index, values): value is string =>
      !!value && values.indexOf(value) === index
    );

    if (
      configuredImageModels.length > 0 &&
      requestHasImages(req) &&
      !modelSupportsImages(model)
    ) {
      // If the resolved model is already one of the configured image targets
      // (family image or global image), it must already support images by the
      // outer guard's intent — only tag the scenario, never re-route. This
      // preserves an explicit route to the global image when both family and
      // global image models are configured.
      if (configuredImageModels.includes(model)) {
        req.scenarioType = 'image';
      } else {
        const imageModel = configuredImageModels
          .map((candidate) => resolveConfiguredModel(candidate, providers, false, 'image', enableFallback, !isStrictProject, isStrictProject))
          .find((candidate): candidate is string => !!candidate);
        if (imageModel) {
          req.log.info(`Using image model fallback for ${model}`);
          model = imageModel;
          req.scenarioType = 'image';
        } else {
          // Try project-aware family fallback first, then the global image fallback.
          const imageFallback = enableFallback
            ? resolveScenarioFallbackModel(
                'image',
                providers,
                imageFamilyConfig?.fallback,
                req.fallbackConfig,
                originalFamily || undefined,
                isStrictProject
              )
            : null;
          if (imageFallback) {
            req.log.info(`Using image fallback model: ${imageFallback}`);
            model = imageFallback;
            req.scenarioType = 'image';
          } else if (isStrictProject) {
            const lastResort = throwStrictProjectError(req, configuredImageModels[0], providers, 'image');
            if (lastResort) {
              model = lastResort;
              req.scenarioType = 'image';
            }
          } else {
            req.log.warn(`Image models ${configuredImageModels.join(', ')} unavailable (fail pool), keeping ${model}`);
            req.scenarioType = 'image';
          }
        }
      }
    }

    if (typeof model === "string" && model.trim()) {
      req.body.model = model;
    } else {
      req.log.warn(`Router could not resolve a valid model for ${req.originalModel || req.body.model}; keeping original request model`);
      req.scenarioType = req.scenarioType || 'default';
    }
  } catch (error: any) {
    // Project routing errors must propagate so the Fastify errorHandler can
    // surface them. They must NOT be swallowed into the default fallback.
    if (error instanceof ProjectRoutingError) {
      throw error;
    }
    req.log.error(`Error in router middleware: ${error.message}`);
    // In strict project mode, any non-project-routing error must also surface
    // instead of silently falling back to an unvalidated default model.
    if (isStrictProject) {
      const sessionId = req.sessionId || req.clientContext?.stableSessionId;
      throw new ProjectRoutingError(
        `Project routing error: router failure in project mode. ${error.message}. Session: "${sessionId || "unknown"}".`,
        {
          sessionId,
          configuredTarget: routerConfig?.default,
          code: "project_router_failure",
          statusCode: 502,
        }
      );
    }
    req.body.model = routerConfig?.default;
    req.scenarioType = 'default';
  }
  return;
};

// Memory cache for sessionId to project name mapping.
// Only positive results are cached because Claude Code may create the
// <sessionId>.jsonl file after the first routed request.
// Uses Map instead of lru-cache to avoid esbuild bundling issues.
const sessionProjectCache = new Map<string, string>();
const SESSION_CACHE_MAX = 1000;

// Sessions for which the one-shot retry window has already been spent on a
// cache miss. This prevents re-paying the retry delay on every request of a
// genuinely un-managed session, while still giving a brand-new session's very
// first request enough time for Claude Code to flush its transcript to disk.
const sessionRetryAttempted = new Set<string>();
const SESSION_RETRY_ATTEMPTED_MAX = 1000;

// On a cache miss, retry the project lookup a few times with a short delay so
// the first request of a new session can still resolve its project once Claude
// Code creates the session transcript (.jsonl) file (~tens of ms later).
const SESSION_LOOKUP_RETRY_COUNT = 3;
const SESSION_LOOKUP_RETRY_DELAY_MS = 50;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function trimCache(): void {
  if (sessionProjectCache.size <= SESSION_CACHE_MAX) return;
  const keysToDelete = [...sessionProjectCache.keys()].slice(0, sessionProjectCache.size - SESSION_CACHE_MAX);
  for (const key of keysToDelete) {
    sessionProjectCache.delete(key);
  }
}

function trimRetryAttempted(): void {
  if (sessionRetryAttempted.size <= SESSION_RETRY_ATTEMPTED_MAX) return;
  const keysToDelete = [...sessionRetryAttempted].slice(0, sessionRetryAttempted.size - SESSION_RETRY_ATTEMPTED_MAX);
  for (const key of keysToDelete) {
    sessionRetryAttempted.delete(key);
  }
}

// Scan all Claude project folders for a `${sessionId}.jsonl` transcript and
// return the owning folder name, or null if none exists yet.
const scanProjectFoldersForSession = async (
  safeSessionId: string
): Promise<string | null> => {
  const dir = await opendir(CLAUDE_PROJECTS_DIR);
  const folderNames: string[] = [];

  // Collect all folder names
  for await (const dirent of dir) {
    if (dirent.isDirectory()) {
      folderNames.push(dirent.name);
    }
  }

  // Concurrently check each project folder for sessionId.jsonl file
  const checkPromises = folderNames.map(async (folderName) => {
    const sessionFilePath = join(
      CLAUDE_PROJECTS_DIR,
      folderName,
      `${safeSessionId}.jsonl`
    );
    try {
      const fileStat = await stat(sessionFilePath);
      return fileStat.isFile() ? folderName : null;
    } catch {
      // File does not exist, continue checking next
      return null;
    }
  });

  const results = await Promise.all(checkPromises);

  // Return the first existing project directory name
  for (const result of results) {
    if (result) {
      return result;
    }
  }

  return null;
};

export const searchProjectBySession = async (
  sessionId: string
): Promise<string | null> => {
  const safeSessionId = normalizeSessionId(sessionId);
  if (!safeSessionId) {
    return null;
  }

  // Check cache first
  if (sessionProjectCache.has(safeSessionId)) {
    return sessionProjectCache.get(safeSessionId) || null;
  }

  try {
    let result = await scanProjectFoldersForSession(safeSessionId);

    // Cache miss: the very first request of a brand-new session (e.g. Claude
    // Code's title-generation meta request) can arrive before the session
    // transcript has been flushed to disk, which would otherwise make this one
    // request fall back to the global Router and bypass project-level routing.
    // Retry the lookup briefly so the file has a chance to appear. Only do this
    // once per session so un-managed sessions don't pay the delay repeatedly.
    if (!result && !sessionRetryAttempted.has(safeSessionId)) {
      sessionRetryAttempted.add(safeSessionId);
      trimRetryAttempted();
      for (let i = 0; i < SESSION_LOOKUP_RETRY_COUNT && !result; i++) {
        await sleep(SESSION_LOOKUP_RETRY_DELAY_MS);
        result = await scanProjectFoldersForSession(safeSessionId);
      }
    }

    if (result) {
      // Cache only successful matches; never cache a miss so a later request
      // can still resolve the project once the transcript exists.
      sessionProjectCache.set(safeSessionId, result);
      trimCache();
      return result;
    }

    return null; // No matching project found
  } catch (error) {
    console.error("Error searching for project by session:", error);
    return null;
  }
};
