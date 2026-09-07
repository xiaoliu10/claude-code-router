import { randomUUID } from "node:crypto";
import { CCR_PROJECT_HEADER } from "@wengine-ai/claude-code-router-shared";
import { extractSessionIdFromUserId } from "../utils/session-id";

export const CLIENT_TYPES = [
  "claude-code",
  "pi",
  "qwen-code",
  "opencode",
  "codex",
  "api",
  "unknown",
] as const;

export type ClientType = (typeof CLIENT_TYPES)[number];
export type ClientUsageScope = "session" | "request";

export interface ClientContext {
  clientType: ClientType;
  usageScope: ClientUsageScope;
  stableSessionId?: string;
  projectId?: string;
  supportsExplicitExtendedContext: boolean;
  longContextThreshold?: number;
  extendedContextThreshold?: number;
}

export interface ClientAdapter {
  type: ClientType;
  createContext(req: any, config: Record<string, any>): ClientContext;
}

function isObject(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function firstSystemHead(system: unknown): string {
  if (typeof system === "string") return system.slice(0, 1000);
  if (Array.isArray(system)) {
    const first = system.find((block: any) => block && typeof block.text === "string");
    return first ? String(first.text).slice(0, 1000) : "";
  }
  return "";
}

function getPathname(req: any): string {
  if (typeof req?.pathname === "string") return req.pathname;
  if (typeof req?.url !== "string") return "";
  try {
    return new URL(req.url, "http://127.0.0.1").pathname;
  } catch {
    return req.url;
  }
}

function getHeader(req: any, name: string): string | undefined {
  const value = req?.headers?.[name.toLowerCase()];
  if (typeof value === "string" && value.trim()) return value.trim();
  if (Array.isArray(value) && typeof value[0] === "string" && value[0].trim()) {
    return value[0].trim();
  }
  return undefined;
}

function requestScopeContext(
  clientType: ClientType,
  supportsExplicitExtendedContext = true
): ClientContext {
  return {
    clientType,
    usageScope: "request",
    supportsExplicitExtendedContext,
  };
}

function metadataSessionContext(
  req: any,
  clientType: ClientType,
  supportsExplicitExtendedContext = true
): ClientContext {
  const stableSessionId = extractSessionIdFromUserId(req?.body?.metadata?.user_id);
  return {
    clientType,
    usageScope: stableSessionId ? "session" : "request",
    stableSessionId,
    supportsExplicitExtendedContext,
  };
}

const claudeCodeAdapter: ClientAdapter = {
  type: "claude-code",
  createContext(req) {
    return metadataSessionContext(req, "claude-code");
  },
};

const piAdapter: ClientAdapter = {
  type: "pi",
  createContext(req) {
    // pi no longer derives extendedContextThreshold from a per-client ratio of
    // its own context window. Like every other client it inherits the absolute
    // threshold chain: familyConfig.extendedContextThreshold ->
    // Router.extendedContextThreshold -> 200000. The threshold represents the
    // default target model's usable window (which other models may not support),
    // not pi's own client window, so a uniform absolute value is correct.
    return {
      ...requestScopeContext("pi", false),
      projectId: getHeader(req, CCR_PROJECT_HEADER),
    };
  },
};

const qwenCodeAdapter: ClientAdapter = {
  type: "qwen-code",
  createContext(req) {
    return metadataSessionContext(req, "qwen-code");
  },
};

const opencodeAdapter: ClientAdapter = {
  type: "opencode",
  createContext() {
    return requestScopeContext("opencode");
  },
};

const codexAdapter: ClientAdapter = {
  type: "codex",
  createContext() {
    return requestScopeContext("codex");
  },
};

const apiAdapter: ClientAdapter = {
  type: "api",
  createContext() {
    return requestScopeContext("api");
  },
};

const unknownAdapter: ClientAdapter = {
  type: "unknown",
  createContext() {
    return requestScopeContext("unknown");
  },
};

export const builtinClientAdapterRegistry: Readonly<Record<ClientType, ClientAdapter>> = {
  "claude-code": claudeCodeAdapter,
  pi: piAdapter,
  "qwen-code": qwenCodeAdapter,
  opencode: opencodeAdapter,
  codex: codexAdapter,
  api: apiAdapter,
  unknown: unknownAdapter,
};

export function isClientType(value: unknown): value is ClientType {
  return typeof value === "string" && (CLIENT_TYPES as readonly string[]).includes(value);
}

export function detectClientType(req: any): ClientType {
  if (isClientType(req?.clientType)) return req.clientType;

  const pathname = getPathname(req);
  const headers = req?.headers || {};
  const userAgent = typeof headers["user-agent"] === "string" ? headers["user-agent"] : "";
  const body = req?.body || {};

  // Keep this order aligned with the legacy server detector. System identities
  // must win because pi and qwen-code can share or impersonate Claude Code signals.
  const sysHead = firstSystemHead(body.system);
  if (/\bYou are Qwen Code\b/i.test(sysHead) || /Qwen Code, an interactive CLI agent/i.test(sysHead)) {
    return "qwen-code";
  }
  if (/operating inside pi\b/i.test(sysHead) || /a coding agent harness/i.test(sysHead)) {
    return "pi";
  }
  if (/\bYou are opencode\b/i.test(sysHead)) {
    return "opencode";
  }
  if (getHeader(req, CCR_PROJECT_HEADER)) return "pi";

  const billingHeader = headers["x-anthropic-billing-header"];
  if (typeof billingHeader === "string" && billingHeader.includes("cc_version=")) {
    return "claude-code";
  }
  // Codex strong signals must precede the generic metadata.user_id heuristic:
  // a /v1/responses request can carry an OpenAI-style metadata.user_id and
  // would otherwise be misclassified as claude-code, skipping Responses
  // protocol handling and mislabeling usage/client attribution.
  if (userAgent.includes("codex") || userAgent.includes("Codex")) return "codex";
  if (pathname.endsWith("/v1/responses")) return "codex";

  if (body.metadata && typeof body.metadata === "object" && typeof body.metadata.user_id === "string") {
    return "claude-code";
  }

  if (userAgent.includes("opencode")) return "opencode";
  if (userAgent.includes("pi-coding-agent")) return "pi";
  if (userAgent.includes("QwenCode")) return "qwen-code";

  const originalModel = req?.originalModel || body.model || "";
  if (/^ccr-(opus|sonnet|haiku)(\[1m\])?$/i.test(originalModel)) {
    if (userAgent.includes("Anthropic/")) return "pi";
    if (userAgent.includes("claude-cli") || userAgent.includes("Claude-CLI")) return "qwen-code";
    if (typeof headers["x-stainless-package-version"] === "string") return "pi";
    return "claude-code";
  }

  if (userAgent.includes("claude-cli") || userAgent.includes("Claude-CLI")) return "claude-code";
  if (String(originalModel).toLowerCase() === "ccr-codex") return "codex";
  if (pathname.endsWith("/v1/messages")) return "api";
  return "unknown";
}

export function getClientAdapter(clientType: ClientType): ClientAdapter {
  return builtinClientAdapterRegistry[clientType];
}

function requestScopeId(req: any): string {
  if (typeof req?.__ccrRequestScopeId === "string" && req.__ccrRequestScopeId) {
    return req.__ccrRequestScopeId;
  }

  const id =
    (typeof req?.id === "string" && req.id) ||
    randomUUID();
  req.__ccrRequestScopeId = id;
  return id;
}

export function applyClientAdapter(
  req: any,
  config: Record<string, any> = {}
): ClientContext {
  const clientType = detectClientType(req);
  const context = getClientAdapter(clientType).createContext(req, config);
  const usageSessionId = context.stableSessionId || requestScopeId(req);
  const scopeLabel = context.usageScope === "session" ? "session" : "request";

  req.clientType = clientType;
  req.clientContext = context;
  if (context.stableSessionId) {
    req.sessionId = context.stableSessionId;
  } else {
    delete req.sessionId;
  }
  if (context.projectId) {
    req.projectId = context.projectId;
    // The project id is router-internal metadata. Keep it on the request
    // context, but never let passthrough providers forward it upstream.
    if (req.headers && typeof req.headers === "object") {
      for (const key of Object.keys(req.headers)) {
        if (key.toLowerCase() === CCR_PROJECT_HEADER) delete req.headers[key];
      }
    }
  } else {
    delete req.projectId;
  }
  req.usageSessionId = usageSessionId;
  req.usageCacheKey = `${clientType}:${scopeLabel}:${usageSessionId}`;
  return context;
}

export function clearClientAdapterCaches(): void {
  // No per-client caches remain after the pi extendedContextRatio removal.
  // Kept as a no-op so server lifecycle callers (onClose) stay compatible.
}
