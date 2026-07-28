import { basename } from "node:path";
import { filterSlashCommands, mergeSlashCommands, slashQuery, } from "./commands.js";
import { isRecord, normalizeExtensionUiRequest, printable, } from "./events.js";
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
        compacting: false,
        model: "default model",
        thinking: "",
        queueDepth: 0,
        composer: "",
        slashCommands: mergeSlashCommands([]),
        slashMenuOpen: false,
        slashSelected: 0,
        scrollOffset: 0,
        timeline: [],
        activity: [],
        nextId: 1,
    };
}
export function reduceStarlingTui(state, action) {
    switch (action.type) {
        case "chat.event":
            return reduceChatEvent(state, action.event);
        case "composer.set":
            return updateComposer(state, action.value);
        case "composer.append":
            return updateComposer(state, state.composer + action.value);
        case "composer.backspace":
            return updateComposer(state, removeLastCodePoint(state.composer));
        case "slash.loaded": {
            const slashCommands = mergeSlashCommands(action.commands);
            const menu = filterSlashCommands(state.composer, slashCommands);
            return {
                ...state,
                slashCommands,
                slashMenuOpen: state.slashMenuOpen && slashQuery(state.composer) !== null,
                slashSelected: clampSelection(state.slashSelected, menu.length),
            };
        }
        case "slash.select": {
            if (!state.slashMenuOpen)
                return state;
            const count = filterSlashCommands(state.composer, state.slashCommands).length;
            if (count === 0)
                return { ...state, slashSelected: 0 };
            return {
                ...state,
                slashSelected: (state.slashSelected + action.delta + count) % count,
            };
        }
        case "slash.dismiss":
            return { ...state, slashMenuOpen: false };
        case "prompt.submitted": {
            return appendTimeline({
                ...state,
                composer: "",
                slashMenuOpen: false,
                slashSelected: 0,
                scrollOffset: 0,
                busy: true,
                phase: "working",
                status: action.queued ? "Follow-up queued" : "Sending…",
                queueDepth: action.queued ? state.queueDepth + 1 : state.queueDepth,
            }, { kind: "user", text: action.text, pending: true });
        }
        case "prompt.rejected":
            return appendTimeline(addActivity({ ...state, phase: "error", busy: false, status: action.message }, "request", action.message, "error"), { kind: "error", text: action.message });
        case "command.submitted":
            return {
                ...state,
                composer: "",
                slashMenuOpen: false,
                slashSelected: 0,
                scrollOffset: 0,
                status: `Running /${action.name}…`,
            };
        case "command.completed": {
            const next = {
                ...state,
                phase: state.busy ? state.phase : "ready",
                status: state.busy ? state.status : "Ready",
            };
            return action.message
                ? appendTimeline(next, { kind: "system", text: action.message })
                : next;
        }
        case "command.failed":
            return appendTimeline(addActivity({
                ...state,
                phase: state.busy ? state.phase : "ready",
                status: state.busy ? state.status : "Ready",
            }, "command", action.message, "error"), { kind: "error", text: action.message });
        case "session.metadata":
            return {
                ...state,
                model: action.model || state.model,
                thinking: action.thinking ?? state.thinking,
                sessionName: action.sessionName || state.sessionName,
                sessionId: action.sessionId || state.sessionId,
                sessionFile: action.sessionFile || state.sessionFile,
            };
        case "scroll":
            return { ...state, scrollOffset: Math.max(0, state.scrollOffset + action.delta) };
        case "diagnostic":
            return reduceDiagnostic(state, action.level, action.message);
        case "ui.open":
            return openUiPrompt(state, action.prompt);
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
            return closeUiPrompt(state);
    }
}
/**
 * Backwards-compatible helper for callers that still receive raw extension UI
 * records. Parsing is delegated to the transport normalizer in events.ts.
 */
