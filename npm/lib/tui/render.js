export const STARLING_TUI_WIDE_MIN_COLUMNS = 100;
/** Render a complete fixed-size frame. The result never contains cursor-control sequences. */
export function renderStarlingFrame(state, viewport) {
    const width = Math.max(20, Math.floor(viewport.width));
    const height = Math.max(10, Math.floor(viewport.height));
    const wide = width >= STARLING_TUI_WIDE_MIN_COLUMNS;
    const bodyHeight = height - 8;
    const header = renderHeader(state, width);
    const body = wide
        ? renderWideBody(state, width, bodyHeight)
        : renderNarrowBody(state, width, bodyHeight);
    const footer = renderFooter(state, width);
    const lines = [...header, ...body, ...footer].slice(0, height);
    while (lines.length < height)
        lines.push({ text: "" });
    return lines
        .map((line) => colorize(fitTerminalLine(line.text, width), line.tone, viewport.color === true))
        .join("\n");
}
export function renderTimelineLines(state, width) {
    const contentWidth = Math.max(10, width);
    if (state.timeline.length === 0) {
        return [
            { text: "", tone: "muted" },
            { text: "  Start a conversation in this workspace.", tone: "muted" },
            { text: "  Starling keeps reasoning, tools, and approvals in one timeline.", tone: "muted" },
        ];
    }
    const lines = [];
    for (const entry of state.timeline) {
        if (lines.length > 0)
            lines.push({ text: "" });
        lines.push(...renderTimelineEntry(entry, contentWidth));
    }
    return lines;
}
export function renderActivityLines(activity, width) {
    const lines = [{ text: " ACTIVITY", tone: "brand" }];
    if (activity.length === 0) {
        lines.push({ text: "", tone: "muted" }, { text: " No activity yet", tone: "muted" });
        return lines;
    }
    for (const item of activity.slice(-12)) {
        const tone = item.tone === "active"
            ? "active"
            : item.tone === "success"
                ? "success"
                : item.tone === "error"
                    ? "error"
                    : "muted";
        lines.push({ text: ` ${activityGlyph(item)} ${item.label}`, tone });
        for (const detail of wrapTerminalText(item.detail, Math.max(4, width - 3)).slice(0, 2)) {
            lines.push({ text: `   ${detail}`, tone: "muted" });
        }
    }
    return lines;
}
export function wrapTerminalText(value, width) {
    const limit = Math.max(1, Math.floor(width));
    const logicalLines = value.replace(/\t/g, "  ").split("\n");
    const output = [];
    for (const logical of logicalLines) {
        if (!logical) {
            output.push("");
            continue;
        }
        let remaining = logical;
        while (visibleWidth(remaining) > limit) {
            const slice = takeTerminalColumns(remaining, limit);
            if (!slice)
                break;
            let splitAt = slice.length;
            const whitespace = Math.max(slice.lastIndexOf(" "), slice.lastIndexOf("/"));
            if (whitespace >= Math.floor(slice.length * 0.55))
                splitAt = whitespace + 1;
            const line = remaining.slice(0, splitAt).trimEnd();
            output.push(line || slice);
            remaining = remaining.slice(splitAt).trimStart();
        }
        output.push(remaining);
    }
    return output.length > 0 ? output : [""];
}
export function fitTerminalLine(value, width) {
    const limit = Math.max(0, Math.floor(width));
    const clipped = takeTerminalColumns(stripAnsi(value), limit);
    return clipped + " ".repeat(Math.max(0, limit - visibleWidth(clipped)));
}
export function visibleWidth(value) {
    let width = 0;
    for (const character of Array.from(stripAnsi(value)))
        width += codePointWidth(character.codePointAt(0) ?? 0);
    return width;
}
function renderHeader(state, width) {
    const phase = phaseLabel(state);
    const left = ` STARLING  ${state.workspace}`;
    const right = `${phase} `;
    const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
    const session = state.sessionName || shorten(state.sessionId || "new session", 28);
    const meta = [
        ` ${shorten(state.cwd, Math.max(12, Math.floor(width * 0.45)))}`,
        `session ${session}`,
        state.model,
        state.thinking ? `thinking ${state.thinking}` : "",
    ].filter(Boolean).join("  ·  ");
    return [
        { text: left + " ".repeat(gap) + right, tone: "brand" },
        { text: meta, tone: "muted" },
        { text: "─".repeat(width), tone: "muted" },
    ];
}
function renderWideBody(state, width, height) {
    const railWidth = Math.min(36, Math.max(29, Math.floor(width * 0.27)));
    const timelineWidth = width - railWidth - 1;
    const timeline = takeViewport(renderTimelineLines(state, Math.max(10, timelineWidth - 2)), height, state.scrollOffset);
    const activity = takeTail(renderActivityLines(state.activity, railWidth - 1), height);
    const rows = [];
    for (let index = 0; index < height; index += 1) {
        const left = fitTerminalLine(` ${timeline[index]?.text ?? ""}`, timelineWidth);
        const right = fitTerminalLine(activity[index]?.text ?? "", railWidth);
        rows.push({ text: `${left}│${right}`, tone: timeline[index]?.tone || activity[index]?.tone });
    }
    return rows;
}
function renderNarrowBody(state, width, height) {
    return takeViewport(renderTimelineLines(state, width - 2), height, state.scrollOffset)
        .map((line) => ({ ...line, text: ` ${line.text}` }));
}
function renderFooter(state, width) {
    const separator = { text: "─".repeat(width), tone: "muted" };
    if (state.uiPrompt) {
        const prompt = state.uiPrompt;
        const label = ` ACTION · ${prompt.title}${prompt.message ? ` — ${prompt.message}` : ""}`;
        let input;
        let hints;
        if (prompt.method === "confirm" || prompt.method === "select") {
            input = prompt.options.length > 0
                ? prompt.options.map((option, index) => index === prompt.selected ? `[${option}]` : ` ${option} `).join("  ")
                : "No options supplied";
            hints = prompt.method === "confirm"
                ? "Y allow · N deny · ←/→ choose · Enter confirm · Esc cancel"
                : "↑/↓ choose · Enter select · Esc cancel";
        }
        else {
            input = `› ${lastLogicalLine(prompt.value)}`;
            hints = prompt.method === "editor"
                ? "Enter newline · Ctrl+S submit · Esc cancel"
                : "Enter submit · Esc cancel";
        }
        return [
            separator,
            { text: label, tone: "active" },
            { text: ` ${input}`, tone: "user" },
            { text: ` ${state.status}`, tone: "active" },
            { text: ` ${hints}`, tone: "muted" },
        ];
    }
    const logicalLines = state.composer.split("\n");
    const label = state.ready
        ? ` MESSAGE${logicalLines.length > 1 ? ` · ${logicalLines.length} lines` : ""}`
        : " MESSAGE · waiting for runtime";
    const input = state.composer ? `› ${lastLogicalLine(state.composer)}` : "› Ask Starling to work in this workspace…";
    const queue = state.queueDepth > 0 ? ` · ${state.queueDepth} queued` : "";
    const status = ` ${phaseGlyph(state)} ${state.status}${queue}`;
    const shortcuts = state.ready
        ? " Enter send · Alt+Enter newline · Esc stop · PgUp/PgDn scroll · Ctrl+C exit"
        : " Ctrl+C exit";
    return [
        separator,
        { text: label, tone: "brand" },
        { text: ` ${input}`, tone: state.composer ? "user" : "muted" },
        { text: status, tone: state.phase === "error" ? "error" : state.busy ? "active" : "success" },
        { text: shortcuts, tone: "muted" },
    ];
}
function renderTimelineEntry(entry, width) {
    if (entry.kind === "user") {
        const suffix = entry.pending ? " · sending" : "";
        return [
            { text: ` YOU${suffix}`, tone: "user" },
            ...wrapTerminalText(entry.text, width - 3).map((text) => ({ text: `   ${text}`, tone: "user" })),
        ];
    }
    if (entry.kind === "assistant") {
        const output = [{ text: " STARLING", tone: "assistant" }];
        if (entry.thinking) {
            for (const text of wrapTerminalText(entry.thinking, width - 5).slice(0, 4)) {
                output.push({ text: `   ◌ ${text}`, tone: "muted" });
            }
            if (wrapTerminalText(entry.thinking, width - 5).length > 4) {
                output.push({ text: "   ◌ … thinking collapsed", tone: "muted" });
            }
        }
        const body = entry.text || (entry.pending ? "…" : "");
        output.push(...wrapTerminalText(body, width - 3).map((text) => ({ text: `   ${text}`, tone: "assistant" })));
        return output;
    }
    if (entry.kind === "tool") {
        const glyph = entry.toolState === "error" ? "×" : entry.toolState === "done" ? "✓" : "◆";
        const tone = entry.toolState === "error" ? "error" : entry.toolState === "done" ? "success" : "active";
        const body = wrapTerminalText(entry.text || "Waiting for output…", width - 5).slice(0, 5);
        return [
            { text: ` ${glyph} TOOL · ${entry.toolName || "tool"}`, tone },
            ...body.map((text) => ({ text: `     ${text}`, tone: "muted" })),
        ];
    }
    const tone = entry.kind === "error" ? "error" : "muted";
    return wrapTerminalText(entry.text, width - 3).map((text, index) => ({
        text: index === 0 ? ` ${entry.kind === "error" ? "ERROR" : "NOTE"} · ${text}` : `   ${text}`,
        tone,
    }));
}
function takeViewport(lines, height, scrollOffset) {
    const end = Math.max(0, lines.length - Math.max(0, scrollOffset));
    const start = Math.max(0, end - height);
    const visible = lines.slice(start, end);
    return [...Array.from({ length: Math.max(0, height - visible.length) }, () => ({ text: "" })), ...visible];
}
function takeTail(lines, height) {
    const visible = lines.slice(-height);
    return [...visible, ...Array.from({ length: Math.max(0, height - visible.length) }, () => ({ text: "" }))];
}
function phaseLabel(state) {
    if (state.uiPrompt)
        return "INPUT NEEDED";
    if (state.phase === "working")
        return "WORKING";
    if (state.phase === "ready")
        return "READY";
    if (state.phase === "error")
        return "ERROR";
    if (state.phase === "stopped")
        return "STOPPED";
    return "STARTING";
}
function phaseGlyph(state) {
    if (state.phase === "error")
        return "×";
    if (state.busy)
        return "◆";
    if (state.ready)
        return "●";
    return "○";
}
function activityGlyph(item) {
    if (item.tone === "error")
        return "×";
    if (item.tone === "success")
        return "✓";
    if (item.tone === "active")
        return "◆";
    return "·";
}
function shorten(value, width) {
    if (visibleWidth(value) <= width)
        return value;
    if (width <= 1)
        return "…";
    return `${takeTerminalColumns(value, width - 1)}…`;
}
function lastLogicalLine(value) {
    return value.split("\n").at(-1) || "";
}
function takeTerminalColumns(value, width) {
    let result = "";
    let used = 0;
    for (const character of Array.from(value)) {
        const next = codePointWidth(character.codePointAt(0) ?? 0);
        if (used + next > width)
            break;
        result += character;
        used += next;
    }
    return result;
}
function codePointWidth(codePoint) {
    if (codePoint === 0 || codePoint < 32 || (codePoint >= 0x7f && codePoint < 0xa0))
        return 0;
    if ((codePoint >= 0x0300 && codePoint <= 0x036f)
        || (codePoint >= 0x1ab0 && codePoint <= 0x1aff)
        || (codePoint >= 0x1dc0 && codePoint <= 0x1dff)
        || (codePoint >= 0x20d0 && codePoint <= 0x20ff)
        || (codePoint >= 0xfe20 && codePoint <= 0xfe2f))
        return 0;
    if (codePoint >= 0x1100 && (codePoint <= 0x115f
        || codePoint === 0x2329
        || codePoint === 0x232a
        || (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f)
        || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
        || (codePoint >= 0xf900 && codePoint <= 0xfaff)
        || (codePoint >= 0xfe10 && codePoint <= 0xfe19)
        || (codePoint >= 0xfe30 && codePoint <= 0xfe6f)
        || (codePoint >= 0xff00 && codePoint <= 0xff60)
        || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
        || (codePoint >= 0x1f300 && codePoint <= 0x1faff)
        || (codePoint >= 0x20000 && codePoint <= 0x3fffd)))
        return 2;
    return 1;
}
function stripAnsi(value) {
    return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}
function colorize(value, tone, enabled) {
    if (!enabled || !tone)
        return value;
    const code = tone === "brand"
        ? "1;36"
        : tone === "muted"
            ? "2;37"
            : tone === "user"
                ? "1;34"
                : tone === "active"
                    ? "1;33"
                    : tone === "success"
                        ? "1;32"
                        : tone === "error"
                            ? "1;31"
                            : "0;37";
    return `\u001b[${code}m${value}\u001b[0m`;
}
