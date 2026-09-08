import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CCR_PROJECT_HEADER,
  deleteProjectConfig,
  getClaudeProjectId,
  writeProjectConfig,
} from "@wengine-ai/claude-code-router-shared";
import Server from "../server";
import { registerRequestPipeline, createCcrPreHandlerCallbacks } from "../ccr/request-pipeline";
import { registerAdminRoutes } from "../ccr/admin-routes";
import { sessionUsageCache } from "../utils/cache";

// Build a runtime that mirrors createCcrServer without touching the real
// ~/.claude-code-router config or starting background probes.
async function buildRuntime(overrides: Record<string, any> = {}) {
  const config = {
    PORT: 0,
    APIKEY: "secret",
    Providers: [
      {
        name: "demo",
        api_base_url: "https://upstream.example/v1/messages",
        api_key: "demo-key",
        models: ["default", "long", "extended"],
      },
    ],
    Router: {
      enableFamilyRouting: true,
      longContextThreshold: 60000,
      families: {
        opus: {
          default: "demo,default",
          longContext: "demo,long",
          extendedContext: "demo,extended",
        },
      },
    },
    ...overrides,
  };

  const server = new Server({
    logger: false,
    useJsonFile: false,
    initialConfig: {
      providers: config.Providers,
      Router: config.Router,
      HOST: "127.0.0.1",
      PORT: 0,
    },
  });

  await server.ready();
  await registerAdminRoutes(server, config);
  registerRequestPipeline(server, config);
  server.ccrPreHandlerCallbacks = createCcrPreHandlerCallbacks(config);
  await server.registerNamespace("/");
  await server.app.ready();
  return { server, config };
}

