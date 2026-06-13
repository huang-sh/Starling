import { createServer, type IncomingMessage, type Server, type ServerResponse } from "http";
import { randomUUID } from "crypto";

export interface CodexChatProxyOptions {
  upstreamBaseUrl: string;
  apiKey: string;
  model?: string;
}

export interface CodexChatProxy {
  baseUrl: string;
  close: () => Promise<void>;
}

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_call_id?: string;
  tool_calls?: unknown[];
}

interface ChatToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

interface StoredResponse {
  messages: ChatMessage[];
}

const JSON_HEADERS = { "content-type": "application/json" };
const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache",
  connection: "keep-alive",
};

export async function startCodexChatProxy(options: CodexChatProxyOptions): Promise<CodexChatProxy> {
  const history = new Map<string, StoredResponse>();
  const upstreamBaseUrl = normalizeUpstreamBaseUrl(options.upstreamBaseUrl);

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      if (req.method === "GET" && isModelsPath(url.pathname)) {
        await handleModels(req, res, upstreamBaseUrl, options.apiKey, url.search);
        return;
      }

      if (req.method === "POST" && isResponsesPath(url.pathname)) {
        const body = await readJsonBody(req);
        await handleResponses(res, body, {
          upstreamBaseUrl,
          apiKey: options.apiKey,
          defaultModel: options.model,
          history,
        });
        return;
      }

      writeJson(res, 404, { error: { message: `Unsupported Codex proxy path: ${url.pathname}` } });
    } catch (error) {
      writeJson(res, 500, {
        error: {
          message: error instanceof Error ? error.message : String(error),
          type: "starling_codex_proxy_error",
        },
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not resolve Starling Codex proxy listen address.");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: () => closeServer(server),
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

async function handleModels(
  req: IncomingMessage,
  res: ServerResponse,
  upstreamBaseUrl: string,
  apiKey: string,
  search: string
): Promise<void> {
  const upstream = await fetch(`${upstreamBaseUrl}/models${search}`, {
    method: "GET",
    headers: forwardHeaders(req, apiKey),
  });
  const body = await upstream.json().catch(() => null) as unknown;
  if (!upstream.ok) {
    writeJson(res, upstream.status, body ?? { models: [] });
    return;
  }
  writeJson(res, 200, normalizeModelsResponse(body));
}

async function handleResponses(
  res: ServerResponse,
  body: unknown,
  context: {
    upstreamBaseUrl: string;
    apiKey: string;
    defaultModel?: string;
    history: Map<string, StoredResponse>;
  }
): Promise<void> {
  if (!isRecord(body)) {
    writeJson(res, 400, { error: { message: "Responses request body must be a JSON object." } });
    return;
  }

  const chatRequest = responsesToChatRequest(body, context.defaultModel, context.history);
  const upstream = await fetch(`${context.upstreamBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${context.apiKey}`,
    },
    body: JSON.stringify(chatRequest),
  });

  const contentType = upstream.headers.get("content-type") || "";
  if (!upstream.ok) {
    const errorText = await upstream.text();
    writeJson(res, upstream.status, chatErrorToResponsesError(errorText, upstream.status));
    return;
  }

  if (chatRequest.stream || contentType.includes("text/event-stream")) {
    await streamChatToResponses(upstream, res, chatRequest.model, context.history);
    return;
  }

  const chatResponse = await upstream.json();
  const { response, storedMessages } = chatCompletionToResponse(chatResponse, chatRequest.model);
  if (typeof response.id === "string") {
    context.history.set(response.id, { messages: [...chatRequest.messages, ...storedMessages] });
  }
  writeJson(res, 200, response);
}

function responsesToChatRequest(
  body: Record<string, unknown>,
  defaultModel: string | undefined,
  history: Map<string, StoredResponse>
): Record<string, unknown> & { model: string; messages: ChatMessage[]; stream: boolean } {
  const model = stringValue(body.model) || defaultModel || "deepseek-v4-pro";
  const messages: ChatMessage[] = [];

  const previousResponseId = stringValue(body.previous_response_id);
  if (previousResponseId) {
    messages.push(...(history.get(previousResponseId)?.messages ?? []));
  }

  const instructions = stringValue(body.instructions);
  if (instructions) messages.push({ role: "system", content: instructions });
  messages.push(...responsesInputToChatMessages(body.input));

  const result: Record<string, unknown> & { model: string; messages: ChatMessage[]; stream: boolean } = {
    model,
    messages,
    stream: body.stream !== false,
  };

  const tools = responsesToolsToChatTools(body.tools);
  if (tools.length > 0) result.tools = tools;
  copyIfPresent(body, result, "temperature");
  copyIfPresent(body, result, "top_p");
  copyIfPresent(body, result, "parallel_tool_calls");
  copyIfPresent(body, result, "tool_choice");
  copyIfPresent(body, result, "stop");
  copyIfPresent(body, result, "frequency_penalty");
  copyIfPresent(body, result, "presence_penalty");
  copyIfPresent(body, result, "seed");
  copyIfPresent(body, result, "stream_options");
  copyIfPresent(body, result, "n");
  if (typeof body.max_output_tokens === "number") result.max_tokens = body.max_output_tokens;
  if (typeof body.max_completion_tokens === "number") result.max_tokens = body.max_completion_tokens;
  const effort = readReasoningEffort(body);
  if (effort) result.reasoning_effort = effort;
  const reasoningObject = body.reasoning;
  if (typeof reasoningObject === "string" && reasoningObject.trim()) {
    copyIfPresent(body, result, "reasoning");
  } else if (isRecord(reasoningObject) && typeof reasoningObject.effort === "string") {
    result.reasoning_effort = reasoningObject.effort;
    copyIfPresent(body, result, "reasoning");
  }

  return result;
}

export function responsesInputToChatMessages(input: unknown): ChatMessage[] {
  if (typeof input === "string") return [{ role: "user", content: input }];
  if (!Array.isArray(input)) return [];

  const messages: ChatMessage[] = [];
  let pendingToolCalls: ChatToolCall[] = [];
  const pendingReasoning: string[] = [];

  const flushPendingReasoning = () => {
    if (pendingReasoning.length === 0) return;
    messages.push({
      role: "system",
      content: `Reasoning: ${pendingReasoning.join("\n")}`,
    });
    pendingReasoning.length = 0;
  };

  const flushPendingToolCalls = () => {
    if (pendingToolCalls.length === 0) return;
    flushPendingReasoning();
    messages.push({ role: "assistant", content: null, tool_calls: pendingToolCalls });
    pendingToolCalls = [];
  };

  for (const item of input) {
    if (!isRecord(item)) continue;
    const type = stringValue(item.type);
    if (type === "function_call" || type === "custom_tool_call" || type === "tool_search_call") {
      const callId = stringValue(item.call_id) || stringValue(item.id) || `call_${randomUUID().replace(/-/g, "")}`;
      const namespace = stringValue(item.namespace);
      const callName = stringValue(item.name) || stringValue(item.tool_name) || "tool_call";
      const name = safeChatToolName(namespace ? `${namespace}_${callName}` : callName);
      const args = stringValue(item.arguments) || stringifyContent(item.input) || "{}";
      pendingToolCalls.push({
        id: callId,
        type: "function",
        function: {
          name,
          arguments: args,
        },
      });
      continue;
    }
    if (type === "function_call_output" || type === "custom_tool_call_output" || type === "tool_search_output") {
      flushPendingToolCalls();
      const callId = stringValue(item.call_id) || stringValue(item.id) || "";
      messages.push({
        role: "tool",
        tool_call_id: callId || undefined,
        content: stringifyContent((item as Record<string, unknown>).output ?? item),
      });
      continue;
    }
    if (type === "reasoning") {
      const text = extractReasoningFromInputItem(item);
      if (text) pendingReasoning.push(text);
      continue;
    }
    if (type === "message" || item.role) {
      flushPendingToolCalls();
      flushPendingReasoning();
      const role = normalizeChatRole(stringValue(item.role));
      if (!role || role === "tool") continue;
      const content = responsesContentToText(item.content);
      const message: ChatMessage = { role, content };
      if ((item as Record<string, unknown>).reasoning) {
        const attached = extractReasoningFromInputItem(item);
        if (attached) {
          const existing = message.content || "";
          message.content = existing ? `${existing}\n\nReasoning: ${attached}` : `Reasoning: ${attached}`;
        }
      }
      messages.push(message);
    }
  }
  flushPendingToolCalls();
  flushPendingReasoning();
  return messages;
}

function responsesContentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return stringifyContent(content);
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      parts.push(part);
      continue;
    }
    if (!isRecord(part)) continue;
    const text = stringValue(part.text) || stringValue(part.input_text) || stringValue(part.output_text);
    if (text) parts.push(text);
  }
  return parts.join("\n");
}

