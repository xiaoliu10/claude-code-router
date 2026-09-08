import { describe, it, expect } from "vitest";
import { OpenCodeTransformer } from "../transformer/opencode.transformer";
import { AnthropicTransformer } from "../transformer/anthropic.transformer";
import { UnifiedChatRequest, UnifiedTool } from "../types/llm";
import { TransformerService } from "../services/transformer";
import { ConfigService } from "../services/config";

// ---------------------------------------------------------------------------
// Helper: build a minimal UnifiedChatRequest with tools
// ---------------------------------------------------------------------------
function makeRequest(overrides?: Partial<UnifiedChatRequest>): UnifiedChatRequest {
  return {
    messages: [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "Hello" },
    ],
    model: "glm-5.2",
    stream: true,
    tools: [
      {
        type: "function",
        function: {
          name: "Bash",
          description: "Execute a bash command",
          parameters: {
            type: "object",
            properties: {
              command: { type: "string", description: "The command to execute" },
            },
          },
        },
      },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helper: build a provider object for AnthropicTransformer.transformRequestIn
// ---------------------------------------------------------------------------
function makeProvider(baseUrl: string) {
  return {
    name: "opencode go",
    baseUrl,
    apiKey: "test-key",
    models: ["glm-5.2"],
  } as any;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("OpenCodeTransformer", () => {
  it("should declare endPoint=/v1/chat/completions", () => {
    const t = new OpenCodeTransformer();
    expect(t.endPoint).toBe("/v1/chat/completions");
    expect(t.name).toBeUndefined(); // uses static TransformerName
    expect((OpenCodeTransformer as any).TransformerName).toBe("opencode");
  });

  it("should preserve cache_control markers in transformRequestIn (opencode zen gates its prompt cache on them)", async () => {
    const t = new OpenCodeTransformer();
    const request = makeRequest({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "hello", cache_control: { type: "ephemeral" } },
          ],
        } as any,
      ],
    });

    const { body: result } = await t.transformRequestIn(request, makeProvider("https://opencode.ai"), {});
    const msg = result.messages[0];
    if (Array.isArray(msg.content)) {
      const textItem = (msg.content as any[]).find((i: any) => i.type === "text");
      expect(textItem.cache_control).toEqual({ type: "ephemeral" });
    }
  });

  it("should preserve cache_control through the Anthropic→Unified→OpenCode chain", async () => {
    // The full chain: Claude Code sends Anthropic format with cache_control on
    // system blocks; anthropic.transformer converts to unified; opencode must
    // not strip the markers on the way to the upstream.
    const anthropicTransformer = new AnthropicTransformer();
    const anthropicRequest = {
      model: "glm-5.2",
      max_tokens: 4096,
      stream: true,
      system: [
        { type: "text", text: "system prompt", cache_control: { type: "ephemeral" } },
      ],
      messages: [{ role: "user", content: "Hello" }],
    };

    const unified = await anthropicTransformer.transformRequestOut(anthropicRequest as any);
    const t = new OpenCodeTransformer();
    const { body: processed } = await t.transformRequestIn(
      unified,
      makeProvider("https://opencode.ai/zen/go/v1/chat/completions"),
      {}
    );

    const sysMsg = (processed.messages as any[]).find((m) => m.role === "system");
    expect(sysMsg).toBeDefined();
    const block = Array.isArray(sysMsg!.content)
      ? (sysMsg!.content as any[]).find((i: any) => i.type === "text")
      : null;
    expect(block?.cache_control).toEqual({ type: "ephemeral" });
  });

  it("should convert assistant thinking to reasoning_content for multi-turn cache continuity", async () => {
    const t = new OpenCodeTransformer();
    const request = makeRequest({
      reasoning: { enabled: true, effort: "high" },
      messages: [
        {
          role: "assistant",
          content: "I will inspect the file.",
          thinking: {
            content: "The file likely contains the relevant implementation.",
            signature: "sig-123",
          },
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: { name: "Read", arguments: '{"path":"a.ts"}' },
            },
          ],
        },
      ],
    });

    const { body: result } = await t.transformRequestIn(request);
    const assistant = result.messages[0] as any;
    expect(assistant.reasoning_content).toBe(
      "The file likely contains the relevant implementation."
    );
    expect(assistant.reasoning_content_signature).toBe("sig-123");
    expect(assistant.thinking).toBeUndefined();
  });

  it("should add empty reasoning_content to thinking-mode assistant tool calls", async () => {
    const t = new OpenCodeTransformer();
    const request = makeRequest({
      reasoning: { enabled: true, effort: "high" },
      messages: [
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: { name: "Read", arguments: '{"path":"a.ts"}' },
            },
          ],
        },
      ],
    });

    const { body: result } = await t.transformRequestIn(request);
    expect((result.messages[0] as any).reasoning_content).toBe(" ");
  });

  it("should not add reasoning_content when thinking mode is disabled", async () => {
    const t = new OpenCodeTransformer();
    const request = makeRequest({
      messages: [
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: { name: "Read", arguments: '{"path":"a.ts"}' },
            },
          ],
        },
      ],
    });

    const { body: result } = await t.transformRequestIn(request);
    expect((result.messages[0] as any).reasoning_content).toBeUndefined();
  });

  it("should clean media_type from image_url in transformRequestIn", async () => {
    const t = new OpenCodeTransformer();
    const request = makeRequest({
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: "data:image/png;base64,abc123" },
              media_type: "image/png",
            },
          ],
        } as any,
      ],
    });

    const { body: result } = await t.transformRequestIn(request, makeProvider("https://opencode.ai"), {});
    const msg = result.messages[0];
    if (Array.isArray(msg.content)) {
      const imgItem = (msg.content as any[]).find((i: any) => i.type === "image_url");
      expect(imgItem.media_type).toBeUndefined();
    }
  });

  it("should keep tools with type='function' after transformRequestIn", async () => {
    const t = new OpenCodeTransformer();
    const request = makeRequest();

    const { body: result } = await t.transformRequestIn(request, makeProvider("https://opencode.ai"), {});
    expect(result.tools).toBeDefined();
    expect(result.tools!.length).toBe(1);
    expect(result.tools![0].type).toBe("function");
    expect(result.tools![0].function.name).toBe("Bash");
  });

  it("should apply options from constructor", async () => {
    const t = new OpenCodeTransformer({ temperature: 0.5 });
    const request = makeRequest();

    const { body: result, config } = await t.transformRequestIn(
      request,
      makeProvider("https://opencode.ai"),
      {}
    );
    expect(result.temperature).toBe(0.5);
    // The {body, config} shape is required so routes.ts merges the session
    // header into the outgoing request headers.
    expect(config?.headers?.["x-opencode-session"]).toBeDefined();
  });
});