export function createExtensionUiPrompt(value) {
    const request = normalizeExtensionUiRequest(value);
    return request ? promptFromRequest(request) : null;
}
export { isRecord, printable };
function reduceChatEvent(state, event) {
    switch (event.type) {
        case "runtime.started": {
            const cwd = event.cwd || state.cwd;
            return {
                ...state,
                cwd,
                workspace: basename(cwd) || cwd,
                runId: event.runId || state.runId,
                sessionId: event.sessionId || state.sessionId,
                status: "Loading session…",
            };
        }
        case "runtime.exited": {
            const label = event.success
                ? "Session closed"
                : `Agent stopped (${event.exitCode ?? "unknown"})`;
            const next = {
                ...state,
                phase: event.success ? "stopped" : "error",
                ready: false,
                busy: false,
                compacting: false,
                status: label,
                uiPrompt: undefined,
                slashMenuOpen: false,
            };
            return event.success ? next : addActivity(next, "runtime", label, "error");
        }
        case "session.snapshot":
            return hydrateSnapshot(state, event.snapshot);
        case "session.name.changed":
            return { ...state, sessionName: event.name || state.sessionName };
        case "session.thinking.changed":
            return { ...state, thinking: event.level || state.thinking };
        case "turn.started":
            return { ...state, busy: true, phase: "working", status: "Agent is working…" };
        case "turn.generating":
            return { ...state, busy: true, phase: "working", status: "Generating…" };
        case "turn.finalizing":
            return { ...state, status: "Finalizing…" };
        case "turn.settled":
            return state.compacting
                ? { ...state, busy: false, phase: "working", status: "Compacting context…", queueDepth: 0 }
                : { ...state, busy: false, phase: "ready", status: "Ready", queueDepth: 0 };
        case "turn.retrying":
            return addActivity({ ...state, busy: true, phase: "working", status: `Retrying (${event.attempt})…` }, "retry", event.message, "active");
        case "message.started":
            return startMessage(state, event.message);
        case "message.delta":
            return updateAssistantDelta(state, event.channel, event.delta);
        case "message.completed":
            return finishMessage(state, event.message);
        case "tool.started": {
            const callId = event.callId || `tool-${state.nextId}`;
            return appendTimeline(state, {
                kind: "tool",
                text: event.input,
                toolCallId: callId,
                toolName: event.name,
                toolState: "running",
            });
        }
        case "tool.updated":
            return updateTool(state, event.callId, event.output, "running");
        case "tool.completed":
            return updateTool(state, event.callId, event.output, event.failed ? "error" : "done", event.name);
        case "queue.changed":
            return { ...state, queueDepth: event.depth };
        case "context.compaction.started":
            return addActivity({ ...state, compacting: true, phase: "working", status: "Compacting context…" }, "context", "Compacting", "active");
        case "context.compaction.completed": {
            const detail = event.aborted
                ? "Compaction cancelled"
                : event.failed ? event.message || "Compaction failed" : "Compaction complete";
            const tone = event.aborted
                ? "neutral"
                : event.failed ? "error" : "success";
            return addActivity({
                ...state,
                compacting: false,
                phase: state.busy ? "working" : "ready",
                status: state.busy ? "Agent is working…" : event.failed || event.aborted ? detail : "Ready",
            }, "context", detail, tone);
        }
        case "retry.completed":
            return addActivity(state, "retry", event.message, event.success ? "success" : "error");
        case "activity.recorded":
            return addActivity(state, event.label, event.detail, event.tone);
        case "diagnostic":
            return reduceDiagnostic(state, event.level === "error" ? "error" : "info", event.message);
        case "interaction.requested":
            return openUiPrompt(state, promptFromRequest(event.request));
        case "interaction.dismissed":
            return state.uiPrompt?.id === event.id ? closeUiPrompt(state) : state;
        case "composer.replaced":
            return updateComposer(state, event.value);
    }
}
function hydrateSnapshot(state, snapshot) {
    const normalized = transcriptToTimeline(snapshot.transcript, state.nextId);
    return {
        ...state,
        phase: snapshot.streaming ? "working" : "ready",
        status: snapshot.streaming ? "Agent is working…" : "Ready",
        ready: true,
        busy: snapshot.streaming,
        compacting: false,
        sessionId: snapshot.sessionId || state.sessionId,
        sessionName: snapshot.sessionName || state.sessionName,
        sessionFile: snapshot.sessionFile || state.sessionFile,
        model: snapshot.model,
        thinking: snapshot.thinking,
        queueDepth: snapshot.queueDepth,
        timeline: normalized.timeline,
        nextId: normalized.nextId,
    };
}
function startMessage(state, message) {
    if (message.kind === "user") {
        const last = state.timeline.at(-1);
        if (last?.kind === "user" && last.pending && last.text === message.text) {
            return {
                ...state,
                timeline: state.timeline.map((entry, index) => index === state.timeline.length - 1 ? { ...entry, pending: false } : entry),
            };
        }
        return message.text
            ? appendTimeline(state, { ...message, kind: "user", pending: false })
            : state;
    }
    if (message.kind === "assistant") {
        return appendTimeline(state, { ...message, kind: "assistant", pending: true });
    }
    if (message.kind === "system" || message.kind === "error") {
        return message.text ? appendTimeline(state, message) : state;
    }
    return state;
}
function updateAssistantDelta(state, channel, delta) {
    if (!delta)
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
function finishMessage(state, message) {
    if (message.kind !== "assistant")
        return state;
    const index = findLastIndex(state.timeline, (entry) => entry.kind === "assistant" && entry.pending === true);
    if (index < 0)
        return appendTimeline(state, { ...message, kind: "assistant", pending: false });
    return {
        ...state,
        timeline: state.timeline.map((entry, entryIndex) => entryIndex === index
            ? {
                ...entry,
                text: message.text || entry.text,
                thinking: message.thinking || entry.thinking,
                pending: false,
            }
            : entry),
    };
}
function updateTool(state, toolCallId, text, toolState, toolName = "tool") {
    if (!toolCallId)
        return state;
    const index = findLastIndex(state.timeline, (entry) => entry.toolCallId === toolCallId);
    if (index < 0) {
        return appendTimeline(state, {
            kind: "tool",
            text,
            toolCallId,
            toolName,
            toolState,
        });
    }
    return {
        ...state,
        timeline: state.timeline.map((entry, entryIndex) => entryIndex === index
            ? { ...entry, text: text || entry.text, toolName: entry.toolName || toolName, toolState }
            : entry),
    };
}
function transcriptToTimeline(transcript, startId) {
    let nextId = startId;
    const timeline = transcript.slice(-MAX_TIMELINE_ENTRIES).map((entry) => ({
        id: nextId++,
        ...entry,
    }));
    return { timeline, nextId };
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
function reduceDiagnostic(state, level, rawMessage) {
    const message = compactWhitespace(rawMessage);
    if (!message)
        return state;
    return addActivity(level === "error" ? { ...state, status: message } : state, level === "error" ? "error" : "log", message, level === "error" ? "error" : "neutral");
}
function promptFromRequest(request) {
    return {
        id: request.id,
        method: request.method,
        title: request.title,
        message: request.message,
        options: request.options,
        selected: 0,
        value: request.initialValue,
    };
}
function openUiPrompt(state, prompt) {
    return addActivity({
        ...state,
        uiPrompt: prompt,
        slashMenuOpen: false,
        status: prompt.title || "Input requested",
    }, "attention", prompt.title || `${prompt.method} requested`, "active");
}
function closeUiPrompt(state) {
    return { ...state, uiPrompt: undefined, status: state.busy ? "Agent is working…" : "Ready" };
}
function compactWhitespace(value) {
    return value.replace(/\s+/g, " ").trim();
}
function removeLastCodePoint(value) {
    return Array.from(value).slice(0, -1).join("");
}
function updateComposer(state, composer) {
    const slashMenuOpen = slashQuery(composer) !== null && state.slashCommands.length > 0;
    return {
        ...state,
        composer,
        slashMenuOpen,
        slashSelected: 0,
    };
}
function clampSelection(selected, count) {
    if (count <= 0)
        return 0;
    return Math.min(Math.max(0, selected), count - 1);
}
function findLastIndex(items, predicate) {
    for (let index = items.length - 1; index >= 0; index -= 1) {
        if (predicate(items[index]))
            return index;
    }
    return -1;
}
