#!/usr/bin/env node
import {
  addBookmark,
  addSpace,
  catalogPath,
  findBookmark,
  generateBookmarkId,
  generateSpaceId,
  listBookmarks,
  listSpaces,
  resolveCatalogReference,
  updateBookmark
} from "./chunk-L7RS3LU7.js";
import "./chunk-EBT5CKYR.js";
import {
  extractClaudeSessionMeta,
  extractCodexSessionMeta,
  findSessionById,
  findSessions,
  parseJsonlHead
} from "./chunk-FBJPGCDT.js";
import {
  hasKnownConfigExtension,
  resolveCodexConfigPath
} from "./chunk-PWS26QTV.js";
import {
  CLAUDE_SESSIONS_DIR,
  CODEX_SESSIONS_DIR,
  DEFAULT_CLAUDE_SETTINGS_DIR,
  DEFAULT_CODEX_HOME,
  DEFAULT_CODEX_SETTINGS_DIR,
  DEFAULT_STARLING_HOME,
  atomicWriteJSON,
  ensureDir
} from "./chunk-RWHPIOVN.js";

// src/commands/run.ts
import { Command } from "commander";
import chalk from "chalk";
import { randomUUID as randomUUID2 } from "crypto";
import { chmodSync as chmodSync2, existsSync as existsSync2, readFileSync as readFileSync2, readdirSync, statSync as statSync2, unlinkSync as unlinkSync2, writeFileSync as writeFileSync2 } from "fs";
import { createInterface } from "readline/promises";
import { spawn } from "child_process";
import { basename, extname, isAbsolute, join as join2, resolve } from "path";

