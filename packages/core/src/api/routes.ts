import {
  FastifyInstance,
  FastifyPluginAsync,
  FastifyRequest,
  FastifyReply,
} from "fastify";
import { RegisterProviderRequest, LLMProvider } from "@/types/llm";
import { sendUnifiedRequest } from "@/utils/request";
import { createApiError } from "./middleware";
import {
  isDebugLogEnabled,
  getDebugLogOptions,
  logProviderRequest,
  logProviderResponse,
  readStreamForDebug,
} from "@/utils/debug-log";
import { version } from "../../package.json";
import { ConfigService } from "@/services/config";
import { ProviderService } from "@/services/provider";
import { TransformerService } from "@/services/transformer";
import { Transformer } from "@/types/transformer";
import { getHealthStore } from "@/services/provider-health";
import { captureRateLimitHeaders } from "@/services/rate-limit";
import { getFallbackPromotionStore } from "@/utils/fallback-promotion";
import { OpenAIResponsesTransformer } from "../transformer/openai.responses.transformer";
import { router } from "@/utils/router";

// Matches the CCR model-family aliases that CCR injects into managed clients
// (e.g. "ccr-opus", "ccr-sonnet[1m]"). Codex sends one of these as a bare model
// name to /v1/responses.
const CCR_FAMILY_ALIAS = /^ccr-(opus|sonnet|haiku)(\[1m\])?$/i;

/**
 * Normalize a Responses API (Codex) request body into a unified chat request so
 * downstream transformers (and the family router) can process it.
 * Codex sends: { model, input: [...], instructions, tools, stream, ... }
 * We convert to: { model, messages: [...], system, tools, stream, ... }
 */
function normalizeResponsesBody(body: any): void {
  const messages: any[] = [];
  const input = Array.isArray(body.input) ? body.input : [body.input];
  for (const item of input) {
    if (item.type === "function_call") {
      messages.push({
        role: "assistant",
        tool_calls: [{
          id: item.call_id,
          type: "function",
          function: { name: item.name, arguments: item.arguments || "{}" },
        }],
      });
    } else if (item.type === "function_call_output") {
      messages.push({
        role: "tool",
        tool_call_id: item.call_id,
        content: typeof item.output === "string" ? item.output : JSON.stringify(item.output),
      });
    } else if (item.type === "reasoning") {
      // Preserve reasoning items (thinking summaries from auto-compact) so the
      // downstream model can see compacted context. Convert to an assistant
      // message with thinking content so non-OpenAI providers can process it.
      const summaryText = Array.isArray(item.summary)
        ? item.summary
            .filter((s: any) => s.type === "summary_text" && s.text)
            .map((s: any) => s.text)
            .join("\n")
        : "";
      if (summaryText) {
        messages.push({
          role: "assistant",
          content: [{ type: "text", text: `[reasoning]\n${summaryText}` }],
          _reasoningItem: true,  // marker for transformRequestIn to restore
        });
      }
    } else if (item.role) {
      // user / assistant / system messages
      let content = item.content;
      // Convert Responses API content format to unified format
      if (Array.isArray(content)) {
        content = content.map((c: any) => {
          if (c.type === "input_text") return { type: "text", text: c.text };
          if (c.type === "output_text") return { type: "text", text: c.text };
          if (c.type === "input_image") return { type: "image_url", image_url: { url: c.image_url }, media_type: c.mime_type };
          return c;
        });
      }
      messages.push({ role: item.role, content });
    }
  }
  body.messages = messages;
  delete body.input;
  // Move instructions to system
  if (body.instructions && typeof body.instructions === "string") {
    body.system = body.instructions;
    delete body.instructions;
  }
  // Normalize tools from Responses API format to OpenAI format
  if (Array.isArray(body.tools)) {
    body.tools = body.tools
      .filter((tool: any) => tool && typeof tool === "object")
      .map((tool: any) => {
        // Responses API tools: { type: "function", name: "X", description: "...", parameters: {...} }
        if (tool.type === "function" && tool.name && !tool.function) {
          return {
            type: "function",
            function: {
              name: tool.name,
              description: tool.description || "",
              parameters: tool.parameters || { type: "object", properties: {} },
            },
          };
        }
        // Standard OpenAI format already
        if (tool.function?.name) {
          return tool;
        }
        // Codex web_search tool
        if (tool.type === "web_search") {
          return {
            type: "function",
            function: {
              name: "web_search",
              description: "Search the web",
              parameters: { type: "object", properties: { query: { type: "string" } } },
            },
          };
        }
        // Drop malformed tools rather than crashing downstream
        return null;
      })
      .filter(Boolean);
  }
  // Normalize reasoning
  if (body.reasoning && typeof body.reasoning === "object") {
    body.reasoning = { enabled: true, effort: body.reasoning.effort };
  }
  // Remove Responses API-specific fields that are meaningless for third-party
  // providers. CCR does not implement a conversation store, so:
  //   - store: OpenAI server-side conversation storage (not supported by CCR)
  //   - previous_response_id: references a stored response (CCR cannot resolve it)
  //   - include: requests extra data in response (not supported by third-party APIs)
  // Keeping these fields would either cause errors at third-party providers or
  // silently be ignored, breaking auto-compact context continuity.
  delete body.store;
  delete body.previous_response_id;
  delete body.include;
}

// Extend FastifyInstance to include custom services
declare module "fastify" {
  interface FastifyInstance {
    configService: ConfigService;
    providerService: ProviderService;
    transformerService: TransformerService;
    recordUsage?: (data: any) => void;
  }

