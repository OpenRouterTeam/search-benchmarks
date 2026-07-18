import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import {
  AuthStorage,
  createAgentSessionFromServices,
  createAgentSessionServices,
  getAgentDir,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import OpenAI from "../../node_modules/@earendil-works/pi-coding-agent/node_modules/openai/index.mjs";
import { createAssistantMessageEventStream } from "../../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/index.js";

const CITATION_PRESERVING_PROVIDER = "openrouter-citations";

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    throw new Error("usage: node pi_runner.mjs <input.json>");
  }
  const input = JSON.parse(await fs.readFile(inputPath, "utf8"));
  const params = input.params ?? {};
  const cwd = params.cwd ? path.resolve(params.cwd) : process.cwd();
  const agentDir = params.agent_dir ? path.resolve(params.agent_dir) : getAgentDir();

  const authStorage = AuthStorage.create(path.join(agentDir, "auth.json"));
  const modelRegistry = ModelRegistry.create(authStorage, path.join(agentDir, "models.json"));

  if (process.env.OPENROUTER_API_KEY && params.provider === "openrouter") {
    authStorage.setRuntimeApiKey("openrouter", process.env.OPENROUTER_API_KEY);
  }

  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
  const systemPrompt = [params.system_prompt, input.instructions].filter(Boolean).join("\n\n");
  const providerRequests = [];
  const providerCitations = [];
  const providerResponses = [];
  const providerUsage = { value: null };
  const useCitationAdapter = params.provider === "openrouter" && (
    params.web_search === "server-tool" || params.web_search === "plugin"
  );
  const extensionFactories = [];
  if (useCitationAdapter) {
    extensionFactories.push(openRouterCitationProviderExtension(params, providerRequests, providerCitations, providerResponses, providerUsage));
  } else {
    const serverToolExtension = openRouterServerToolExtension(params, providerRequests);
    if (serverToolExtension) extensionFactories.push(serverToolExtension);
  }
  const services = await createAgentSessionServices({
    cwd,
    agentDir,
    authStorage,
    modelRegistry,
    settingsManager,
    resourceLoaderOptions: {
      systemPromptOverride: () => systemPrompt,
      extensionFactories,
    },
  });
  const diagnostics = services.diagnostics ?? [];
  const fatalDiagnostic = diagnostics.find((diagnostic) => diagnostic.type === "error");
  if (fatalDiagnostic) {
    throw new Error(fatalDiagnostic.message);
  }

  const provider = useCitationAdapter ? CITATION_PRESERVING_PROVIDER : params.provider ?? "openrouter";
  const model = resolveModel(services.modelRegistry, provider, params.model);
  if (!model) {
    throw new Error(`Pi could not resolve model ${provider}/${params.model}`);
  }

  let text = "";
  const events = [];
  const counters = { tool_calls: 0, turns: 0 };
  let finalMessages = [];
  let session;
  try {
    const created = await createAgentSessionFromServices({
      services,
      model,
      ...(params.thinking_level ? { thinkingLevel: params.thinking_level } : {}),
      sessionManager: SessionManager.inMemory(),
      ...(params.tools ? { tools: params.tools } : {}),
      ...(params.no_tools ? { noTools: params.no_tools } : {}),
      ...(params.exclude_tools?.length ? { excludeTools: params.exclude_tools } : {}),
    });
    session = created.session;
    session.subscribe((event) => {
      events.push(event.type);
      if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
        text += event.assistantMessageEvent.delta;
      } else if (event.type === "tool_execution_start") {
        counters.tool_calls += 1;
      } else if (event.type === "turn_end") {
        counters.turns += 1;
      } else if (event.type === "agent_end") {
        finalMessages = event.messages ?? [];
      }
    });
    await session.prompt(input.problem);
    if (!text.trim()) {
      text = lastAssistantText(finalMessages.length ? finalMessages : session.messages);
    }
    process.stdout.write(JSON.stringify({
      final_response: text.trim(),
      model: `${params.provider ?? "openrouter"}/${params.model}`,
      session_id: session.sessionId,
      counters,
      events,
      usage: providerUsage.value ?? usageFromMessages(finalMessages),
      provider_requests: providerRequests,
      provider_citations: providerCitations,
      provider_responses: providerResponses,
      messages: finalMessages,
      diagnostics,
    }));
  } finally {
    session?.dispose();
  }
}

