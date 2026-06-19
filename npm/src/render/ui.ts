import { ansi } from "./ansi.js";

export function terminalWidth(width?: number): number {
  return Math.max(72, Math.min(width ?? process.stdout.columns ?? 100, 140));
}

export function header(title: string, detail = "", width?: number): string {
  const w = terminalWidth(width);
  const brand = `${ansi.bold(ansi.cyan("✦"))} ${ansi.bold(title)}`;
  const right = detail ? ansi.dim(detail) : "";
  const gap = Math.max(1, w - visible(brand) - visible(right));
  return `${brand}${" ".repeat(gap)}${right}`;
}

export function section(title: string, detail = ""): string {
  return `${ansi.bold(title)}${detail ? ` ${ansi.dim(detail)}` : ""}`;
}

export function divider(width?: number): string {
  return ansi.gray("─".repeat(Math.min(terminalWidth(width), 118)));
}

export function empty(message: string, hint?: string): string {
  return [ansi.yellow(message), hint ? ansi.dim(hint) : ""].filter(Boolean).join("\n");
}

export function meta(parts: Array<string | undefined | null | false>): string {
  return parts.filter(Boolean).join(ansi.gray("  ·  "));
}

export function keyValueBlock(title: string, rows: Array<[string, string]>): string {
  if (rows.length === 0) return empty(`${title}: empty`);
  const width = Math.max(...rows.map(([key]) => key.length));
  return [
    section(title),
    ...rows.map(([key, value]) => `  ${ansi.gray(key.padEnd(width))}  ${value || "-"}`),
  ].join("\n");
}

export function pill(value: string, tone: Tone = "neutral"): string {
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

export function statusDot(status: string): string {
  switch (status) {
    case "busy":
      return ansi.yellow("●");
    case "permission":
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

export function colorStatus(status: string): string {
  switch (status) {
    case "busy":
      return ansi.yellow(ansi.bold(status));
    case "permission":
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

export function meter(value: number, width = 10): string {
  if (!Number.isFinite(value) || value < 0) return "";
  const clamped = Math.max(0, Math.min(value, 100));
  const filled = Math.round((clamped / 100) * width);
  const bar = `${"█".repeat(filled)}${"░".repeat(Math.max(0, width - filled))}`;
  if (clamped >= 90) return ansi.red(bar);
  if (clamped >= 70) return ansi.yellow(bar);
  return ansi.cyan(bar);
}

export function relativeTime(ms: number, now = Date.now()): string {
  if (!ms || !Number.isFinite(ms)) return "";
  const delta = Math.max(0, now - ms);
  const sec = Math.floor(delta / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hour = Math.floor(min / 60);
  if (hour < 48) return `${hour}h ago`;
  return `${Math.floor(hour / 24)}d ago`;
}

export function compactPath(value: string, max: number): string {
  if (!value) return "-";
  const chars = Array.from(value);
  if (chars.length <= max) return value;
  return `…${chars.slice(Math.max(0, chars.length - max + 1)).join("")}`;
}

export function truncate(value: string, max: number): string {
  const chars = Array.from(value || "");
  if (chars.length <= max) return value || "";
  return `${chars.slice(0, Math.max(0, max - 1)).join("")}…`;
}

export function padRight(value: string, plainValue: string, width: number): string {
  return `${value}${" ".repeat(Math.max(0, width - visible(plainValue)))}`;
}

export function visible(value: string): number {
  return stripAnsi(value).length;
}

export function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

export function formatClock(date: Date): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mi = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}

type Tone = "good" | "warn" | "bad" | "info" | "muted" | "neutral";