export function responsesToolsToChatTools(tools: unknown): unknown[] {
  if (!Array.isArray(tools)) return [];

  const result: unknown[] = [];
  const seen = new Set<string>();

  const addFunctionTool = (name: string, tool: Record<string, unknown>, namespace?: string | null) => {
    const displayName = safeChatToolName(namespace ? `${namespace}_${name}` : name);
    if (seen.has(displayName)) return;
    seen.add(displayName);

    result.push({
      type: "function",
      function: {
        name: displayName,
        description: stringValue(tool.description) || "",
        parameters: isRecord(tool.parameters) ? tool.parameters : { type: "object", properties: {} },
      },
    });
  };

  const visitTool = (tool: unknown, namespace: string | null = null) => {
    if (typeof tool === "string") {
      const name = tool.trim();
      if (!name) return;
      addFunctionTool(
        name,
        {
          description: "",
          parameters: { type: "object", properties: {} },
        },
        namespace
      );
      return;
    }
    if (!isRecord(tool)) return;

    const toolType = stringValue(tool.type);
    if (toolType === "namespace") {
      const ns = stringValue(tool.name);
      if (!ns) return;
      const children = Array.isArray(tool.tools) ? tool.tools : isRecord(tool.tools) ? [] : Array.isArray(tool.children) ? tool.children : [];
      for (const child of children as unknown[]) {
        visitTool(child, ns);
      }
      return;
    }

    if (toolType === "tool_search") {
      const displayName = "tool_search";
      if (seen.has(displayName)) return;
      seen.add(displayName);
      result.push({
        type: "function",
        function: {
          name: displayName,
          description: "Search and load Codex tools, plugins, connectors, and MCP namespaces for the current task.",
          parameters: { type: "object", properties: { query: { type: "string" }, limit: { type: "integer" } }, required: ["query"] },
        },
      });
      return;
    }

    const name = stringValue(tool.name);
    if (!name) return;
    if (toolType === "custom") {
      const displayName = safeChatToolName(namespace ? `${namespace}_${name}` : name);
      if (seen.has(displayName)) return;
      seen.add(displayName);
      result.push({
        type: "function",
        function: {
          name: displayName,
          description: stringValue(tool.description) || "",
          parameters: {
            type: "object",
            properties: {
              input: {
                type: "string",
                description: "Tool input",
              },
            },
            required: ["input"],
          },
        },
      });
      return;
    }

    if (toolType === "function" || !toolType) {
      addFunctionTool(name, tool, namespace);
    }
  };

  for (const tool of tools) {
    visitTool(tool);
  }

  return result;
}

