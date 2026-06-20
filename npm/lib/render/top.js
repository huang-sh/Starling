import { ansi } from "./ansi.js";
import { colorStatus, formatClock, meta, relativeTime, statusDot, terminalWidth, truncate, visible, } from "./ui.js";
import { monitorRows, normalizeMonitorSnapshot, } from "../protocol.js";
export { normalizeMonitorSnapshot };
export function renderTopSnapshot(input, options = {}) {
    const snapshot = normalizeMonitorSnapshot(input);
    const rows = monitorRows(snapshot);
    const width = terminalWidth(options.width);
    const nowMs = options.now?.getTime() ?? Date.now();
    const lines = [];
    const sortedRows = sortTopRows(rows);
    lines.push(renderDashboard(snapshot, rows, width, nowMs));
    lines.push("");
    if (rows.length === 0) {
        lines.push(ansi.yellow("No agent sessions to display."));
        lines.push(ansi.dim("Tip: use --unpin to include unpinned sessions."));
        return lines.join("\n");
    }
    lines.push(renderPinnedTitle(sortedRows.length, snapshot.pinned_total));
    lines.push(renderMonitorList(sortedRows, width, nowMs));
    return lines.join("\n");
}
export function renderTopWatchFrame(input, options = {}) {
    const when = options.now ?? new Date();
    const width = terminalWidth(options.width);
    return [
        `${ansi.bold("Starling monitor")} ${ansi.gray(`refresh 3s  ${formatClock(when)}  Ctrl-C to exit`)}`,
        renderTopSnapshot(input, { ...options, width }),
    ].join("\n");
}
function renderSummary(snapshot) {
    const parts = [`${snapshot.pinned_total} pinned`];
    if (snapshot.recent_total > 0)
        parts.push(`${snapshot.recent_total} unpinned`);
    parts.push(`${snapshot.active} active`);
    return parts.join(" · ");
}
function renderDashboard(snapshot, rows, width, nowMs) {
    const statusCounts = countStatuses(rows);
    const tokenIn = rows.reduce((sum, row) => sum + row.tokens_in, 0);
    const tokenOut = rows.reduce((sum, row) => sum + row.tokens_out, 0);
    const tokenCache = rows.reduce((sum, row) => sum + row.tokens_cache, 0);
    const newest = rows.reduce((max, row) => Math.max(max, row.last_activity_ms), 0);
    const busy = statusCounts.get("busy") ?? 0;
    const running = statusCounts.get("running") ?? 0;
    const idle = (statusCounts.get("idle") ?? 0) + (statusCounts.get("waiting") ?? 0);
    const attention = statusCounts.get("permission") ?? 0;
    const stopped = statusCounts.get("stopped") ?? 0;
    const title = `${ansi.bold("Starling top")} ${ansi.gray(renderSummary(snapshot))}`;
    const clock = ansi.gray(formatClock(new Date(nowMs)));
    const gap = Math.max(1, width - visible(title) - visible(clock));
    const statusLine = statusChips(statusCounts);
    return [
        `${title}${" ".repeat(gap)}${clock}`,
        meta([
            `tasks ${rows.length} total, ${snapshot.active} active, ${running} running, ${busy} busy, ${attention} attention, ${idle} idle, ${stopped} stopped`,
            `tokens ${compactNumber(tokenIn)}/${compactNumber(tokenOut)}/${compactNumber(tokenCache)}`,
            `last ${relativeTime(newest, nowMs) || "-"}`,
            statusLine || false,
        ]),
    ].join("\n");
}
function renderPinnedTitle(shown, total) {
    if (shown < total)
        return ansi.bold(`Pinned (${shown} of ${total})`);
    return ansi.bold(`Pinned (${total})`);
}
function renderMonitorList(rows, width, nowMs) {
    const columns = topColumns(width);
    const header = [
        ["SID", columns.session],
        ["S", columns.status],
        ["AGT", columns.agent],
        ["MODEL", columns.model],
        ["PID", columns.pid],
        ["CPU", columns.cpu],
        ["MEM", columns.mem],
        ["CTX", columns.ctx],
        ["TOK", columns.tokens],
        ["AGE", columns.age],
        ["TASK", columns.task],
    ];
    const lines = [
        ansi.inverse(header.map(([label, col]) => padVisible(ansi.bold(label), col)).join(" ")),
    ];
    rows.forEach((row, index) => {
        lines.push(formatMonitorRow(row, columns, nowMs, index));
    });
    return lines.join("\n");
}
function formatMonitorRow(row, columns, nowMs, index) {
    const task = row.current_task.trim() || (row.last_tool ? `${row.last_tool}×${row.tool_count}` : row.title || "-");
    const cells = [
        padVisible(sessionCell(row), columns.session),
        padVisible(statusLetter(row.status), columns.status),
        padVisible(agentCell(row.provider), columns.agent),
        padVisible(shortModel(row.model), columns.model),
        padVisible(pidCell(row.pid), columns.pid),
        padVisible(cpuCell(row.cpu_pct, columns.cpu), columns.cpu),
        padVisible(memCell(row.mem_kb), columns.mem),
        padVisible(ctxCell(row.ctx_pct, columns.ctx), columns.ctx),
        padVisible(tokenCell(row), columns.tokens),
        padVisible(relativeTime(row.last_activity_ms, nowMs) || "-", columns.age),
        padVisible(taskCell(task, row), columns.task),
    ];
    const line = cells.join(" ");
    if (index % 2 === 1)
        return ansi.dim(line);
    return line;
}
function shortSessionId(id) {
    if (!id)
        return "-";
    return id.length <= 13 ? id : id.slice(0, 13);
}
function sortTopRows(rows) {
    return [...rows].sort((a, b) => {
        const statusDelta = statusRank(a.status) - statusRank(b.status);
        if (statusDelta !== 0)
            return statusDelta;
        return b.last_activity_ms - a.last_activity_ms;
    });
}
function statusRank(status) {
    switch (status) {
        case "permission":
            return 0;
        case "running":
            return 1;
        case "busy":
            return 2;
        case "waiting":
            return 3;
        case "idle":
            return 4;
        case "unknown":
            return 5;
        case "stopped":
            return 6;
        default:
            return 7;
    }
}
function activeRank(status) {
    switch (status) {
        case "permission":
        case "busy":
        case "running":
            return 0;
        default:
            return 9;
    }
}
function compactNumber(value) {
    if (!Number.isFinite(value) || value <= 0)
        return "0";
    if (value >= 1_000_000)
        return `${(value / 1_000_000).toFixed(1)}M`;
    if (value >= 1_000)
        return `${Math.round(value / 1_000)}k`;
    return String(value);
}
function topColumns(width) {
    const fixed = width >= 126
        ? { session: 14, status: 1, agent: 6, model: 13, pid: 7, cpu: 12, mem: 8, ctx: 12, tokens: 16, age: 8 }
        : width >= 104
            ? { session: 13, status: 1, agent: 5, model: 11, pid: 7, cpu: 10, mem: 7, ctx: 10, tokens: 13, age: 7 }
            : { session: 12, status: 1, agent: 6, model: 9, pid: 7, cpu: 7, mem: 6, ctx: 6, tokens: 11, age: 6 };
    const used = Object.values(fixed).reduce((sum, col) => sum + col, 0) + Object.keys(fixed).length;
    return { ...fixed, task: Math.max(12, width - used - 1) };
}
function padVisible(value, width) {
    const clipped = visible(value) <= width ? value : truncate(stripAnsi(value), width);
    return `${clipped}${" ".repeat(Math.max(0, width - visible(clipped)))}`;
}
function stripAnsi(value) {
    return value.replace(/\x1b\[[0-9;]*m/g, "");
}
function shortModel(model) {
    if (!model)
        return "-";
    const low = model.toLowerCase();
    if (low.includes("opus"))
        return low.includes("4-6") || low.includes("4.6") ? "opus-4.6" : "opus-4";
    if (low.includes("sonnet"))
        return low.includes("4-6") || low.includes("4.6") ? "son-4.6" : "son-4";
    if (low.includes("haiku"))
        return "haiku";
    if (low.includes("gpt-5"))
        return model.length > 10 ? model.replace("gpt-", "g") : model;
    return model.length > 11 ? `${model.slice(0, 10)}…` : model;
}
function pidCell(pid) {
    if (!pid || pid <= 0)
        return "-";
    return String(pid);
}
function sessionCell(row) {
    const id = shortSessionId(row.session_id);
    const marker = row.pinned ? ansi.cyan("*") : ansi.gray(" ");
    return `${marker}${id}`;
}
function agentCell(provider) {
    if (provider === "claude")
        return ansi.magenta("claude");
    if (provider === "codex")
        return ansi.green("codex");
    return provider || "-";
}
function statusLetter(status) {
    switch (status) {
        case "permission":
            return ansi.red("P");
        case "waiting":
            return ansi.blue("W");
        case "busy":
            return ansi.yellow("B");
        case "running":
            return ansi.cyan("R");
        case "idle":
            return ansi.green("I");
        case "stopped":
            return ansi.gray("S");
        default:
            return ansi.gray("?");
    }
}
function cpuCell(value, width) {
    if (!Number.isFinite(value) || value <= 0)
        return ansi.gray("-".padEnd(width));
    const text = `${value.toFixed(value < 10 ? 1 : 0)}%`;
    const barWidth = Math.max(2, width - visible(text) - 1);
    const bar = tinyBar(Math.min(100, value), barWidth);
    const cell = `${bar} ${text}`;
    if (value >= 80)
        return ansi.red(cell);
    if (value >= 30)
        return ansi.yellow(cell);
    return ansi.green(cell);
}
function memCell(value) {
    if (!Number.isFinite(value) || value <= 0)
        return ansi.gray("-");
    return formatMem(value);
}
function ctxCell(value, width) {
    if (!Number.isFinite(value) || value < 0)
        return ansi.gray("-");
    const text = `${value.toFixed(0)}%`;
    const barWidth = Math.max(2, width - visible(text) - 1);
    const cell = `${tinyBar(value, barWidth)} ${text}`;
    if (value >= 90)
        return ansi.red(ansi.bold(cell));
    if (value >= 70)
        return ansi.yellow(cell);
    return ansi.cyan(cell);
}
function tokenCell(row) {
    return `${compactNumber(row.tokens_in)}/${compactNumber(row.tokens_out)}/${ansi.gray(compactNumber(row.tokens_cache))}`;
}
function taskCell(task, row) {
    if (row.status === "permission")
        return ansi.red(task);
    if (row.status === "waiting")
        return ansi.blue(task);
    if (row.status === "busy")
        return ansi.yellow(task);
    return task;
}
function tinyBar(value, width) {
    const clamped = Math.max(0, Math.min(100, value));
    const filled = Math.round((clamped / 100) * width);
    return `${"▮".repeat(filled)}${ansi.gray("·".repeat(Math.max(0, width - filled)))}`;
}
function formatMem(kb) {
    const mb = kb / 1024;
    if (!Number.isFinite(mb) || mb <= 0)
        return "0M";
    if (mb < 1024)
        return `${mb.toFixed(mb < 10 ? 1 : 0)}M`;
    return `${(mb / 1024).toFixed(2)}G`;
}
function countStatuses(rows) {
    const counts = new Map();
    for (const row of rows)
        counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
    return counts;
}
function statusChips(counts) {
    const statuses = ["running", "busy", "permission", "idle", "waiting", "unknown"];
    return statuses
        .filter((status) => (counts.get(status) ?? 0) > 0)
        .map((status) => `${statusDot(status)} ${colorStatus(status)} ${counts.get(status)}`)
        .join(ansi.gray("  "));
}