  interface FastifyRequest {
    provider?: string;
  }
}

/**
 * Main handler for transformer endpoints
 * Coordinates the entire request processing flow: validate provider, handle request transformers,
 * send request, handle response transformers, format response
 */
async function handleTransformerEndpoint(
  req: FastifyRequest,
  reply: FastifyReply,
  fastify: FastifyInstance,
  transformer: any
) {
  const body = req.body as any;

  // Normalize Responses API (Codex) format into a unified chat request BEFORE
  // provider resolution. This must happen first so that a CCR family alias can be
  // routed through the shared family router below, which needs messages/system/tools
  // to count tokens.
  if (transformer.endPoint === "/v1/responses" && body?.input && !body?.messages) {
    normalizeResponsesBody(body);
  }

  // Codex sends a bare CCR family alias (e.g. "ccr-opus") to /v1/responses. Run the
  // same family router used for /v1/messages so Codex is routed by the CCR model
  // family (default/think/longContext/webSearch) instead of falling back to
  // Router.default. The router rewrites body.model to "provider,model".
  if (
    transformer.endPoint === "/v1/responses" &&
    !req.provider &&
    typeof body?.model === "string" &&
    CCR_FAMILY_ALIAS.test(body.model)
  ) {
    await router(req, reply, {
      configService: fastify.configService,
      tokenizerService: (fastify as any).tokenizerService,
    });
  }

  // For /v1/responses (Codex) the modelProviderMiddleware does not run because
  // it only handles /v1/messages. Parse provider from body.model here.
  let providerName = req.provider as string | undefined;
  if (!providerName && body?.model) {
    const parts = body.model.split(",");
    if (parts.length > 1) {
      providerName = parts[0];
      body.model = parts.slice(1).join(",");
    }
  }
  // If still no provider (e.g. Codex sends a CCR alias without comma), try
  // resolving via the provider service's model routes which index by model name.
  let provider = providerName
    ? fastify.providerService.getProvider(providerName)
    : undefined;
  if (!provider && body?.model) {
    const route = fastify.providerService.resolveModelRoute(body.model);
    if (route) {
      provider = route.provider;
      body.model = route.targetModel;
    }
  }
  // Last resort: use the Router's default config to resolve the model.
  // This handles Codex-style aliases that don't match any registered model
  // directly but can be mapped via family/default routing.
  if (!provider && body?.model) {
    const routerConfig = fastify.configService.get("Router");
    const defaultRoute = routerConfig?.default;
    if (defaultRoute && defaultRoute.includes(",")) {
      const [pName, ...mParts] = defaultRoute.split(",");
      const p = fastify.providerService.getProvider(pName);
      if (p) {
        provider = p;
        body.model = mParts.join(",");
      }
    }
  }

  // Save original model BEFORE provider resolution mutates body.model (below).
  // modelProviderMiddleware may already have set req.originalModel for /v1/messages,
  // but for /v1/responses (Codex) the middleware doesn't run.
  if (!(req as any).originalModel) {
    (req as any).originalModel = body?.model;
  }

  // Validate provider exists
  if (!provider) {
    throw createApiError(
      `Provider '${providerName}' not found`,
      404,
      "provider_not_found"
    );
  }

  // Expose provider name on the request so downstream hooks (onResponse in
  // server/index.ts) can record it for usage stats and health tracking.
  // This is especially important for /v1/responses where modelProviderMiddleware
  // does not run.
  (req as any).provider = provider.name || providerName;

  // Detect if this is a codex client hitting /v1/messages. Codex sometimes
  // switches from /v1/responses to /v1/messages mid-session. When that happens
  // the Anthropic transformer runs (endpoint = /v1/messages), but the response
  // needs to be converted to Responses API format for codex to parse it.
  // We flag the request so processResponseTransformers can apply the conversion.
  const codexDetected = isCodexClient(req);
  const isCodexOnMessagesEndpoint =
    transformer.endPoint === "/v1/messages" &&
    codexDetected;

  // DEBUG: Set a response header to verify codex detection
  if (codexDetected) {
    reply.header("X-Codex-Detected", "true");
  }
  if (isCodexOnMessagesEndpoint) {
    reply.header("X-Codex-On-Messages", "true");
  }

  // Store codex flags on the request so handleFallback can propagate them
  (req as any).isCodexOnMessagesEndpoint = isCodexOnMessagesEndpoint;
  (req as any).codexDetected = codexDetected;

  try {
    // Safety net: convert any Responses API (Codex) body that was not already
    // normalized above (idempotent — the guard is false once converted).
    if (transformer.endPoint === "/v1/responses" && body.input && !body.messages) {
      normalizeResponsesBody(body);
    }

    // Process request transformer chain
    const { requestBody, config, bypass } = await processRequestTransformers(
      body,
      provider,
      transformer,
      req.headers,
      {
        req,
      }
    );

    // Move system messages to the end of the messages array and dedupe exact
    // repeats so the conversation prefix stays stable for upstream prompt caching.
    // Claude Code may append identical reminder system messages every few turns;
    // if those are sent as a growing list, OpenAI-compatible providers can miss
    // prompt cache even though the user/assistant prefix did not change.
    if (requestBody?.messages && !bypass && !(req as any).isTargetAnthropic) {
      const msgs = requestBody.messages;
      const seenSystem = new Set<string>();
      const systemMsgs: any[] = [];
      const otherMsgs: any[] = [];
      for (const message of msgs) {
        if (message?.role !== "system") {
          otherMsgs.push(message);
          continue;
        }
        const key = JSON.stringify(message.content ?? "");
        if (!seenSystem.has(key)) {
          seenSystem.add(key);
          systemMsgs.push(message);
        }
      }
      if (systemMsgs.length > 0 && otherMsgs.length > 0) {
        requestBody.messages = [...systemMsgs, ...otherMsgs];
      }
    }

    // Send request to LLM provider
    const response = await sendRequestToProvider(
      requestBody,
      config,
      provider,
      fastify,
      bypass,
      transformer,
      {
        req,
      }
    );

    // Capture rate limit headers from upstream response
    try {
      if (provider?.baseUrl && response?.headers) {
        captureRateLimitHeaders(providerName, provider.baseUrl, response.headers);
      }
    } catch {}

    // Process response transformer chain
    let finalResponse = await processResponseTransformers(
      requestBody,
      response,
      provider,
      transformer,
      bypass,
      {
        req,
        isCodexOnMessagesEndpoint,
      }
    );

    // Validate streaming responses have data before forwarding.
    // When GLM/Zhipu returns an empty 200 SSE (e.g. rate-limited or overloaded),
    // the Anthropic-transformed stream lacks message_start, causing Claude Code's
    // SDK to report "empty or malformed response". We detect this early and throw
    // so that the fallback mechanism can try another model instead.
    if (body.stream && finalResponse?.body) {
      const reader = finalResponse.body.getReader();
      const firstResult = await reader.read();
      if (firstResult.done) {
        reader.releaseLock();
        throw createApiError(
          `Provider returned empty streaming response from ${providerName}`,
          400,
          "provider_response_error"
        );
      }
      const firstChunkText = new TextDecoder().decode(firstResult.value);
      // Check if the first chunk contains an SSE error event (e.g. GLM/Zhipu
      // returning error JSON inside the SSE stream). Throw to trigger fallback.
      if (firstChunkText.includes("event: error")) {
        reader.releaseLock();
        const errMsg = firstChunkText.length < 500 ? firstChunkText : firstChunkText.slice(0, 500);
        throw createApiError(
          `Provider ${providerName} returned error in SSE stream: ${errMsg}`,
          400,
          "provider_response_error"
        );
      }
      // Check if the first chunk has no meaningful SSE data lines.
      // Some providers (e.g. GLM) return HTTP 200 with whitespace-only or
      // empty SSE that passes the "done" check but contains no actual content.
      // Detect this and throw to trigger fallback instead of forwarding garbage.
      const dataLines = firstChunkText.split('\n').filter(
        (line: string) => line.startsWith('data:') && line.trim().length > 5
      );
      if (dataLines.length === 0) {
        reader.releaseLock();
        const preview = firstChunkText.length < 500 ? firstChunkText : firstChunkText.slice(0, 500);
        throw createApiError(
          `Provider ${providerName} returned streaming response with no SSE data lines: ${preview}`,
          400,
          "provider_response_error"
        );
      }
      // Reconstruct the stream from the peeked first chunk + remaining data
      const remainingStream = new ReadableStream({
        start: (controller) => {
          controller.enqueue(firstResult.value!);
          const pump = () => {
            reader.read().then(({ done, value }) => {
              if (done) {
                controller.close();
              } else {
                controller.enqueue(value);
                pump();
              }
            }).catch((err) => controller.error(err));
          };
          pump();
        },
        cancel: () => {
          reader.cancel();
        },
      });
      finalResponse = new Response(remainingStream, {
        headers: finalResponse.headers,
        status: finalResponse.status,
        statusText: finalResponse.statusText,
      });
    }

    const result = formatResponse(finalResponse, reply, body, fastify);

    try {
      const model = body.model || (req as any).originalModel;
      if (providerName && model) {
        getHealthStore().recordSuccess(providerName, model);
      }
    } catch {}

    return result;
  } catch (error: any) {
    // Handle fallback for any request error (timeout, network, API errors)
    const fallbackResult = await handleFallback(req, reply, fastify, transformer, error);
    if (fallbackResult) {
      return fallbackResult;
    }
    throw error;
  }
}