function safeChatToolName(value: string): string {
  const normalized = value
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || "tool_call";
}

async function streamChatToResponses(
  upstream: Response,
  res: ServerResponse,
  model: string,
  history: Map<string, StoredResponse>
): Promise<void> {
  res.writeHead(200, SSE_HEADERS);

  const responseId = `resp_starling_${randomUUID().replace(/-/g, "")}`;
  const createdAt = Math.floor(Date.now() / 1000);
  const state = createResponseState(responseId, model, createdAt);
  const assistantMessage: ChatMessage = { role: "assistant", content: "" };

  writeSse(res, "response.created", {
    type: "response.created",
    response: responseEnvelope(state, "in_progress", []),
  });

  const reader = upstream.body?.getReader();
  if (!reader) throw new Error("Upstream response did not provide a readable stream.");

  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += new TextDecoder().decode(value, { stream: true });
    const blocks = splitSseBlocks(buffer);
    buffer = blocks.remainder;
    for (const block of blocks.complete) {
      const data = parseSseData(block);
      if (!data || data === "[DONE]") continue;
      const chunk = JSON.parse(data) as unknown;
      for (const event of chatChunkToResponseEvents(chunk, state)) {
        writeSse(res, event.event, event.data);
      }
    }
  }

  const completedOutput = finalizeResponseState(state);
  for (const event of completedOutput.events) {
    writeSse(res, event.event, event.data);
  }
  const response = responseEnvelope(state, "completed", completedOutput.items);
  writeSse(res, "response.completed", { type: "response.completed", response });
  res.end();

  assistantMessage.content = state.text;
  const toolCalls = [...state.toolItems.values()]
    .filter((tool) => tool.started)
    .map((tool) => ({
      id: tool.callId,
      type: "function",
      function: {
        name: tool.name,
        arguments: tool.arguments,
      },
    }));
  if (toolCalls.length > 0) assistantMessage.tool_calls = toolCalls;
  history.set(responseId, { messages: [assistantMessage] });
}