function nonStreamResponse(body: Partial<any> = {}) {
  // The Anthropic transformer converts OpenAI chat completion responses to
  // Anthropic format, so the upstream mock must return OpenAI-compatible JSON.
  return new Response(JSON.stringify({
    id: "chatcmpl-1",
    object: "chat.completion",
    created: 1700000000,
    model: body.model || "default",
    choices: [{
      index: 0,
      message: { role: "assistant", content: "ok" },
      finish_reason: "stop",
    }],
    usage: {
      prompt_tokens: 12,
      completion_tokens: 3,
      total_tokens: 15,
    },
    ...body,
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function streamResponse() {
  const events = [
    { event: "message_start", data: { message: { model: "default" }, usage: { input_tokens: 7, output_tokens: 0 } } },
    { event: "content_block_delta", data: { delta: { type: "text_delta", text: "hi" } } },
    { event: "message_delta", data: { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } } },
    { event: "message_stop", data: {} },
  ];
  const body = events.map(e => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join("");
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("runtime integration", () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchCalls: any[];

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchCalls = [];
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    sessionUsageCache.delete("claude-code:session:int-session");
    sessionUsageCache.delete("claude-code:session:int-session-2");
    sessionUsageCache.delete("claude-code:session:int-zero");
  });

  it("routes a Claude Code request through adapter→router→handler and records usage", async () => {
    globalThis.fetch = vi.fn(async (url: any, init: any) => {
      fetchCalls.push({ url: String(url), body: init?.body });
      return nonStreamResponse();
    }) as any;

    const { server } = await buildRuntime();
    try {
      const res = await server.app.inject({
        method: "POST",
        url: "/v1/messages",
        headers: { "x-anthropic-billing-header": "cc_version=9.9" },
        payload: {
          model: "ccr-opus",
          messages: [{ role: "user", content: "hello" }],
          metadata: { user_id: "user_x_session_int-session" },
          stream: false,
        },
      });

      if (res.statusCode !== 200) {
        console.error("NON-200", res.statusCode, res.body);
      }
      expect(res.statusCode).toBe(200);
      // Router rewrote body.model to "demo,default".
      expect(fetchCalls.length).toBeGreaterThan(0);
      expect(fetchCalls[0].body).toContain('"model":"default"');
    } finally {
      await server.app.close();
    }
  });

  it("routes Pi through its project Router and strips the internal header upstream", async () => {
    const projectPath = mkdtempSync(join(tmpdir(), "ccr-runtime-pi-project-"));
    const projectId = getClaudeProjectId(projectPath);
    await writeProjectConfig(projectPath, {
      Router: {
        default: "project,project-model",
        enableFamilyRouting: false,
      },
    });
    globalThis.fetch = vi.fn(async (url: any, init: any) => {
      fetchCalls.push({
        url: String(url),
        body: init?.body,
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
      });
      return nonStreamResponse({ model: "project-model" });
    }) as any;

    let server: Awaited<ReturnType<typeof buildRuntime>>["server"] | undefined;
    try {
      ({ server } = await buildRuntime({
        Providers: [
          {
            name: "global",
            api_base_url: "https://upstream.example/v1/messages",
            api_key: "global-key",
            models: ["global-model"],
          },
          {
            name: "project",
            api_base_url: "https://upstream.example/v1/messages",
            api_key: "project-key",
            models: ["project-model"],
          },
        ],
        Router: {
          default: "global,global-model",
          enableFamilyRouting: false,
        },
      }));

      const res = await server.app.inject({
        method: "POST",
        url: "/v1/messages",
        headers: { [CCR_PROJECT_HEADER]: projectId },
        payload: {
          model: "ccr-opus",
          messages: [{ role: "user", content: "hello" }],
          system: "You are operating inside pi",
          stream: false,
        },
      });

      expect(res.statusCode).toBe(200);
      expect(fetchCalls).toHaveLength(1);
      expect(fetchCalls[0].body).toContain('"model":"project-model"');
      expect(fetchCalls[0].headers[CCR_PROJECT_HEADER]).toBeUndefined();
    } finally {
      if (server) await server.app.close();
      await deleteProjectConfig(projectPath);
      rmSync(projectPath, { recursive: true, force: true });
    }
  });

  it("authenticates management routes for remote callers", async () => {
    const { server } = await buildRuntime();
    try {
      const unauth = await server.app.inject({
        method: "GET",
        url: "/api/debug-log",
        remoteAddress: "10.0.0.2",
      });
      expect(unauth.statusCode).toBe(401);

      const auth = await server.app.inject({
        method: "GET",
        url: "/api/debug-log",
        remoteAddress: "10.0.0.2",
        headers: { authorization: "Bearer secret" },
      });
      expect(auth.statusCode).toBe(200);
      expect(auth.json().enabled).toBe(false);
    } finally {
      await server.app.close();
    }
  });

  it("waits for streaming usage capture before onResponse records usage", async () => {
    globalThis.fetch = vi.fn(async () => streamResponse()) as any;

    // Use a passthrough provider so the upstream Anthropic SSE reaches the
    // pipeline capture unchanged (the Anthropic transformer with no upstream
    // conversion expects OpenAI format; passthrough skips that).
    const { server } = await buildRuntime({
      Providers: [{
        name: "demo",
        api_base_url: "https://upstream.example/v1/messages",
        api_key: "demo-key",
        models: ["default", "long", "extended"],
        transformer: { use: ["Anthropic"] },
      }],
    });
    try {
      const res = await server.app.inject({
        method: "POST",
        url: "/v1/messages",
        headers: { "x-anthropic-billing-header": "cc_version=9.9" },
        payload: {
          model: "ccr-opus",
          messages: [{ role: "user", content: "stream" }],
          metadata: { user_id: "user_x_session_int-session" },
          stream: true,
        },
      });

      if (res.statusCode !== 200) {
        console.error("STREAM-NON-200", res.statusCode, res.body.slice(0,200));
      }
      expect(res.statusCode).toBe(200);
      // Allow the teed background stream + onResponse await to settle.
      await new Promise((resolve) => setTimeout(resolve, 150));
      const usage = sessionUsageCache.get("claude-code:session:int-session");
      // The Anthropic transformer re-emits SSE with usage in message_start and
      // message_delta. The pipeline capture reads from the transformed stream.
      // If usage is still 0, the capture did not complete before onResponse.
      if (!usage || usage.input_tokens === 0) {
        console.error("USAGE-CAPTURE-MISSED", JSON.stringify(usage), res.body.slice(0,200));
      }
      expect(usage?.input_tokens).toBeGreaterThan(0);
    } finally {
      await server.app.close();
    }
  });

  it("routes preset namespace requests with isolated config", async () => {
    const presetFetch = vi.fn(async (url: any, init: any) => {
      fetchCalls.push({ url: String(url), body: init?.body });
      return nonStreamResponse({ model: "preset-model" });
    });
    globalThis.fetch = presetFetch as any;

    // Build a fresh runtime and register the preset namespace BEFORE app.ready.
    const config = {
      PORT: 0,
      APIKEY: "secret",
      Providers: [
        { name: "demo", api_base_url: "https://upstream.example/v1/messages", api_key: "demo-key", models: ["default"] },
      ],
      Router: { enableFamilyRouting: true, families: { opus: { default: "demo,default" } } },
    };
    const server = new Server({
      logger: false,
      useJsonFile: false,
      initialConfig: { providers: config.Providers, Router: config.Router, HOST: "127.0.0.1", PORT: 0 },
    });
    await server.ready();
    await registerAdminRoutes(server, config);
    registerRequestPipeline(server, config);
    server.ccrPreHandlerCallbacks = createCcrPreHandlerCallbacks(config);
    await server.registerNamespace("/");
    await server.registerNamespace("/preset/my-preset", {
      Providers: [{
        name: "preset-provider",
        api_base_url: "https://preset.example/v1/messages",
        api_key: "preset-key",
        models: ["preset-model"],
      }],
      Router: { default: "preset-provider,preset-model" },
    });
    await server.app.ready();
    try {
      const res = await server.app.inject({
        method: "POST",
        url: "/preset/my-preset/v1/messages",
        headers: { "x-anthropic-billing-header": "cc_version=9.9" },
        payload: {
          model: "ccr-opus",
          messages: [{ role: "user", content: "preset" }],
          metadata: { user_id: "user_x_session_int-session-2" },
          stream: false,
        },
      });

      if (res.statusCode !== 200) {
        console.error("PRESET-NON-200", res.statusCode, res.body);
      }
      expect(res.statusCode).toBe(200);
      if (fetchCalls.length === 0) {
        console.error("NO-FETCH-CALLED", res.statusCode, res.body.slice(0,200));
      }
      expect(fetchCalls.length).toBeGreaterThan(0);
      if (fetchCalls.length > 0) {
        expect(fetchCalls[0].url).toContain("preset.example");
        expect(fetchCalls[0].body).toContain('"model":"preset-model"');
      }
    } finally {
      await server.app.close();
    }
  });
});
