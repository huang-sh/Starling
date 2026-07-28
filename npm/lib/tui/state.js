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
        composerCursor: 0,
        slashCommands: mergeSlashCommands([]),
        slashMenuOpen: false,
        slashSelected: 0,
        scrollOffset: 0,
        timeline: [],
        activity: [],
        statusItems: {},
        widgets: {},
        terminalTitle: "",
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
            return insertComposer(state, action.value);
        case "composer.backspace":
            return removeComposerGrapheme(state, -1);
        case "composer.delete":
            return removeComposerGrapheme(state, 1);
        case "composer.move":
            return moveComposerCursor(state, action.delta);
        case "composer.line":
            return {
                ...state,
                composerCursor: moveLineCursor(state.composer, state.composerCursor, action.delta),
            };
        case "composer.home":
            return { ...state, composerCursor: lineStart(state.composer, state.composerCursor) };
        case "composer.end":
            return { ...state, composerCursor: lineEnd(state.composer, state.composerCursor) };
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
                composerCursor: 0,
                slashMenuOpen: false,
                slashSelected: 0,
                scrollOffset: 0,
                busy: action.queued ? state.busy : true,
                phase: "working",
                status: action.queued ? "Follow-up queued" : "Sending…",
                queueDepth: action.queued ? state.queueDepth + 1 : state.queueDepth,
            }, { kind: "user", text: action.text, pending: true });
        }
        case "prompt.rejected": {
            const optimistic = action.text === undefined
                ? -1
                : findLastIndex(state.timeline, (entry) => entry.kind === "user" && entry.pending === true && entry.text === action.text);
            const composer = state.composer || action.text || "";
            const busy = action.queued ? state.busy : false;
            const next = addActivity({
                ...state,
                phase: busy || state.compacting ? "working" : "ready",
                busy,
                status: busy
                    ? "Agent is working…"
                    : state.compacting ? "Compacting context…" : "Ready",
                queueDepth: action.queued ? Math.max(0, state.queueDepth - 1) : state.queueDepth,
                composer,
                composerCursor: state.composer ? state.composerCursor : composer.length,
                timeline: optimistic < 0
                    ? state.timeline
                    : state.timeline.filter((_, index) => index !== optimistic),
            }, "request", action.message, "error");
            return appendTimeline(next, { kind: "error", text: action.message });
        }
        case "command.submitted":
            return {
                ...state,
                composer: "",
                composerCursor: 0,
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
                ...(action.model !== undefined ? { model: action.model || "default model" } : {}),
                ...(action.thinking !== undefined ? { thinking: action.thinking } : {}),
                ...(Object.hasOwn(action, "sessionName") ? { sessionName: action.sessionName } : {}),
                ...(Object.hasOwn(action, "sessionId") ? { sessionId: action.sessionId } : {}),
                ...(Object.hasOwn(action, "sessionFile") ? { sessionFile: action.sessionFile } : {}),
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
                ? { ...state, uiPrompt: { ...state.uiPrompt, value: action.value, cursor: action.value.length } }
                : state;
        case "ui.append": {
            if (!state.uiPrompt)
                return state;
            const edit = insertText(state.uiPrompt.value, promptCursor(state.uiPrompt), action.value);
            return { ...state, uiPrompt: { ...state.uiPrompt, value: edit.value, cursor: edit.cursor } };
        }
        case "ui.backspace":
        case "ui.delete": {
            if (!state.uiPrompt)
                return state;
            const edit = removeTextGrapheme(state.uiPrompt.value, promptCursor(state.uiPrompt), action.type === "ui.backspace" ? -1 : 1);
            return { ...state, uiPrompt: { ...state.uiPrompt, value: edit.value, cursor: edit.cursor } };
        }
        case "ui.move":
            return state.uiPrompt
                ? {
                    ...state,
                    uiPrompt: {
                        ...state.uiPrompt,
                        cursor: moveTextCursor(state.uiPrompt.value, promptCursor(state.uiPrompt), action.delta),
                    },
                }
                : state;
        case "ui.line":
            return state.uiPrompt
                ? {
                    ...state,
                    uiPrompt: {
                        ...state.uiPrompt,
                        cursor: moveLineCursor(state.uiPrompt.value, promptCursor(state.uiPrompt), action.delta),
                    },
                }
                : state;
        case "ui.home":
            return state.uiPrompt
                ? { ...state, uiPrompt: { ...state.uiPrompt, cursor: lineStart(state.uiPrompt.value, promptCursor(state.uiPrompt)) } }
                : state;
        case "ui.end":
            return state.uiPrompt
                ? { ...state, uiPrompt: { ...state.uiPrompt, cursor: lineEnd(state.uiPrompt.value, promptCursor(state.uiPrompt)) } }
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
            return { ...state, sessionName: event.name };
        case "session.thinking.changed":
            return { ...state, thinking: event.level };
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
        case "status.changed":
            return { ...state, statusItems: updateKeyedValue(state.statusItems, event.key, event.text) };
        case "widget.changed": {
            const widgets = { ...state.widgets };
            if (event.lines === undefined)
                delete widgets[event.key];
            else {
                widgets[event.key] = {
                    key: event.key,
                    lines: event.lines,
                    placement: event.placement,
                };
            }
            return { ...state, widgets };
        }
        case "terminal.title.changed":
            return { ...state, terminalTitle: event.title };
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
    const compacting = snapshot.compacting === true;
    const working = snapshot.streaming || compacting;
    return {
        ...state,
        phase: working ? "working" : "ready",
        status: snapshot.streaming
            ? "Agent is working…"
            : compacting ? "Compacting context…" : "Ready",
        ready: true,
        busy: snapshot.streaming,
        compacting,
        sessionId: snapshot.sessionId,
        sessionName: snapshot.sessionName,
        sessionFile: snapshot.sessionFile,
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
function promptCursor(prompt) {
    return prompt.cursor ?? prompt.value.length;
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
        cursor: request.initialValue.length,
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
    return {
        ...state,
        uiPrompt: undefined,
        status: state.busy
            ? "Agent is working…"
            : state.compacting ? "Compacting context…" : "Ready",
    };
}
function compactWhitespace(value) {
    return value.replace(/\s+/g, " ").trim();
}
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
function insertText(value, cursor, inserted) {
    const at = clampCursor(value, cursor);
    const nextValue = value.slice(0, at) + inserted + value.slice(at);
    return {
        value: nextValue,
        cursor: ceilCursor(nextValue, at + inserted.length),
    };
}
function removeTextGrapheme(value, cursor, direction) {
    const boundaries = graphemeBoundaries(value);
    const at = boundaryIndex(boundaries, clampCursor(value, cursor));
    const startIndex = direction < 0 ? at - 1 : at;
    const endIndex = startIndex + 1;
    if (startIndex < 0 || endIndex >= boundaries.length)
        return { value, cursor: boundaries[at] ?? 0 };
    const start = boundaries[startIndex] ?? 0;
    const end = boundaries[endIndex] ?? start;
    return { value: value.slice(0, start) + value.slice(end), cursor: start };
}
function moveTextCursor(value, cursor, delta) {
    const boundaries = graphemeBoundaries(value);
    const index = boundaryIndex(boundaries, clampCursor(value, cursor));
    const next = Math.min(Math.max(0, index + Math.trunc(delta)), boundaries.length - 1);
    return boundaries[next] ?? value.length;
}
function insertComposer(state, value) {
    const edit = insertText(state.composer, state.composerCursor, value);
    return updateComposer(state, edit.value, edit.cursor);
}
function removeComposerGrapheme(state, direction) {
    const edit = removeTextGrapheme(state.composer, state.composerCursor, direction);
    if (edit.value === state.composer && edit.cursor === state.composerCursor)
        return state;
    return updateComposer(state, edit.value, edit.cursor);
}
function moveComposerCursor(state, delta) {
    return { ...state, composerCursor: moveTextCursor(state.composer, state.composerCursor, delta) };
}
function updateComposer(state, composer, cursor = composer.length) {
    const slashMenuOpen = slashQuery(composer) !== null && state.slashCommands.length > 0;
    return {
        ...state,
        composer,
        composerCursor: clampCursor(composer, cursor),
        slashMenuOpen,
        slashSelected: 0,
    };
}
function graphemeBoundaries(value) {
    const boundaries = [0];
    for (const part of graphemeSegmenter.segment(value))
        boundaries.push(part.index + part.segment.length);
    return boundaries;
}
function boundaryIndex(boundaries, cursor) {
    const exact = boundaries.indexOf(cursor);
    if (exact >= 0)
        return exact;
    for (let index = boundaries.length - 1; index >= 0; index -= 1) {
        if ((boundaries[index] ?? 0) < cursor)
            return index;
    }
    return 0;
}
function clampCursor(value, cursor) {
    const bounded = Math.min(Math.max(0, Math.trunc(cursor)), value.length);
    const boundaries = graphemeBoundaries(value);
    return boundaries[boundaryIndex(boundaries, bounded)] ?? 0;
}
function ceilCursor(value, cursor) {
    const bounded = Math.min(Math.max(0, Math.trunc(cursor)), value.length);
    for (const boundary of graphemeBoundaries(value)) {
        if (boundary >= bounded)
            return boundary;
    }
    return value.length;
}
function lineStart(value, cursor) {
    if (cursor <= 0)
        return 0;
    return value.lastIndexOf("\n", cursor - 1) + 1;
}
function lineEnd(value, cursor) {
    const end = value.indexOf("\n", cursor);
    return end < 0 ? value.length : end;
}
function moveLineCursor(value, cursor, delta) {
    const at = clampCursor(value, cursor);
    const start = lineStart(value, at);
    const column = graphemeBoundaries(value.slice(start, at)).length - 1;
    let targetStart;
    if (delta < 0) {
        if (start === 0)
            return at;
        targetStart = lineStart(value, start - 1);
    }
    else {
        const currentEnd = lineEnd(value, at);
        if (currentEnd >= value.length)
            return at;
        targetStart = currentEnd + 1;
    }
    const targetEnd = lineEnd(value, targetStart);
    const targetBoundaries = graphemeBoundaries(value.slice(targetStart, targetEnd));
    const targetColumn = Math.min(column, targetBoundaries.length - 1);
    return targetStart + (targetBoundaries[targetColumn] ?? 0);
}
function updateKeyedValue(values, key, value) {
    const next = { ...values };
    if (value === undefined)
        delete next[key];
    else
        next[key] = value;
    return next;
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
