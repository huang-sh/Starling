import { basename } from "node:path";
const MAX_TIMELINE_ENTRIES = 1_000;
const MAX_ACTIVITY_ENTRIES = 100;
export function createInitialStarlingTuiState(cwd) {
    const normalized = cwd.trim() || process.cwd();
    return {
        cwd: normalized,
        workspace: basename(normalized) || normalized,
        phase: "starting",
        status: "Starting agent runtime…",
        ready: false,
        busy: false,
        model: "default model",
        thinking: "",
        queueDepth: 0,
        composer: "",
        scrollOffset: 0,
        timeline: [],
        activity: [],
        nextId: 1,
    };
}
export function reduceStarlingTui(state, action) {
    switch (action.type) {
        case "starling.started": {
            const cwd = textField(action.value.cwd) || state.cwd;
            const next = {
                ...state,
                cwd,
                workspace: basename(cwd) || cwd,
                runId: textField(action.value.runId) || state.runId,
                sessionId: textField(action.value.sessionId) || state.sessionId,
                status: "Loading session…",
            };
            return addActivity(next, "runtime", "Starling agent host started", "active");
        }
        case "starling.exited": {
            const success = action.value.success === true;
            const exitCode = numberField(action.value.exitCode);
            const label = success ? "Session closed" : `Agent stopped (${exitCode ?? "unknown"})`;
            return addActivity({
                ...state,
                phase: success ? "stopped" : "error",
                ready: false,
                busy: false,
                status: label,
                uiPrompt: undefined,
            }, "runtime", label, success ? "success" : "error");
        }
        case "session.hydrated": {
            const model = isRecord(action.state.model) ? action.state.model : {};
            const provider = textField(model.provider);
            const modelId = textField(model.id) || textField(model.modelId);
            const normalized = normalizeHistory(action.messages);
            const isStreaming = action.state.isStreaming === true;
            return {
                ...state,
                phase: isStreaming ? "working" : "ready",
                status: isStreaming ? "Agent is working…" : "Ready",
                ready: true,
                busy: isStreaming,
                sessionId: textField(action.state.sessionId) || state.sessionId,
                sessionName: textField(action.state.sessionName) || state.sessionName,
                sessionFile: textField(action.state.sessionFile) || state.sessionFile,
                model: [provider, modelId].filter(Boolean).join("/") || "default model",
                thinking: textField(action.state.thinkingLevel),
                queueDepth: numberField(action.state.pendingMessageCount) ?? 0,
                timeline: normalized.timeline,
                nextId: Math.max(state.nextId, normalized.nextId),
            };
        }
        case "rpc.event":
            return reduceRpcEvent(state, action.value);
        case "composer.set":
            return { ...state, composer: action.value };
        case "composer.append":
            return { ...state, composer: state.composer + action.value };
        case "composer.backspace":
            return { ...state, composer: removeLastCodePoint(state.composer) };
        case "prompt.submitted": {
            const next = appendTimeline({
                ...state,
                composer: "",
                scrollOffset: 0,
                busy: true,
                phase: "working",
                status: action.queued ? "Follow-up queued" : "Sending…",
                queueDepth: action.queued ? state.queueDepth + 1 : state.queueDepth,
            }, { kind: "user", text: action.text, pending: true });
            return addActivity(next, action.queued ? "queue" : "prompt", action.queued ? "Follow-up queued" : "Prompt accepted", "active");
        }
        case "prompt.rejected":
            return appendTimeline(addActivity({ ...state, phase: "error", busy: false, status: action.message }, "request", action.message, "error"), { kind: "error", text: action.message });
        case "scroll":
            return { ...state, scrollOffset: Math.max(0, state.scrollOffset + action.delta) };
        case "diagnostic": {
            const message = compactWhitespace(action.message);
            if (!message)
                return state;
            return addActivity(action.level === "error" ? { ...state, status: message } : state, action.level === "error" ? "error" : "log", message, action.level === "error" ? "error" : "neutral");
        }
        case "ui.open":
            return addActivity({ ...state, uiPrompt: action.prompt, status: action.prompt.title || "Input requested" }, "attention", action.prompt.title || `${action.prompt.method} requested`, "active");
        case "ui.select": {
            if (!state.uiPrompt || state.uiPrompt.options.length === 0)
                return state;
            const count = state.uiPrompt.options.length;
            const selected = (state.uiPrompt.selected + action.delta + count) % count;
            return { ...state, uiPrompt: { ...state.uiPrompt, selected } };
        }
        case "ui.value":
            return state.uiPrompt
                ? { ...state, uiPrompt: { ...state.uiPrompt, value: action.value } }
                : state;
        case "ui.append":
            return state.uiPrompt
                ? { ...state, uiPrompt: { ...state.uiPrompt, value: state.uiPrompt.value + action.value } }
                : state;
        case "ui.backspace":
            return state.uiPrompt
                ? { ...state, uiPrompt: { ...state.uiPrompt, value: removeLastCodePoint(state.uiPrompt.value) } }
                : state;
        case "ui.close":
            return { ...state, uiPrompt: undefined, status: state.busy ? "Agent is working…" : "Ready" };
    }
}
export function createExtensionUiPrompt(value) {
    const id = textField(value.id);
    const method = textField(value.method);
    if (!id || !isInteractiveUiMethod(method))
        return null;
    const suppliedOptions = Array.isArray(value.options) ? value.options.map(String) : [];
    const options = method === "confirm" ? ["No", "Yes"] : suppliedOptions;
    return {
        id,
        method,
        title: textField(value.title) || "Starling needs your input",
        message: textField(value.message) || textField(value.placeholder),
        options,
        selected: 0,
        value: method === "editor" ? textField(value.prefill) : "",
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
function reduceRpcEvent(state, value) {
    switch (value.type) {
        case "agent_start":
            return addActivity({ ...state, busy: true, phase: "working", status: "Agent is working…" }, "turn", "Reasoning started", "active");
        case "agent_settled":
            return addActivity({ ...state, busy: false, phase: "ready", status: "Ready", queueDepth: 0 }, "turn", "Agent settled", "success");
        case "agent_end":
            return { ...state, status: value.willRetry === true ? "Retrying…" : "Finishing turn…" };
        case "turn_start":
            return { ...state, busy: true, phase: "working", status: "Generating…" };
        case "turn_end":
            return { ...state, status: "Finalizing…" };
        case "message_start":
            return startMessage(state, value.message);
        case "message_update":
            return updateAssistantDelta(state, value.assistantMessageEvent);
        case "message_end":
            return finishMessage(state, value.message);
        case "tool_execution_start": {
            const id = textField(value.toolCallId) || `tool-${state.nextId}`;
            const name = textField(value.toolName) || "tool";
            const next = appendTimeline(state, {
                kind: "tool",
                text: printable(value.args),
                toolCallId: id,
                toolName: name,
                toolState: "running",
            });
            return addActivity(next, name, "Running", "active");
        }
        case "tool_execution_update":
            return updateTool(state, textField(value.toolCallId), printable(value.partialResult), "running");
        case "tool_execution_end": {
            const failed = value.isError === true;
            const id = textField(value.toolCallId);
            const name = textField(value.toolName) || "tool";
            const next = updateTool(state, id, printable(value.result), failed ? "error" : "done");
            return addActivity(next, name, failed ? "Failed" : "Completed", failed ? "error" : "success");
        }
        case "queue_update": {
            const steering = Array.isArray(value.steering) ? value.steering.length : 0;
            const followUp = Array.isArray(value.followUp) ? value.followUp.length : 0;
            return { ...state, queueDepth: steering + followUp };
        }
        case "session_info_changed":
            return { ...state, sessionName: textField(value.name) || state.sessionName };
        case "thinking_level_changed":
            return { ...state, thinking: textField(value.level) || state.thinking };
        case "compaction_start":
            return addActivity({ ...state, status: "Compacting context…" }, "context", "Compacting", "active");
        case "compaction_end": {
            const failed = Boolean(value.errorMessage);
            return addActivity({ ...state, status: failed ? textField(value.errorMessage) : state.status }, "context", failed ? textField(value.errorMessage) : "Compaction complete", failed ? "error" : "success");
        }
        case "auto_retry_start":
            return addActivity({ ...state, status: `Retrying (${numberField(value.attempt) ?? 1})…` }, "retry", textField(value.errorMessage) || "Retry scheduled", "active");
        case "auto_retry_end":
            return addActivity(state, "retry", value.success === true ? "Retry recovered" : textField(value.finalError) || "Retry failed", value.success === true ? "success" : "error");
        case "bash_execution_update":
            return addActivity(state, "shell", textField(value.delta), "active");
        default:
            return state;
    }
}
function startMessage(state, raw) {
    if (!isRecord(raw))
        return state;
    const role = textField(raw.role);
    const { text, thinking } = extractContent(raw.content);
    if (role === "user") {
        const last = state.timeline.at(-1);
        if (last?.kind === "user" && last.pending && last.text === text) {
            return {
                ...state,
                timeline: state.timeline.map((entry, index) => index === state.timeline.length - 1 ? { ...entry, pending: false } : entry),
            };
        }
        return text ? appendTimeline(state, { kind: "user", text }) : state;
    }
    if (role === "assistant") {
        return appendTimeline(state, { kind: "assistant", text, thinking, pending: true });
    }
    if (role === "custom" || role === "system") {
        return text ? appendTimeline(state, { kind: "system", text }) : state;
    }
    return state;
}
function updateAssistantDelta(state, raw) {
    if (!isRecord(raw))
        return state;
    const delta = textField(raw.delta);
    if (!delta)
        return state;
    const channel = raw.type === "thinking_delta" ? "thinking" : raw.type === "text_delta" ? "text" : "";
    if (!channel)
        return state;
    let index = findLastIndex(state.timeline, (entry) => entry.kind === "assistant" && entry.pending === true);
    let next = state;
    if (index < 0) {
        next = appendTimeline(state, { kind: "assistant", text: "", pending: true });
        index = next.timeline.length - 1;
    }
    return {
        ...next,
        timeline: next.timeline.map((entry, entryIndex) => {
            if (entryIndex !== index)
                return entry;
            return channel === "thinking"
                ? { ...entry, thinking: (entry.thinking || "") + delta }
                : { ...entry, text: entry.text + delta };
        }),
    };
}
function finishMessage(state, raw) {
    if (!isRecord(raw))
        return state;
    const role = textField(raw.role);
    if (role !== "assistant")
        return state;
    const content = extractContent(raw.content);
    const index = findLastIndex(state.timeline, (entry) => entry.kind === "assistant" && entry.pending === true);
    if (index < 0)
        return appendTimeline(state, { kind: "assistant", ...content, pending: false });
    return {
        ...state,
        timeline: state.timeline.map((entry, entryIndex) => entryIndex === index
            ? {
                ...entry,
                text: content.text || entry.text,
                thinking: content.thinking || entry.thinking,
                pending: false,
            }
            : entry),
    };
}
function updateTool(state, toolCallId, text, toolState) {
    if (!toolCallId)
        return state;
    const index = findLastIndex(state.timeline, (entry) => entry.toolCallId === toolCallId);
    if (index < 0) {
        return appendTimeline(state, {
            kind: "tool",
            text,
            toolCallId,
            toolName: "tool",
            toolState,
        });
    }
    return {
        ...state,
        timeline: state.timeline.map((entry, entryIndex) => entryIndex === index
            ? { ...entry, text: text || entry.text, toolState }
            : entry),
    };
}
function normalizeHistory(messages) {
    const timeline = [];
    let nextId = 1;
    const append = (entry) => timeline.push({ id: nextId++, ...entry });
    for (const raw of messages) {
        if (!isRecord(raw))
            continue;
        const role = textField(raw.role);
        const content = extractContent(raw.content);
        if (role === "user" && content.text)
            append({ kind: "user", text: content.text });
        if (role === "assistant") {
            if (content.text || content.thinking)
                append({ kind: "assistant", ...content });
            if (Array.isArray(raw.content)) {
                for (const block of raw.content) {
                    if (!isRecord(block) || block.type !== "toolCall")
                        continue;
                    append({
                        kind: "tool",
                        text: printable(block.arguments ?? block.args),
                        toolCallId: textField(block.id),
                        toolName: textField(block.name) || "tool",
                        toolState: "done",
                    });
                }
            }
        }
        if (role === "toolResult") {
            append({
                kind: "tool",
                text: content.text || printable(raw.content),
                toolCallId: textField(raw.toolCallId),
                toolName: textField(raw.toolName) || "tool result",
                toolState: raw.isError === true ? "error" : "done",
            });
        }
        if ((role === "custom" || role === "system") && content.text) {
            append({ kind: "system", text: content.text });
        }
    }
    return { timeline: timeline.slice(-MAX_TIMELINE_ENTRIES), nextId };
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
function appendTimeline(state, entry) {
    return {
        ...state,
        timeline: [...state.timeline, { id: state.nextId, ...entry }].slice(-MAX_TIMELINE_ENTRIES),
        nextId: state.nextId + 1,
    };
}
function addActivity(state, label, detail, tone) {
    const cleanDetail = compactWhitespace(detail);
    if (!cleanDetail)
        return state;
    return {
        ...state,
        activity: [
            ...state.activity,
            { id: state.nextId, label, detail: cleanDetail, tone },
        ].slice(-MAX_ACTIVITY_ENTRIES),
        nextId: state.nextId + 1,
    };
}
function textField(value) {
    return typeof value === "string" ? value : "";
}
function numberField(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function compactWhitespace(value) {
    return value.replace(/\s+/g, " ").trim();
}
function removeLastCodePoint(value) {
    return Array.from(value).slice(0, -1).join("");
}
function findLastIndex(items, predicate) {
    for (let index = items.length - 1; index >= 0; index -= 1) {
        if (predicate(items[index]))
            return index;
    }
    return -1;
}
function isInteractiveUiMethod(value) {
    return value === "confirm" || value === "select" || value === "input" || value === "editor";
}
