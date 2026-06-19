import { ansi } from "./ansi.js";
import {
  colorStatus,
  formatClock,
  meta,
  relativeTime,
  statusDot,
  terminalWidth,
  truncate,
  visible,
} from "./ui.js";
import {
  type LiveStatus,
  type MonitorRow,
  type MonitorSnapshot,
  monitorRows,
  normalizeMonitorSnapshot,
} from "../protocol.js";

export { normalizeMonitorSnapshot };

export function renderTopSnapshot(input: unknown, options: { width?: number; now?: Date } = {}): string {
  const snapshot = normalizeMonitorSnapshot(input);
  const rows = monitorRows(snapshot);
  const width = terminalWidth(options.width);
  const nowMs = options.now?.getTime() ?? Date.now();
  const lines: string[] = [];
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

export function renderTopWatchFrame(input: unknown, options: { width?: number; now?: Date } = {}): string {
  const when = options.now ?? new Date();
  const width = terminalWidth(options.width);
  return [
    `${ansi.bold("Starling monitor")} ${ansi.gray(`refresh 3s  ${formatClock(when)}  Ctrl-C to exit`)}`,
    renderTopSnapshot(input, { ...options, width }),
  ].join("\n");
}

function renderSummary(snapshot: MonitorSnapshot): string {
  const parts = [`${snapshot.pinned_total} pinned`];
  if (snapshot.recent_total > 0) parts.push(`${snapshot.recent_total} unpinned`);
  parts.push(`${snapshot.active} active`);
  return parts.join(" · ");
}

function renderDashboard(snapshot: MonitorSnapshot, rows: MonitorRow[], width: number, nowMs: number): string {
  const statusCounts = countStatuses(rows);
  const active = rows.filter((row) => activeRank(row.status) < 5);
  const totalCpu = active.reduce((sum, row) => sum + Math.max(0, row.cpu_pct), 0);
  const totalMemKb = rows.reduce((sum, row) => sum + Math.max(0, row.mem_kb), 0);
  const maxCtx = rows.reduce((max, row) => Math.max(max, row.ctx_pct), -1);
  const tokenIn = rows.reduce((sum, row) => sum + row.tokens_in, 0);
  const tokenOut = rows.reduce((sum, row) => sum + row.tokens_out, 0);
  const tokenCache = rows.reduce((sum, row) => sum + row.tokens_cache, 0);
  const newest = rows.reduce((max, row) => Math.max(max, row.last_activity_ms), 0);
  const busy = statusCounts.get("busy") ?? 0;
  const running = statusCounts.get("running") ?? 0;
  const waiting = (statusCounts.get("waiting") ?? 0) + (statusCounts.get("permission") ?? 0);
  const stopped = statusCounts.get("stopped") ?? 0;
  const title = `${ansi.bold("Starling top")} ${ansi.gray(renderSummary(snapshot))}`;
  const clock = ansi.gray(formatClock(new Date(nowMs)));
  const gap = Math.max(1, width - visible(title) - visible(clock));
  const statusLine = statusChips(statusCounts);
  return [
    `${title}${" ".repeat(gap)}${clock}`,
    dashboardLine("CPU", totalCpu, 100, `${totalCpu.toFixed(totalCpu < 10 ? 1 : 0)}%`, width),
    dashboardLine("MEM", totalMemKb, maxMemScale(totalMemKb), formatMem(totalMemKb), width),
    dashboardLine("CTX", Math.max(0, maxCtx), 100, maxCtx >= 0 ? `${maxCtx.toFixed(0)}% max` : "-", width),
    meta([
      `tasks ${rows.length} total, ${snapshot.active} active, ${running} running, ${busy} busy, ${waiting} waiting, ${stopped} stopped`,
      `tokens ${compactNumber(tokenIn)}/${compactNumber(tokenOut)}/${compactNumber(tokenCache)}`,
      `last ${relativeTime(newest, nowMs) || "-"}`,
      statusLine || false,
    ]),
  ].join("\n");
}

function renderPinnedTitle(shown: number, total: number): string {
  if (shown < total) return ansi.bold(`Pinned (${shown} of ${total})`);
  return ansi.bold(`Pinned (${total})`);
}

function renderMonitorList(rows: MonitorRow[], width: number, nowMs: number): string {
  const columns = topColumns(width);
  const header = [
    ["SID", columns.session],
    ["S", columns.status],
    ["AGT", columns.agent],
    ["MODEL", columns.model],
    ["PROJ", columns.project],
    ["CPU", columns.cpu],
    ["MEM", columns.mem],
    ["CTX", columns.ctx],
    ["TOK", columns.tokens],
    ["AGE", columns.age],
    ["TASK", columns.task],
  ] as const;
  const lines = [
    ansi.inverse(header.map(([label, col]) => padVisible(ansi.bold(label), col)).join(" ")),
  ];
  rows.forEach((row, index) => {
    lines.push(formatMonitorRow(row, columns, nowMs, index));
  });
  return lines.join("\n");
}

function formatMonitorRow(row: MonitorRow, columns: TopColumns, nowMs: number, index: number): string {
  const project = basename(row.project_path || row.project || "-");
  const task = row.current_task.trim() || (row.last_tool ? `${row.last_tool}×${row.tool_count}` : row.title || "-");
  const cells = [
    padVisible(sessionCell(row), columns.session),
    padVisible(statusLetter(row.status), columns.status),
    padVisible(agentCell(row.provider), columns.agent),
    padVisible(shortModel(row.model), columns.model),
    padVisible(project || "-", columns.project),
    padVisible(cpuCell(row.cpu_pct, columns.cpu), columns.cpu),
    padVisible(memCell(row.mem_kb), columns.mem),
    padVisible(ctxCell(row.ctx_pct, columns.ctx), columns.ctx),
    padVisible(tokenCell(row), columns.tokens),
    padVisible(relativeTime(row.last_activity_ms, nowMs) || "-", columns.age),
    padVisible(taskCell(task, row), columns.task),
  ];
  const line = cells.join(" ");
  if (index % 2 === 1) return ansi.dim(line);
  return line;
}

function shortSessionId(id: string): string {
  if (!id) return "-";
  return id.length <= 13 ? id : id.slice(0, 13);
}

function sortTopRows(rows: MonitorRow[]): MonitorRow[] {
  return [...rows].sort((a, b) => {
    const statusDelta = statusRank(a.status) - statusRank(b.status);
    if (statusDelta !== 0) return statusDelta;
    return b.last_activity_ms - a.last_activity_ms;
  });
}

function statusRank(status: LiveStatus): number {
  switch (status) {
    case "permission":
      return 0;
    case "waiting":
      return 1;
    case "busy":
      return 2;
    case "running":
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

function activeRank(status: LiveStatus): number {
  switch (status) {
    case "permission":
    case "waiting":
    case "busy":
    case "running":
    case "idle":
      return 0;
    default:
      return 9;
  }
}

function compactNumber(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}

interface TopColumns {
  session: number;
  status: number;
  agent: number;
  model: number;
  project: number;
  cpu: number;
  mem: number;
  ctx: number;
  tokens: number;
  age: number;
  task: number;
}

function topColumns(width: number): TopColumns {
  const fixed = width >= 126
    ? { session: 14, status: 1, agent: 6, model: 13, project: 16, cpu: 12, mem: 8, ctx: 12, tokens: 16, age: 8 }
    : width >= 104
      ? { session: 13, status: 1, agent: 5, model: 11, project: 13, cpu: 10, mem: 7, ctx: 10, tokens: 13, age: 7 }
      : { session: 12, status: 1, agent: 6, model: 9, project: 10, cpu: 7, mem: 6, ctx: 6, tokens: 11, age: 6 };
  const used = Object.values(fixed).reduce((sum, col) => sum + col, 0) + Object.keys(fixed).length;
  return { ...fixed, task: Math.max(12, width - used - 1) };
}

function padVisible(value: string, width: number): string {
  const clipped = visible(value) <= width ? value : truncate(stripAnsi(value), width);
  return `${clipped}${" ".repeat(Math.max(0, width - visible(clipped)))}`;
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

function basename(value: string): string {
  if (!value || value === "-") return "-";
  const clean = value.replace(/\/+$/, "");
  const idx = clean.lastIndexOf("/");
  return idx >= 0 ? clean.slice(idx + 1) || clean : clean;
}

function shortModel(model: string): string {
  if (!model) return "-";
  const low = model.toLowerCase();
  if (low.includes("opus")) return low.includes("4-6") || low.includes("4.6") ? "opus-4.6" : "opus-4";
  if (low.includes("sonnet")) return low.includes("4-6") || low.includes("4.6") ? "son-4.6" : "son-4";
  if (low.includes("haiku")) return "haiku";
  if (low.includes("gpt-5")) return model.length > 10 ? model.replace("gpt-", "g") : model;
  return model.length > 11 ? `${model.slice(0, 10)}…` : model;
}

function sessionCell(row: MonitorRow): string {
  const id = shortSessionId(row.session_id);
  const marker = row.pinned ? ansi.cyan("*") : ansi.gray(" ");
  return `${marker}${id}`;
}

function agentCell(provider: string): string {
  if (provider === "claude") return ansi.magenta("claude");
  if (provider === "codex") return ansi.green("codex");
  return provider || "-";
}

function statusLetter(status: LiveStatus): string {
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

function cpuCell(value: number, width: number): string {
  if (!Number.isFinite(value) || value <= 0) return ansi.gray("-".padEnd(width));
  const text = `${value.toFixed(value < 10 ? 1 : 0)}%`;
  const barWidth = Math.max(2, width - visible(text) - 1);
  const bar = tinyBar(Math.min(100, value), barWidth);
  const cell = `${bar} ${text}`;
  if (value >= 80) return ansi.red(cell);
  if (value >= 30) return ansi.yellow(cell);
  return ansi.green(cell);
}

function memCell(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return ansi.gray("-");
  return formatMem(value);
}

function ctxCell(value: number, width: number): string {
  if (!Number.isFinite(value) || value < 0) return ansi.gray("-");
  const text = `${value.toFixed(0)}%`;
  const barWidth = Math.max(2, width - visible(text) - 1);
  const cell = `${tinyBar(value, barWidth)} ${text}`;
  if (value >= 90) return ansi.red(ansi.bold(cell));
  if (value >= 70) return ansi.yellow(cell);
  return ansi.cyan(cell);
}

function tokenCell(row: MonitorRow): string {
  return `${compactNumber(row.tokens_in)}/${compactNumber(row.tokens_out)}/${ansi.gray(compactNumber(row.tokens_cache))}`;
}

function taskCell(task: string, row: MonitorRow): string {
  if (row.status === "permission") return ansi.red(task);
  if (row.status === "waiting") return ansi.blue(task);
  if (row.status === "busy") return ansi.yellow(task);
  return task;
}

function dashboardLine(label: string, value: number, max: number, text: string, width: number): string {
  const labelText = ansi.cyan(label.padStart(3));
  const barWidth = Math.max(12, Math.min(42, width - visible(label) - visible(text) - 7));
  const pct = max > 0 ? (value / max) * 100 : 0;
  return `${labelText} ${wideBar(pct, barWidth)} ${text}`;
}

function wideBar(value: number, width: number): string {
  const clamped = Math.max(0, Math.min(100, value));
  const filled = Math.round((clamped / 100) * width);
  const bar = `${"█".repeat(filled)}${"░".repeat(Math.max(0, width - filled))}`;
  if (clamped >= 90) return ansi.red(bar);
  if (clamped >= 70) return ansi.yellow(bar);
  if (clamped > 0) return ansi.green(bar);
  return ansi.gray(bar);
}

function tinyBar(value: number, width: number): string {
  const clamped = Math.max(0, Math.min(100, value));
  const filled = Math.round((clamped / 100) * width);
  return `${"▮".repeat(filled)}${ansi.gray("·".repeat(Math.max(0, width - filled)))}`;
}

function formatMem(kb: number): string {
  const mb = kb / 1024;
  if (!Number.isFinite(mb) || mb <= 0) return "0M";
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)}M`;
  return `${(mb / 1024).toFixed(2)}G`;
}

function maxMemScale(kb: number): number {
  if (kb <= 0) return 1;
  const mb = kb / 1024;
  if (mb <= 1024) return 1024 * 1024;
  if (mb <= 4096) return 4096 * 1024;
  return 16384 * 1024;
}

function countStatuses(rows: MonitorRow[]): Map<LiveStatus, number> {
  const counts = new Map<LiveStatus, number>();
  for (const row of rows) counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
  return counts;
}

function statusChips(counts: Map<LiveStatus, number>): string {
  const statuses: LiveStatus[] = ["busy", "permission", "waiting", "running", "idle", "unknown"];
  return statuses
    .filter((status) => (counts.get(status) ?? 0) > 0)
    .map((status) => `${statusDot(status)} ${colorStatus(status)} ${counts.get(status)}`)
    .join(ansi.gray("  "));
}