function chatChunkToResponseEvents(
  chunk: unknown,
  state: ReturnType<typeof createResponseState>
): Array<{ event: string; data: unknown }> {
  if (!isRecord(chunk)) return [];
  const model = stringValue(chunk.model);
  if (model) state.model = model;
  const choice = Array.isArray(chunk.choices) && isRecord(chunk.choices[0]) ? chunk.choices[0] : null;
  const delta = isRecord(choice?.delta) ? choice.delta : null;
  const events: Array<{ event: string; data: unknown }> = [];

  const content = stringValue(delta?.content);
  if (content) events.push(...pushTextDelta(state, content));
  const reasoning = stringValue(delta?.reasoning);
  if (reasoning) events.push(...pushReasoningDelta(state, reasoning));

  if (Array.isArray(delta?.tool_calls)) {
    for (const callDelta of delta.tool_calls) {
      if (!isRecord(callDelta)) continue;
      const index = typeof callDelta.index === "number" ? callDelta.index : 0;
      const current = state.toolItems.get(index) ?? {
        itemId: `fc_${randomUUID().replace(/-/g, "")}`,
        callId: stringValue(callDelta.id) || `call_${randomUUID().replace(/-/g, "")}`,
        name: "",
        arguments: "",
        started: false,
        done: false,
        outputIndex: -1,
      };
      if (stringValue(callDelta.id)) {
        current.callId = stringValue(callDelta.id) || current.callId;
      }
      const fn = isRecord(callDelta.function) ? callDelta.function : {};
      const name = stringValue(fn.name);
      const args = stringValue(fn.arguments);
      if (name) current.name = name;
      if (args) current.arguments += args;
      state.toolItems.set(index, current);
      events.push(...pushToolDelta(state, current, args || ""));
    }
  }

  return events;
}

function createResponseState(responseId: string, model: string, createdAt: number) {
  return {
    responseId,
    model,
    createdAt,
    text: "",
    textStarted: false,
    textOutputIndex: 0,
    nextOutputIndex: 0,
    reasoning: {
      text: "",
      started: false,
      done: false,
      outputIndex: -1,
      itemId: `${responseId}_reason`,
    },
    outputItems: new Map<number, unknown>(),
    toolItems: new Map<number, { itemId: string; callId: string; name: string; arguments: string; started: boolean; done: boolean; outputIndex: number }>(),
  };
}

