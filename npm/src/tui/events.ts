/**
 * Starling-owned chat semantics.
 *
 * Raw official Pi SDK and Starling records are deliberately normalized in
 * this module before they reach the TUI reducer. Keeping protocol knowledge
 * at one boundary lets the state machine and renderer remain backend-neutral.
 */

export type ChatRole = "user" | "assistant" | "system";
export type ChatToolState = "running" | "done" | "error";
export type ChatActivityTone = "neutral" | "active" | "success" | "error";

export interface ChatTranscriptItem {
  kind: ChatRole | "tool" | "error";
  text: string;
  thinking?: string;
  toolCallId?: string;
  toolName?: string;
  toolState?: ChatToolState;
  pending?: boolean;
}

export interface ChatSessionSnapshot {
  sessionId?: string;
  sessionName?: string;
  sessionFile?: string;
  model: string;
  thinking: string;
  queueDepth: number;
  streaming: boolean;
  compacting?: boolean;
  transcript: ChatTranscriptItem[];
}

export type ChatInteractionMethod = "confirm" | "select" | "input" | "editor";

export interface ChatInteractionRequest {
  id: string;
  method: ChatInteractionMethod;
  title: string;
  message: string;
  options: string[];
  initialValue: string;
  secret: boolean;
}

export type ChatEvent =
  | {
    type: "runtime.started";
    cwd?: string;
    runId?: string;
    sessionId?: string;
  }
  | {
    type: "runtime.exited";
    success: boolean;
    exitCode?: number;
  }
  | { type: "session.snapshot"; snapshot: ChatSessionSnapshot }
  | { type: "session.name.changed"; name?: string }
  | { type: "session.thinking.changed"; level: string }
  | { type: "status.changed"; key: string; text?: string }
  | {
    type: "widget.changed";
    key: string;
    lines?: string[];
    placement: "aboveEditor" | "belowEditor";
  }
  | { type: "terminal.title.changed"; title: string }
  | { type: "turn.started" }
  | { type: "turn.generating" }
  | { type: "turn.finalizing" }
  | { type: "turn.settled" }
  | { type: "turn.retrying"; attempt: number; message: string }
  | { type: "message.started"; message: ChatTranscriptItem }
  | {
    type: "message.delta";
    channel: "text" | "thinking";
    delta: string;
  }
  | { type: "message.completed"; message: ChatTranscriptItem }
  | {
    type: "tool.started";
    callId: string;
    name: string;
    input: string;
  }
  | { type: "tool.updated"; callId: string; output: string }
  | {
    type: "tool.completed";
    callId: string;
    name: string;
    output: string;
    failed: boolean;
  }
  | { type: "queue.changed"; depth: number }
  | { type: "context.compaction.started" }
  | {
    type: "context.compaction.completed";
    failed: boolean;
    aborted: boolean;
    message?: string;
  }
  | {
    type: "retry.completed";
    success: boolean;
    message: string;
  }
  | {
    type: "activity.recorded";
    label: string;
    detail: string;
    tone: ChatActivityTone;
  }
  | {
    type: "diagnostic";
    level: "info" | "warning" | "error";
    message: string;
  }
  | { type: "interaction.requested"; request: ChatInteractionRequest }
  | { type: "interaction.dismissed"; id: string }
  | { type: "composer.replaced"; value: string };

/** Normalize an SDK state/message pair returned by get_state/get_messages. */
export function normalizeChatSnapshot(
  rawState: unknown,
  rawMessages: readonly unknown[],
): ChatSessionSnapshot {
  const state = isRecord(rawState) ? rawState : {};
  const model = isRecord(state.model) ? state.model : {};
  const provider = textField(model.provider);
  const modelId = textField(model.id) || textField(model.modelId);
  return {
    sessionId: optionalText(state.sessionId),
    sessionName: optionalText(state.sessionName),
    sessionFile: optionalText(state.sessionFile),
    model: [provider, modelId].filter(Boolean).join("/") || "default model",
    thinking: textField(state.thinkingLevel) || textField(state.thinking),
    queueDepth: nonNegativeInteger(state.pendingMessageCount),
    streaming: state.isStreaming === true,
    compacting: state.isCompacting === true,
    transcript: normalizeHistory(rawMessages),
  };
}

/**
 * Convert one raw official Pi/Starling JSON record into zero or more stable events.
 * Unknown backend records are ignored at this boundary, never in the reducer.
 */
