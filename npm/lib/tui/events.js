/**
 * Starling-owned chat semantics.
 *
 * Raw official Pi SDK and Starling records are deliberately normalized in
 * this module before they reach the TUI reducer. Keeping protocol knowledge
 * at one boundary lets the state machine and renderer remain backend-neutral.
 */
/** Normalize an SDK state/message pair returned by get_state/get_messages. */
export function normalizeChatSnapshot(rawState, rawMessages) {
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
export function normalizeChatRecord(raw) {
    if (!isRecord(raw))
        return [];
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
            if (!update || !delta)
                return [];
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
            const events = message
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
            if (!Object.hasOwn(raw, "name") && !Object.hasOwn(raw, "sessionName"))
                return [];
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
export function normalizeExtensionUiRequest(raw) {
    if (!isRecord(raw))
        return null;
    const id = textField(raw.id);
    const method = textField(raw.method);
    if (!id || !isInteractionMethod(method))
        return null;
    const suppliedOptions = Array.isArray(raw.options) ? raw.options.map(String) : [];
    return {
        id,
        method,
        title: textField(raw.title) || "Starling needs your input",
        message: textField(raw.message) || textField(raw.placeholder),
        options: method === "confirm" ? ["No", "Yes"] : suppliedOptions,
        initialValue: method === "editor" ? textField(raw.prefill) : "",
    };
}
export function isRecord(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
export function printable(value) {
    if (typeof value === "string")
        return value;
    if (value === undefined || value === null)
        return "";
    try {
        return JSON.stringify(value, null, 2);
    }
    catch {
        return String(value);
    }
}
function normalizeExtensionUiRecord(raw) {
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
                ? raw.widgetLines
                : null;
        if (!key || lines === null)
            return [];
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
function normalizeMessage(raw, pending) {
    if (!isRecord(raw))
        return null;
    const role = textField(raw.role);
    const content = extractContent(raw.content);
    if (role === "user")
        return { kind: "user", text: content.text, pending };
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
function normalizeHistory(messages) {
    const transcript = [];
    const toolIndexes = new Map();
    for (const raw of messages) {
        if (!isRecord(raw) || raw.display === false)
            continue;
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
                    if (!isRecord(block) || block.type !== "toolCall")
                        continue;
                    const callId = textField(block.id) || textField(block.toolCallId);
                    const item = {
                        kind: "tool",
                        text: printable(block.arguments ?? block.args),
                        toolCallId: callId,
                        toolName: textField(block.name) || "tool",
                        toolState: "done",
                    };
                    if (callId)
                        toolIndexes.set(callId, transcript.length);
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
            const item = {
                kind: "tool",
                text: content.text || printable(raw.content),
                toolCallId: callId,
                toolName: textField(raw.toolName) || "tool result",
                toolState: raw.isError === true ? "error" : "done",
            };
            const existingIndex = callId ? toolIndexes.get(callId) : undefined;
            if (existingIndex === undefined)
                transcript.push(item);
            else
                transcript[existingIndex] = { ...transcript[existingIndex], ...item };
            continue;
        }
        if ((role === "custom" || role === "system" || role === "developer") && content.text) {
            transcript.push({ kind: "system", text: content.text });
        }
    }
    return transcript;
}
function extractContent(content) {
    if (typeof content === "string")
        return { text: content };
    if (!Array.isArray(content))
        return { text: "" };
    let text = "";
    let thinking = "";
    for (const block of content) {
        if (!isRecord(block))
            continue;
        if (block.type === "text")
            text += textField(block.text);
        if (block.type === "thinking")
            thinking += textField(block.thinking) || textField(block.text);
    }
    return { text, thinking: thinking || undefined };
}
function assistantTerminalIssue(raw) {
    if (!isRecord(raw) || raw.role !== "assistant")
        return null;
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
function diagnosticLevel(value) {
    return value === "error" ? "error" : value === "warning" ? "warning" : "info";
}
function isInteractionMethod(value) {
    return value === "confirm" || value === "select" || value === "input" || value === "editor";
}
function textField(value) {
    return typeof value === "string" ? value : "";
}
function optionalText(value) {
    return typeof value === "string" && value ? value : undefined;
}
function optionalNumber(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function nonNegativeInteger(value) {
    return typeof value === "number" && Number.isFinite(value)
        ? Math.max(0, Math.trunc(value))
        : 0;
}
