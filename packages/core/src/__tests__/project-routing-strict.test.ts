import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CCR_PROJECT_HEADER,
  getClaudeProjectId,
} from "@wengine-ai/claude-code-router-shared";

// --- Mocks must run before importing the module under test ---

// Track promotion calls so we can verify strict project requests don't promote.
const mockPromotionGet = vi.fn<(provider: string, model: string, scenario: string, providers: any[]) => string | null>(() => null);
const mockPromotionClear = vi.fn();
const mockPromotionPromote = vi.fn();

// Health store availability is controllable per-test: by default everything is
// available; tests for fail-pool behavior flip specific keys to false.
const mockHealthUnavailable = new Set<string>();
function setHealthUnavailable(provider: string, model: string, unavailable: boolean) {
  const key = `${provider},${model}`;
  if (unavailable) mockHealthUnavailable.add(key);
  else mockHealthUnavailable.delete(key);
}

vi.mock("../services/provider-health", () => ({
  getHealthStore: () => ({
    isAvailable: (provider: string, model: string) =>
      !mockHealthUnavailable.has(`${provider},${model}`),
    recordSuccess: vi.fn(),
    recordFailure: vi.fn(),
    markRateLimited: vi.fn(),
    forceOpen: vi.fn(),
  }),
}));

vi.mock("../services/quota-store", () => ({
  getQuotaResult: () => undefined,
}));

vi.mock("../utils/fallback-promotion", () => ({
  getFallbackPromotionStore: () => ({
    getPromotion: mockPromotionGet,
    clear: mockPromotionClear,
    promote: mockPromotionPromote,
  }),
}));

// Mock fs/promises so we can control project Router resolution without touching
// the real ~/.claude directory. vi.hoisted ensures the variables are available
// when vi.mock's hoisted factory runs.
const { mockReadFile, mockOpendir, mockStat } = vi.hoisted(() => ({
  mockReadFile: vi.fn(),
  mockOpendir: vi.fn(),
  mockStat: vi.fn(),
}));
vi.mock("fs/promises", () => ({
  readFile: mockReadFile,
  opendir: mockOpendir,
  stat: mockStat,
}));

import { ConfigService } from "../services/config";
import { applyClientAdapter } from "../clients/adapters";
import {
  router,
  ProjectRoutingError,
  diagnoseResolutionFailure,
} from "../utils/router";
import Server from "../server";

const log = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

/**
 * Configure the fs mocks so that a project folder is found for the given
 * session id, and the project config contains the provided Router object.
 */
function setupProjectRouter(sessionId: string, projectRouter: Record<string, any> | null) {
  mockOpendir.mockResolvedValue({
    async *[Symbol.asyncIterator]() {
      yield { isDirectory: () => true, name: "test-project-123" };
    },
  });
  mockStat.mockResolvedValue({ isFile: () => true });
  mockReadFile.mockImplementation(async (path: string) => {
    if (typeof path === "string" && path.includes("config.json")) {
      return JSON.stringify({ Router: projectRouter });
    }
    if (typeof path === "string" && path.endsWith(`${sessionId}.json`)) {
      return JSON.stringify({});
    }
    return JSON.stringify({});
  });
}

/**
 * Configure project config.json to return malformed JSON.
 */
function setupMalformedProjectConfig(sessionId: string) {
  mockOpendir.mockResolvedValue({
    async *[Symbol.asyncIterator]() {
      yield { isDirectory: () => true, name: "test-project-123" };
    },
  });
  mockStat.mockResolvedValue({ isFile: () => true });
  mockReadFile.mockImplementation(async (path: string) => {
    if (typeof path === "string" && path.includes("config.json")) {
      return "{ invalid json !!!";
    }
    if (typeof path === "string" && path.endsWith(`${sessionId}.json`)) {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    }
    return JSON.stringify({});
  });
}

function setupNoProject() {
  mockOpendir.mockResolvedValue({
    async *[Symbol.asyncIterator]() {
      // No folders
    },
  });
  mockStat.mockRejectedValue(new Error("ENOENT"));
  mockReadFile.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
}

function setupExplicitProjectRouter(projectPath: string, projectRouter: Record<string, any>) {
  const projectId = getClaudeProjectId(projectPath);
  mockOpendir.mockRejectedValue(new Error("session discovery must not run"));
  mockReadFile.mockImplementation(async (filePath: string) => {
    if (typeof filePath === "string" && filePath.endsWith(`${projectId}/config.json`)) {
      return JSON.stringify({ projectPath, Router: projectRouter });
    }
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  });
  return projectId;
}