function pushTextDelta(state: ReturnType<typeof createResponseState>, delta: string): Array<{ event: string; data: unknown }> {
  const itemId = `${state.responseId}_msg`;
  const events: Array<{ event: string; data: unknown }> = [];
  if (!state.textStarted) {
    state.textStarted = true;
    state.textOutputIndex = state.nextOutputIndex++;
    const item = { id: itemId, type: "message", status: "in_progress", role: "assistant", content: [] };
    events.push({
      event: "response.output_item.added",
      data: { type: "response.output_item.added", output_index: state.textOutputIndex, item },
    });
    events.push({
      event: "response.content_part.added",
      data: {
        type: "response.content_part.added",
        item_id: itemId,
        output_index: state.textOutputIndex,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      },
    });
  }
  state.text += delta;
  events.push({
    event: "response.output_text.delta",
    data: {
      type: "response.output_text.delta",
      item_id: itemId,
      output_index: state.textOutputIndex,
      content_index: 0,
      delta,
    },
  });
  return events;
}

function pushToolDelta(
  state: ReturnType<typeof createResponseState>,
  current: {
    itemId: string;
    callId: string;
    name: string;
    arguments: string;
    started: boolean;
    done: boolean;
    outputIndex: number;
  },
  delta: string
): Array<{ event: string; data: unknown }> {
  const outputIndex = current.outputIndex < 0 ? state.nextOutputIndex++ : current.outputIndex;
  current.outputIndex = outputIndex;

  const events: Array<{ event: string; data: unknown }> = [];
  if (!current.started) {
    current.started = true;
    events.push({
      event: "response.output_item.added",
      data: {
        type: "response.output_item.added",
        output_index: outputIndex,
        item: {
          id: current.itemId,
          type: "function_call",
          status: "in_progress",
          call_id: current.callId,
          name: current.name,
          arguments: "",
        },
      },
    });
  }
  if (delta) {
    events.push({
      event: "response.function_call_arguments.delta",
      data: {
        type: "response.function_call_arguments.delta",
        item_id: current.itemId,
        output_index: outputIndex,
        delta,
      },
    });
  }
  return events;
}

function finalizeResponseState(state: ReturnType<typeof createResponseState>): {
  events: Array<{ event: string; data: unknown }>;
  items: unknown[];
} {
  const events: Array<{ event: string; data: unknown }> = [];
  const items: unknown[] = [];

  if (state.reasoning.started && !state.reasoning.done) {
    const summary = state.reasoning.text.trim();
    const outputIndex = state.reasoning.outputIndex < 0 ? state.nextOutputIndex++ : state.reasoning.outputIndex;
    state.reasoning.outputIndex = outputIndex;
    state.reasoning.done = true;
    state.outputItems.set(outputIndex, {
      id: state.reasoning.itemId,
      type: "reasoning",
      status: "completed",
      summary: [{ type: "summary_text", text: summary }],
    });
    events.push({
      event: "response.reasoning_summary_text.done",
      data: {
        type: "response.reasoning_summary_text.done",
        item_id: state.reasoning.itemId,
        output_index: outputIndex,
        summary_index: 0,
        text: summary,
      },
    });
    events.push({
      event: "response.output_item.done",
      data: {
        type: "response.output_item.done",
        output_index: outputIndex,
        item: {
          id: state.reasoning.itemId,
          type: "reasoning",
          status: "completed",
          summary: [{ type: "summary_text", text: summary }],
        },
      },
    });
  }

  if (state.textStarted) {
    const itemId = `${state.responseId}_msg`;
    const outputIndex = state.textOutputIndex;
    const item = {
      id: itemId,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: state.text, annotations: [] }],
    };
    events.push({
      event: "response.output_text.done",
      data: {
        type: "response.output_text.done",
        item_id: itemId,
        output_index: outputIndex,
        content_index: 0,
        text: state.text,
      },
    });
    events.push({
      event: "response.content_part.done",
      data: {
        type: "response.content_part.done",
        item_id: itemId,
        output_index: outputIndex,
        content_index: 0,
        part: { type: "output_text", text: state.text, annotations: [] },
      },
    });
    events.push({
      event: "response.output_item.done",
      data: { type: "response.output_item.done", output_index: outputIndex, item },
    });
    items.push(item);
    state.outputItems.set(outputIndex, item);
  }

  for (const tool of state.toolItems.values()) {
    const outputIndex = tool.outputIndex < 0 ? state.nextOutputIndex++ : tool.outputIndex;
    tool.outputIndex = outputIndex;
    if (!tool.started) {
      tool.started = true;
      events.push({
        event: "response.output_item.added",
        data: {
          type: "response.output_item.added",
          output_index: outputIndex,
          item: {
            id: tool.itemId,
            type: "function_call",
            status: "in_progress",
            call_id: tool.callId,
            name: tool.name,
            arguments: "",
          },
        },
      });
    }
    const item = {
      id: tool.itemId,
      type: "function_call",
      status: "completed",
      call_id: tool.callId,
      name: tool.name,
      arguments: tool.arguments,
    };
    events.push({
      event: "response.function_call_arguments.done",
      data: {
        type: "response.function_call_arguments.done",
        item_id: tool.itemId,
        output_index: outputIndex,
        arguments: tool.arguments,
      },
    });
    events.push({
        event: "response.output_item.done",
        data: { type: "response.output_item.done", output_index: outputIndex, item },
      });
      items.push(item);
      state.outputItems.set(outputIndex, item);
    }

  const orderedItems = [...state.outputItems.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, item]) => item);
  return { events, items: orderedItems };
}