function resolveModel(modelRegistry, provider, modelId) {
  const exact = modelRegistry.find(provider, modelId);
  if (exact) return exact;

  // Pi's built-in OpenRouter catalog can lag OpenRouter variants such as
  // z-ai/glm-5.2:nitro. Reuse the base model's provider metadata while keeping
  // the exact requested id that OpenRouter accepts.
  const lastColon = modelId.lastIndexOf(":");
  const lastSlash = modelId.lastIndexOf("/");
  if (lastColon > lastSlash) {
    const baseId = modelId.slice(0, lastColon);
    const base = modelRegistry.find(provider, baseId);
    if (base) {
      return { ...base, id: modelId, name: modelId };
    }
  }
  return undefined;
}

function openRouterServerToolExtension(params, providerRequests) {
  if (params.provider !== "openrouter" || params.web_search !== "server-tool") return null;
  const webSearchTool = buildWebSearchTool(params);
  return (pi) => {
    pi.on("before_provider_request", (event) => {
      const payload = { ...event.payload };
      const existingTools = Array.isArray(payload.tools) ? payload.tools : [];
      payload.tools = [...existingTools, webSearchTool];
      if (params.max_tool_calls) {
        payload.stop_server_tools_when = [{ type: "step_count_is", step_count: params.max_tool_calls }];
      }
      providerRequests.push({
        tools: payload.tools,
        stop_server_tools_when: payload.stop_server_tools_when,
      });
      return payload;
    });
  };
}

function buildWebSearchTool(params) {
  const parameters = {};
  if (params.max_results_per_search !== "default") parameters.max_results = params.max_results_per_search;
  if (params.max_total_results) parameters.max_total_results = params.max_total_results;
  if (params.search_backend) parameters.engine = params.search_backend;
  if (params.search_context_size && !params.max_characters) parameters.search_context_size = params.search_context_size;
  if (params.max_characters) parameters.max_characters = params.max_characters;
  if (Array.isArray(params.allowed_domains) && params.allowed_domains.length) {
    parameters.allowed_domains = params.allowed_domains;
  }
  if (Array.isArray(params.excluded_domains) && params.excluded_domains.length) {
    parameters.excluded_domains = params.excluded_domains;
  }
  return { type: "openrouter:web_search", parameters };
}

function openRouterCitationProviderExtension(params, providerRequests, providerCitations, providerResponses, providerUsage) {
  return (pi) => {
    pi.registerProvider(CITATION_PRESERVING_PROVIDER, {
      name: "OpenRouter with citations",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "$OPENROUTER_API_KEY",
      api: "openrouter-citations-chat-completions",
      streamSimple: (model, context, options) => streamOpenRouterWithCitations(model, context, options, {
        params,
        providerRequests,
        providerCitations,
        providerResponses,
        providerUsage,
      }),
      models: [citationModelDefinition(params)],
    });
  };
}

function citationModelDefinition(params) {
  return {
    id: params.model,
    name: params.model,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
    compat: {
      thinkingFormat: "openrouter",
      supportsReasoningEffort: true,
    },
  };
}