// src/lib/codexChatProxy.ts
import { createServer } from "http";
import { randomUUID } from "crypto";
var JSON_HEADERS = { "content-type": "application/json" };
var SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache",
  connection: "keep-alive"
};
async function startCodexChatProxy(options) {
  const history = /* @__PURE__ */ new Map();
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
          history
        });
        return;
      }
      writeJson(res, 404, { error: { message: `Unsupported Codex proxy path: ${url.pathname}` } });
    } catch (error) {
      writeJson(res, 500, {
        error: {
          message: error instanceof Error ? error.message : String(error),
          type: "starling_codex_proxy_error"
        }
      });
    }
  });
  await new Promise((resolve2, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve2();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not resolve Starling Codex proxy listen address.");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: () => closeServer(server)
  };
}
function closeServer(server) {
  return new Promise((resolve2) => {
    server.close(() => resolve2());
  });
}
async function handleModels(req, res, upstreamBaseUrl, apiKey, search) {
  const upstream = await fetch(`${upstreamBaseUrl}/models${search}`, {
    method: "GET",
    headers: forwardHeaders(req, apiKey)
  });
  const body = await upstream.json().catch(() => null);
  if (!upstream.ok) {
    writeJson(res, upstream.status, body ?? { models: [] });
    return;
  }
  writeJson(res, 200, normalizeModelsResponse(body));
}
async function handleResponses(res, body, context) {
  if (!isRecord(body)) {
    writeJson(res, 400, { error: { message: "Responses request body must be a JSON object." } });
    return;
  }
  const chatRequest = responsesToChatRequest(body, context.defaultModel, context.history);
  const upstream = await fetch(`${context.upstreamBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${context.apiKey}`
    },
    body: JSON.stringify(chatRequest)
  });
  const contentType = upstream.headers.get("content-type") || "";
  if (!upstream.ok) {
    const errorText = await upstream.text();
    writeJson(res, upstream.status, chatErrorToResponsesError(errorText, upstream.status));
    return;
  }
  if (chatRequest.stream || contentType.includes("text/event-stream")) {
    await streamChatToResponses(upstream, res, chatRequest.model, context.history, chatRequest.toolMetadata);
    return;
  }
  const chatResponse = await upstream.json();
  const { response, storedMessages } = chatCompletionToResponse(chatResponse, chatRequest.model, chatRequest.toolMetadata);
  if (typeof response.id === "string") {
    context.history.set(response.id, { messages: [...chatRequest.messages, ...storedMessages] });
  }
  writeJson(res, 200, response);
}
function responsesToChatRequest(body, defaultModel, history) {
  const model = stringValue(body.model) || defaultModel || "deepseek-v4-pro";
  const messages = [];
  const previousResponseId = stringValue(body.previous_response_id);
  if (previousResponseId) {
    messages.push(...history.get(previousResponseId)?.messages ?? []);
  }
  const instructions = stringValue(body.instructions);
  if (instructions) messages.push({ role: "system", content: instructions });
  messages.push(...responsesInputToChatMessages(body.input));
  const result = {
    model,
    messages,
    stream: body.stream !== false,
    toolMetadata: /* @__PURE__ */ new Map()
  };
  const { tools, metadata } = responsesToolsToChatToolsWithMetadata(body.tools, messages);
  result.toolMetadata = metadata;
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
function responsesInputToChatMessages(input) {
  if (typeof input === "string") return [{ role: "user", content: input }];
  if (!Array.isArray(input)) return [];
  const messages = [];
  let pendingToolCalls = [];
  const pendingReasoning = [];
  const flushPendingReasoning = () => {
    if (pendingReasoning.length === 0) return;
    messages.push({
      role: "system",
      content: `Reasoning: ${pendingReasoning.join("\n")}`
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
          arguments: args
        }
      });
      continue;
    }
    if (type === "function_call_output" || type === "custom_tool_call_output" || type === "tool_search_output") {
      flushPendingToolCalls();
      const callId = stringValue(item.call_id) || stringValue(item.id) || "";
      messages.push({
        role: "tool",
        tool_call_id: callId || void 0,
        content: stringifyContent(item.output ?? item)
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
      const message = { role, content };
      if (item.reasoning) {
        const attached = extractReasoningFromInputItem(item);
        if (attached) {
          const existing = message.content || "";
          message.content = existing ? `${existing}

Reasoning: ${attached}` : `Reasoning: ${attached}`;
        }
      }
      messages.push(message);
    }
  }
  flushPendingToolCalls();
  flushPendingReasoning();
  return messages;
}
function responsesContentToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return stringifyContent(content);
  const parts = [];
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
function responsesToolsToChatToolsWithMetadata(tools, messages = []) {
  if (!Array.isArray(tools)) return { tools: [], metadata: /* @__PURE__ */ new Map() };
  const result = [];
  const metadata = /* @__PURE__ */ new Map();
  const seen = /* @__PURE__ */ new Set();
  const runningProcessIds = extractRunningProcessIds(messages);
  const addFunctionTool = (name, tool, namespace, responseType = "function_call", extraMetadata = {}) => {
    const displayName = safeChatToolName(namespace ? `${namespace}_${name}` : name);
    if (displayName === "write_stdin" && runningProcessIds.length === 0) return;
    if (seen.has(displayName)) return;
    seen.add(displayName);
    metadata.set(displayName, {
      responseType,
      responseName: responseType === "custom_tool_call" ? name : displayName,
      ...extraMetadata
    });
    result.push({
      type: "function",
      function: {
        name: displayName,
        description: toolDescriptionForChat(displayName, tool, runningProcessIds),
        parameters: toolParametersForChat(displayName, tool, runningProcessIds)
      }
    });
  };
  const visitTool = (tool, namespace = null) => {
    if (typeof tool === "string") {
      const name2 = tool.trim();
      if (!name2) return;
      addFunctionTool(
        name2,
        {
          description: "",
          parameters: { type: "object", properties: {} }
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
      for (const child of children) {
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
          parameters: { type: "object", properties: { query: { type: "string" }, limit: { type: "integer" } }, required: ["query"] }
        }
      });
      return;
    }
    const name = stringValue(tool.name);
    if (!name) return;
    if (toolType === "custom") {
      if (name === "apply_patch") {
        addApplyPatchProxyTools(name, tool, namespace);
        return;
      }
      addFunctionTool(
        name,
        {
          description: stringValue(tool.description) || "",
          parameters: {
            type: "object",
            properties: {
              input: { type: "string", description: "Tool input" }
            },
            required: ["input"]
          }
        },
        namespace,
        "custom_tool_call"
      );
      return;
    }
    if (toolType === "function" || !toolType) {
      addFunctionTool(name, tool, namespace);
    }
  };
  for (const tool of tools) {
    visitTool(tool);
  }
  return { tools: result, metadata };
  function addApplyPatchProxyTools(name, tool, namespace) {
    const baseDescription = stringValue(tool.description) || "Apply a source code patch.";
    const addProxy = (suffix, description, parameters) => {
      addFunctionTool(
        `${name}_${suffix}`,
        {
          description: `${baseDescription}

${description}`,
          parameters
        },
        namespace,
        "custom_tool_call",
        {
          responseName: name,
          applyPatchProxy: suffix
        }
      );
    };
    addProxy(
      "add_file",
      "Create one new file by providing a target path and full file content. Do not include patch '+' prefixes in content.",
      {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string", description: "Target file path." },
          content: { type: "string", description: "Full file content without patch '+' prefixes." }
        },
        required: ["path", "content"]
      }
    );
    addProxy(
      "delete_file",
      "Delete one file by providing a target path.",
      {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string", description: "Target file path." }
        },
        required: ["path"]
      }
    );
    addProxy(
      "update_file",
      "Edit one existing file with structured hunks.",
      {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string", description: "Target file path." },
          move_to: { type: "string", description: "Optional destination path for move operations." },
          hunks: applyPatchHunksSchema()
        },
        required: ["path", "hunks"]
      }
    );
    addProxy(
      "replace_file",
      "Replace one existing file by providing a target path and full new file content.",
      {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string", description: "Target file path." },
          content: { type: "string", description: "Full replacement content." }
        },
        required: ["path", "content"]
      }
    );
    addProxy(
      "batch",
      "Edit files by providing ordered structured patch operations.",
      {
        type: "object",
        additionalProperties: false,
        properties: {
          operations: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                type: { type: "string", enum: ["add_file", "delete_file", "update_file", "replace_file"] },
                path: { type: "string" },
                move_to: { type: "string", description: "Optional destination path for update_file move operations." },
                content: { type: "string", description: "Full content for add_file or replace_file." },
                hunks: applyPatchHunksSchema()
              },
              required: ["type", "path"]
            }
          }
        },
        required: ["operations"]
      }
    );
  }
}
function extractRunningProcessIds(messages) {
  const ids = /* @__PURE__ */ new Set();
  for (const message of messages) {
    if (typeof message.content !== "string") continue;
    for (const match of message.content.matchAll(/Process running with session ID\s+(\d+)/g)) {
      const id = Number(match[1]);
      if (Number.isFinite(id)) ids.add(id);
    }
  }
  return [...ids].sort((a, b) => a - b);
}
function toolDescriptionForChat(displayName, tool, runningProcessIds) {
  const description = stringValue(tool.description) || "";
  if (displayName !== "write_stdin") return description;
  return [
    description,
    `Only use this tool to poll or send input to a process that is still running from a previous exec_command result. Valid session_id values for this request: ${runningProcessIds.join(", ")}.`,
    "Do not use write_stdin to create or edit files; use exec_command or apply_patch instead."
  ].filter(Boolean).join("\n");
}
function toolParametersForChat(displayName, tool, runningProcessIds) {
  const parameters = isRecord(tool.parameters) ? JSON.parse(JSON.stringify(tool.parameters)) : { type: "object", properties: {} };
  if (displayName !== "write_stdin") return parameters;
  if (!isRecord(parameters.properties)) {
    parameters.properties = {};
  }
  const properties = parameters.properties;
  const sessionId = isRecord(properties.session_id) ? { ...properties.session_id } : { type: "integer" };
  sessionId.enum = runningProcessIds;
  properties.session_id = sessionId;
  parameters.properties = properties;
  return parameters;
}
function safeChatToolName(value) {
  const normalized = value.trim().replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  return normalized || "tool_call";
}
async function streamChatToResponses(upstream, res, model, history, toolMetadata) {
  res.writeHead(200, SSE_HEADERS);
  const responseId = `resp_starling_${randomUUID().replace(/-/g, "")}`;
  const createdAt = Math.floor(Date.now() / 1e3);
  const state = createResponseState(responseId, model, createdAt);
  const assistantMessage = { role: "assistant", content: "" };
  writeSse(res, "response.created", {
    type: "response.created",
    response: responseEnvelope(state, "in_progress", [])
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
      const chunk = JSON.parse(data);
      for (const event of chatChunkToResponseEvents(chunk, state, toolMetadata)) {
        writeSse(res, event.event, event.data);
      }
    }
  }
  const completedOutput = finalizeResponseState(state, toolMetadata);
  for (const event of completedOutput.events) {
    writeSse(res, event.event, event.data);
  }
  const response = responseEnvelope(state, "completed", completedOutput.items);
  writeSse(res, "response.completed", { type: "response.completed", response });
  res.end();
  assistantMessage.content = state.text;
  const toolCalls = [...state.toolItems.values()].filter((tool) => tool.started).map((tool) => ({
    id: tool.callId,
    type: "function",
    function: {
      name: tool.name,
      arguments: toolArgumentsForChatHistory(tool, toolMetadata.get(tool.name))
    }
  }));
  if (toolCalls.length > 0) assistantMessage.tool_calls = toolCalls;
  history.set(responseId, { messages: [assistantMessage] });
}
function chatChunkToResponseEvents(chunk, state, toolMetadata) {
  if (!isRecord(chunk)) return [];
  const model = stringValue(chunk.model);
  if (model) state.model = model;
  const choice = Array.isArray(chunk.choices) && isRecord(chunk.choices[0]) ? chunk.choices[0] : null;
  const delta = isRecord(choice?.delta) ? choice.delta : null;
  const events = [];
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
        outputIndex: -1
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
      events.push(...pushToolDelta(state, current, args || "", toolMetadata));
    }
  }
  return events;
}
function createResponseState(responseId, model, createdAt) {
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
      itemId: `${responseId}_reason`
    },
    outputItems: /* @__PURE__ */ new Map(),
    toolItems: /* @__PURE__ */ new Map()
  };
}
function pushTextDelta(state, delta) {
  const itemId = `${state.responseId}_msg`;
  const events = [];
  if (!state.textStarted) {
    state.textStarted = true;
    state.textOutputIndex = state.nextOutputIndex++;
    const item = { id: itemId, type: "message", status: "in_progress", role: "assistant", content: [] };
    events.push({
      event: "response.output_item.added",
      data: { type: "response.output_item.added", output_index: state.textOutputIndex, item }
    });
    events.push({
      event: "response.content_part.added",
      data: {
        type: "response.content_part.added",
        item_id: itemId,
        output_index: state.textOutputIndex,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] }
      }
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
      delta
    }
  });
  return events;
}
function pushToolDelta(state, current, delta, toolMetadata) {
  const outputIndex = current.outputIndex < 0 ? state.nextOutputIndex++ : current.outputIndex;
  current.outputIndex = outputIndex;
  const events = [];
  const metadata = toolMetadata.get(current.name) || inferApplyPatchMetadataFromToolName(current.name);
  if (!current.started) {
    current.started = true;
    const item = metadata?.responseType === "custom_tool_call" ? {
      id: current.itemId,
      type: "custom_tool_call",
      status: "in_progress",
      call_id: current.callId,
      name: metadata.responseName,
      input: ""
    } : {
      id: current.itemId,
      type: "function_call",
      status: "in_progress",
      call_id: current.callId,
      name: current.name,
      arguments: ""
    };
    events.push({
      event: "response.output_item.added",
      data: {
        type: "response.output_item.added",
        output_index: outputIndex,
        item
      }
    });
  }
  return events;
}
function responseToolItem(tool, metadata, status) {
  const effectiveMetadata = metadata || inferApplyPatchMetadataFromToolName(tool.name);
  if (effectiveMetadata?.responseType === "custom_tool_call") {
    return {
      id: tool.itemId,
      type: "custom_tool_call",
      status,
      call_id: tool.callId,
      name: effectiveMetadata.responseName,
      input: status === "completed" ? customToolInputFromChatArguments(tool.arguments, effectiveMetadata) : ""
    };
  }
  return {
    id: tool.itemId,
    type: "function_call",
    status,
    call_id: tool.callId,
    name: tool.name,
    arguments: status === "completed" ? functionToolArgumentsFromChatArguments(tool.arguments) : ""
  };
}
function inferApplyPatchMetadataFromToolName(name) {
  if (name === "apply_patch") {
    return { responseType: "custom_tool_call", responseName: "apply_patch" };
  }
  const suffix = name.startsWith("apply_patch_") ? name.slice("apply_patch_".length) : "";
  if (!["add_file", "delete_file", "update_file", "replace_file", "batch"].includes(suffix)) {
    return void 0;
  }
  return {
    responseType: "custom_tool_call",
    responseName: "apply_patch",
    applyPatchProxy: suffix
  };
}
function customToolInputFromChatArguments(args, metadata) {
  const trimmed = args.trim();
  if (!trimmed) return "";
  if (metadata?.applyPatchProxy) {
    return applyPatchProxyInputFromChatArguments(trimmed, metadata.applyPatchProxy);
  }
  let input = args;
  try {
    const parsed = JSON.parse(trimmed);
    if (isRecord(parsed) && typeof parsed.input === "string") {
      input = parsed.input;
    }
  } catch {
    if (trimmed.includes("*** Begin Patch")) {
      return normalizeCustomToolInput(trimmed);
    }
  }
  return normalizeCustomToolInput(input);
}
function functionToolArgumentsFromChatArguments(args) {
  const trimmed = args.trim();
  if (!trimmed) return "{}";
  try {
    JSON.parse(trimmed);
    return trimmed;
  } catch {
    return JSON.stringify({
      _starling_invalid_arguments: trimmed
    });
  }
}
function toolArgumentsForChatHistory(tool, metadata) {
  const effectiveMetadata = metadata || (tool.name ? inferApplyPatchMetadataFromToolName(tool.name) : void 0);
  return effectiveMetadata?.responseType === "custom_tool_call" ? JSON.stringify({ input: customToolInputFromChatArguments(tool.arguments, effectiveMetadata) }) : functionToolArgumentsFromChatArguments(tool.arguments);
}
function normalizeCustomToolInput(input) {
  const withoutFence = stripMarkdownFence(input);
  if (!withoutFence.includes("*** Begin Patch")) return withoutFence;
  return normalizeApplyPatchInput(withoutFence);
}
function stripMarkdownFence(input) {
  const trimmed = input.trim();
  const match = trimmed.match(/^```(?:\w+)?\s*\n([\s\S]*?)\n```$/);
  return match ? match[1].trim() : input;
}
function normalizeApplyPatchInput(input) {
  const begin = input.indexOf("*** Begin Patch");
  if (begin < 0) return input;
  const fromBegin = input.slice(begin);
  const endMarker = "*** End Patch";
  const end = fromBegin.indexOf(endMarker);
  if (end < 0) return fromBegin.trimEnd();
  return fromBegin.slice(0, end + endMarker.length);
}
function applyPatchHunksSchema() {
  return {
    type: "array",
    description: "Structured update hunks.",
    items: {
      type: "object",
      additionalProperties: false,
      properties: {
        context: { type: "string", description: "Optional @@ context header text." },
        lines: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              op: { type: "string", enum: ["context", "add", "remove"] },
              text: { type: "string" }
            },
            required: ["op", "text"]
          }
        }
      },
      required: ["lines"]
    }
  };
}
function applyPatchProxyInputFromChatArguments(args, kind) {
  if (args.includes("*** Begin Patch")) return normalizeApplyPatchInput(args);
  let parsed;
  try {
    parsed = JSON.parse(args);
  } catch {
    return args;
  }
  const operations = kind === "batch" ? applyPatchOperationsFromBatch(parsed) : [applyPatchOperationFromRecord(kind, parsed)];
  if (!operations.length || operations.some((operation) => !operation)) {
    return args;
  }
  return formatApplyPatchOperations(operations);
}
function applyPatchOperationsFromBatch(parsed) {
  if (!isRecord(parsed) || !Array.isArray(parsed.operations)) return [];
  return parsed.operations.map((operation) => {
    if (!isRecord(operation)) return null;
    const type = stringValue(operation.type);
    if (!["add_file", "delete_file", "update_file", "replace_file"].includes(type)) return null;
    return applyPatchOperationFromRecord(type, operation);
  });
}
function applyPatchOperationFromRecord(kind, parsed) {
  if (kind === "batch" || !isRecord(parsed)) return null;
  const path = stringValue(parsed.path);
  if (!path) return null;
  return {
    type: kind,
    path,
    moveTo: stringValue(parsed.move_to) || stringValue(parsed.moveTo) || void 0,
    content: stringValue(parsed.content) ?? void 0,
    hunks: Array.isArray(parsed.hunks) ? parsed.hunks : void 0
  };
}
function formatApplyPatchOperations(operations) {
  const lines = ["*** Begin Patch"];
  for (const operation of operations) {
    if (operation.type === "add_file") {
      lines.push(`*** Add File: ${operation.path}`);
      lines.push(...plusPrefixedLines(operation.content || ""));
      continue;
    }
    if (operation.type === "delete_file") {
      lines.push(`*** Delete File: ${operation.path}`);
      continue;
    }
    if (operation.type === "replace_file") {
      lines.push(`*** Delete File: ${operation.path}`);
      lines.push(`*** Add File: ${operation.path}`);
      lines.push(...plusPrefixedLines(operation.content || ""));
      continue;
    }
    lines.push(`*** Update File: ${operation.path}`);
    if (operation.moveTo) lines.push(`*** Move to: ${operation.moveTo}`);
    lines.push(...formatApplyPatchHunks(operation.hunks || []));
  }
  lines.push("*** End Patch");
  return lines.join("\n");
}
function plusPrefixedLines(content) {
  const withoutTrailingNewline = content.endsWith("\n") ? content.slice(0, -1) : content;
  if (!withoutTrailingNewline) return ["+"];
  return withoutTrailingNewline.split("\n").map((line) => `+${line}`);
}
function formatApplyPatchHunks(hunks) {
  const lines = [];
  for (const hunk of hunks) {
    if (!isRecord(hunk)) continue;
    const context = stringValue(hunk.context);
    lines.push(context ? context.startsWith("@@") ? context : `@@ ${context}` : "@@");
    const hunkLines = Array.isArray(hunk.lines) ? hunk.lines : [];
    for (const line of hunkLines) {
      if (!isRecord(line)) continue;
      const op = stringValue(line.op);
      const text = stringValue(line.text) ?? "";
      if (op === "add") {
        lines.push(`+${text}`);
      } else if (op === "remove") {
        lines.push(`-${text}`);
      } else {
        lines.push(` ${text}`);
      }
    }
  }
  return lines;
}
function finalizeResponseState(state, toolMetadata) {
  const events = [];
  const items = [];
  if (state.reasoning.started && !state.reasoning.done) {
    const summary = state.reasoning.text.trim();
    const outputIndex = state.reasoning.outputIndex < 0 ? state.nextOutputIndex++ : state.reasoning.outputIndex;
    state.reasoning.outputIndex = outputIndex;
    state.reasoning.done = true;
    state.outputItems.set(outputIndex, {
      id: state.reasoning.itemId,
      type: "reasoning",
      status: "completed",
      summary: [{ type: "summary_text", text: summary }]
    });
    events.push({
      event: "response.reasoning_summary_text.done",
      data: {
        type: "response.reasoning_summary_text.done",
        item_id: state.reasoning.itemId,
        output_index: outputIndex,
        summary_index: 0,
        text: summary
      }
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
          summary: [{ type: "summary_text", text: summary }]
        }
      }
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
      content: [{ type: "output_text", text: state.text, annotations: [] }]
    };
    events.push({
      event: "response.output_text.done",
      data: {
        type: "response.output_text.done",
        item_id: itemId,
        output_index: outputIndex,
        content_index: 0,
        text: state.text
      }
    });
    events.push({
      event: "response.content_part.done",
      data: {
        type: "response.content_part.done",
        item_id: itemId,
        output_index: outputIndex,
        content_index: 0,
        part: { type: "output_text", text: state.text, annotations: [] }
      }
    });
    events.push({
      event: "response.output_item.done",
      data: { type: "response.output_item.done", output_index: outputIndex, item }
    });
    items.push(item);
    state.outputItems.set(outputIndex, item);
  }
  for (const tool of state.toolItems.values()) {
    const outputIndex = tool.outputIndex < 0 ? state.nextOutputIndex++ : tool.outputIndex;
    tool.outputIndex = outputIndex;
    const metadata = toolMetadata.get(tool.name);
    if (!tool.started) {
      tool.started = true;
      events.push({
        event: "response.output_item.added",
        data: {
          type: "response.output_item.added",
          output_index: outputIndex,
          item: responseToolItem(tool, metadata, "in_progress")
        }
      });
    }
    const item = responseToolItem(tool, metadata, "completed");
    if (metadata?.responseType !== "custom_tool_call") {
      const argumentsJson = functionToolArgumentsFromChatArguments(tool.arguments);
      events.push({
        event: "response.function_call_arguments.delta",
        data: {
          type: "response.function_call_arguments.delta",
          item_id: tool.itemId,
          output_index: outputIndex,
          delta: argumentsJson
        }
      });
      events.push({
        event: "response.function_call_arguments.done",
        data: {
          type: "response.function_call_arguments.done",
          item_id: tool.itemId,
          output_index: outputIndex,
          arguments: argumentsJson
        }
      });
    }
    events.push({
      event: "response.output_item.done",
      data: { type: "response.output_item.done", output_index: outputIndex, item }
    });
    items.push(item);
    state.outputItems.set(outputIndex, item);
  }
  const orderedItems = [...state.outputItems.entries()].sort((a, b) => a[0] - b[0]).map(([, item]) => item);
  return { events, items: orderedItems };
}
function pushReasoningDelta(state, delta) {
  const events = [];
  if (!state.reasoning.started) {
    state.reasoning.started = true;
    state.reasoning.outputIndex = state.nextOutputIndex++;
    state.outputItems.set(state.reasoning.outputIndex, {
      id: state.reasoning.itemId,
      type: "reasoning",
      status: "in_progress",
      summary: [{ type: "summary_text", text: "" }]
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
          summary: [{ type: "summary_text", text: "" }]
        }
      }
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
      delta
    }
  });
  return events;
}
function chatCompletionToResponse(chatResponse, defaultModel, toolMetadata) {
  const responseId = isRecord(chatResponse) && stringValue(chatResponse.id) ? `resp_${stringValue(chatResponse.id)}` : `resp_starling_${randomUUID().replace(/-/g, "")}`;
  const choice = isRecord(chatResponse) && Array.isArray(chatResponse.choices) && isRecord(chatResponse.choices[0]) ? chatResponse.choices[0] : {};
  const message = isRecord(choice.message) ? choice.message : {};
  const [text, inlineReasoning] = splitReasoningFromContent(stringValue(message.content) || "");
  const reasoningText = [stringifyContent(message.reasoning), inlineReasoning].map((value) => value.trim()).filter(Boolean).join("\n");
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const output = [];
  if (reasoningText) {
    output.push({
      id: `${responseId}_reason`,
      type: "reasoning",
      status: "completed",
      summary: [{ type: "summary_text", text: reasoningText }]
    });
  }
  if (text) {
    output.push({
      id: `${responseId}_msg`,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text, annotations: [] }]
    });
  }
  for (const tool of toolCalls) {
    if (!isRecord(tool)) continue;
    const fn = isRecord(tool.function) ? tool.function : {};
    const name = stringValue(fn.name) || "";
    output.push(responseToolItem({
      itemId: `fc_${randomUUID().replace(/-/g, "")}`,
      callId: stringValue(tool.id) || `call_${randomUUID().replace(/-/g, "")}`,
      name,
      arguments: stringValue(fn.arguments) || ""
    }, toolMetadata.get(name), "completed"));
  }
  const response = responseEnvelope(
    {
      responseId,
      model: isRecord(chatResponse) && stringValue(chatResponse.model) || defaultModel,
      createdAt: isRecord(chatResponse) && typeof chatResponse.created === "number" ? chatResponse.created : Math.floor(Date.now() / 1e3)
    },
    "completed",
    output
  );
  return {
    response,
    storedMessages: [{ role: "assistant", content: text, ...toolCalls.length > 0 ? { tool_calls: toolCalls } : {} }]
  };
}
function extractReasoningFromInputItem(item) {
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
function reasonSummaryTextFromItems(value) {
  const chunks = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const text = typeof entry.text === "string" ? entry.text : reasonSummaryTextFromContainer(entry) || "";
    if (text) chunks.push(text);
  }
  return chunks.length > 0 ? chunks.join("\n") : null;
}
function reasonSummaryTextFromContainer(container) {
  const summary = container.summary;
  if (typeof summary === "string") return summary;
  if (Array.isArray(summary)) {
    const chunks = [];
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
function splitReasoningFromContent(content) {
  if (!content) return ["", ""];
  const normalized = content.trim();
  if (!normalized) return ["", ""];
  const reasonParts = [];
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
function responseEnvelope(state, status, output) {
  return {
    id: state.responseId,
    object: "response",
    created_at: state.createdAt,
    status,
    model: state.model,
    output,
    parallel_tool_calls: true,
    usage: null
  };
}
function chatErrorToResponsesError(errorText, status) {
  let parsed;
  try {
    parsed = JSON.parse(errorText);
  } catch {
    parsed = null;
  }
  const message = isRecord(parsed) && isRecord(parsed.error) && stringValue(parsed.error.message) || isRecord(parsed) && stringValue(parsed.message) || errorText || `Upstream error ${status}`;
  return { error: { message, type: "upstream_error", code: status } };
}
function normalizeModelsResponse(body) {
  if (isRecord(body) && Array.isArray(body.models)) return body;
  const source = isRecord(body) && Array.isArray(body.data) ? body.data : [];
  const models = source.filter(isRecord).map((model, index) => {
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
        { effort: "high", description: "Greater reasoning depth for complex tasks" }
      ],
      shell_type: "shell_command",
      visibility: "list",
      supported_in_api: true,
      object: stringValue(model.object) || "model",
      owned_by: stringValue(model.owned_by) || "deepseek",
      context_window: 1e6,
      max_context_window: 1e6,
      priority: 1e3 + index,
      additional_speed_tiers: [],
      service_tiers: [],
      availability_nux: null,
      upgrade: null,
      base_instructions: "You are Codex, a coding agent. Help the user with software engineering tasks in the current workspace.",
      model_messages: {
        instructions_template: "You are Codex, a coding agent. Help the user with software engineering tasks in the current workspace."
      },
      supports_reasoning_summaries: false,
      default_reasoning_summary: "none",
      support_verbosity: true,
      default_verbosity: "low",
      apply_patch_tool_type: "freeform",
      web_search_tool_type: "text_and_image",
      truncation_policy: { mode: "tokens", limit: 1e4 },
      supports_parallel_tool_calls: true,
      supports_image_detail_original: true,
      effective_context_window_percent: 95,
      experimental_supported_tools: [],
      input_modalities: ["text"],
      supports_search_tool: true,
      use_responses_lite: false
    };
  }).filter((model) => model.id && model.slug);
  return { models };
}
function normalizeUpstreamBaseUrl(value) {
  return value.replace(/\/+$/, "");
}
function isModelsPath(pathname) {
  return pathname === "/models" || pathname === "/v1/models";
}
function isResponsesPath(pathname) {
  return pathname === "/responses" || pathname === "/v1/responses" || pathname === "/v1/responses/compact";
}
function forwardHeaders(req, apiKey) {
  const headers = { authorization: `Bearer ${apiKey}` };
  const accept = req.headers.accept;
  if (typeof accept === "string") headers.accept = accept;
  return headers;
}
async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf-8");
  return text ? JSON.parse(text) : {};
}
function writeJson(res, status, body) {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}
function writeSse(res, event, data) {
  res.write(`event: ${event}
`);
  res.write(`data: ${JSON.stringify(data)}

`);
}
function splitSseBlocks(buffer) {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const parts = normalized.split("\n\n");
  return { complete: parts.slice(0, -1), remainder: parts.at(-1) ?? "" };
}
function parseSseData(block) {
  return block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
}
function readReasoningEffort(body) {
  if (isRecord(body.reasoning)) {
    const effort = stringValue(body.reasoning.effort);
    if (effort) return effort;
  }
  return stringValue(body.model_reasoning_effort);
}
function copyIfPresent(source, target, key) {
  if (typeof source[key] !== "undefined") target[key] = source[key];
}
function normalizeChatRole(value) {
  if (value === "system" || value === "user" || value === "assistant" || value === "tool") return value;
  return value ? "user" : null;
}
function stringifyContent(value) {
  if (typeof value === "string") return value;
  if (value == null) return "";
  return JSON.stringify(value);
}
function stringValue(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// src/lib/codexDefaultGuard.ts
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync, chmodSync } from "fs";
import { join } from "path";
function snapshotCodexDefaultConfig() {
  return {
    files: [
      snapshotFile(join(DEFAULT_CODEX_HOME, "config.toml")),
      snapshotFile(join(DEFAULT_CODEX_HOME, "auth.json"))
    ]
  };
}
function restoreCodexDefaultConfig(snapshot) {
  if (!snapshot) return;
  for (const file of snapshot.files) {
    restoreFile(file);
  }
}
function snapshotFile(path) {
  if (!existsSync(path)) {
    return { path, existed: false };
  }
  const st = statSync(path);
  return {
    path,
    existed: true,
    content: readFileSync(path, "utf-8"),
    mode: st.mode & 511
  };
}
function restoreFile(snapshot) {
  if (!snapshot.existed) {
    if (existsSync(snapshot.path)) {
      unlinkSync(snapshot.path);
    }
    return;
  }
  ensureDir(snapshot.path);
  writeFileSync(snapshot.path, snapshot.content ?? "", "utf-8");
  if (snapshot.mode !== void 0) {
    chmodSync(snapshot.path, snapshot.mode);
  }
}