export function normalizeChatRecord(raw: unknown): ChatEvent[] {
  if (!isRecord(raw)) return [];

  switch (raw.type) {
    case "starling_started":
      return [{
        type: "runtime.started",
        cwd: optionalText(raw.cwd),
        runId: optionalText(raw.runId),
        sessionId: optionalText(raw.sessionId),
      }];
    case "starling_exited":
      return [{
        type: "runtime.exited",
        success: raw.success === true,
        exitCode: optionalNumber(raw.exitCode),
      }];
    case "agent_start":
      return [{ type: "turn.started" }];
    case "agent_settled":
      return [{ type: "turn.settled" }];
    case "agent_end":
      return raw.willRetry === true
        ? [{
          type: "turn.retrying",
          attempt: nonNegativeInteger(raw.attempt) || 1,
          message: textField(raw.errorMessage) || "Retry scheduled",
        }]
        : [{ type: "turn.finalizing" }];
    case "turn_start":
      return [{ type: "turn.generating" }];
    case "turn_end":
      return [{ type: "turn.finalizing" }];
    case "message_start": {
      const message = normalizeMessage(raw.message, true);
      return message ? [{ type: "message.started", message }] : [];
    }
    case "message_update": {
      const update = isRecord(raw.assistantMessageEvent)
        ? raw.assistantMessageEvent
        : undefined;
      const delta = update ? textField(update.delta) : "";
      if (!update || !delta) return [];
      if (update.type === "thinking_delta") {
        return [{ type: "message.delta", channel: "thinking", delta }];
      }
      if (update.type === "text_delta") {
        return [{ type: "message.delta", channel: "text", delta }];
      }
      return [];
    }
    case "message_end": {
      const message = normalizeMessage(raw.message, false);
      const events: ChatEvent[] = message
        ? [{ type: "message.completed", message }]
        : [];
      const issue = assistantTerminalIssue(raw.message);
      if (issue) {
        events.push({
          type: "diagnostic",
          level: issue.level,
          message: issue.message,
        });
      }
      return events;
    }
    case "tool_execution_start":
      return [{
        type: "tool.started",
        callId: textField(raw.toolCallId) || "tool",
        name: textField(raw.toolName) || "tool",
        input: printable(raw.args),
      }];
    case "tool_execution_update":
      return [{
        type: "tool.updated",
        callId: textField(raw.toolCallId),
        output: printable(raw.partialResult),
      }];
    case "tool_execution_end":
      return [{
        type: "tool.completed",
        callId: textField(raw.toolCallId),
        name: textField(raw.toolName) || "tool",
        output: printable(raw.result),
        failed: raw.isError === true,
      }];
    case "queue_update": {
      const steering = Array.isArray(raw.steering) ? raw.steering.length : 0;
      const followUp = Array.isArray(raw.followUp) ? raw.followUp.length : 0;
      return [{ type: "queue.changed", depth: steering + followUp }];
    }
    case "session_info_changed": {
      if (!Object.hasOwn(raw, "name") && !Object.hasOwn(raw, "sessionName")) return [];
      const value = Object.hasOwn(raw, "name") ? raw.name : raw.sessionName;
      return [{ type: "session.name.changed", name: optionalText(value) }];
    }
    case "thinking_level_changed": {
      const level = textField(raw.level);
      return level ? [{ type: "session.thinking.changed", level }] : [];
    }
    case "compaction_start":
      return [{ type: "context.compaction.started" }];
    case "compaction_end": {
      const message = textField(raw.errorMessage);
      const aborted = raw.aborted === true;
      return [{
        type: "context.compaction.completed",
        failed: !aborted && Boolean(message),
        aborted,
        message: message || undefined,
      }];
    }
    case "auto_retry_start":
      return [{
        type: "turn.retrying",
        attempt: nonNegativeInteger(raw.attempt) || 1,
        message: textField(raw.errorMessage) || "Retry scheduled",
      }];
    case "auto_retry_end": {
      const success = raw.success === true;
      return [{
        type: "retry.completed",
        success,
        message: success
          ? "Retry recovered"
          : textField(raw.finalError) || "Retry failed",
      }];
    }
    case "bash_execution_update": {
      const detail = textField(raw.delta);
      return detail
        ? [{ type: "activity.recorded", label: "shell", detail, tone: "active" }]
        : [];
    }
    case "notice": {
      const level = diagnosticLevel(raw.level);
      const message = textField(raw.message);
      return message ? [{ type: "diagnostic", level, message }] : [];
    }
    case "extension_error": {
      const source = textField(raw.extensionPath) || "extension";
      const message = textField(raw.error) || "Extension failed";
      return [{ type: "diagnostic", level: "error", message: `${source}: ${message}` }];
    }
    case "extension_ui_request":
      return normalizeExtensionUiRecord(raw);
    case "extension_ui_cancelled": {
      const id = textField(raw.id);
      return id ? [{ type: "interaction.dismissed", id }] : [];
    }
    default:
      return [];
  }
}