function pushReasoningDelta(
  state: ReturnType<typeof createResponseState>,
  delta: string
): Array<{ event: string; data: unknown }> {
  const events: Array<{ event: string; data: unknown }> = [];

  if (!state.reasoning.started) {
    state.reasoning.started = true;
    state.reasoning.outputIndex = state.nextOutputIndex++;
    state.outputItems.set(state.reasoning.outputIndex, {
      id: state.reasoning.itemId,
      type: "reasoning",
      status: "in_progress",
      summary: [{ type: "summary_text", text: "" }],
    });
    events.push({
      event: "response.output_item.added",
      data: {
        type: "response.output_item.added",
        output_index: state.reasoning.outputIndex,
        item: {
          id: state.reasoning.itemId,
          type: "reasoning",
          status: "in_progress",
          summary: [{ type: "summary_text", text: "" }],
        },
      },
    });
  }

  state.reasoning.text += delta;
  events.push({
    event: "response.reasoning_summary_text.delta",
    data: {
      type: "response.reasoning_summary_text.delta",
      item_id: state.reasoning.itemId,
      output_index: state.reasoning.outputIndex,
      summary_index: 0,
      delta,
    },
  });

  return events;
}

function chatCompletionToResponse(chatResponse: unknown, defaultModel: string): { response: Record<string, unknown>; storedMessages: ChatMessage[] } {
  const responseId = isRecord(chatResponse) && stringValue(chatResponse.id) ? `resp_${stringValue(chatResponse.id)}` : `resp_starling_${randomUUID().replace(/-/g, "")}`;
  const choice = isRecord(chatResponse) && Array.isArray(chatResponse.choices) && isRecord(chatResponse.choices[0]) ? chatResponse.choices[0] : {};
  const message = isRecord(choice.message) ? choice.message : {};
  const [text, inlineReasoning] = splitReasoningFromContent(stringValue(message.content) || "");
  const reasoningText = [stringifyContent(message.reasoning), inlineReasoning]
    .map((value) => value.trim())
    .filter(Boolean)
    .join("\n");
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const output: unknown[] = [];
  if (reasoningText) {
    output.push({
      id: `${responseId}_reason`,
      type: "reasoning",
      status: "completed",
      summary: [{ type: "summary_text", text: reasoningText }],
    });
  }
  if (text) {
    output.push({
      id: `${responseId}_msg`,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text, annotations: [] }],
    });
  }
  for (const tool of toolCalls) {
    if (!isRecord(tool)) continue;
    const fn = isRecord(tool.function) ? tool.function : {};
    output.push({
      id: `fc_${randomUUID().replace(/-/g, "")}`,
      type: "function_call",
      status: "completed",
      call_id: stringValue(tool.id) || `call_${randomUUID().replace(/-/g, "")}`,
      name: stringValue(fn.name) || "",
      arguments: stringValue(fn.arguments) || "",
    });
  }
  const response = responseEnvelope(
    {
      responseId,
      model: (isRecord(chatResponse) && stringValue(chatResponse.model)) || defaultModel,
      createdAt: (isRecord(chatResponse) && typeof chatResponse.created === "number" ? chatResponse.created : Math.floor(Date.now() / 1000)),
    },
    "completed",
    output
  );
  return {
    response,
    storedMessages: [{ role: "assistant", content: text, ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}) }],
  };
}