describe("OpenCodeTransformer x-opencode-session", () => {
  it("should extract a stable session id from Claude Code metadata.user_id", async () => {
    const t = new OpenCodeTransformer();
    const request = makeRequest({
      metadata: { user_id: "user_ab12cd34__session_8f0e1d2c3b4a" },
    } as any);

    const { config } = await t.transformRequestIn(request, makeProvider("https://opencode.ai"), {});
    expect(config?.headers?.["x-opencode-session"]).toBe("8f0e1d2c3b4a");
  });

  it("should prefer the client adapter's stableSessionId from the request context", async () => {
    const t = new OpenCodeTransformer();
    const request = makeRequest();
    const context = {
      req: {
        clientContext: { stableSessionId: "adapter-session" },
        sessionId: "adapter-session",
        headers: {},
      },
    };

    const { config } = await t.transformRequestIn(request, makeProvider("https://opencode.ai"), context);
    expect(config?.headers?.["x-opencode-session"]).toBe("adapter-session");
  });

  it("should preserve an incoming x-opencode-session header from a native opencode client", async () => {
    const t = new OpenCodeTransformer();
    const request = makeRequest();
    const context = {
      req: { headers: { "x-opencode-session": "native-opencode-session" } },
    };

    const { config } = await t.transformRequestIn(request, makeProvider("https://opencode.ai"), context);
    expect(config?.headers?.["x-opencode-session"]).toBe("native-opencode-session");
  });

  it("should fall back to a UUID-shaped id when no session source exists", async () => {
    const t = new OpenCodeTransformer();
    const request = makeRequest();

    const { config } = await t.transformRequestIn(request, makeProvider("https://opencode.ai"), {});
    const value = config?.headers?.["x-opencode-session"];
    expect(value).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
  });
});

describe("OpenCodeTransformer registration prevents bypass", () => {
  it("should be resolvable by TransformerService", async () => {
    // Simulate how ProviderService resolves the "opencode" transformer name
    const mockConfig = {
      get: () => [],
    } as any;
    const mockLogger = { info: () => {}, error: () => {} };
    const ts = new TransformerService(mockConfig, mockLogger);
    await ts.initialize();

    const resolved = ts.getTransformer("opencode");
    expect(resolved).toBeDefined();

    // The transformer should have an endPoint
    if (typeof resolved === "function") {
      const instance = new (resolved as any)();
      expect(instance.endPoint).toBe("/v1/chat/completions");
    } else {
      expect((resolved as any).endPoint).toBe("/v1/chat/completions");
    }
  });
});