// src/commands/run.ts
var RUN_SESSION_SCAN_LIMIT = 500;
var RUN_PIN_ATTEMPT_DRAIN_TIMEOUT_MS = 300;
function registerRunCommand(program) {
  const run = new Command("run").description("Launch claude/codex with auto catalog assignment for the created session").argument("<agent>", "agent binary: claude | codex | agent").argument("[agent-args...]", "arguments passed verbatim to the agent CLI").option("-c, --catalog <catalog>", "add created session to catalog").option("--config <config>", "Starling settings profile under ~/.starling/settings/{claude|codex}").option("--title <title>", "pin title for created session").option("--tags <tags>", "pin tags for created session, comma-separated").option("--cwd <path>", "working directory for agent launch").allowUnknownOption().passThroughOptions().addHelpText(
    "after",
    "\nStarling options must be placed before <agent>. Everything after <agent> is passed to claude/codex."
  ).action(async (agentRaw, agentArgs, opts, command) => {
    const provider = normalizeAgent(agentRaw);
    if (!provider) {
      console.error(chalk.red(`Unknown agent: ${agentRaw}`));
      console.error(chalk.gray("Allowed values: claude, codex, agent"));
      process.exit(1);
    }
    const rawArgs = command.rawArgs;
    const requestedConfig = opts.config;
    const resolvedConfig = provider === "codex" ? resolveCodexConfigPath(requestedConfig) : resolveConfigFilePath(provider, opts.config);
    if (provider === "codex" && requestedConfig && !resolvedConfig) {
      const expectedPath = join2(DEFAULT_CODEX_SETTINGS_DIR, requestedConfig);
      console.error(chalk.red(`Config file not found: ${requestedConfig}`));
      console.error(chalk.gray(`Expected path: ${expectedPath}`));
      process.exit(1);
    }
    const normalizedCwd = opts.cwd ? resolve(opts.cwd) : process.cwd();
    const catalog = await resolveCatalog(opts.catalog);
    const shouldTrackSession = Boolean(catalog);
    const codexDefaultSnapshot = provider === "codex" ? snapshotCodexDefaultConfig() : null;
    let codexConfig = provider === "codex" ? await createCodexRunConfig(resolvedConfig) : null;
    if (provider === "codex" && catalog) {
      codexConfig = ensureCodexRunHookConfig(codexConfig);
    }
    const hookRun = provider === "claude" && catalog ? createClaudeRunHookSettings(resolvedConfig) : null;
    const runHookEventsPath = hookRun?.eventsPath ?? codexConfig?.eventsPath;
    const effectiveConfig = hookRun?.settingsPath ?? resolvedConfig;
    const args = resolveAgentArgs(provider, rawArgs, agentArgs, effectiveConfig, codexConfig);
    const cwd = opts.cwd;
    const binary = provider === "claude" ? "claude" : "codex";
    const startedAt = (/* @__PURE__ */ new Date()).toISOString();
    const beforeRun = shouldTrackSession && !runHookEventsPath ? await snapshotSessions(provider) : /* @__PURE__ */ new Map();
    const beforeRunProjectFiles = shouldTrackSession && provider === "claude" && !runHookEventsPath ? snapshotProjectSessions(normalizedCwd) : /* @__PURE__ */ new Map();
    const cleanupRunState = async () => {
      syncClaudeProfileSettingsFromRunSettings(resolvedConfig, hookRun?.settingsPath ?? null);
      cleanupClaudeRunHookSettings(hookRun);
      await cleanupCodexRunConfig(codexConfig);
      restoreCodexDefaultConfig(codexDefaultSnapshot);
    };
    let catalogPinned = false;
    let agentClosed = false;
    let stopAutoPinWatcher = false;
    let hintedSessionId;
    let pinAttempt = null;
    const startAutoPinWatcher = async () => {
      if (!catalog || catalogPinned) return;
      if (pinAttempt) return;
      pinAttempt = (async () => {
        const startedTime = Date.parse(startedAt);
        let attemptsAfterClose = 0;
        for (let i = 0; !stopAutoPinWatcher; i++) {
          const sessionId = hintedSessionId ?? readRunHookSessionId(runHookEventsPath);
          if (!sessionId) {
            if (provider === "codex" && !runHookEventsPath) {
              const candidate2 = await findSingleCodexSessionForRunningAgent(startedTime, beforeRun, normalizedCwd);
              if (candidate2) {
                hintedSessionId = candidate2.session_id;
                await pinSessionToCatalog(candidate2, opts, catalog);
                catalogPinned = true;
                return;
              }
            }
            if (agentClosed || stopAutoPinWatcher) return;
            await sleep(250);
            continue;
          }
          hintedSessionId = sessionId;
          const candidate = hookRun && provider === "claude" ? await findClaudeSessionInProjectById(sessionId, normalizedCwd) : await findKnownSessionForRun(sessionId, provider, normalizedCwd, i);
          if (isRunSessionCandidate(candidate, provider, startedTime, beforeRun, sessionId)) {
            await pinSessionToCatalog(candidate, opts, catalog);
            catalogPinned = true;
            return;
          }
          if (agentClosed || stopAutoPinWatcher) {
            attemptsAfterClose++;
            if (attemptsAfterClose >= 20) break;
          }
          await sleep(250);
        }
        const fallback = provider === "claude" ? await detectSessionInCurrentClaudeProject(
          Date.parse(startedAt),
          beforeRun,
          normalizedCwd,
          beforeRunProjectFiles
        ) : await findSingleCodexSessionForRunningAgent(
          Date.parse(startedAt),
          beforeRun,
          normalizedCwd
        );
        if (fallback && fallback.provider === provider && (!hintedSessionId || fallback.session_id === hintedSessionId)) {
          await pinSessionToCatalog(fallback, opts, catalog);
          catalogPinned = true;
        }
      })().finally(() => {
        pinAttempt = null;
      });
      pinAttempt.catch((error) => {
        if (process.env.NODE_ENV !== "test") {
          const sessionLabel = hintedSessionId ? ` ${hintedSessionId}` : "";
          console.error(chalk.yellow(`Failed to auto-pin session${sessionLabel} to catalog ${catalog?.name}: ${String(error)}`));
        }
      });
    };
    if (hookRun || provider === "codex" && catalog) {
      void startAutoPinWatcher();
    }
    let runResult;
    try {
      runResult = await runAgent(binary, args, cwd, {
        preserveSignals: true,
        env: buildAgentEnv(provider, codexConfig?.env)
      });
    } catch (error) {
      await cleanupRunState();
      throw error;
    }
    agentClosed = true;
    syncCodexProfileProjectTrustFromRunConfig(resolvedConfig, codexConfig);
    const exitCode = runResult.exitCode;
    if (!shouldTrackSession) {
      await cleanupRunState();
      if (exitCode !== 0) {
        process.exit(exitCode);
      }
      return;
    }
    if (pinAttempt) {
      await drainPinAttempt(pinAttempt);
      stopAutoPinWatcher = true;
    }
    if (exitCode !== 0) {
      await cleanupRunState();
      process.exit(exitCode);
    }
    await cleanupRunState();
  });
  program.addCommand(run);
}
async function drainPinAttempt(pinAttempt) {
  await Promise.race([
    pinAttempt,
    sleep(RUN_PIN_ATTEMPT_DRAIN_TIMEOUT_MS)
  ]);
}
var CONFIG_FILE_EXTENSIONS = [".json", ".jsonc", ".toml", ".yaml", ".yml", ".js", ".ts"];
var SESSION_ID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
function buildAgentEnv(provider, overrides) {
  if (provider !== "codex" && !overrides) return void 0;
  const env = { ...process.env, ...overrides ?? {} };
  if (provider === "codex") {
    for (const key of Object.keys(env)) {
      if (key.startsWith("CODEX_") && key !== "CODEX_HOME") {
        delete env[key];
      }
    }
  }
  return env;
}
function parseSessionIdFromText(text) {
  const resumeMatch = text.match(new RegExp(`--resume\\s+(${SESSION_ID_PATTERN.source})`, "i"));
  if (resumeMatch?.[1]) return resumeMatch[1];
  const sessionMatch = text.match(new RegExp(`session\\s+id\\s*[:=]\\s*(${SESSION_ID_PATTERN.source})`, "i"));
  if (sessionMatch?.[1]) return sessionMatch[1];
  const genericMatch = SESSION_ID_PATTERN.exec(text)?.[0];
  if (genericMatch) return genericMatch;
  return null;
}
function createClaudeRunHookSettings(configPath) {
  const runId = randomUUID2();
  const baseDir = join2(DEFAULT_STARLING_HOME, "run-hooks");
  const eventsPath = join2(baseDir, `${runId}.jsonl`);
  const settingsPath = join2(baseDir, `${runId}.settings.json`);
  ensureDir(eventsPath);
  const settings = readClaudeSettingsObject(configPath);
  if (!settings) return null;
  const hooks = isRecord2(settings.hooks) ? { ...settings.hooks } : {};
  const sessionStart = Array.isArray(hooks.SessionStart) ? [...hooks.SessionStart] : [];
  sessionStart.push({
    hooks: [
      {
        type: "command",
        command: `bash -c 'cat >> "$1"; printf "\\n" >> "$1"' _ ${shellQuote(eventsPath)}`
      }
    ]
  });
  hooks.SessionStart = sessionStart;
  atomicWriteJSON(settingsPath, { ...settings, hooks });
  return { settingsPath, eventsPath };
}
function cleanupClaudeRunHookSettings(hookRun) {
  if (!hookRun) return;
  for (const path of [hookRun.settingsPath, hookRun.eventsPath]) {
    try {
      unlinkSync2(path);
    } catch {
    }
  }
}
var CLAUDE_SETTINGS_SYNC_KEYS = [
  "permissions",
  "projects",
  "trust",
  "trustedProjects",
  "enableAllProjectMcpServers",
  "enabledMcpjsonServers",
  "disabledMcpjsonServers"
];
function syncClaudeProfileSettingsFromRunSettings(sourceConfigPath, runSettingsPath) {
  if (!sourceConfigPath || !runSettingsPath || !existsSync2(runSettingsPath)) return false;
  const sourceExt = extname(sourceConfigPath).toLowerCase();
  if (sourceExt !== ".json" && sourceExt !== ".jsonc") return false;
  try {
    const sourceSettings = readSettingsJsonObject(sourceConfigPath, sourceExt === ".jsonc");
    const runSettings = readSettingsJsonObject(runSettingsPath, false);
    if (!sourceSettings || !runSettings) return false;
    let changed = false;
    for (const key of CLAUDE_SETTINGS_SYNC_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(runSettings, key)) continue;
      if (jsonStable(sourceSettings[key]) === jsonStable(runSettings[key])) continue;
      sourceSettings[key] = cloneJsonValue(runSettings[key]);
      changed = true;
    }
    if (!changed) return false;
    atomicWriteJSON(sourceConfigPath, sourceSettings);
    return true;
  } catch (error) {
    console.error(chalk.yellow(`Could not sync Claude settings to ${sourceConfigPath}: ${String(error)}`));
    return false;
  }
}
async function createCodexRunConfig(configPath) {
  if (!configPath) {
    return null;
  }
  const ext = extname(configPath).toLowerCase();
  if (ext === ".toml") {
    const profile = readCodexTomlProfileForRun(configPath);
    return createCodexRunConfigFromProfile(profile);
  }
  if (ext === ".json" || ext === ".jsonc") {
    const profile = readCodexJsonProfileForRun(configPath, ext === ".jsonc");
    return createCodexRunConfigFromProfile(profile);
  }
  console.error(chalk.red(`Unsupported Codex config file type: ${configPath}`));
  console.error(chalk.gray("Use .json, .jsonc, or .toml under ~/.starling/settings/codex."));
  process.exit(1);
}
function ensureCodexRunHookConfig(config) {
  const runId = randomUUID2();
  const baseDir = join2(DEFAULT_STARLING_HOME, "run-hooks");
  const eventsPath = join2(baseDir, `${runId}.codex.jsonl`);
  ensureDir(eventsPath);
  const hookText = codexSessionStartHookToml(eventsPath);
  if (config?.cleanupPaths[0] && config.args.includes("--profile")) {
    const profilePath2 = config.cleanupPaths[0];
    const existing = readFileSync2(profilePath2, "utf-8");
    writeFileSync2(profilePath2, `${existing.trimEnd()}

${hookText}`, "utf-8");
    return {
      ...config,
      args: addCodexHookTrustBypassArg(config.args),
      cleanupPaths: [...config.cleanupPaths, eventsPath],
      eventsPath
    };
  }
  const profileName = `starling-run-${randomUUID2()}`;
  const profilePath = join2(DEFAULT_CODEX_HOME, `${profileName}.config.toml`);
  ensureDir(profilePath);
  writeFileSync2(profilePath, hookText, "utf-8");
  chmodSync2(profilePath, 384);
  return {
    args: ["--profile", profileName, ...addCodexHookTrustBypassArg(config?.args ?? [])],
    cleanupPaths: [profilePath, eventsPath, ...config?.cleanupPaths ?? []],
    cleanupTasks: config?.cleanupTasks,
    env: config?.env,
    eventsPath
  };
}
function codexSessionStartHookToml(eventsPath) {
  return [
    "[features]",
    "hooks = true",
    "",
    "[[hooks.SessionStart]]",
    'matcher = "startup"',
    "",
    "[[hooks.SessionStart.hooks]]",
    'type = "command"',
    `command = ${JSON.stringify(`bash -c 'cat >> "$1"; printf "\\n" >> "$1"' _ ${shellQuote(eventsPath)}`)}`,
    "timeout = 5"
  ].join("\n") + "\n";
}
function addCodexHookTrustBypassArg(args) {
  return args.includes("--dangerously-bypass-hook-trust") ? args : ["--dangerously-bypass-hook-trust", ...args];
}
async function createCodexRunConfigFromProfile(profile) {
  const args = [];
  const cleanupPaths = [];
  const cleanupTasks = [];
  let configText = profile.configText;
  if (profile.chatProxy) {
    const proxy = await startCodexChatProxy({
      upstreamBaseUrl: profile.chatProxy.upstreamBaseUrl,
      apiKey: profile.chatProxy.apiKey,
      model: profile.chatProxy.model
    });
    cleanupTasks.push(proxy.close);
    configText = codexProxyConfigText(profile.chatProxy.config, proxy.baseUrl);
    console.error(chalk.gray(`Starling Codex adapter: routing ${profile.chatProxy.providerName} via ${proxy.baseUrl}`));
  }
  if (configText) {
    const profileName = `starling-run-${randomUUID2()}`;
    const profilePath = join2(DEFAULT_CODEX_HOME, `${profileName}.config.toml`);
    ensureDir(profilePath);
    writeFileSync2(profilePath, configText, "utf-8");
    chmodSync2(profilePath, 384);
    args.push("--profile", profileName);
    cleanupPaths.push(profilePath);
  }
  if (profile.inlineConfig) {
    for (const [key, value] of flattenCodexConfig(profile.inlineConfig)) {
      args.push("--config", `${key}=${toCodexConfigValue(value)}`);
    }
  }
  return { args, cleanupPaths, cleanupTasks, env: profile.env };
}
async function cleanupCodexRunConfig(config) {
  if (!config) return;
  for (const path of config.cleanupPaths) {
    try {
      unlinkSync2(path);
    } catch {
    }
  }
  for (const cleanup of config.cleanupTasks ?? []) {
    try {
      await cleanup();
    } catch {
    }
  }
}
function syncCodexProfileProjectTrustFromRunConfig(sourceConfigPath, runConfig) {
  if (!sourceConfigPath || !runConfig) return;
  const sourceExt = extname(sourceConfigPath).toLowerCase();
  if (sourceExt !== ".json" && sourceExt !== ".jsonc" && sourceExt !== ".toml") return;
  const trustedProjects = /* @__PURE__ */ new Set();
  for (const path of runConfig.cleanupPaths) {
    if (!path.endsWith(".config.toml") || !existsSync2(path)) continue;
    for (const projectPath of readTrustedProjectsFromCodexToml(path)) {
      trustedProjects.add(projectPath);
    }
  }
  if (trustedProjects.size === 0) return;
  if (sourceExt === ".toml") {
    syncCodexTomlProjectTrust(sourceConfigPath, trustedProjects);
    return;
  }
  try {
    const raw = readFileSync2(sourceConfigPath, "utf-8");
    const parsed = JSON.parse(sourceExt === ".jsonc" ? stripJsonComments(raw) : raw);
    if (!isRecord2(parsed)) return;
    const config = isRecord2(parsed.config) ? parsed.config : {};
    const projects = isRecord2(config.projects) ? config.projects : {};
    let changed = false;
    for (const projectPath of trustedProjects) {
      const project = isRecord2(projects[projectPath]) ? projects[projectPath] : {};
      if (project.trust_level === "trusted") continue;
      project.trust_level = "trusted";
      projects[projectPath] = project;
      changed = true;
    }
    if (!changed) return;
    config.projects = projects;
    parsed.config = config;
    atomicWriteJSON(sourceConfigPath, parsed);
  } catch (error) {
    console.error(chalk.yellow(`Could not sync Codex project trust to ${sourceConfigPath}: ${String(error)}`));
  }
}
function syncCodexTomlProjectTrust(sourceConfigPath, trustedProjects) {
  try {
    let raw = readFileSync2(sourceConfigPath, "utf-8");
    let changed = false;
    for (const projectPath of trustedProjects) {
      const updated = upsertCodexTomlProjectTrust(raw, projectPath);
      if (updated !== raw) {
        raw = updated;
        changed = true;
      }
    }
    if (changed) writeFileSync2(sourceConfigPath, raw.endsWith("\n") ? raw : `${raw}
`, "utf-8");
  } catch (error) {
    console.error(chalk.yellow(`Could not sync Codex project trust to ${sourceConfigPath}: ${String(error)}`));
  }
}
function upsertCodexTomlProjectTrust(raw, projectPath) {
  const header = `[projects.${JSON.stringify(projectPath)}]`;
  const lines = raw.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => line.trim() === header);
  if (headerIndex < 0) {
    return `${raw.trimEnd()}

${header}
trust_level = "trusted"
`;
  }
  let endIndex = lines.length;
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    if (/^\s*\[/.test(lines[index])) {
      endIndex = index;
      break;
    }
  }
  let hasTrust = false;
  const nextLines = [...lines];
  for (let index = endIndex - 1; index > headerIndex; index -= 1) {
    if (!/^\s*trust_level\s*=\s*["']trusted["']\s*(?:#.*)?$/.test(nextLines[index])) continue;
    if (hasTrust) {
      nextLines.splice(index, 1);
      endIndex -= 1;
      continue;
    }
    hasTrust = true;
  }
  if (!hasTrust) {
    nextLines.splice(endIndex, 0, 'trust_level = "trusted"');
  }
  return nextLines.join("\n").replace(/\n{3,}/g, "\n\n");
}
function readTrustedProjectsFromCodexToml(filePath) {
  const raw = readFileSync2(filePath, "utf-8");
  const trusted = [];
  let currentProject = null;
  let currentTrusted = false;
  const flush = () => {
    if (currentProject && currentTrusted) trusted.push(currentProject);
  };
  for (const line of raw.split(/\r?\n/)) {
    const section = line.match(/^\s*\[projects\.(?:"([^"]+)"|'([^']+)'|([^\]]+))\]\s*$/);
    if (section) {
      flush();
      currentProject = section[1] ?? section[2] ?? section[3] ?? null;
      currentTrusted = false;
      continue;
    }
    if (!currentProject) continue;
    const trust = line.match(/^\s*trust_level\s*=\s*(?:"trusted"|'trusted')\s*(?:#.*)?$/);
    if (trust) currentTrusted = true;
  }
  flush();
  return trusted;
}
function readCodexJsonProfileForRun(configPath, allowComments) {
  try {
    const raw = readFileSync2(configPath, "utf-8");
    const parsed = JSON.parse(allowComments ? stripJsonComments(raw) : raw);
    if (!isRecord2(parsed)) {
      console.error(chalk.red(`Codex config must be a JSON object: ${configPath}`));
      process.exit(1);
    }
    const auth = resolveCodexProfileAuth(parsed);
    const chatProxy = resolveCodexChatProxySpec(parsed, auth);
    const configText = chatProxy ? convertCodexJsonToToml(chatProxy.config) : resolveCodexProfileConfigText(parsed);
    const env = chatProxy ? resolveStringEnv(parsed.env) : resolveCodexProfileEnv(parsed, auth, configText);
    const inlineConfig = resolveCodexInlineConfig(parsed);
    return { inlineConfig, configText, env, chatProxy };
  } catch (error) {
    console.error(chalk.red(`Could not parse Codex config JSON: ${configPath}`));
    console.error(chalk.gray(String(error)));
    process.exit(1);
  }
}
function readCodexTomlProfileForRun(configPath) {
  try {
    const configText = readFileSync2(configPath, "utf-8");
    const config = parseSimpleToml(configText);
    const auth = resolveCodexTomlAuth(config);
    const profile = { config };
    const chatProxy = resolveCodexChatProxySpec(profile, auth);
    const env = chatProxy ? {} : resolveCodexProfileEnv(profile, auth, configText);
    return {
      inlineConfig: null,
      configText: configText.trim() ? configText.endsWith("\n") ? configText : `${configText}
` : null,
      env,
      chatProxy
    };
  } catch (error) {
    console.error(chalk.red(`Could not parse Codex config TOML: ${configPath}`));
    console.error(chalk.gray(String(error)));
    process.exit(1);
  }
}
function resolveCodexTomlAuth(config) {
  const providerName = resolveCodexModelProviderName(config);
  const providers = isRecord2(config.model_providers) ? config.model_providers : {};
  const providerConfig = providerName && isRecord2(providers[providerName]) ? providers[providerName] : {};
  const token = stringValue2(providerConfig.experimental_bearer_token) || stringValue2(config.OPENAI_API_KEY);
  return token ? { OPENAI_API_KEY: token } : null;
}
function resolveCodexProfileConfigText(profile) {
  const value = profile.config;
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  if (isRecord2(value)) {
    const toml = convertCodexJsonToToml(value);
    return toml.trim() ? toml : null;
  }
  return null;
}
function resolveCodexProfileAuth(profile) {
  if (isRecord2(profile.auth)) {
    return profile.auth;
  }
  const candidateKeys = ["OPENAI_API_KEY", "openai_api_key", "apiKey", "api_key"];
  for (const key of candidateKeys) {
    const value = profile[key];
    if (typeof value === "string" && value.trim()) {
      return { OPENAI_API_KEY: value };
    }
  }
  if (typeof profile.token === "string" && profile.token.trim()) {
    return { OPENAI_API_KEY: profile.token };
  }
  return null;
}
function resolveCodexProfileEnv(profile, auth, configText) {
  const env = {};
  const candidateKeys = ["OPENAI_API_KEY", "openai_api_key", "apiKey", "api_key", "token"];
  for (const key of candidateKeys) {
    const value = auth?.[key] ?? (key !== "token" && isRecord2(profile.env) ? profile.env[key] : void 0);
    if (typeof value === "string" && value.trim()) {
      env.OPENAI_API_KEY = value;
    }
  }
  if (isRecord2(profile.env)) {
    for (const [key, value] of Object.entries(profile.env)) {
      if (typeof value === "string" && value.trim()) {
        env[key] = value;
      }
    }
  }
  if (configText && isRecord2(profile.config) && typeof profile.config === "object" && profile.config !== null) {
    const providerName = resolveCodexModelProviderName(profile.config);
    const baseUrl = resolveCodexCustomProviderBaseUrl(profile.config, providerName);
    if (typeof baseUrl === "string" && baseUrl.trim()) {
      env.OPENAI_BASE_URL = env.OPENAI_BASE_URL || baseUrl;
      env.OPENAI_API_BASE_URL = env.OPENAI_API_BASE_URL || baseUrl;
      env.BASE_URL = env.BASE_URL || baseUrl;
    }
  }
  return env;
}
function resolveStringEnv(value) {
  const env = {};
  if (!isRecord2(value)) return env;
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "string" && child.trim()) {
      env[key] = child;
    }
  }
  return env;
}
function resolveCodexChatProxySpec(profile, auth) {
  if (!isRecord2(profile.config)) return null;
  const providerName = resolveCodexModelProviderName(profile.config);
  if (!providerName) return null;
  const providers = profile.config.model_providers;
  if (!isRecord2(providers)) return null;
  const providerConfig = providers[providerName];
  if (!isRecord2(providerConfig)) return null;
  const upstreamBaseUrl = typeof providerConfig.base_url === "string" ? providerConfig.base_url.trim() : "";
  if (!upstreamBaseUrl) return null;
  const apiFormat = resolveCodexApiFormat(profile, profile.config, providerConfig);
  const providerLabel = `${providerName} ${stringValue2(providerConfig.name)} ${stringValue2(profile.config.model)} ${upstreamBaseUrl}`.toLowerCase();
  const shouldProxy = apiFormat === "openai_chat" || providerLabel.includes("deepseek");
  if (!shouldProxy) return null;
  const apiKey = resolveCodexApiKey(auth, profile);
  if (!apiKey) {
    console.error(chalk.red("Codex chat adapter requires an API key in auth.OPENAI_API_KEY or OPENAI_API_KEY."));
    process.exit(1);
  }
  return {
    providerName,
    upstreamBaseUrl,
    apiKey,
    model: typeof profile.config.model === "string" ? profile.config.model : void 0,
    config: cloneRecord(profile.config)
  };
}
function codexProxyConfigText(config, proxyBaseUrl) {
  const cloned = cloneRecord(config);
  const providerName = resolveCodexModelProviderName(cloned);
  if (!providerName || !isRecord2(cloned.model_providers)) {
    return convertCodexJsonToToml(cloned);
  }
  const providerConfig = cloned.model_providers[providerName];
  if (isRecord2(providerConfig)) {
    providerConfig.base_url = proxyBaseUrl;
    providerConfig.wire_api = "responses";
    providerConfig.requires_openai_auth = false;
    delete providerConfig.env_key;
    delete providerConfig.experimental_bearer_token;
    delete providerConfig.auth;
  }
  return convertCodexJsonToToml(cloned);
}
function resolveCodexApiFormat(...values) {
  for (const value of values) {
    const apiFormat = stringValue2(value.api_format) || stringValue2(value.apiFormat);
    if (apiFormat) return apiFormat;
  }
  return null;
}
function resolveCodexApiKey(auth, profile) {
  const candidateKeys = ["OPENAI_API_KEY", "openai_api_key", "apiKey", "api_key", "token"];
  for (const key of candidateKeys) {
    const value = auth?.[key] ?? profile[key] ?? (isRecord2(profile.env) ? profile.env[key] : void 0);
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}
function cloneRecord(value) {
  return JSON.parse(JSON.stringify(value));
}
function stringValue2(value) {
  return typeof value === "string" ? value : "";
}
function resolveCodexModelProviderName(configValue) {
  const provider = configValue.model_provider;
  if (typeof provider === "string" && provider.trim()) return provider.trim();
  return null;
}
function resolveCodexCustomProviderBaseUrl(configValue, providerName) {
  if (!providerName) return null;
  const providers = configValue.model_providers;
  if (!isRecord2(providers)) return null;
  const providerConfig = providers[providerName];
  if (!isRecord2(providerConfig)) return null;
  const baseUrl = providerConfig.base_url;
  if (typeof baseUrl === "string" && baseUrl.trim()) return baseUrl.trim();
  return null;
}
function resolveCodexInlineConfig(profile) {
  if (typeof profile.config !== "undefined" && typeof profile.config !== "string") {
    return null;
  }
  const config = { ...profile };
  delete config.auth;
  delete config.config;
  return Object.keys(config).length > 0 ? config : null;
}
function stripJsonComments(value) {
  return value.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}
function parseSimpleToml(raw) {
  const root = {};
  let current = root;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const section = trimmed.match(/^\[([^\]]+)\]$/);
    if (section) {
      current = root;
      for (const part of splitTomlPath(section[1])) {
        const existing = current[part];
        if (!isRecord2(existing)) current[part] = {};
        current = current[part];
      }
      continue;
    }
    const kv = trimmed.match(/^([A-Za-z0-9_.-]+|"(?:\\.|[^"])+")\s*=\s*(.+?)\s*(?:#.*)?$/);
    if (!kv) continue;
    current[unquoteTomlKey(kv[1])] = parseTomlScalar(kv[2].trim());
  }
  return root;
}
function splitTomlPath(value) {
  const parts = [];
  let current = "";
  let inQuote = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === '"' && value[index - 1] !== "\\") {
      inQuote = !inQuote;
      current += char;
      continue;
    }
    if (char === "." && !inQuote) {
      parts.push(unquoteTomlKey(current.trim()));
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) parts.push(unquoteTomlKey(current.trim()));
  return parts;
}
function unquoteTomlKey(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}
function parseTomlScalar(value) {
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  return value;
}
function flattenCodexConfig(value, prefix = "") {
  const entries = [];
  for (const [key, nestedValue] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isRecord2(nestedValue)) {
      entries.push(...flattenCodexConfig(nestedValue, path));
      continue;
    }
    entries.push([path, nestedValue]);
  }
  return entries;
}
function toCodexConfigValue(value) {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null) {
    console.error(chalk.red("Codex config values cannot be null."));
    process.exit(1);
  }
  return JSON.stringify(value);
}
function toTomlValue(value) {
  if (isRecord2(value)) {
    const segments = [];
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === "undefined") continue;
      segments.push(`${toTomlKey(k)} = ${toTomlValue(v)}`);
    }
    return `{ ${segments.join(", ")} }`;
  }
  if (Array.isArray(value)) {
    const entries = value.filter((item) => typeof item !== "undefined").map((item) => toTomlValue(item));
    return `[${entries.join(", ")}]`;
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null) {
    console.error(chalk.red("Codex config values cannot be null."));
    process.exit(1);
  }
  return JSON.stringify(String(value));
}
function toTomlKey(key) {
  return /^\w+$/.test(key) ? key : JSON.stringify(key);
}
function serializeTomlObject(value, prefix, lines) {
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "undefined" || isRecord2(child)) continue;
    lines.push(`${toTomlKey(key)} = ${toTomlValue(child)}`);
  }
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "undefined") continue;
    if (isRecord2(child)) {
      const nextPath = [...prefix, key];
      if (hasDirectTomlValues(child)) {
        lines.push("");
        lines.push(`[${[...nextPath].map(toTomlKey).join(".")}]`);
      }
      serializeTomlObject(child, nextPath, lines);
    }
  }
}
function hasDirectTomlValues(value) {
  return Object.values(value).some((child) => typeof child !== "undefined" && !isRecord2(child));
}
function convertCodexJsonToToml(value) {
  const lines = [];
  serializeTomlObject(value, [], lines);
  return lines.length > 0 ? `${lines.join("\n")}
` : "";
}
function readRunHookSessionId(eventsPath) {
  if (!eventsPath || !existsSync2(eventsPath)) return null;
  let raw = "";
  try {
    raw = readFileSync2(eventsPath, "utf-8");
  } catch {
    return null;
  }
  const lines = raw.trim().split(/\r?\n/).filter(Boolean).reverse();
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      const sessionId = readSessionIdFromHookEntry(entry);
      if (sessionId) return sessionId;
    } catch {
      const sessionId = parseSessionIdFromText(line);
      if (sessionId) return sessionId;
    }
  }
  return null;
}
function readSessionIdFromHookEntry(value) {
  if (!isRecord2(value)) return null;
  const direct = value.session_id ?? value.sessionId;
  if (typeof direct === "string" && SESSION_ID_PATTERN.test(direct)) return direct;
  for (const nested of Object.values(value)) {
    const found = readSessionIdFromHookEntry(nested);
    if (found) return found;
  }
  return null;
}
function readClaudeSettingsObject(configPath) {
  if (!configPath) return {};
  try {
    const parsed = readSettingsJsonObject(configPath, extname(configPath).toLowerCase() === ".jsonc");
    if (parsed) return parsed;
  } catch {
    console.log(chalk.yellow("Could not add Claude SessionStart hook because settings is not parseable JSON."));
  }
  return null;
}
function readSettingsJsonObject(filePath, allowComments) {
  const raw = readFileSync2(filePath, "utf-8");
  const parsed = JSON.parse(allowComments ? stripJsonComments(raw) : raw);
  return isRecord2(parsed) ? parsed : null;
}
function jsonStable(value) {
  return JSON.stringify(value);
}
function cloneJsonValue(value) {
  return value === void 0 ? void 0 : JSON.parse(JSON.stringify(value));
}
function isRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function shellQuote(value) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
function resolveConfigFilePath(provider, configFile) {
  if (!configFile) return null;
  if (isAbsolute(configFile) || existsSync2(configFile)) {
    if (!existsSync2(configFile)) {
      console.error(chalk.red(`Config file not found: ${configFile}`));
      process.exit(1);
    }
    return configFile;
  }
  const baseDir = provider === "claude" ? DEFAULT_CLAUDE_SETTINGS_DIR : DEFAULT_CODEX_SETTINGS_DIR;
  const fileName = basename(configFile);
  const candidate = join2(baseDir, fileName);
  if (existsSync2(candidate)) return candidate;
  const candidatesTried = [candidate];
  if (!hasKnownConfigExtension(fileName, CONFIG_FILE_EXTENSIONS)) {
    for (const ext of CONFIG_FILE_EXTENSIONS) {
      const candidateWithExtension = `${candidate}${ext}`;
      candidatesTried.push(candidateWithExtension);
      if (existsSync2(candidateWithExtension)) return candidateWithExtension;
    }
  }
  console.error(chalk.red(`Config file not found: ${configFile}`));
  console.error(chalk.gray(`Expected path: ${candidate}`));
  console.error(
    chalk.gray(`Tried: ${candidatesTried.map((path) => path.replace(`${DEFAULT_CLAUDE_SETTINGS_DIR}/`, "").replace(`${DEFAULT_CODEX_SETTINGS_DIR}/`, "")).join(", ")}`)
  );
  process.exit(1);
}
async function resolveCatalog(catalog) {
  if (!catalog) return null;
  const existing = resolveCatalogReference(catalog);
  if (existing.kind === "found") return existing.space;
  if (existing.kind === "ambiguous") {
    console.error(chalk.red(`Ambiguous catalog reference: ${catalog}`));
    console.error(chalk.red("Use a catalog path like parent/child or the catalog id."));
    for (const match of existing.matches) {
      console.error(chalk.gray(`  ${catalogPath(match, listSpaces())} (${match.id})`));
    }
    process.exit(1);
  }
  if (!process.stdin.isTTY) {
    console.error(chalk.red(`Catalog not found: ${catalog}`));
    console.error(chalk.yellow(`Create it first: starling catalog create ${catalog}`));
    process.exit(1);
  }
  const input = await askCreateCatalog(catalog);
  if (!input) {
    console.error(chalk.yellow(`Catalog not found: ${catalog}`));
    process.exit(1);
  }
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const created = createCatalogPath(catalog, now);
  console.log(chalk.green(`Created catalog: ${created.id} "${catalogPath(created)}"`));
  return created;
}
async function askCreateCatalog(catalog) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`Catalog not found: ${chalk.yellow(catalog)}. Create it now? (y/N) `);
    const normalized = answer.trim().toLowerCase();
    return normalized === "y" || normalized === "yes";
  } catch (error) {
    if (isReadlineAbort(error)) {
      return false;
    }
    throw error;
  } finally {
    rl.close();
  }
}
function isReadlineAbort(error) {
  return Boolean(
    error && typeof error === "object" && "code" in error && error.code === "ABORT_ERR"
  );
}
function createCatalogPath(pathRef, now) {
  const parts = pathRef.split("/").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) {
    console.error(chalk.red("Catalog name cannot be empty."));
    process.exit(1);
  }
  let parentId = null;
  let currentSpace;
  for (const part of parts) {
    const existing = findSiblingCatalog(part, parentId);
    if (existing) {
      currentSpace = existing;
      parentId = existing.id;
      continue;
    }
    currentSpace = {
      id: generateSpaceId(listSpaces()),
      name: part,
      description: "",
      tags: [],
      parent_id: parentId,
      created_at: now,
      updated_at: now
    };
    addSpace(currentSpace);
    parentId = currentSpace.id;
  }
  return currentSpace;
}
function findSiblingCatalog(name, parentId) {
  return listSpaces().find((space) => space.name === name && space.parent_id === parentId);
}
function resolveAgentArgs(provider, rawArgs, parsedArgs, configPath, codexConfig) {
  const args = rawArgs ? parsePassthroughArgs(rawArgs, parsedArgs) : parsedArgs;
  if (provider === "codex") {
    return [...codexConfig?.args ?? [], ...args];
  }
  if (!configPath) return args;
  return ["--settings", configPath, ...args];
}
function parsePassthroughArgs(rawArgs, parsedArgs) {
  if (!rawArgs) return parsedArgs;
  const separatorIndex = rawArgs.lastIndexOf("--");
  if (separatorIndex === -1) return parsedArgs;
  return rawArgs.slice(separatorIndex + 1);
}
async function runAgent(binary, args, cwd, options) {
  return new Promise((resolvePromise, reject) => {
    const childEnv = options?.env;
    const child = spawn(binary, args, {
      stdio: "inherit",
      cwd,
      env: childEnv
    });
    let terminalInterrupted = false;
    let settled = false;
    const onSigInt = () => {
      terminalInterrupted = true;
      child.kill("SIGINT");
    };
    const cleanupListeners = () => {
      if (options?.preserveSignals) {
        process.off("SIGINT", onSigInt);
      }
    };
    const settle = (exitCode) => {
      if (settled) return;
      settled = true;
      cleanupListeners();
      resolvePromise({ exitCode });
    };
    if (options?.preserveSignals) {
      process.on("SIGINT", onSigInt);
    }
    child.on("error", (err) => {
      cleanupListeners();
      reject(err);
    });
    child.on("exit", (code) => {
      if (terminalInterrupted) {
        settle(130);
        return;
      }
      settle(code ?? 0);
    });
    child.on("close", (code) => {
      if (terminalInterrupted) {
        settle(130);
        return;
      }
      settle(code ?? 0);
    });
  });
}
async function snapshotSessions(provider) {
  const sessions = await findSessions(RUN_SESSION_SCAN_LIMIT, provider);
  const snapshot = /* @__PURE__ */ new Map();
  for (const session of sessions) {
    const modifiedAt = Date.parse(session.modified_at);
    snapshot.set(session.session_id, Number.isFinite(modifiedAt) ? modifiedAt : 0);
  }
  return snapshot;
}
function wasSessionTouchedAfterRun(session, startedAt, beforeRun) {
  const modifiedAt = Date.parse(session.modified_at);
  if (!Number.isFinite(modifiedAt) || modifiedAt < startedAt) return false;
  const previousModifiedAt = beforeRun.get(session.session_id);
  if (previousModifiedAt === void 0) return true;
  return modifiedAt > previousModifiedAt;
}
function isRunSessionCandidate(session, provider, startedAt, beforeRun, reportedSessionId) {
  if (!session || session.provider !== provider) return false;
  if (reportedSessionId && session.session_id === reportedSessionId) return true;
  return wasSessionTouchedAfterRun(session, startedAt, beforeRun);
}
function collectSessionFilesByModifiedTime(dir, sinceMs, accumulator, limit = 3e3) {
  if (accumulator.length >= limit) return;
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === "subagents") continue;
    const full = join2(dir, entry);
    let st;
    try {
      st = statSync2(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      collectSessionFilesByModifiedTime(full, sinceMs, accumulator, limit);
      continue;
    }
    if (!entry.endsWith(".jsonl")) continue;
    if (st.mtimeMs < sinceMs) continue;
    accumulator.push(full);
    if (accumulator.length >= limit) return;
  }
}
async function collectSessionCandidatesByModifiedTime(baseDir, startedTime, beforeRun, provider, limit = 500) {
  const filePaths = [];
  collectSessionFilesByModifiedTime(baseDir, startedTime, filePaths, limit * 4);
  const matches = [];
  for (const filePath of filePaths) {
    try {
      const st = statSync2(filePath);
      const modifiedAt = new Date(st.mtimeMs).toISOString();
      const entries = await parseJsonlHead(filePath);
      const extract = provider === "codex" ? extractCodexSessionMeta : extractClaudeSessionMeta;
      const meta = extract(entries, filePath, modifiedAt);
      if (!meta) continue;
      if (wasSessionTouchedAfterRun(meta, startedTime, beforeRun)) {
        matches.push(meta);
      }
    } catch {
      continue;
    }
  }
  return dedupeById(matches).sort((a, b) => b.modified_at.localeCompare(a.modified_at));
}
async function findSingleCodexSessionForRunningAgent(startedTime, beforeRun, normalizedCwd) {
  const candidates = await collectSessionCandidatesByModifiedTime(
    CODEX_SESSIONS_DIR,
    startedTime,
    beforeRun,
    "codex"
  );
  const sameProjectCandidates = candidates.filter(
    (session) => normalizeProjectPath(session.project_path) === normalizedCwd
  );
  if (sameProjectCandidates.length !== 1) return null;
  return sameProjectCandidates[0];
}
async function findKnownSessionForRun(sessionId, provider, normalizedCwd, attempt) {
  if (provider === "claude" && normalizedCwd) {
    const direct = await findClaudeSessionInProjectById(sessionId, normalizedCwd);
    if (direct) return direct;
  }
  if (attempt % 8 !== 0) return null;
  return findSessionById(sessionId);
}
async function findClaudeSessionInProjectById(sessionId, normalizedCwd) {
  const filePath = join2(encodeClaudeProjectDirectory(normalizedCwd), `${sessionId}.jsonl`);
  let fileModifiedAt;
  try {
    const st = statSync2(filePath);
    if (!st.isFile()) return null;
    fileModifiedAt = st.mtimeMs;
  } catch {
    return null;
  }
  const modifiedAt = new Date(fileModifiedAt).toISOString();
  try {
    const parsedEntries = await parseJsonlHead(filePath);
    const parsedMeta = extractClaudeSessionMeta(parsedEntries, filePath, modifiedAt);
    if (parsedMeta) {
      return parsedMeta;
    }
  } catch {
  }
  return {
    session_id: sessionId,
    provider: "claude",
    model: "",
    project_path: normalizedCwd,
    first_prompt: "",
    file_path: filePath,
    created_at: modifiedAt,
    modified_at: modifiedAt
  };
}
function encodeClaudeProjectDirectory(cwd) {
  const normalized = resolve(cwd);
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  return join2(CLAUDE_SESSIONS_DIR, `-${parts.join("-")}`);
}
function snapshotProjectSessions(projectDir) {
  const snapshot = /* @__PURE__ */ new Map();
  const absoluteProjectDir = encodeClaudeProjectDirectory(projectDir);
  const stack = [absoluteProjectDir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    let entries;
    try {
      entries = readdirSync(current);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry === "subagents") {
        continue;
      }
      const fullPath = join2(current, entry);
      let stat;
      try {
        stat = statSync2(fullPath);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (entry.endsWith(".jsonl")) {
        snapshot.set(fullPath, stat.mtimeMs);
      }
    }
  }
  return snapshot;
}
async function detectSessionInCurrentClaudeProject(startedTime, beforeRun, normalizedCwd, beforeRunProjectFiles = /* @__PURE__ */ new Map()) {
  const currentProjectFiles = snapshotProjectSessions(normalizedCwd);
  if (currentProjectFiles.size === 0) return null;
  const candidates = [];
  for (const [filePath, fileModifiedAt] of currentProjectFiles) {
    if (fileModifiedAt < startedTime) continue;
    const beforeProjectModifiedAt = beforeRunProjectFiles.get(filePath);
    if (beforeProjectModifiedAt !== void 0 && fileModifiedAt <= beforeProjectModifiedAt) continue;
    const modifiedAt = new Date(fileModifiedAt).toISOString();
    let parsed = null;
    try {
      const parsedEntries = await parseJsonlHead(filePath);
      const parsedMeta = extractClaudeSessionMeta(parsedEntries, filePath, modifiedAt);
      parsed = parsedMeta ?? null;
    } catch {
      parsed = null;
    }
    const sessionId = parsed?.session_id || basename(filePath, ".jsonl");
    const candidate = {
      session_id: sessionId,
      provider: "claude",
      model: parsed?.model || "",
      project_path: parsed?.project_path || normalizedCwd,
      first_prompt: parsed?.first_prompt || "",
      file_path: filePath,
      created_at: parsed?.created_at || modifiedAt,
      modified_at: modifiedAt,
      ...parsed?.token_usage ? { token_usage: parsed.token_usage } : {}
    };
    if (normalizeProjectPath(candidate.project_path) !== normalizedCwd) continue;
    if (!wasSessionTouchedAfterRun(candidate, startedTime, beforeRun)) continue;
    candidates.push(candidate);
  }
  if (candidates.length === 0) {
    const directCandidates = [];
    for (const [filePath, beforeModifiedAt] of beforeRunProjectFiles) {
      const after = currentProjectFiles.get(filePath);
      if (after === void 0) continue;
      if (!Number.isFinite(after) || after < startedTime || after <= beforeModifiedAt) continue;
      const sessionId = basename(filePath, ".jsonl");
      directCandidates.push({
        session_id: sessionId,
        provider: "claude",
        model: "",
        project_path: normalizedCwd,
        first_prompt: "",
        file_path: filePath,
        created_at: new Date(after).toISOString(),
        modified_at: new Date(after).toISOString()
      });
    }
    if (directCandidates.length > 0) {
      directCandidates.sort((a, b) => b.modified_at.localeCompare(a.modified_at));
      return directCandidates[0];
    }
  }
  if (candidates.length === 0) return null;
  const deduped = dedupeById(candidates);
  if (deduped.length === 1) return deduped[0];
  deduped.sort((a, b) => b.modified_at.localeCompare(a.modified_at));
  return deduped[0];
}
function normalizeProjectPath(value) {
  if (!value) return "";
  try {
    return resolve(value);
  } catch {
    return value;
  }
}
function dedupeById(sessions) {
  const latest = /* @__PURE__ */ new Map();
  for (const session of sessions) {
    const current = latest.get(session.session_id);
    if (!current || session.modified_at > current.modified_at) {
      latest.set(session.session_id, session);
    }
  }
  return [...latest.values()];
}
function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
async function pinSessionToCatalog(session, opts, space) {
  const existing = findBookmark(session.session_id);
  if (existing) {
    if (!existing.space_ids.includes(space.id)) {
      existing.space_ids.push(space.id);
      updateBookmark(existing.id, { space_ids: existing.space_ids });
      console.log(chalk.green(`Added ${existing.id} to catalog "${space.name}" (${space.id})`));
    } else {
      console.log(chalk.yellow(`Session already in catalog "${space.name}".`));
    }
    return;
  }
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const bookmarkId = generateBookmarkId(listBookmarks());
  const title = opts.title || session.first_prompt.slice(0, 60) || session.session_id.slice(0, 16);
  const tagList = opts.tags ? opts.tags.split(",").map((tag) => tag.trim()).filter(Boolean) : [];
  addBookmark({
    id: bookmarkId,
    provider: session.provider,
    session_id: session.session_id,
    title,
    category: "",
    tags: tagList,
    project_path: session.project_path ?? "",
    first_prompt: session.first_prompt ?? "",
    notes: [],
    space_ids: [space.id],
    created_at: now,
    updated_at: now
  });
  console.log(chalk.green(`Pinned: ${bookmarkId}`));
  console.log(`  Title:   ${title}`);
  console.log(`  Catalog: ${space.name} (${space.id})`);
}
function normalizeAgent(input) {
  if (input === "claude") return "claude";
  if (input === "codex" || input === "agent") return "codex";
  return null;
}
export {
  registerRunCommand,
  syncClaudeProfileSettingsFromRunSettings
};