function extractReasoningFromInputItem(item: Record<string, unknown>): string | null {
  const reasoning = item.reasoning;
  if (typeof reasoning === "string" && reasoning.trim()) return reasoning.trim();
  if (isRecord(reasoning)) {
    const summary = reasonSummaryTextFromContainer(reasoning);
    if (summary) return summary.trim();
  }
  if (typeof item.summary === "string" && item.summary.trim()) return item.summary.trim();
  if (Array.isArray(item.summary)) {
    const summary = reasonSummaryTextFromItems(item.summary);
    if (summary) return summary.trim();
  }
  if (isRecord(item.summary)) {
    const summary = reasonSummaryTextFromContainer(item.summary);
    if (summary) return summary.trim();
  }
  const text = stringifyContent(item.text);
  return text ? text.trim() : null;
}

function reasonSummaryTextFromItems(value: unknown[]): string | null {
  const chunks: string[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const text = typeof entry.text === "string" ? entry.text : reasonSummaryTextFromContainer(entry) || "";
    if (text) chunks.push(text);
  }
  return chunks.length > 0 ? chunks.join("\n") : null;
}

function reasonSummaryTextFromContainer(container: Record<string, unknown>): string | null {
  const summary = container.summary;
  if (typeof summary === "string") return summary;
  if (Array.isArray(summary)) {
    const chunks: string[] = [];
    for (const entry of summary) {
      if (!isRecord(entry)) continue;
      const text = typeof entry.text === "string" ? entry.text : "";
      if (text) chunks.push(text);
    }
    return chunks.length > 0 ? chunks.join("\n") : null;
  }
  if (isRecord(summary) && typeof summary.text === "string") return summary.text;
  return null;
}

function splitReasoningFromContent(content: string): [string, string] {
  if (!content) return ["", ""];

  const normalized = content.trim();
  if (!normalized) return ["", ""];

  const reasonParts: string[] = [];
  let remaining = normalized;

  const reasonRegex = /<reasoning>([\s\S]*?)<\/reasoning>/gi;
  remaining = remaining.replace(reasonRegex, (_, captured) => {
    const text = typeof captured === "string" ? captured.trim() : "";
    if (text) reasonParts.push(text);
    return "";
  });

  const thinkRegex = /<think>([\s\S]*?)<\/think>/gi;
  remaining = remaining.replace(thinkRegex, (_, captured) => {
    const text = typeof captured === "string" ? captured.trim() : "";
    if (text) reasonParts.push(text);
    return "";
  });

  const finalRemaining = remaining.replace(/^\s*\n+|\s+$/g, "").replace(/\n{3,}/g, "\n\n");
  const reasoningText = reasonParts.join("\n").trim();

  return [finalRemaining, reasoningText];
}

function responseEnvelope(
  state: { responseId: string; model: string; createdAt: number },
  status: "in_progress" | "completed" | "failed",
  output: unknown[]
): Record<string, unknown> {
  return {
    id: state.responseId,
    object: "response",
    created_at: state.createdAt,
    status,
    model: state.model,
    output,
    parallel_tool_calls: true,
    usage: null,
  };
}