function makeRequest(sessionId: string, model = "ccr-opus"): any {
  return {
    id: `req-${sessionId}`,
    url: "/v1/messages",
    headers: {},
    log,
    body: {
      model,
      messages: [{ role: "user", content: "hello" }],
      system: [],
      tools: [],
      metadata: { user_id: `user_abc_session_${sessionId}` },
    },
  };
}

function makeConfig(providers: any[], routerConfig: Record<string, any> = {}): ConfigService {
  return new ConfigService({
    useJsonFile: false,
    initialConfig: {
      providers,
      Router: routerConfig,
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPromotionGet.mockReturnValue(null);
  mockPromotionPromote.mockClear();
  mockHealthUnavailable.clear();
});

describe("Pi managed project routing", () => {
  it("loads the explicit project Router without a Claude session transcript", async () => {
    const projectPath = "/Users/test/projects/pi-app";
    const projectId = setupExplicitProjectRouter(projectPath, {
      default: "project-provider,project-model",
      enableFallback: false,
      enableFamilyRouting: false,
    });
    const config = makeConfig(
      [{ name: "global-provider", enabled: true, models: ["global-model"] },
       { name: "project-provider", enabled: true, models: ["project-model"] }],
      { default: "global-provider,global-model", enableFamilyRouting: false },
    );
    const req = {
      id: "pi-project-request",
      url: "/v1/messages",
      headers: { [CCR_PROJECT_HEADER]: projectId },
      log,
      body: {
        model: "ccr-opus",
        messages: [{ role: "user", content: "hello" }],
        system: "You are operating inside pi",
        tools: [],
      },
    };

    // Match the real request pipeline: the adapter consumes and strips the
    // internal header before the router phase runs.
    applyClientAdapter(req, config.getAll());
    expect(req.headers[CCR_PROJECT_HEADER]).toBeUndefined();
    await router(req, undefined, { configService: config });

    expect(req.body.model).toBe("project-provider,project-model");
    expect(req.strictProjectRouting).toBe(true);
    expect(req.projectId).toBe(projectId);
    expect(mockOpendir).not.toHaveBeenCalled();
  });

  it("rejects a traversal project id instead of escaping to the global Router", async () => {
    const config = makeConfig(
      [{ name: "global-provider", enabled: true, models: ["global-model"] }],
      { default: "global-provider,global-model", enableFamilyRouting: false },
    );
    const req = {
      id: "pi-invalid-project",
      url: "/v1/messages",
      headers: { [CCR_PROJECT_HEADER]: "../../config" },
      log,
      body: {
        model: "ccr-opus",
        messages: [{ role: "user", content: "hello" }],
        system: "You are operating inside pi",
        tools: [],
      },
    };

    await expect(router(req, undefined, { configService: config })).rejects.toMatchObject({
      code: "invalid_project_id",
      statusCode: 400,
    });
    expect(mockReadFile).not.toHaveBeenCalled();
  });

  it("fails closed when a managed project provider points to a deleted config", async () => {
    mockReadFile.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    const config = makeConfig(
      [{ name: "global-provider", enabled: true, models: ["global-model"] }],
      { default: "global-provider,global-model", enableFamilyRouting: false },
    );
    const req = {
      id: "pi-missing-project",
      url: "/v1/messages",
      headers: { [CCR_PROJECT_HEADER]: "-Users-test-missing" },
      log,
      body: {
        model: "ccr-opus",
        messages: [{ role: "user", content: "hello" }],
        system: "You are operating inside pi",
        tools: [],
      },
    };

    await expect(router(req, undefined, { configService: config })).rejects.toMatchObject({
      code: "project_config_not_found",
      statusCode: 404,
    });
  });

  it("fails closed when the stored path does not match the managed project id", async () => {
    const requestedPath = "/Users/test/projects/requested";
    const projectId = getClaudeProjectId(requestedPath);
    mockReadFile.mockResolvedValue(JSON.stringify({
      projectPath: "/Users/test/projects/different",
      Router: { default: "project-provider,project-model" },
    }));
    const config = makeConfig(
      [{ name: "project-provider", enabled: true, models: ["project-model"] }],
      { default: "global-provider,global-model", enableFamilyRouting: false },
    );
    const req = {
      id: "pi-mismatched-project",
      url: "/v1/messages",
      headers: { [CCR_PROJECT_HEADER]: projectId },
      log,
      body: {
        model: "ccr-opus",
        messages: [{ role: "user", content: "hello" }],
        system: "You are operating inside pi",
        tools: [],
      },
    };

    await expect(router(req, undefined, { configService: config })).rejects.toMatchObject({
      code: "invalid_project_id",
      statusCode: 400,
    });
    expect(mockOpendir).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// diagnoseResolutionFailure
// ---------------------------------------------------------------------------

describe("diagnoseResolutionFailure", () => {
  const providers = [
    { name: "Active", enabled: true, models: ["model-a"] },
    { name: "Disabled", enabled: false, models: ["model-b"] },
  ];

  it("reports provider_not_found when the provider does not exist", () => {
    const d = diagnoseResolutionFailure("nonexistent,model-x", providers);
    expect(d.code).toBe("provider_not_found");
    expect(d.reason).toContain("not found");
  });

  it("reports provider_disabled when the provider is disabled", () => {
    const d = diagnoseResolutionFailure("Disabled,model-b", providers);
    expect(d.code).toBe("provider_disabled");
    expect(d.reason).toContain("disabled");
  });

  it("reports model_not_found when the model is missing", () => {
    const d = diagnoseResolutionFailure("Active,model-z", providers);
    expect(d.code).toBe("model_not_found");
    expect(d.reason).toContain("not found");
  });

  it("reports invalid_model_format for non-route strings", () => {
    const d = diagnoseResolutionFailure("just-a-model", providers);
    expect(d.code).toBe("invalid_model_format");
  });
});

// ---------------------------------------------------------------------------
// Strict project routing: disabled provider + enableFallback=false
// ---------------------------------------------------------------------------

describe("strict project routing — disabled provider + enableFallback=false", () => {
  const sessionId = "strict-disabled-provider";

  beforeEach(() => {
    setupProjectRouter(sessionId, {
      default: "恒生芸擎中转,claude-sonnet-4",
      enableFallback: false,
      enableFamilyRouting: false,
    });
  });

  it("rejects with ProjectRoutingError (statusCode 503, code provider_disabled)", async () => {
    const config = makeConfig([
      { name: "恒生芸擎中转", enabled: false, models: ["claude-sonnet-4"] },
    ]);
    const req = makeRequest(sessionId, "ccr-opus");

    await expect(router(req, undefined, { configService: config })).rejects.toThrow(
      ProjectRoutingError
    );

    try {
      await router(req, undefined, { configService: config });
    } catch (e: any) {
      expect(e).toBeInstanceOf(ProjectRoutingError);
      expect(e.statusCode).toBe(503);
      expect(e.code).toBe("provider_disabled");
      expect(e.configuredTarget).toBe("恒生芸擎中转,claude-sonnet-4");
      expect(e.message).toContain("恒生芸擎中转");
      expect(e.message).toContain("disabled");
      // Session id must be in the message text
      expect(e.message).toContain(sessionId);
    }
  });

  it("rejects the request — no scenarioType set, no upstream execution", async () => {
    const config = makeConfig([
      { name: "恒生芸擎中转", enabled: false, models: ["claude-sonnet-4"] },
    ]);
    const req = makeRequest(sessionId, "ccr-opus");

    await expect(router(req, undefined, { configService: config })).rejects.toThrow(
      ProjectRoutingError
    );
    // Router did not resolve a model — scenarioType was never set.
    expect(req.scenarioType).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Strict project routing: provider not found
// ---------------------------------------------------------------------------

describe("strict project routing — provider not configured", () => {
  const sessionId = "strict-missing-provider";

  beforeEach(() => {
    setupProjectRouter(sessionId, {
      default: "missing-provider,some-model",
      enableFallback: false,
      enableFamilyRouting: false,
    });
  });

  it("rejects with provider_not_found (statusCode 404)", async () => {
    const config = makeConfig([]);
    const req = makeRequest(sessionId, "ccr-opus");

    try {
      await router(req, undefined, { configService: config });
      throw new Error("should have thrown");
    } catch (e: any) {
      expect(e).toBeInstanceOf(ProjectRoutingError);
      expect(e.code).toBe("provider_not_found");
      expect(e.statusCode).toBe(404);
    }
  });
});

// ---------------------------------------------------------------------------
// Strict project routing: model not found
// ---------------------------------------------------------------------------

describe("strict project routing — model not in provider", () => {
  const sessionId = "strict-model-not-found";

  beforeEach(() => {
    setupProjectRouter(sessionId, {
      default: "my-provider,nonexistent-model",
      enableFallback: false,
      enableFamilyRouting: false,
    });
  });

  it("rejects with model_not_found (statusCode 404)", async () => {
    const config = makeConfig([
      { name: "my-provider", enabled: true, models: ["other-model"] },
    ]);
    const req = makeRequest(sessionId, "ccr-opus");

    try {
      await router(req, undefined, { configService: config });
      throw new Error("should have thrown");
    } catch (e: any) {
      expect(e).toBeInstanceOf(ProjectRoutingError);
      expect(e.code).toBe("model_not_found");
      expect(e.statusCode).toBe(404);
    }
  });
});

// ---------------------------------------------------------------------------
// Strict project routing: enableFallback=true but NO project fallback + global fallback exists
// ---------------------------------------------------------------------------

describe("strict project routing — enableFallback=true but no project fallback, global exists", () => {
  const sessionId = "strict-fallback-no-inherit";

  beforeEach(() => {
    setupProjectRouter(sessionId, {
      default: "primary,sonnet",
      enableFallback: true,
      enableFamilyRouting: false,
      // No project-level `fallback` defined
    });
  });

  it("does NOT inherit global fallback — rejects with ProjectRoutingError", async () => {
    const config = new ConfigService({
      useJsonFile: false,
      initialConfig: {
        providers: [
          { name: "primary", enabled: false, models: ["sonnet"] },
          { name: "global-backup", enabled: true, models: ["backup-model"] },
        ],
        Router: {
          default: "global-backup,backup-model",
          enableFallback: true,
          fallback: {
            default: ["global-backup,backup-model"],
          },
        },
      },
    });
    const req = makeRequest(sessionId, "ccr-opus");

    // Even though global fallback exists and project enableFallback=true,
    // the project has no `fallback` of its own -> must NOT inherit global.
    await expect(router(req, undefined, { configService: config })).rejects.toThrow(
      ProjectRoutingError
    );
  });
});

// ---------------------------------------------------------------------------
// Strict project routing: project enableFallback=true with project fallback still works
// ---------------------------------------------------------------------------

describe("strict project routing — project enableFallback=true with own fallback", () => {
  const sessionId = "strict-fallback-own";

  beforeEach(() => {
    setupProjectRouter(sessionId, {
      default: "primary-provider,sonnet",
      enableFallback: true,
      enableFamilyRouting: false,
      fallback: {
        default: ["backup-provider,backup-model"],
      },
    });
  });

  it("uses project fallback when primary is unavailable", async () => {
    const config = makeConfig([
      { name: "primary-provider", enabled: false, models: ["sonnet"] },
      { name: "backup-provider", enabled: true, models: ["backup-model"] },
    ]);
    const req = makeRequest(sessionId, "ccr-opus");

    await router(req, undefined, { configService: config });
    expect(req.body.model).toBe("backup-provider,backup-model");
    expect(req.scenarioType).toBe("default");
  });
});

// ---------------------------------------------------------------------------
// Strict project routing: healthy provider resolves normally
// ---------------------------------------------------------------------------

describe("strict project routing — healthy provider resolves normally", () => {
  const sessionId = "strict-healthy";

  beforeEach(() => {
    setupProjectRouter(sessionId, {
      default: "active-provider,my-model",
      enableFallback: false,
      enableFamilyRouting: false,
    });
  });

  it("routes successfully when the configured provider/model is available", async () => {
    const config = makeConfig([
      { name: "active-provider", enabled: true, models: ["my-model"] },
    ]);
    const req = makeRequest(sessionId, "ccr-opus");

    await router(req, undefined, { configService: config });
    expect(req.body.model).toBe("active-provider,my-model");
  });
});

// ---------------------------------------------------------------------------
// Strict project routing: fail-pool target is retried, not 503'd
// ---------------------------------------------------------------------------

describe("strict project routing — fail-pool target retried instead of 503", () => {
  const sessionId = "strict-unhealthy";

  beforeEach(() => {
    setupProjectRouter(sessionId, {
      default: "active-provider,my-model",
      enableFallback: false,
      enableFamilyRouting: false,
    });
  });

  it("still routes to the configured target when it is only circuit-broken (model_unhealthy)", async () => {
    setHealthUnavailable("active-provider", "my-model", true);
    const config = makeConfig([
      { name: "active-provider", enabled: true, models: ["my-model"] },
    ]);
    const req = makeRequest(sessionId, "ccr-opus");

    // Must NOT reject — the request goes out to the configured provider so the
    // client sees the real upstream error instead of a CCR-side 503.
    await expect(router(req, undefined, { configService: config })).resolves.toBeUndefined();
    expect(req.body.model).toBe("active-provider,my-model");
  });

  it("still rejects with provider_disabled when the provider is disabled (not a fail-pool case)", async () => {
    const config = makeConfig([
      { name: "active-provider", enabled: false, models: ["my-model"] },
    ]);
    const req = makeRequest(sessionId, "ccr-opus");

    await expect(router(req, undefined, { configService: config })).rejects.toMatchObject({
      code: "provider_disabled",
      statusCode: 503,
    });
  });

  it("still rejects with model_not_found when the model is missing (not a fail-pool case)", async () => {
    const config = makeConfig([
      { name: "active-provider", enabled: true, models: ["other-model"] },
    ]);
    const req = makeRequest(sessionId, "ccr-opus");

    await expect(router(req, undefined, { configService: config })).rejects.toMatchObject({
      code: "model_not_found",
      statusCode: 404,
    });
  });
});

// ---------------------------------------------------------------------------
// Strict project routing: custom router skipped
// ---------------------------------------------------------------------------

describe("strict project routing — global custom router is skipped", () => {
  const sessionId = "strict-no-custom-router";

  beforeEach(() => {
    setupProjectRouter(sessionId, {
      default: "active,model-a",
      enableFallback: false,
      enableFamilyRouting: false,
    });
  });

  it("does not execute the global custom router when project Router is active", async () => {
    const config = new ConfigService({
      useJsonFile: false,
      initialConfig: {
        providers: [
          { name: "active", enabled: true, models: ["model-a"] },
        ],
        Router: {
          default: "active,model-a",
        },
        CUSTOM_ROUTER_PATH: "/nonexistent/custom-router.js",
      },
    });
    const req = makeRequest(sessionId, "ccr-opus");

    await router(req, undefined, { configService: config });
    // The custom router would fail to load (file doesn't exist), but the
    // project router should still resolve to the project's configured default.
    // If custom router were running and returned a model, it would bypass
    // the project Router. The fact that we get the project's model confirms
    // the custom router was skipped.
    expect(req.body.model).toBe("active,model-a");
    expect(req.strictProjectRouting).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Strict project routing: promotion store is not used
// ---------------------------------------------------------------------------

describe("strict project routing — global promotion store not used", () => {
  const sessionId = "strict-no-promotion";

  beforeEach(() => {
    setupProjectRouter(sessionId, {
      default: "primary,model-x",
      enableFallback: false,
      enableFamilyRouting: false,
    });
    // Simulate a global promotion entry that would route to an unconfigured model
    mockPromotionGet.mockReturnValue("other-provider,promoted-model");
  });

  it("does not use global promotion — rejects because configured target is unavailable", async () => {
    const config = makeConfig([
      { name: "primary", enabled: false, models: ["model-x"] },
      { name: "other-provider", enabled: true, models: ["promoted-model"] },
    ]);
    const req = makeRequest(sessionId, "ccr-opus");

    await expect(router(req, undefined, { configService: config })).rejects.toThrow(
      ProjectRoutingError
    );
    // The promotion store getPromotion should NOT have been called because
    // allowPromotion is false in strict project mode.
    expect(mockPromotionGet).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Strict project routing: modelMapping target unavailable -> throws (no fall-through)
// ---------------------------------------------------------------------------

describe("strict project routing — modelMapping target unavailable throws", () => {
  const sessionId = "strict-model-mapping";

  beforeEach(() => {
    setupProjectRouter(sessionId, {
      default: "healthy-provider,default-model",
      enableFallback: false,
      enableFamilyRouting: false,
      models: {
        "opus": "unhealthy-provider,mapped-model",
      },
    });
  });

  it("throws for mapped model instead of falling through to default", async () => {
    const config = makeConfig([
      { name: "unhealthy-provider", enabled: false, models: ["mapped-model"] },
      { name: "healthy-provider", enabled: true, models: ["default-model"] },
    ]);
    // Use a non-ccr-alias model name so it gets mapped via Router.models
    // (ccr-* aliases are intentionally unmapped when enableFamilyRouting=false).
    const req = makeRequest(sessionId, "claude-opus-4-20250514");

    // The mapped model targets a disabled provider. In strict mode, this must
    // throw instead of falling through to the healthy default.
    await expect(router(req, undefined, { configService: config })).rejects.toThrow(
      ProjectRoutingError
    );
    try {
      await router(req, undefined, { configService: config });
    } catch (e: any) {
      expect(e.code).toBe("provider_disabled");
    }
  });
});

// ---------------------------------------------------------------------------
// Strict project routing: non-"provider,model" target -> invalid_model_format (no escape)
// ---------------------------------------------------------------------------

describe("strict project routing — malformed (non-route) default target throws, no global escape", () => {
  const sessionId = "strict-non-route-target";

  beforeEach(() => {
    setupProjectRouter(sessionId, {
      // A configured default that is NOT a "provider,model" route. Previously
      // resolveConfiguredModel passed bare names through unchanged, so this was
      // treated as a successful route and the handler resolved it via global
      // provider routes — escaping the project boundary. Strict mode must
      // surface invalid_model_format instead.
      default: "model-only",
      enableFallback: false,
      enableFamilyRouting: false,
    });
  });

  it("rejects with invalid_model_format and never calls the upstream provider", async () => {
    let fetchCalled = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    }) as any;
    try {
      const config = makeConfig([
        // A global provider that resolveModelRoute could match against the bare
        // name if the escape were still possible.
        { name: "global-prov", api_base_url: "https://x/v1/messages", api_key: "k", models: ["model-only"] },
      ]);
      const req = makeRequest(sessionId, "ccr-opus");

      await expect(router(req, undefined, { configService: config })).rejects.toThrow(
        ProjectRoutingError
      );
      try {
        await router(req, undefined, { configService: config });
      } catch (e: any) {
        expect(e.code).toBe("invalid_model_format");
        expect(e.configuredTarget).toBe("model-only");
      }
      // The malformed project target must never reach an upstream call.
      expect(fetchCalled).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// Strict project routing: malformed project config -> throws (no silent global fallback)
// ---------------------------------------------------------------------------

describe("strict project routing — malformed project config", () => {
  const sessionId = "strict-malformed-config";

  beforeEach(() => {
    setupMalformedProjectConfig(sessionId);
  });

  it("throws project_config_error instead of silently using global routing", async () => {
    const config = makeConfig([
      { name: "global-provider", enabled: true, models: ["global-model"] },
    ]);
    const req = makeRequest(sessionId, "ccr-opus");

    await expect(router(req, undefined, { configService: config })).rejects.toThrow(
      ProjectRoutingError
    );
    try {
      await router(req, undefined, { configService: config });
    } catch (e: any) {
      expect(e).toBeInstanceOf(ProjectRoutingError);
      expect(e.code).toBe("project_config_error");
      expect(e.statusCode).toBe(500);
    }
  });
});

// ---------------------------------------------------------------------------
// Non-project (global) routing: unchanged behavior
// ---------------------------------------------------------------------------

describe("global routing — not affected by strict mode", () => {
  const sessionId = "global-no-project";

  beforeEach(() => {
    setupNoProject();
  });

  it("keeps original model when default provider is disabled (no strict error)", async () => {
    const config = new ConfigService({
      useJsonFile: false,
      initialConfig: {
        providers: [
          { name: "disabled-prov", enabled: false, models: ["m"] },
        ],
        Router: {
          default: "disabled-prov,m",
          enableFallback: false,
        },
      },
    });
    const req = makeRequest(sessionId, "ccr-opus");

    await router(req, undefined, { configService: config });
    // No ProjectRoutingError — global routing keeps existing behavior.
    expect(req.body.model).toBeDefined();
    expect(req.strictProjectRouting).toBeFalsy();
  });

  it("routes normally with a healthy provider in global config", async () => {
    const config = new ConfigService({
      useJsonFile: false,
      initialConfig: {
        providers: [
          { name: "global-prov", enabled: true, models: ["global-model"] },
        ],
        Router: {
          default: "global-prov,global-model",
          enableFallback: false,
        },
      },
    });
    const req = makeRequest(sessionId, "global-prov,global-model");

    await router(req, undefined, { configService: config });
    expect(req.body.model).toBe("global-prov,global-model");
  });

  it("promotion store IS used in non-project mode", async () => {
    const config = new ConfigService({
      useJsonFile: false,
      initialConfig: {
        providers: [
          { name: "global-prov", enabled: true, models: ["global-model"] },
        ],
        Router: {
          default: "global-prov,global-model",
          enableFallback: true,
        },
      },
    });
    const req = makeRequest(sessionId, "global-prov,global-model");

    await router(req, undefined, { configService: config });
    // In non-strict mode, getPromotion IS called by resolveConfiguredModel
    expect(mockPromotionGet).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Fastify inject integration: HTTP status + error code/message
// ---------------------------------------------------------------------------

describe("Fastify inject integration — project routing error", () => {
  const sessionId = "inject-strict-error";

  beforeEach(() => {
    setupProjectRouter(sessionId, {
      default: "disabled-provider,some-model",
      enableFallback: false,
      enableFamilyRouting: false,
    });
  });

  it("returns HTTP 503 with error.code=provider_disabled", async () => {
    const server = new Server({
      logger: false,
      useJsonFile: false,
      initialConfig: {
        providers: [
          { name: "disabled-provider", enabled: false, models: ["some-model"] },
        ],
        Router: {
          default: "disabled-provider,some-model",
        },
      },
    });
    await server.ready();
    server.ccrPreHandlerCallbacks = {
      authClient: async () => {},
      agent: async () => {},
    };
    await server.registerNamespace("/");
    await server.app.ready();

    try {
      const response = await server.app.inject({
        method: "POST",
        url: "/v1/messages",
        payload: {
          model: "ccr-opus",
          messages: [{ role: "user", content: "hello" }],
          stream: false,
          metadata: { user_id: `user_abc_session_${sessionId}` },
        },
      });

      expect(response.statusCode).toBe(503);
      const body = JSON.parse(response.body);
      expect(body.error.code).toBe("provider_disabled");
      expect(body.error.message).toContain("disabled-provider");
      // No stack trace in the message
      expect(body.error.message).not.toContain("at ");
    } finally {
      await server.app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Runtime integration: handleFallback path with strict project routing
// ---------------------------------------------------------------------------

describe("runtime handleFallback — strict project, no project fallback, global exists", () => {
  const sessionId = "runtime-fallback-no-inherit";

  beforeEach(() => {
    // Project Router: enableFallback=true but NO project fallback defined
    setupProjectRouter(sessionId, {
      default: "primary,model-a",
      enableFallback: true,
      enableFamilyRouting: false,
      // No `fallback` key — project has no fallback of its own
    });
  });

  it("primary failure does NOT invoke global fallback stub", async () => {
    // Track fetch calls per provider URL
    const fetchCalls: string[] = [];

    const server = new Server({
      logger: false,
      useJsonFile: false,
      initialConfig: {
        providers: [
          {
            name: "primary",
            api_base_url: "https://primary.example/v1/messages",
            api_key: "primary-key",
            models: ["model-a"],
          },
          {
            name: "global-backup",
            api_base_url: "https://backup.example/v1/messages",
            api_key: "backup-key",
            models: ["backup-model"],
          },
        ],
        Router: {
          default: "primary,model-a",
          enableFallback: true,
          fallback: {
            default: ["global-backup,backup-model"],
          },
        },
      },
    });
    await server.ready();
    server.ccrPreHandlerCallbacks = {
      authClient: async () => {},
      agent: async () => {},
    };
    await server.registerNamespace("/");
    await server.app.ready();

    const originalFetch = globalThis.fetch;
    // Mock fetch: primary returns 500, backup would return 200 (but should never be called)
    globalThis.fetch = vi.fn(async (url: any) => {
      const urlStr = String(url);
      fetchCalls.push(urlStr);
      if (urlStr.includes("primary.example")) {
        return new Response(JSON.stringify({ error: "upstream failure" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
      // Backup provider — should never be called
      return new Response(JSON.stringify({
        id: "chatcmpl-backup",
        object: "chat.completion",
        model: "backup-model",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as any;

    try {
      const response = await server.app.inject({
        method: "POST",
        url: "/v1/messages",
        payload: {
          model: "ccr-opus",
          messages: [{ role: "user", content: "hello" }],
          stream: false,
          metadata: { user_id: `user_abc_session_${sessionId}` },
        },
      });

      // The response should be an error (primary failed, no project fallback)
      expect(response.statusCode).toBeGreaterThanOrEqual(500);
      // The global backup provider must NOT have been called
      const backupCalls = fetchCalls.filter(u => u.includes("backup.example"));
      expect(backupCalls.length).toBe(0);
      // Primary was called at least once (initial attempt + possibly one retry)
      const primaryCalls = fetchCalls.filter(u => u.includes("primary.example"));
      expect(primaryCalls.length).toBeGreaterThan(0);
    } finally {
      globalThis.fetch = originalFetch;
      await server.app.close();
    }
  });
});

describe("runtime handleFallback — strict project, project fallback works", () => {
  const sessionId = "runtime-fallback-own";

  beforeEach(() => {
    setupProjectRouter(sessionId, {
      default: "primary,model-a",
      enableFallback: true,
      enableFamilyRouting: false,
      fallback: {
        default: ["project-backup,backup-model"],
      },
    });
  });

  it("primary failure invokes project fallback (not global)", async () => {
    const fetchCalls: string[] = [];

    const server = new Server({
      logger: false,
      useJsonFile: false,
      initialConfig: {
        providers: [
          {
            name: "primary",
            api_base_url: "https://primary.example/v1/messages",
            api_key: "primary-key",
            models: ["model-a"],
          },
          {
            name: "project-backup",
            api_base_url: "https://project-backup.example/v1/messages",
            api_key: "backup-key",
            models: ["backup-model"],
          },
        ],
        Router: {
          default: "primary,model-a",
          enableFallback: true,
          // Global fallback points to a DIFFERENT provider — should NOT be used
          fallback: {
            default: ["global-other,global-model"],
          },
        },
      },
    });
    await server.ready();
    server.ccrPreHandlerCallbacks = {
      authClient: async () => {},
      agent: async () => {},
    };
    await server.registerNamespace("/");
    await server.app.ready();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url: any) => {
      const urlStr = String(url);
      fetchCalls.push(urlStr);
      if (urlStr.includes("primary.example")) {
        return new Response(JSON.stringify({ error: "upstream failure" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
      // Project backup returns success
      return new Response(JSON.stringify({
        id: "chatcmpl-backup",
        object: "chat.completion",
        model: "backup-model",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as any;

    try {
      const response = await server.app.inject({
        method: "POST",
        url: "/v1/messages",
        payload: {
          model: "ccr-opus",
          messages: [{ role: "user", content: "hello" }],
          stream: false,
          metadata: { user_id: `user_abc_session_${sessionId}` },
        },
      });

      // Project fallback should succeed
      expect(response.statusCode).toBe(200);
      // Project backup WAS called
      const backupCalls = fetchCalls.filter(u => u.includes("project-backup.example"));
      expect(backupCalls.length).toBeGreaterThan(0);
    } finally {
      globalThis.fetch = originalFetch;
      await server.app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Subagent override tag stripped in strict project mode
// ---------------------------------------------------------------------------

describe("strict project routing — subagent override tag stripped but model not used", () => {
  const sessionId = "strict-subagent-strip";

  beforeEach(() => {
    setupProjectRouter(sessionId, {
      default: "active-provider,project-model",
      enableFallback: false,
      enableFamilyRouting: false,
    });
  });

  it("strips the CCR-SUBAGENT-MODEL tag and routes via project Router", async () => {
    const config = makeConfig([
      { name: "active-provider", enabled: true, models: ["project-model"] },
      { name: "subagent-provider", enabled: true, models: ["subagent-model"] },
    ]);
    const req = makeRequest(sessionId, "ccr-opus");
    // Inject a subagent override tag into system[1]
    req.body.system = [
      { type: "text", text: "system prompt" },
      { type: "text", text: "<CCR-SUBAGENT-MODEL>subagent-provider,subagent-model</CCR-SUBAGENT-MODEL>Please help." },
    ];

    await router(req, undefined, { configService: config });

    // The tag must be stripped from the system text
    expect(req.body.system[1].text).not.toContain("<CCR-SUBAGENT-MODEL>");
    // The model must be the project Router's default, NOT the subagent override
    expect(req.body.model).toBe("active-provider,project-model");
  });
});

// ---------------------------------------------------------------------------
// Subagent tag stripped early: even when family routing returns early
// ---------------------------------------------------------------------------

describe("subagent tag stripped early — family routing returns before old position", () => {
  const sessionId = "subagent-family-early-strip";

  beforeEach(() => {
    setupProjectRouter(sessionId, {
      enableFamilyRouting: true,
      enableFallback: false,
      families: {
        opus: {
          default: "family-provider,family-model",
        },
      },
    });
  });

  it("strips tag even when family routing branch returns early", async () => {
    const config = makeConfig([
      { name: "family-provider", enabled: true, models: ["family-model"] },
      { name: "subagent-provider", enabled: true, models: ["subagent-model"] },
    ]);
    const req = makeRequest(sessionId, "ccr-opus");
    req.body.system = [
      { type: "text", text: "system prompt" },
      { type: "text", text: "<CCR-SUBAGENT-MODEL>subagent-provider,subagent-model</CCR-SUBAGENT-MODEL>Please help." },
    ];

    await router(req, undefined, { configService: config });

    // Family routing returned early with the family default model.
    expect(req.body.model).toBe("family-provider,family-model");
    expect(req.scenarioType).toBe("default");
    // The tag MUST already be stripped — family routing returns before the
    // old subagent override position.
    expect(req.body.system[1].text).not.toContain("<CCR-SUBAGENT-MODEL>");
  });
});

// ---------------------------------------------------------------------------
// Subagent tag stripped early: even when longContext returns early
// ---------------------------------------------------------------------------

describe("subagent tag stripped early — strict longContext returns before old position", () => {
  const sessionId = "subagent-longctx-early-strip";

  beforeEach(() => {
    setupProjectRouter(sessionId, {
      enableFamilyRouting: false,
      enableFallback: false,
      longContextThreshold: 10,
      longContext: "longctx-provider,long-model",
      default: "default-provider,default-model",
    });
  });

  it("strips tag even when longContext branch returns early", async () => {
    const config = makeConfig([
      { name: "longctx-provider", enabled: true, models: ["long-model"] },
      { name: "default-provider", enabled: true, models: ["default-model"] },
      { name: "subagent-provider", enabled: true, models: ["subagent-model"] },
    ]);
    // Use a non-family model so family routing doesn't intercept
    const req = makeRequest(sessionId, "some-model");
    req.body.system = [
      { type: "text", text: "system prompt" },
      { type: "text", text: "<CCR-SUBAGENT-MODEL>subagent-provider,subagent-model</CCR-SUBAGENT-MODEL>Please help." },
    ];

    await router(req, undefined, { configService: config });

    // longContext routing returned early (token count > threshold of 10).
    expect(req.body.model).toBe("longctx-provider,long-model");
    expect(req.scenarioType).toBe("longContext");
    // The tag MUST already be stripped — longContext returns before the
    // old subagent override position.
    expect(req.body.system[1].text).not.toContain("<CCR-SUBAGENT-MODEL>");
  });
});