function streamOpenRouterWithCitations(model, context, options, capture) {
  const stream = createAssistantMessageEventStream();
  (async () => {
    const output = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: emptyPiUsage(),
      stopReason: "stop",
      timestamp: Date.now(),
    };
    try {
      const payload = buildOpenRouterPayload(model, context, options, capture.params);
      capture.providerRequests.push(summarizeOpenRouterPayload(payload));

      const nextPayload = await options?.onPayload?.(payload, model);
      const requestPayload = nextPayload === undefined ? payload : nextPayload;
      const client = new OpenAI({
        apiKey: options?.apiKey || process.env.OPENROUTER_API_KEY,
        baseURL: "https://openrouter.ai/api/v1",
        dangerouslyAllowBrowser: true,
        defaultHeaders: options?.headers,
      });
      const requestOptions = {
        ...(options?.signal ? { signal: options.signal } : {}),
        ...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
        maxRetries: options?.maxRetries ?? 0,
      };
      const { data: response, response: rawResponse } = await client.chat.completions
        .create(requestPayload, requestOptions)
        .withResponse();

      await options?.onResponse?.({ status: rawResponse.status, headers: headersToRecord(rawResponse.headers) }, model);
      output.responseId = response.id;
      if (typeof response.model === "string" && response.model.length > 0 && response.model !== model.id) {
        output.responseModel = response.model;
      }
      output.usage = parseOpenRouterUsage(response.usage);
      capture.providerUsage.value = piUsageToHarnessUsage(output.usage);

      const choice = Array.isArray(response.choices) ? response.choices[0] : undefined;
      const message = choice?.message ?? {};
      output.stopReason = mapFinishReason(choice?.finish_reason);
      const annotations = collectAnnotations(response);
      const citations = annotations.filter((annotation) => annotation?.type === "url_citation");
      capture.providerCitations.push(...citations);
      capture.providerResponses.push({
        id: response.id,
        model: response.model,
        finish_reason: choice?.finish_reason,
        usage: response.usage,
        annotations,
      });

      stream.push({ type: "start", partial: output });
      const reasoning = firstString(message.reasoning, message.reasoning_content, message.reasoning_text);
      if (reasoning) {
        const block = { type: "thinking", thinking: reasoning, thinkingSignature: "reasoning" };
        output.content.push(block);
        const contentIndex = output.content.indexOf(block);
        stream.push({ type: "thinking_start", contentIndex, partial: output });
        stream.push({ type: "thinking_delta", contentIndex, delta: reasoning, partial: output });
        stream.push({ type: "thinking_end", contentIndex, content: reasoning, partial: output });
      }

      const text = messageText(message.content);
      if (text) {
        const block = { type: "text", text };
        output.content.push(block);
        const contentIndex = output.content.indexOf(block);
        stream.push({ type: "text_start", contentIndex, partial: output });
        stream.push({ type: "text_delta", contentIndex, delta: text, partial: output });
        stream.push({ type: "text_end", contentIndex, content: text, partial: output });
      }
      if (output.stopReason === "error") {
        throw new Error(`Provider returned finish_reason=${choice?.finish_reason ?? "unknown"}`);
      }
      stream.push({ type: "done", reason: output.stopReason, message: output });
      stream.end();
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error?.message ?? String(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();
  return stream;
}

function buildOpenRouterPayload(model, context, options, params) {
  const payload = {
    model: model.id,
    messages: convertContextToOpenAIMessages(context),
    stream: false,
  };
  if (options?.temperature !== undefined) payload.temperature = options.temperature;
  if (options?.maxTokens) payload.max_tokens = options.maxTokens;
  if (options?.reasoning && options.reasoning !== "off") {
    payload.reasoning = { effort: options.reasoning };
  }
  if (params.web_search === "server-tool") {
    payload.tools = [buildWebSearchTool(params)];
    if (params.max_tool_calls) {
      payload.stop_server_tools_when = [{ type: "step_count_is", step_count: params.max_tool_calls }];
    }
  } else if (params.web_search === "plugin") {
    payload.plugins = [buildWebPlugin(params)];
  }
  return payload;
}

function buildWebPlugin(params) {
  const plugin = { id: "web" };
  if (params.max_results_per_search !== "default") plugin.max_results = params.max_results_per_search;
  if (params.search_backend) plugin.engine = params.search_backend;
  if (Array.isArray(params.allowed_domains) && params.allowed_domains.length) {
    plugin.include_domains = params.allowed_domains;
  }
  if (Array.isArray(params.excluded_domains) && params.excluded_domains.length) {
    plugin.exclude_domains = params.excluded_domains;
  }
  return plugin;
}

function convertContextToOpenAIMessages(context) {
  const messages = [];
  if (context.systemPrompt) {
    messages.push({ role: "system", content: context.systemPrompt });
  }
  for (const message of context.messages ?? []) {
    if (message.role === "user") {
      messages.push({ role: "user", content: contentToText(message.content) });
    } else if (message.role === "assistant") {
      const content = contentToText(message.content?.filter?.((block) => block.type !== "toolCall") ?? message.content);
      if (content.trim()) messages.push({ role: "assistant", content });
    } else if (message.role === "toolResult") {
      messages.push({ role: "tool", tool_call_id: message.toolCallId, content: contentToText(message.content) });
    }
  }
  return messages;
}

function contentToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => block?.text ?? block?.thinking ?? "").filter(Boolean).join("\n");
}

function messageText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((item) => {
    if (typeof item === "string") return item;
    if (item?.type === "text") return item.text ?? "";
    if (item?.text) return item.text;
    return "";
  }).join("");
}