function chatErrorToResponsesError(errorText: string, status: number): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(errorText) as unknown;
  } catch {
    parsed = null;
  }
  const message =
    (isRecord(parsed) && isRecord(parsed.error) && stringValue(parsed.error.message)) ||
    (isRecord(parsed) && stringValue(parsed.message)) ||
    errorText ||
    `Upstream error ${status}`;
  return { error: { message, type: "upstream_error", code: status } };
}

function normalizeModelsResponse(body: unknown): Record<string, unknown> {
  if (isRecord(body) && Array.isArray(body.models)) return body;
  const source = isRecord(body) && Array.isArray(body.data) ? body.data : [];
  const models = source
    .filter(isRecord)
    .map((model, index) => {
      const id = stringValue(model.id) || stringValue(model.name);
      const name = stringValue(model.name) || id;
      return {
        id,
        slug: id,
        name,
        display_name: name,
        description: name,
        default_reasoning_level: "high",
        supported_reasoning_levels: [
          { effort: "low", description: "Fast responses with lighter reasoning" },
          { effort: "medium", description: "Balances speed and reasoning depth" },
          { effort: "high", description: "Greater reasoning depth for complex tasks" },
        ],
        shell_type: "shell_command",
        visibility: "list",
        supported_in_api: true,
        object: stringValue(model.object) || "model",
        owned_by: stringValue(model.owned_by) || "deepseek",
        context_window: 1_000_000,
        max_context_window: 1_000_000,
        priority: 1000 + index,
        additional_speed_tiers: [],
        service_tiers: [],
        availability_nux: null,
        upgrade: null,
        base_instructions: "You are Codex, a coding agent. Help the user with software engineering tasks in the current workspace.",
        model_messages: {
          instructions_template: "You are Codex, a coding agent. Help the user with software engineering tasks in the current workspace.",
        },
        supports_reasoning_summaries: false,
        default_reasoning_summary: "none",
        support_verbosity: true,
        default_verbosity: "low",
        apply_patch_tool_type: "freeform",
        web_search_tool_type: "text_and_image",
        truncation_policy: { mode: "tokens", limit: 10000 },
        supports_parallel_tool_calls: true,
        supports_image_detail_original: true,
        effective_context_window_percent: 95,
        experimental_supported_tools: [],
        input_modalities: ["text"],
        supports_search_tool: true,
        use_responses_lite: false,
      };
    })
    .filter((model) => model.id && model.slug);
  return { models };
}

function normalizeUpstreamBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function isModelsPath(pathname: string): boolean {
  return pathname === "/models" || pathname === "/v1/models";
}

function isResponsesPath(pathname: string): boolean {
  return pathname === "/responses" || pathname === "/v1/responses" || pathname === "/v1/responses/compact";
}

function forwardHeaders(req: IncomingMessage, apiKey: string): Record<string, string> {
  const headers: Record<string, string> = { authorization: `Bearer ${apiKey}` };
  const accept = req.headers.accept;
  if (typeof accept === "string") headers.accept = accept;
  return headers;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf-8");
  return text ? JSON.parse(text) as unknown : {};
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

function writeSse(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function splitSseBlocks(buffer: string): { complete: string[]; remainder: string } {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const parts = normalized.split("\n\n");
  return { complete: parts.slice(0, -1), remainder: parts.at(-1) ?? "" };
}

function parseSseData(block: string): string {
  return block
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
}

function readReasoningEffort(body: Record<string, unknown>): string | null {
  if (isRecord(body.reasoning)) {
    const effort = stringValue(body.reasoning.effort);
    if (effort) return effort;
  }
  return stringValue(body.model_reasoning_effort);
}

function copyIfPresent(source: Record<string, unknown>, target: Record<string, unknown>, key: string): void {
  if (typeof source[key] !== "undefined") target[key] = source[key];
}

function normalizeChatRole(value: string | null): ChatMessage["role"] | null {
  if (value === "system" || value === "user" || value === "assistant" || value === "tool") return value;
  return value ? "user" : null;
}

function stringifyContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  return JSON.stringify(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