/**
 * Handle fallback logic when request fails
 * Tries each fallback model in sequence until one succeeds
 * Skips models in fail pool (open state), uses half-open models as lower priority
 */
async function handleFallback(
  req: FastifyRequest,
  reply: FastifyReply,
  fastify: FastifyInstance,
  transformer: any,
  error: any
): Promise<any> {
  const scenarioType = (req as any).scenarioType || 'default';
  const familyFallback = (req as any).familyFallback;
  const modelFamily = (req as any).modelFamily;
  // Prefer the project-aware fallback config resolved by router() so that
  // per-project Router.fallback overrides (and the enableFallback gate below)
  // are honored instead of always falling back to the global config.
  const globalFallback = (req as any).fallbackConfig ?? fastify.configService.get<any>('fallback');
  const healthStore = getHealthStore();

  const originalProvider = req.provider || "";
  const originalModel = (req.body as any).model || "";
  const attemptedFallbacks = new Set<string>();

  // Hoisted so the fallback-success path below (which calls forceOpen) can skip
  // forceOpen for rate-limit errors — markRateLimited already set rateLimitUntil,
  // and forceOpen would delete it.
  const isRateLimit = error?.statusCode === 429 ||
    error?.isRateLimit === true ||
    (error?.rawBody && isRateLimitError(error.rawBody)) ||
    (error?.message && isRateLimitError(error.message));

  if (originalProvider && originalModel) {
    // Use markRateLimited for rate-limit errors instead of recordFailure
    // so the model is immediately isolated (bypassing the 3-failure threshold)
    // and auto-recovers after a cooldown period.
    if (isRateLimit) {
      healthStore.markRateLimited(originalProvider, originalModel, 120, error?.message);
      req.log.warn(`Primary model ${originalProvider},${originalModel} rate-limited, will try fallbacks`);
    } else {
      healthStore.recordFailure(originalProvider, originalModel, error?.message);
    }
    attemptedFallbacks.add(`${originalProvider},${originalModel}`);

    // Record failed primary model attempt in usage stats
    fastify.recordUsage?.({
      provider: originalProvider,
      model: originalModel,
      originalModel: (req as any).originalModel || originalModel,
      scenarioType,
      modelFamily: (req as any).modelFamily,
      errorMessage: error?.message || String(error),
      sessionId: (req as any).usageSessionId || req.id,
      stream: (req.body as any).stream,
      inputTokens: (req as any).tokenCount || 0,
      req,
    });
  }

  // Check if fallback is enabled (default: false - disabled when not set).
  // Use the project-aware flag set by router(); fall back to the global
  // config for requests that didn't go through router().
  const enableFallback = (req as any).enableFallback ?? (fastify.configService.get<any>('Router')?.enableFallback === true);
  if (!enableFallback) {
    req.log.info(`Fallback disabled by configuration, skipping fallback attempts`);
    return null;
  }

  const parseFallbackModel = (fallbackModel: string) => {
    const [provider, ...modelParts] = fallbackModel.split(',');
    const providerName = provider?.trim();
    const model = modelParts.join(',').trim();

    if (!providerName || !model) {
      return null;
    }

    return {
      provider: providerName,
      model,
      key: `${providerName},${model}`,
    };
  };

  const fallbackStages: Array<{ name: string; models: string[] }> = [];
  if (modelFamily) {
    const familyScenarioFallback = familyFallback?.[scenarioType];
    if (Array.isArray(familyScenarioFallback) && familyScenarioFallback.length > 0) {
      fallbackStages.push({
        name: `${modelFamily}/${scenarioType}`,
        models: familyScenarioFallback,
      });
    } else {
      req.log.warn(`No ${modelFamily} fallback configured for ${scenarioType}; will try global ${scenarioType} fallback`);
    }
  }

  if (Array.isArray(globalFallback?.[scenarioType]) && globalFallback[scenarioType].length > 0) {
    fallbackStages.push({
      name: `global/${scenarioType}`,
      models: globalFallback[scenarioType],
    });
  }

  // Safety net: if request contains images but no fallback was found for the
  // current scenarioType, also try fallback.image. This covers edge cases
  // where scenarioType wasn't set to 'image' by the router.
  if (fallbackStages.length === 0 && scenarioType !== 'image') {
    const body = req.body as any;
    const hasImages = body?.messages?.some(
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
    if (hasImages && Array.isArray(globalFallback?.image) && globalFallback.image.length > 0) {
      req.log.info(`No fallback for scenario '${scenarioType}', but request has images — trying fallback.image`);
      fallbackStages.push({
        name: 'global/image (auto-detected)',
        models: globalFallback.image,
      });
    }
  }

  if (fallbackStages.length === 0) {
    return null;
  }

  const totalFallbacks = fallbackStages.reduce((total, stage) => total + stage.models.length, 0);
  req.log.warn(`Request failed for ${scenarioType}, trying ${totalFallbacks} fallback models across ${fallbackStages.length} fallback stage(s)`);

  for (const fallbackStage of fallbackStages) {
    req.log.info(`Trying ${fallbackStage.name} fallback stage with ${fallbackStage.models.length} models`);

    // Try each fallback model in configured order, skipping open (fail pool) models
    for (const fallbackModel of fallbackStage.models) {
      const fallbackRoute = parseFallbackModel(fallbackModel);
      if (!fallbackRoute) {
        req.log.warn(`Fallback model '${fallbackModel}' is invalid, skipping`);
        continue;
      }

      if (attemptedFallbacks.has(fallbackRoute.key)) {
        continue;
      }
      attemptedFallbacks.add(fallbackRoute.key);

      const fallbackProvider = fallbackRoute.provider;
      const model = fallbackRoute.model;

      try {
        // Skip if model is in fail pool (open state)
        if (!healthStore.isAvailable(fallbackProvider, model)) {
          req.log.warn(`Fallback model ${fallbackModel} unavailable (fail pool), skipping`);
          continue;
        }

        req.log.info(`Trying fallback model: ${fallbackModel}`);

        // Update request with fallback model
        const newBody = { ...(req.body as any) };
        newBody.model = model;

        // Create new request object with updated provider and body
        const newReq = {
          ...req,
          provider: fallbackProvider,
          body: newBody,
        };

        const provider = fastify.providerService.getProvider(fallbackProvider);
        if (!provider) {
          req.log.warn(`Fallback provider '${fallbackProvider}' not found, skipping`);
          continue;
        }

        if (provider.enabled === false) {
          req.log.warn(`Fallback provider '${fallbackProvider}' is disabled, skipping`);
          continue;
        }

        // Process request transformer chain
        const { requestBody, config, bypass } = await processRequestTransformers(
          newBody,
          provider,
          transformer,
          req.headers,
          { req: newReq }
        );

        // Send request to LLM provider
        const response = await sendRequestToProvider(
          requestBody,
          config,
          provider,
          fastify,
          bypass,
          transformer,
          { req: newReq }
        );

        // Capture rate limit headers from upstream response
        try {
          if (provider?.baseUrl && response?.headers) {
            captureRateLimitHeaders(fallbackProvider, provider.baseUrl, response.headers);
          }
        } catch {}

        // Process response transformer chain — propagate codex flags so the
        // fallback response also gets Responses API conversion when needed.
        const finalResponse = await processResponseTransformers(
          requestBody,
          response,
          provider,
          transformer,
          bypass,
          {
            req: newReq,
            isCodexOnMessagesEndpoint: (req as any).isCodexOnMessagesEndpoint || false,
          }
        );

        req.log.info(`Fallback model ${fallbackModel} succeeded`);

        // Record success for the fallback model
        healthStore.recordSuccess(fallbackProvider, model);

        // Promote the fallback model globally for this primary + scenario
        // This ensures all clients skip the failing primary until TTL expires
        if (originalProvider && originalModel) {
          const fallbackPromotion = getFallbackPromotionStore();
          fallbackPromotion.promote(
            originalProvider,
            originalModel,
            scenarioType,
            fallbackProvider,
            model
          );
          req.log.info(`Promoted fallback model ${fallbackProvider},${model} for ${originalProvider},${originalModel}:${scenarioType}`);

          // Immediately mark the original model as unavailable so routing skips it
          // even when promotion TTL expires or is cleared.
          // SKIP forceOpen for rate-limit errors — markRateLimited was already called
          // above and set rateLimitUntil; forceOpen would delete that cooldown timestamp.
          if (!isRateLimit) {
            healthStore.forceOpen(originalProvider, originalModel, error?.message);
            req.log.info(`Marked original model ${originalProvider},${originalModel} as unavailable`);
          } else {
            req.log.info(`Rate-limited original model ${originalProvider},${originalModel} already marked unavailable with cooldown`);
          }
        }

        // Write back to original req so onResponse hook records correct provider/model
        req.provider = fallbackProvider;
        req.body = newBody;

        // Format and return response
        return formatResponse(finalResponse, reply, newBody, fastify);
      } catch (fallbackError: any) {
        healthStore.recordFailure(fallbackProvider, model, fallbackError.message);
        req.log.warn(`Fallback model ${fallbackRoute.key} failed: ${fallbackError.message}`);

        // Record failed fallback attempt in usage stats
        fastify.recordUsage?.({
          provider: fallbackProvider,
          model,
          originalModel: (req.body as any).model,
          scenarioType,
          modelFamily: (req as any).modelFamily,
          errorMessage: fallbackError.message,
          sessionId: (req as any).usageSessionId || req.id,
          stream: (req.body as any).stream,
          req,
        });

        continue;
      }
    }
  }

  req.log.error(`All fallback models failed for ${scenarioType}`);
  return null;
}

/**
 * Process request transformer chain
 * Sequentially execute transformRequestOut, provider transformers, model-specific transformers
 * Returns processed request body, config, and flag indicating whether to skip transformers
 */
async function processRequestTransformers(
  body: any,
  provider: any,
  transformer: any,
  headers: any,
  context: any
) {
  // Deep clone the request body to preserve original messages for caching
  // and to ensure thinking blocks are not lost when switching between models
  let requestBody = JSON.parse(JSON.stringify(body));

  // Normalize per-request "cch=xxx;" hash in billing header system messages.
  // Claude Code injects a rotating hash (cch=...) that changes every request,
  // breaking prompt cache prefix matching on upstream providers like GLM.
  // Keep the field shape but replace the value with a stable token.
  // Must run BEFORE transformers which may restructure system into messages.
  const sys = requestBody?.system;
  if (typeof sys === "string" && sys.includes("cch=")) {
    requestBody.system = sys.replace(/cch=[^;]+;?/g, "cch=ccr-stable;");
  } else if (Array.isArray(sys)) {
    for (let i = 0; i < sys.length; i++) {
      const item = sys[i];
      const t = typeof item === "string" ? item : (item?.text ?? "");
      if (t.includes("cch=")) {
        const cleaned = t.replace(/cch=[^;]+;?/g, "cch=ccr-stable;");
        if (typeof item === "string") {
          sys[i] = cleaned;
        } else if (typeof item?.text === "string") {
          item.text = cleaned;
        }
      }
    }
  }

  let config: any = {};
  let bypass = false;

  // Check if transformers should be bypassed (passthrough mode)
  bypass = shouldBypassTransformers(provider, transformer, body);

  if (bypass) {
    if (headers instanceof Headers) {
      headers.delete("content-length");
    } else {
      delete headers["content-length"];
    }
    config.headers = headers;
  }

  // Execute transformer's transformRequestOut method
  if (!bypass && typeof transformer.transformRequestOut === "function") {
    const transformOut = await transformer.transformRequestOut(requestBody);
    if (transformOut.body) {
      requestBody = transformOut.body;
      config = transformOut.config || {};
    } else {
      requestBody = transformOut;
    }
  }

  // Execute provider-level transformers
  if (!bypass && provider.transformer?.use?.length) {
    for (const providerTransformer of provider.transformer.use) {
      if (
        !providerTransformer ||
        typeof providerTransformer.transformRequestIn !== "function"
      ) {
        continue;
      }
      const transformIn = await providerTransformer.transformRequestIn(
        requestBody,
        provider,
        context
      );
      if (transformIn.body) {
        requestBody = transformIn.body;
        config = { ...config, ...transformIn.config };
      } else {
        requestBody = transformIn;
      }
    }
  }

  // Execute model-specific transformers
  if (!bypass && provider.transformer?.[body.model]?.use?.length) {
    for (const modelTransformer of provider.transformer[body.model].use) {
      if (
        !modelTransformer ||
        typeof modelTransformer.transformRequestIn !== "function"
      ) {
        continue;
      }
      requestBody = await modelTransformer.transformRequestIn(
        requestBody,
        provider,
        context
      );
    }
  }

  return { requestBody, config, bypass };
}

/**
 * Determine if transformers should be bypassed (passthrough mode)
 * Skip other transformers when provider only uses one transformer and it matches the current one
 */
function shouldBypassTransformers(
  provider: any,
  transformer: any,
  body: any
): boolean {
  // If the target API is OpenAI-compatible (/v1/chat/completions) but the system field
  // is an object array (Anthropic format), we must process the request through
  // transformers to convert system array into messages[0] with role=system.
  // Without this conversion, the system prompt is silently dropped by the
  // OpenAI-compatible API, which prevents prefix-based prompt caching.
  if (transformer.endPoint === "/v1/chat/completions" && Array.isArray(body?.system)) {
    return false;
  }

  return (
    provider.transformer?.use?.length === 1 &&
    provider.transformer.use[0].name === transformer.name &&
    (!provider.transformer?.[body.model]?.use.length ||
      (provider.transformer?.[body.model]?.use.length === 1 &&
        provider.transformer?.[body.model]?.use[0].name === transformer.name))
  );
}

/**
 * Detect if the request comes from a codex (OpenAI Codex CLI) client.
 * Codex sometimes switches from /v1/responses to /v1/messages mid-session,
 * so we need to detect it regardless of which endpoint it hits.
 */
function isCodexClient(req: any): boolean {
  const headers = req.headers || {};
  const billingHeader = headers["x-anthropic-billing-header"] || "";
  if (typeof billingHeader === "string" && billingHeader.includes("cc_version=")) {
    return false;
  }

  const userAgent = headers["user-agent"] || "";
  if (typeof userAgent === "string" && /codex/i.test(userAgent)) {
    return true;
  }

  const pathname = req.pathname || req.url || "";
  if (typeof pathname === "string" && pathname.split("?", 1)[0].endsWith("/v1/responses")) {
    return true;
  }

  const originalModel = req.originalModel || req.body?.model || "";
  return typeof originalModel === "string" &&
    originalModel.toLowerCase() === "ccr-codex";
}

/**
 * Send request to LLM provider
 * Handle authentication, build request config, send request and handle errors
 */
async function sendRequestToProvider(
  requestBody: any,
  config: any,
  provider: any,
  fastify: FastifyInstance,
  bypass: boolean,
  transformer: any,
  context: any
) {
  const url = config.url || new URL(provider.baseUrl);

  // Apply timeout from config
  if (!config.TIMEOUT) {
    const timeoutMs = fastify.configService.get<string | number>('API_TIMEOUT_MS');
    if (timeoutMs) {
      config.TIMEOUT = typeof timeoutMs === 'string' ? parseInt(timeoutMs, 10) : timeoutMs;
    }
  }

  // Handle authentication in passthrough mode
  if (bypass && typeof transformer.auth === "function") {
    const auth = await transformer.auth(requestBody, provider);
    if (auth.body) {
      requestBody = auth.body;
      let headers = config.headers || {};
      if (auth.config?.headers) {
        headers = {
          ...headers,
          ...auth.config.headers,
        };
        delete headers.host;
        delete auth.config.headers;
      }
      config = {
        ...config,
        ...auth.config,
        headers,
      };
    } else {
      requestBody = auth;
    }
  }

  // Send HTTP request
  // Prepare headers
  const requestHeaders: Record<string, string> = {
    Authorization: `Bearer ${provider.apiKey}`,
    ...(config?.headers || {}),
  };

  for (const key in requestHeaders) {
    if (requestHeaders[key] === "undefined") {
      delete requestHeaders[key];
    } else if (
      ["authorization", "Authorization"].includes(key) &&
      requestHeaders[key]?.includes("undefined")
    ) {
      delete requestHeaders[key];
    }
  }

  // Debug: log outgoing request to provider
  if (isDebugLogEnabled(fastify.configService)) {
    logProviderRequest(fastify.log, context.req.id, {
      url: String(url),
      headers: requestHeaders,
      body: requestBody,
    });
  }

  const response = await sendUnifiedRequest(
    url,
    requestBody,
    {
      httpsProxy: fastify.configService.getHttpsProxy(),
      ...config,
      headers: JSON.parse(JSON.stringify(requestHeaders)),
    },
    context,
    fastify.log
  );

  // Handle request errors
  if (!response.ok) {
    const errorText = await response.text();
    fastify.log.error(
      `[provider_response_error] Error from provider(${provider.name},${requestBody.model}: ${response.status}): ${errorText}`,
    );
    const error = createApiError(
      `Error from provider(${provider.name},${requestBody.model}: ${response.status}): ${errorText}`,
      response.status,
      "provider_response_error"
    );
    (error as any).isRateLimit = response.status === 429 || isRateLimitError(errorText);
    error.rawBody = errorText;
    throw error;
  }

  // Handle hidden errors in HTTP 200 OK responses (e.g. Zhipu rate limits, empty bodies)
  if (response.ok) {
    const contentType = response.headers.get("content-type") || "";
    const isStreamRequest = requestBody.stream === true;
    // DEBUG: log response metadata to diagnose why empty responses bypass checks
    fastify.log.info(
      `[hidden-error-check] provider=${provider.name} model=${requestBody.model} stream=${requestBody.stream} isStreamRequest=${isStreamRequest} contentType=${contentType} ok=${response.ok} status=${response.status} hasBody=${!!response.body}`
    );
    // For non-streaming requests, always validate the response body regardless
    // of content-type. Some providers return 200 with empty body or non-JSON
    // content-type (e.g. text/event-stream for non-streaming requests), which
    // would bypass the JSON-only hidden error check and forward garbage to the client.
    if (!isStreamRequest || contentType.includes("application/json")) {
      const cloned = response.clone();
      let bodyText = "";
      try {
        bodyText = await cloned.text();
        if (!bodyText || bodyText.trim() === "") {
          throw new SyntaxError("Empty JSON body");
        }
        const bodyJson = JSON.parse(bodyText);
        // Check if the response contains an error object
        if (bodyJson && typeof bodyJson === 'object' && bodyJson.error) {
          // If error is null or explicitly empty, it might not be a real error
          const hasRealError =
            typeof bodyJson.error === 'string' ||
            (typeof bodyJson.error === 'object' && Object.keys(bodyJson.error).length > 0);

          if (hasRealError) {
            fastify.log.error(
              `[provider_response_error] Hidden error from provider(${provider.name},${requestBody.model}: ${response.status}): ${bodyText}`,
            );
            // Classify as rate-limit when error text contains relevant keywords
            const isRateLimit = isRateLimitError(bodyText);
            const error = createApiError(
              `Error from provider(${provider.name},${requestBody.model}: ${response.status}): ${bodyText}`,
              // Promote to 400 to trigger fallback and correct usage logging
              400,
              "provider_response_error"
            );
            (error as any).isRateLimit = isRateLimit;
            error.rawBody = bodyText;
            throw error;
          }
        }
      } catch (e) {
        // Empty or malformed JSON body on HTTP 200 — the provider returned an
        // invalid response. Throw to trigger fallback instead of forwarding
        // the empty response to the client, which would cause a different error.
        if (e instanceof SyntaxError) {
          fastify.log.warn(
            `[provider_response_error] Empty or malformed JSON response from provider(${provider.name},${requestBody.model}: 200): "${bodyText}"`
          );
          const error = createApiError(
            `API returned an empty or malformed response (HTTP 200) from ${provider.name} — check for a proxy or gateway intercepting the request`,
            400,
            "provider_response_error"
          );
          error.rawBody = bodyText;
          throw error;
        }
        // For non-SyntaxError exceptions (e.g. network issues reading cloned body),
        // re-throw so they propagate and trigger fallback too.
        throw e;
      }
    }
  }

  // Debug: log non-stream response from provider
  if (!requestBody.stream && isDebugLogEnabled(fastify.configService)) {
    const cloned = response.clone();
    const bodyText = await cloned.text();
    logProviderResponse(fastify.log, context.req.id, {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: bodyText,
    });
  }

  return response;
}

/**
 * Process response transformer chain
 * Sequentially execute provider transformers, model-specific transformers, transformer's transformResponseIn
 */
async function processResponseTransformers(
  requestBody: any,
  response: any,
  provider: any,
  transformer: any,
  bypass: boolean,
  context: any
) {
  let finalResponse = response;

  // Execute provider-level response transformers
  if (!bypass && provider.transformer?.use?.length) {
    for (const providerTransformer of Array.from(
      provider.transformer.use
    ).reverse() as Transformer[]) {
      if (
        !providerTransformer ||
        typeof providerTransformer.transformResponseOut !== "function"
      ) {
        continue;
      }
      finalResponse = await providerTransformer.transformResponseOut!(
        finalResponse,
        context
      );
    }
  }

  // Execute model-specific response transformers
  if (!bypass && provider.transformer?.[requestBody.model]?.use?.length) {
    for (const modelTransformer of Array.from(
      provider.transformer[requestBody.model].use
    ).reverse() as Transformer[]) {
      if (
        !modelTransformer ||
        typeof modelTransformer.transformResponseOut !== "function"
      ) {
        continue;
      }
      finalResponse = await modelTransformer.transformResponseOut!(
        finalResponse,
        context
      );
    }
  }

  // Execute transformer's transformResponseIn method
  if (!bypass && transformer.transformResponseIn) {
    // Expose provider to transformer so it can read cacheMode for usage translation
    if (!context.provider) context.provider = provider;
    finalResponse = await transformer.transformResponseIn(
      finalResponse,
      context
    );
  }

  // When a codex client sends requests to /v1/messages (instead of /v1/responses),
  // the response is in Anthropic SSE format which codex cannot parse. Apply the
  // Responses API conversion so codex can display the response correctly.
  if (context?.isCodexOnMessagesEndpoint) {
    try {
      const responsesTransformer = new OpenAIResponsesTransformer();
      finalResponse = await responsesTransformer.transformResponseIn(
        finalResponse,
        { ...context, provider }
      );
    } catch (e) {
      // If the conversion fails, fall through and return the original response
      console.error("Failed to apply Responses API conversion for codex client:", e);
    }
  }

  return finalResponse;
}

/**
 * Format and return response
 * Handle HTTP status codes, format streaming and regular responses
 */
function formatResponse(response: any, reply: FastifyReply, body: any, fastify?: FastifyInstance) {
  // Set HTTP status code
  if (!response.ok) {
    reply.code(response.status);
  }

  // Handle streaming response
  const isStream = body.stream === true;
  if (isStream) {
    reply.header("Content-Type", "text/event-stream");
    reply.header("Cache-Control", "no-cache");
    reply.header("Connection", "keep-alive");

    // Debug: tee stream to log SSE chunks
    if (fastify && isDebugLogEnabled(fastify.configService)) {
      const [debugStream, clientStream] = response.body.tee();
      const options = getDebugLogOptions(fastify.configService);
      readStreamForDebug(debugStream, fastify.log, reply.request.id, options);
      return reply.send(clientStream);
    }

    return reply.send(response.body);
  } else {
    // Handle regular JSON response
    return response.json();
  }
}

export const registerApiRoutes = async (
  fastify: FastifyInstance
) => {
  // Health and info endpoints
  fastify.get("/", async () => {
    return { message: "LLMs API", version };
  });

  fastify.get("/health", async () => {
    return { status: "ok", timestamp: new Date().toISOString() };
  });

  // Provider health status endpoint
  fastify.get("/providers/health", async () => {
    const healthStore = getHealthStore();
    const states = healthStore.getAllStates();
    return {
      states: states.map(s => ({
        provider: s.provider,
        model: s.model,
        status: s.status,
        failureCount: s.failureCount,
        successCount: s.successCount,
        lastFailureTime: s.lastFailureTime,
        lastError: s.lastError,
        rateLimitUntil: s.rateLimitUntil ?? null,
      })),
      timestamp: new Date().toISOString(),
    };
  });

  const transformersWithEndpoint =
    fastify.transformerService.getTransformersWithEndpoint();

  for (const { transformer } of transformersWithEndpoint) {
    if (transformer.endPoint) {
      fastify.post(
        transformer.endPoint,
        async (req: FastifyRequest, reply: FastifyReply) => {
          return handleTransformerEndpoint(req, reply, fastify, transformer);
        }
      );
    }
  }

  fastify.post(
    "/providers",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            type: { type: "string", enum: ["openai", "anthropic"] },
            baseUrl: { type: "string" },
            apiKey: { type: "string" },
            models: { type: "array", items: { type: "string" } },
          },
          required: ["id", "name", "type", "baseUrl", "apiKey", "models"],
        },
      },
    },
    async (
      request: FastifyRequest<{ Body: RegisterProviderRequest }>,
      reply: FastifyReply
    ) => {
      // Validation
      const { name, baseUrl, apiKey, models } = request.body;

      if (!name?.trim()) {
        throw createApiError(
          "Provider name is required",
          400,
          "invalid_request"
        );
      }

      if (!baseUrl || !isValidUrl(baseUrl)) {
        throw createApiError(
          "Valid base URL is required",
          400,
          "invalid_request"
        );
      }

      if (!apiKey?.trim()) {
        throw createApiError("API key is required", 400, "invalid_request");
      }

      if (!models || !Array.isArray(models) || models.length === 0) {
        throw createApiError(
          "At least one model is required",
          400,
          "invalid_request"
        );
      }

      // Check if provider already exists
      if (fastify.providerService.getProvider(request.body.name)) {
        throw createApiError(
          `Provider with name '${request.body.name}' already exists`,
          400,
          "provider_exists"
        );
      }

      return fastify.providerService.registerProvider(request.body);
    }
  );

  fastify.get("/providers", async () => {
    return fastify.providerService.getProviders();
  });

  fastify.get(
    "/providers/:id",
    {
      schema: {
        params: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
      },
    },
    async (request: FastifyRequest<{ Params: { id: string } }>) => {
      const provider = fastify.providerService.getProvider(
        request.params.id
      );
      if (!provider) {
        throw createApiError("Provider not found", 404, "provider_not_found");
      }
      return provider;
    }
  );

  fastify.put(
    "/providers/:id",
    {
      schema: {
        params: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
        body: {
          type: "object",
          properties: {
            name: { type: "string" },
            type: { type: "string", enum: ["openai", "anthropic"] },
            baseUrl: { type: "string" },
            apiKey: { type: "string" },
            models: { type: "array", items: { type: "string" } },
            enabled: { type: "boolean" },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Body: Partial<LLMProvider>;
      }>,
      reply
    ) => {
      const provider = fastify.providerService.updateProvider(
        request.params.id,
        request.body
      );
      if (!provider) {
        throw createApiError("Provider not found", 404, "provider_not_found");
      }
      return provider;
    }
  );

  fastify.delete(
    "/providers/:id",
    {
      schema: {
        params: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
      },
    },
    async (request: FastifyRequest<{ Params: { id: string } }>) => {
      const success = fastify.providerService.deleteProvider(
        request.params.id
      );
      if (!success) {
        throw createApiError("Provider not found", 404, "provider_not_found");
      }
      return { message: "Provider deleted successfully" };
    }
  );

  fastify.patch(
    "/providers/:id/toggle",
    {
      schema: {
        params: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
        body: {
          type: "object",
          properties: { enabled: { type: "boolean" } },
          required: ["enabled"],
        },
      },
    },
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Body: { enabled: boolean };
      }>,
      reply
    ) => {
      const success = fastify.providerService.toggleProvider(
        request.params.id,
        request.body.enabled
      );
      if (!success) {
        throw createApiError("Provider not found", 404, "provider_not_found");
      }
      return {
        message: `Provider ${
          request.body.enabled ? "enabled" : "disabled"
        } successfully`,
      };
    }
  );
};

/**
 * Check if an error message or response body indicates a rate-limit error.
 * Matches common patterns across providers (OpenAI, GLM/Zhipu, Anthropic, etc.).
 */
function isRateLimitError(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes('rate limit') ||
    lower.includes('rate_limit') ||
    lower.includes('rate_limit_error') ||
    lower.includes('too many requests') ||
    lower.includes('too many') ||
    lower.includes('quota exhausted') ||
    lower.includes('qps_limit') ||
    lower.includes('token_limit') ||
    lower.includes('限流') ||
    lower.includes('频率限制')
  );
}

// Helper function
function isValidUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}