function collectAnnotations(response) {
  const annotations = [];
  for (const choice of response?.choices ?? []) {
    for (const annotation of choice?.message?.annotations ?? []) {
      annotations.push(annotation);
    }
    for (const annotation of choice?.annotations ?? []) {
      annotations.push(annotation);
    }
  }
  for (const annotation of response?.annotations ?? []) {
    annotations.push(annotation);
  }
  return annotations;
}

function summarizeOpenRouterPayload(payload) {
  return {
    tools: payload.tools,
    stop_server_tools_when: payload.stop_server_tools_when,
    stream: payload.stream,
  };
}

function parseOpenRouterUsage(usage) {
  const input = Number(usage?.prompt_tokens ?? 0) || 0;
  const output = Number(usage?.completion_tokens ?? 0) || 0;
  const cachedInput = Number(usage?.prompt_tokens_details?.cached_tokens ?? 0) || 0;
  const reasoning = Number(usage?.completion_tokens_details?.reasoning_tokens ?? 0) || 0;
  const totalTokens = Number(usage?.total_tokens ?? input + output) || 0;
  return {
    input,
    output,
    cacheRead: cachedInput,
    cacheWrite: 0,
    reasoning,
    totalTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function piUsageToHarnessUsage(usage) {
  return {
    input_tokens: usage.input ?? 0,
    output_tokens: usage.output ?? 0,
    total_tokens: usage.totalTokens ?? 0,
    cached_input_tokens: usage.cacheRead ?? 0,
    reasoning_tokens: usage.reasoning ?? 0,
  };
}

function usageFromMessages(messages) {
  const assistant = [...(messages ?? [])].reverse().find((message) => message?.role === "assistant" && message?.usage);
  return assistant ? piUsageToHarnessUsage(assistant.usage) : null;
}

function emptyPiUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function mapFinishReason(reason) {
  if (reason === "length") return "length";
  if (reason === "tool_calls" || reason === "function_call") return "toolUse";
  if (reason === "content_filter") return "error";
  return "stop";
}

function headersToRecord(headers) {
  const record = {};
  headers?.forEach?.((value, key) => {
    record[key] = value;
  });
  return record;
}

function firstString(...values) {
  return values.find((value) => typeof value === "string" && value.length > 0) ?? "";
}

function lastAssistantText(messages) {
  if (!Array.isArray(messages)) return "";
  for (const message of [...messages].reverse()) {
    const role = message?.role ?? message?.type;
    if (role !== "assistant") continue;
    const content = message?.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content.map((item) => item?.text ?? "").join("").trim();
    }
  }
  return "";
}

export { buildOpenRouterPayload };

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exit(1);
  });
}
