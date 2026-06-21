import { ansi } from "./ansi.js";
export function terminalWidth(width) {
    return Math.max(72, Math.min(width ?? process.stdout.columns ?? 100, 140));
}
export function header(title, detail = "", width) {
    const w = terminalWidth(width);
    const brand = `${ansi.bold(ansi.cyan("✦"))} ${ansi.bold(title)}`;
    const right = detail ? ansi.dim(detail) : "";
    const gap = Math.max(1, w - visible(brand) - visible(right));
    return `${brand}${" ".repeat(gap)}${right}`;
}
export function section(title, detail = "") {
    return `${ansi.bold(title)}${detail ? ` ${ansi.dim(detail)}` : ""}`;
}
export function divider(width) {
    return ansi.gray("─".repeat(Math.min(terminalWidth(width), 118)));
}
export function empty(message, hint) {
    return [ansi.yellow(message), hint ? ansi.dim(hint) : ""].filter(Boolean).join("\n");
}
export function meta(parts) {
    return parts.filter(Boolean).join(ansi.gray("  ·  "));
}
export function keyValueBlock(title, rows) {
    if (rows.length === 0)
        return empty(`${title}: empty`);
    const width = Math.max(...rows.map(([key]) => key.length));
    return [
        section(title),
        ...rows.map(([key, value]) => `  ${ansi.gray(key.padEnd(width))}  ${value || "-"}`),
    ].join("\n");
}
export function pill(value, tone = "neutral") {
    const label = ` ${value} `;
    switch (tone) {
        case "good":
            return ansi.green(label);
        case "warn":
            return ansi.yellow(label);
        case "bad":
            return ansi.red(label);
        case "info":
            return ansi.cyan(label);
        case "muted":
            return ansi.gray(label);
        default:
            return ansi.white(label);
    }
}
export function statusDot(status) {
    switch (status) {
        case "failed":
        case "crashed":
            return ansi.red("!");
        case "waiting":
            return ansi.blue("○");
        case "idle":
        case "completed":
        case "success":
        case "succeeded":
            return ansi.green("✓");
        case "running":
            return ansi.cyan("●");
        case "stopped":
            return ansi.gray("·");
        default:
            return ansi.gray("○");
    }
}
export function colorStatus(status) {
    switch (status) {
        case "failed":
        case "crashed":
            return ansi.red(ansi.bold(status));
        case "waiting":
            return ansi.blue(ansi.bold(status));
        case "idle":
        case "completed":
        case "success":
        case "succeeded":
            return ansi.green(status);
        case "running":
            return ansi.cyan(status);
        case "stopped":
            return ansi.gray(status);
        default:
            return ansi.gray(status || "unknown");
    }
}
export function meter(value, width = 10) {
    if (!Number.isFinite(value) || value < 0)
        return "";
    const clamped = Math.max(0, Math.min(value, 100));
    const filled = Math.round((clamped / 100) * width);
    const bar = `${"█".repeat(filled)}${"░".repeat(Math.max(0, width - filled))}`;
    if (clamped >= 90)
        return ansi.red(bar);
    if (clamped >= 70)
        return ansi.yellow(bar);
    return ansi.cyan(bar);
}
export function relativeTime(ms, now = Date.now()) {
    if (!ms || !Number.isFinite(ms))
        return "";
    const delta = Math.max(0, now - ms);
    const sec = Math.floor(delta / 1000);
    if (sec < 60)
        return `${sec}s ago`;
    const min = Math.floor(sec / 60);
    if (min < 60)
        return `${min}m ago`;
    const hour = Math.floor(min / 60);
    if (hour < 48)
        return `${hour}h ago`;
    return `${Math.floor(hour / 24)}d ago`;
}
export function compactPath(value, max) {
    if (!value)
        return "-";
    const chars = Array.from(value);
    if (chars.length <= max)
        return value;
    return `…${chars.slice(Math.max(0, chars.length - max + 1)).join("")}`;
}
export function truncate(value, max) {
    const chars = Array.from(value || "");
    if (chars.length <= max)
        return value || "";
    return `${chars.slice(0, Math.max(0, max - 1)).join("")}…`;
}
export function padRight(value, plainValue, width) {
    return `${value}${" ".repeat(Math.max(0, width - visible(plainValue)))}`;
}
export function visible(value) {
    return stripAnsi(value).length;
}
export function stripAnsi(value) {
    return value.replace(/\x1b\[[0-9;]*m/g, "");
}
export function formatClock(date) {
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, "0");
    const dd = String(date.getDate()).padStart(2, "0");
    const hh = String(date.getHours()).padStart(2, "0");
    const mi = String(date.getMinutes()).padStart(2, "0");
    const ss = String(date.getSeconds()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}