describe("End-to-end: Anthropic request → OpenCode provider tools format", () => {
  it("should produce tools with type='function' when sent to OpenAI-compatible endpoint", async () => {
    // Step 1: Simulate AnthropicTransformer.transformRequestOut (incoming Anthropic request)
    const anthropicTransformer = new AnthropicTransformer();
    const anthropicRequest = {
      model: "glm-5.2",
      max_tokens: 4096,
      stream: true,
      system: "You are a helpful assistant.",
      messages: [
        { role: "user", content: "Hello" },
      ],
      tools: [
        {
          name: "Bash",
          description: "Execute a bash command",
          input_schema: {
            type: "object",
            properties: {
              command: { type: "string", description: "The command to execute" },
            },
          },
        },
      ],
    };

    const unifiedRequest = await anthropicTransformer.transformRequestOut(anthropicRequest);

    // Verify unified format has type="function"
    expect(unifiedRequest.tools).toBeDefined();
    expect(unifiedRequest.tools!.length).toBe(1);
    expect(unifiedRequest.tools![0].type).toBe("function");
    expect(unifiedRequest.tools![0].function.name).toBe("Bash");

    // Step 2: Simulate OpenCodeTransformer.transformRequestIn
    const openCodeTransformer = new OpenCodeTransformer();
    const { body: processedRequest } = await openCodeTransformer.transformRequestIn(
      unifiedRequest,
      makeProvider("https://opencode.ai/zen/go/v1/chat/completions"),
      {}
    );

    // Step 3: Verify the tools still have type="function" after processing
    expect(processedRequest.tools).toBeDefined();
    expect(processedRequest.tools!.length).toBe(1);
    expect(processedRequest.tools![0].type).toBe("function");

    // Step 4: Simulate what gets sent via JSON.stringify (same as sendUnifiedRequest)
    const serialized = JSON.stringify(processedRequest);
    const parsed = JSON.parse(serialized);
    expect(parsed.tools[0].type).toBe("function");
    expect(parsed.tools[0].function.name).toBe("Bash");

    // Verify the old Anthropic format fields are NOT present at top level
    expect(parsed.tools[0].name).toBeUndefined();
    expect(parsed.tools[0].input_schema).toBeUndefined();
  });
});

describe("OpenAI-compatible usage cache mapping", () => {
  // convertOpenAIResponseToAnthropic reads context.req.id and this.logger.debug.
  const ctx = { req: { id: "test-req" } } as any;
  const noopLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

  function makeTransformer(): AnthropicTransformer {
    const t = new AnthropicTransformer();
    t.logger = noopLogger;
    return t;
  }
  // anthropic.transformer maps upstream OpenAI-style usage to Anthropic
  // semantics. Cache reads arrive as prompt_tokens_details.cached_tokens OR
  // DeepSeek-style prompt_cache_hit_tokens; both must surface as
  // cache_read_input_tokens with input_tokens net of cache.
  function makeNonStreamingResponse(usage: any): Response {
    return new Response(
      JSON.stringify({
        id: "chatcmpl-1",
        model: "deepseek-v4-flash",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "ok" },
            finish_reason: "stop",
          },
        ],
        usage,
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  it("maps prompt_tokens_details.cached_tokens (non-streaming)", async () => {
    const t = makeTransformer();
    const res = makeNonStreamingResponse({
      prompt_tokens: 1000,
      completion_tokens: 5,
      prompt_tokens_details: { cached_tokens: 800 },
    });
    const out = await t.transformResponseIn(res, ctx);
    const data = await (out as Response).json();
    expect(data.usage.cache_read_input_tokens).toBe(800);
    expect(data.usage.input_tokens).toBe(200);
  });

  it("maps DeepSeek-style prompt_cache_hit_tokens when cached_tokens is absent (non-streaming)", async () => {
    const t = makeTransformer();
    const res = makeNonStreamingResponse({
      prompt_tokens: 1000,
      completion_tokens: 5,
      prompt_cache_hit_tokens: 600,
      prompt_cache_miss_tokens: 400,
    });
    const out = await t.transformResponseIn(res, ctx);
    const data = await (out as Response).json();
    expect(data.usage.cache_read_input_tokens).toBe(600);
    expect(data.usage.input_tokens).toBe(400);
  });
});