/** Normalize only the interactive subset of an extension UI request. */
export function normalizeExtensionUiRequest(raw: unknown): ChatInteractionRequest | null {
  if (!isRecord(raw)) return null;
  const id = textField(raw.id);
  const method = textField(raw.method);
  if (!id || !isInteractionMethod(method)) return null;
  const suppliedOptions = Array.isArray(raw.options) ? raw.options.map(String) : [];
  return {
    id,
    method,
    title: textField(raw.title) || "Starling needs your input",
    message: textField(raw.message) || textField(raw.placeholder),
    options: method === "confirm" ? ["No", "Yes"] : suppliedOptions,
    initialValue: method === "editor" ? textField(raw.prefill) : "",
    secret: method === "input" && raw.secret === true,
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function printable(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function normalizeExtensionUiRecord(raw: Record<string, unknown>): ChatEvent[] {
  const method = textField(raw.method);
  if (method === "notify") {
    const message = textField(raw.message);
    return message
      ? [{ type: "diagnostic", level: diagnosticLevel(raw.notifyType), message }]
      : [];
  }
  if (method === "setStatus") {
    const key = textField(raw.statusKey) || "status";
    return [{ type: "status.changed", key, text: optionalText(raw.statusText) }];
  }
  if (method === "setWidget") {
    const key = textField(raw.widgetKey);
    const lines = raw.widgetLines === undefined
      ? undefined
      : Array.isArray(raw.widgetLines) && raw.widgetLines.every((line) => typeof line === "string")
        ? raw.widgetLines as string[]
        : null;
    if (!key || lines === null) return [];
    return [{
      type: "widget.changed",
      key,
      lines,
      placement: raw.widgetPlacement === "belowEditor" ? "belowEditor" : "aboveEditor",
    }];
  }
  if (method === "setTitle") {
    return [{ type: "terminal.title.changed", title: textField(raw.title) }];
  }
  if (method === "set_editor_text") {
    return [{ type: "composer.replaced", value: textField(raw.text) }];
  }
  const request = normalizeExtensionUiRequest(raw);
  return request ? [{ type: "interaction.requested", request }] : [];
}

function normalizeMessage(raw: unknown, pending: boolean): ChatTranscriptItem | null {
  if (!isRecord(raw)) return null;
  const role = textField(raw.role);
  const content = extractContent(raw.content);
  if (role === "user") return { kind: "user", text: content.text, pending };
  if (role === "assistant") {
    return {
      kind: "assistant",
      text: content.text,
      thinking: content.thinking,
      pending,
    };
  }
  if (role === "custom" || role === "system" || role === "developer") {
    return content.text ? { kind: "system", text: content.text } : null;
  }
  return null;
}

function normalizeHistory(messages: readonly unknown[]): ChatTranscriptItem[] {
  const transcript: ChatTranscriptItem[] = [];
  const toolIndexes = new Map<string, number>();
  for (const raw of messages) {
    if (!isRecord(raw) || raw.display === false) continue;
    const role = textField(raw.role);
    const content = extractContent(raw.content);
    if (role === "user" && content.text) {
      transcript.push({ kind: "user", text: content.text });
      continue;
    }
    if (role === "assistant") {
      if (content.text || content.thinking) {
        transcript.push({ kind: "assistant", ...content });
      }
      if (Array.isArray(raw.content)) {
        for (const block of raw.content) {
          if (!isRecord(block) || block.type !== "toolCall") continue;
          const callId = textField(block.id) || textField(block.toolCallId);
          const item: ChatTranscriptItem = {
            kind: "tool",
            text: printable(block.arguments ?? block.args),
            toolCallId: callId,
            toolName: textField(block.name) || "tool",
            toolState: "done",
          };
          if (callId) toolIndexes.set(callId, transcript.length);
          transcript.push(item);
        }
      }
      const issue = assistantTerminalIssue(raw);
      if (issue) {
        transcript.push({
          kind: issue.level === "error" ? "error" : "system",
          text: issue.message,
        });
      }
      continue;
    }
    if (role === "toolResult") {
      const callId = textField(raw.toolCallId);
      const item: ChatTranscriptItem = {
        kind: "tool",
        text: content.text || printable(raw.content),
        toolCallId: callId,
        toolName: textField(raw.toolName) || "tool result",
        toolState: raw.isError === true ? "error" : "done",
      };
      const existingIndex = callId ? toolIndexes.get(callId) : undefined;
      if (existingIndex === undefined) transcript.push(item);
      else transcript[existingIndex] = { ...transcript[existingIndex], ...item };
      continue;
    }
    if ((role === "custom" || role === "system" || role === "developer") && content.text) {
      transcript.push({ kind: "system", text: content.text });
    }
  }
  return transcript;
}

function extractContent(content: unknown): { text: string; thinking?: string } {
  if (typeof content === "string") return { text: content };
  if (!Array.isArray(content)) return { text: "" };
  let text = "";
  let thinking = "";
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "text") text += textField(block.text);
    if (block.type === "thinking") thinking += textField(block.thinking) || textField(block.text);
  }
  return { text, thinking: thinking || undefined };
}

function assistantTerminalIssue(
  raw: unknown,
): { level: "info" | "error"; message: string } | null {
  if (!isRecord(raw) || raw.role !== "assistant") return null;
  if (raw.stopReason === "error") {
    return {
      level: "error",
      message: textField(raw.errorMessage) || "Agent request failed",
    };
  }
  if (raw.stopReason === "aborted") {
    return {
      level: "info",
      message: textField(raw.errorMessage) || "Request aborted",
    };
  }
  return null;
}

function diagnosticLevel(value: unknown): "info" | "warning" | "error" {
  return value === "error" ? "error" : value === "warning" ? "warning" : "info";
}

function isInteractionMethod(value: string): value is ChatInteractionMethod {
  return value === "confirm" || value === "select" || value === "input" || value === "editor";
}

function textField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : 0;
}
