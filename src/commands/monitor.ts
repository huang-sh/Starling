import { Command } from "commander";
import chalk from "chalk";
import Table from "cli-table3";
import { basename } from "path";
import { existsSync, statSync } from "fs";
import { listBookmarks, listSpaces } from "../lib/store.js";
import { catalogPath, resolveCatalogReference } from "../lib/catalogResolver.js";
import { loadSessionIndex, SESSION_INDEX_PATH, type SessionIndex } from "../lib/sessionIndex.js";
import {
  detectRunningSessions,
  loadRuns,
  reconcileStaleRuns,
  runsPath,
  type DetectedSession,
} from "../lib/runs.js";
import { getProcessTreeMetrics, resetCpuSampler } from "../lib/processMetrics.js";
import {
  getSessionLiveMetrics,
  type ChatMessageEntry,
  type ToolCallEntry,
} from "../lib/sessionMetrics.js";
import { shortSessionId } from "../lib/sessionDisplay.js";
import type { Bookmark, RunRecord, RunStatus } from "../types.js";

interface RowSpec {
  session_id: string;
  provider: string;
  project_path: string;
  title: string;
  pinned: boolean;
  catalog?: string;
}

/**
 * Fine-grained live status for monitor rows (6 states, mirrors abtop).
 *
 * `RunStatus` is left untouched for run records; the monitor boundary maps
 * RunStatus → LiveStatus via `resolveLiveStatus`.
 */
export type LiveStatus =
  | "thinking" // model generating; last user msg awaiting assistant
  | "executing" // tool_use in flight or descendant CPU active
  | "waiting" // idle, awaiting user input
  | "rate_limited" // reserved (Tier 3)
  | "done" // terminal (run completed/errored/crashed)
  | "unknown"; // no process + no run record

const LIVE_GLYPH: Record<LiveStatus, string> = {
  thinking: "◐",
  executing: "▸",
  waiting: "⏸",
  rate_limited: "⏱",
  done: "✓",
  unknown: "?",
};

const LIVE_COLOR: Record<LiveStatus, (s: string) => string> = {
  thinking: chalk.cyan,
  executing: chalk.green,
  waiting: chalk.gray,
  rate_limited: chalk.magenta,
  done: chalk.dim,
  unknown: chalk.gray,
};

const IDLE_THRESHOLD_MS = 30_000;

function resolveLiveStatus(
  runStatus: RunStatus,
  live: {
    pendingSinceMs: number;
    thinkingSinceMs: number;
    lastActivityMs: number;
  } | null,
  detected: boolean,
  now = Date.now(),
  idleThresholdMs = IDLE_THRESHOLD_MS
): LiveStatus {
  if (!detected) {
    if (runStatus === "completed" || runStatus === "errored" || runStatus === "crashed") return "done";
    if (runStatus === "running") return "thinking"; // optimistic — process went away between ticks
    return "unknown"; // stale / unknown
  }
  if (live) {
    if (live.pendingSinceMs > 0) return "executing";
    if (live.thinkingSinceMs > 0) {
      return now - live.thinkingSinceMs < idleThresholdMs ? "thinking" : "waiting";
    }
    return now - live.lastActivityMs < idleThresholdMs ? "executing" : "waiting";
  }
  return "thinking"; // detected but unreadable transcript — give benefit of the doubt
}

function liveBadge(status: LiveStatus): string {
  return LIVE_COLOR[status](LIVE_GLYPH[status]);
}

/** Active states (model or tools doing work) for sort + active count. */
function isActiveLiveStatus(s: LiveStatus): boolean {
  return s === "thinking" || s === "executing" || s === "rate_limited";
}

export interface MonitorRow {
  session_id: string;
  pinned: boolean;
  catalog?: string;
  title: string;
  provider: string;
  model: string;
  status: LiveStatus;
  pid?: number;
  cpu_pct?: number;
  mem_kb?: number;
  ctx_pct: number;
  tokens_in: number;
  tokens_out: number;
  tokens_cache: number;
  last_tool: string | null;
  tool_count: number;
  project_path: string;
  file_path?: string;
  last_activity_ms: number;
  // --- Tier 1 enrichment ---
  started_at_ms: number;
  elapsed_secs: number;
  pending_since_ms: number;
  thinking_since_ms: number;
  token_history: number[];
  context_history: number[];
  compaction_count: number;
  current_task: string;
  tool_calls_tail: ToolCallEntry[];
  chat_tail: ChatMessageEntry[];
}

interface Snapshot {
  pinned: MonitorRow[];
  recent: MonitorRow[];
  pinnedTotal: number;
  recentTotal: number;
  activeCount: number;
  error?: string;
}

/**
 * Mutable cache populated by `buildSnapshot` on the first load and reused on
 * subsequent calls when the underlying file's mtime hasn't advanced. Watch mode
 * passes one in so a 3s tick skips re-parsing the 12MB+ session index and the
 * runs file when nothing changed.
 */
interface SnapshotCaches {
  index?: SessionIndex | null;
  indexMtimeMs?: number;
  runs?: RunRecord[];
  runsMtimeMs?: number;
}

const PINNED_DISPLAY_LIMIT = 30;
const RECENT_LIMIT = 8;

async function buildRow(
  spec: RowSpec,
  detected: Map<string, DetectedSession>,
  indexBySid: Map<string, { file_path: string; modified_at: string }>,
  latestRunBySid: Map<string, RunRecord>
): Promise<MonitorRow> {
  const det = detected.get(spec.session_id);
  const latest = latestRunBySid.get(spec.session_id);
  const detectedFlag = !!det || latest?.status === "running";
  const runStatus: RunStatus = latest?.status ?? "unknown";

  const indexEntry = indexBySid.get(spec.session_id);
  const filePath = det?.file_path ?? indexEntry?.file_path;

  let model = "";
  let tokens = { input: 0, output: 0, cache: 0, total: 0 };
  let ctxPct = -1;
  let lastTool: string | null = null;
  let toolCount = 0;
  let lastActivityMs = indexEntry ? Date.parse(indexEntry.modified_at) || 0 : 0;
  // Live fields default to empty / zero.
  let startedAtMs = 0;
  let pendingSinceMs = 0;
  let thinkingSinceMs = 0;
  let tokenHistory: number[] = [];
  let contextHistory: number[] = [];
  let compactionCount = 0;
  let currentTask = "";
  let toolCallsTail: ToolCallEntry[] = [];
  let chatTail: ChatMessageEntry[] = [];

  if (filePath) {
    try {
      const live = await getSessionLiveMetrics(filePath);
      model = live.model;
      tokens = live.tokens;
      ctxPct = live.ctxPct;
      lastTool = live.lastTool;
      toolCount = live.toolCount;
      lastActivityMs = live.lastActivityMs;
      startedAtMs = live.startedAtMs;
      pendingSinceMs = live.pendingSinceMs;
      thinkingSinceMs = live.thinkingSinceMs;
      tokenHistory = live.tokenHistory;
      contextHistory = live.contextHistory;
      compactionCount = live.compactionCount;
      currentTask = live.currentTask;
      toolCallsTail = live.toolCallsTail;
      chatTail = live.chatTail;
    } catch {
      /* unreadable session file — metrics stay empty */
    }
  }

  const liveForStatus = filePath
    ? { pendingSinceMs, thinkingSinceMs, lastActivityMs }
    : null;
  const status = resolveLiveStatus(runStatus, liveForStatus, detectedFlag);

  let pid = det?.pid;
  let cpuPct: number | undefined;
  let memKb: number | undefined;
  if (pid) {
    const m = getProcessTreeMetrics(pid);
    cpuPct = m.cpuPct;
    memKb = m.memKb;
  }

  const now = Date.now();
  const elapsedSecs = startedAtMs > 0 ? Math.max(0, Math.floor((now - startedAtMs) / 1000)) : 0;

  return {
    session_id: spec.session_id,
    pinned: spec.pinned,
    catalog: spec.catalog,
    title: spec.title,
    provider: spec.provider || (det?.provider ?? ""),
    model,
    status,
    pid,
    cpu_pct: cpuPct,
    mem_kb: memKb,
    ctx_pct: ctxPct,
    tokens_in: tokens.input,
    tokens_out: tokens.output,
    tokens_cache: tokens.cache,
    last_tool: lastTool,
    tool_count: toolCount,
    project_path: spec.project_path || (det?.project_path ?? ""),
    file_path: filePath,
    last_activity_ms: lastActivityMs,
    started_at_ms: startedAtMs,
    elapsed_secs: elapsedSecs,
    pending_since_ms: pendingSinceMs,
    thinking_since_ms: thinkingSinceMs,
    token_history: tokenHistory,
    context_history: contextHistory,
    compaction_count: compactionCount,
    current_task: currentTask,
    tool_calls_tail: toolCallsTail,
    chat_tail: chatTail,
  };
}

export async function buildSnapshot(
  opts: {
    catalogFilter?: string;
    pinnedLimit?: number;
    includeRecent?: boolean;
  },
  caches?: SnapshotCaches
): Promise<Snapshot> {
  const catalogFilter = opts.catalogFilter;
  const pinnedLimit = opts.pinnedLimit && opts.pinnedLimit > 0 ? opts.pinnedLimit : PINNED_DISPLAY_LIMIT;
  reconcileStaleRuns();
  const detected = await detectRunningSessions();
  // Load runs.json once (cached by mtime when a caches object is passed in).
  // Index by session_id with most-recent first so each row lookup is O(1).
  let runs = caches?.runs;
  if (caches) {
    try {
      const st = statSync(runsPath());
      if (caches.runsMtimeMs !== st.mtimeMs) {
        caches.runsMtimeMs = st.mtimeMs;
        caches.runs = undefined;
      }
    } catch {
      caches.runs = undefined;
    }
    runs = caches.runs;
  }
  if (!runs) {
    runs = loadRuns().runs;
    if (caches) caches.runs = runs;
  }
  const latestRunBySid = new Map<string, RunRecord>();
  for (const r of runs) {
    if (!r.session_id) continue;
    const existing = latestRunBySid.get(r.session_id);
    if (!existing || r.started_at > existing.started_at) {
      latestRunBySid.set(r.session_id, r);
    }
  }
  // Same for the session index — it's the dominant cost on large fleets.
  let index: SessionIndex | null | undefined = caches?.index;
  if (caches) {
    try {
      const st = statSync(SESSION_INDEX_PATH);
      if (caches.indexMtimeMs !== st.mtimeMs) {
        caches.indexMtimeMs = st.mtimeMs;
        caches.index = undefined;
      }
    } catch {
      caches.index = undefined;
    }
    index = caches.index;
  }
  if (index === undefined) {
    index = loadSessionIndex();
    if (caches) caches.index = index;
  }
  const indexBySid = new Map<string, { file_path: string; modified_at: string }>();
  const metaBySid = new Map<string, { provider: string; project_path: string; first_prompt: string; custom_title?: string }>();
  if (index && Array.isArray(index.sessions)) {
    for (const s of index.sessions) {
      if (s.file_path) indexBySid.set(s.session_id, { file_path: s.file_path, modified_at: s.modified_at });
      metaBySid.set(s.session_id, {
        provider: s.provider,
        project_path: s.project_path,
        first_prompt: s.first_prompt,
        custom_title: s.custom_title,
      });
    }
  }
  const spaces = listSpaces();

  // Pinned bookmarks (optionally filtered to a catalog).
  let pinned: Bookmark[] = listBookmarks().filter((b) => b.space_ids.length > 0);
  if (catalogFilter) {
    const resolution = resolveCatalogReference(catalogFilter);
    if (resolution.kind !== "found") {
      const error =
        resolution.kind === "ambiguous"
          ? `Ambiguous catalog "${catalogFilter}": ${resolution.matches.map((m) => m.name).join(", ")}`
          : `Catalog not found: ${catalogFilter}`;
      return { pinned: [], recent: [], pinnedTotal: 0, recentTotal: 0, activeCount: 0, error };
    }
    const catalogId = resolution.space.id;
    pinned = pinned.filter((b) => b.space_ids.includes(catalogId));
  }

  const pinnedTotal = pinned.length;

  // Build specs with a cheap activity timestamp (no file read yet) so we can cap.
  type PinnedEntry = { spec: RowSpec; modifiedAt: string; running: boolean; filePath?: string };
  const entries: PinnedEntry[] = pinned.map((b) => {
    const firstSpaceId = b.space_ids[0];
    const space = firstSpaceId ? spaces.find((s) => s.id === firstSpaceId) : undefined;
    const catalog = space ? catalogPath(space, spaces) : b.space_ids.join(",") || "-";
    const indexEntry = indexBySid.get(b.session_id);
    const det = detected.get(b.session_id);
    return {
      spec: {
        session_id: b.session_id,
        provider: b.provider,
        project_path: b.project_path,
        title: b.title,
        pinned: true,
        catalog,
      },
      modifiedAt: indexEntry?.modified_at ?? "",
      running: !!det,
      filePath: det?.file_path ?? indexEntry?.file_path,
    };
  });

  // Show every running pinned session, plus the most-recently-active idle ones
  // whose session file is still readable, up to the limit. Idle entries whose
  // session file has disappeared (e.g. benchmark runs under since-removed
  // isolated homes) are skipped so they don't burn display slots on empty rows.
  const running = entries.filter((e) => e.running);
  const idleLimit = Math.max(0, pinnedLimit - running.length);
  const sortedIdle = entries
    .filter((e) => !e.running)
    .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  const idle: PinnedEntry[] = [];
  const statBudget = Math.max(idleLimit * 4, 60);
  let stats = 0;
  for (const e of sortedIdle) {
    if (idle.length >= idleLimit) break;
    // Only stat when an index path is known; entries with no path still get
    // shown (they may carry run-record status). Skip known-missing files so
    // since-removed isolated-home sessions don't fill the display with dashes.
    if (e.filePath) {
      if (stats++ >= statBudget && idle.length > 0) break;
      if (!existsSync(e.filePath)) continue;
    }
    idle.push(e);
  }
  const displayPinned = [...running, ...idle].map((e) => e.spec);

  const pinnedRows = await Promise.all(displayPinned.map((s) => buildRow(s, detected, indexBySid, latestRunBySid)));
  pinnedRows.sort((a, b) => {
    const aActive = isActiveLiveStatus(a.status);
    const bActive = isActiveLiveStatus(b.status);
    if (aActive && !bActive) return -1;
    if (bActive && !aActive) return 1;
    return b.last_activity_ms - a.last_activity_ms;
  });

  // Recent unpinned (opt-in via --recent; always hidden under a catalog filter).
  let recentRows: MonitorRow[] = [];
  let recentTotal = 0;
  if (opts.includeRecent && !catalogFilter) {
    const pinnedIds = new Set(pinned.map((b) => b.session_id));
    const recentCandidates = [...indexBySid.entries()]
      .filter(([sid]) => !pinnedIds.has(sid))
      .map(([sid, v]) => ({ sid, modified_at: v.modified_at, file_path: v.file_path }))
      .sort((a, b) => b.modified_at.localeCompare(a.modified_at));
    recentTotal = recentCandidates.length;
    // Skip sessions whose file has disappeared (same reason as the pinned idle
    // filter) so recent slots aren't burned on empty rows.
    const recentMeta: typeof recentCandidates = [];
    let budget = 0;
    for (const c of recentCandidates) {
      if (recentMeta.length >= RECENT_LIMIT) break;
      if (budget++ >= RECENT_LIMIT * 4) break;
      if (!existsSync(c.file_path)) continue;
      recentMeta.push(c);
    }
    const recentSpecs: RowSpec[] = recentMeta.map((m) => {
      const meta = metaBySid.get(m.sid);
      return {
        session_id: m.sid,
        provider: meta?.provider ?? "claude",
        project_path: meta?.project_path ?? "",
        title: meta?.custom_title || (meta?.first_prompt ? meta.first_prompt.slice(0, 40) : ""),
        pinned: false,
      };
    });
    recentRows = await Promise.all(recentSpecs.map((s) => buildRow(s, detected, indexBySid, latestRunBySid)));
    recentRows.sort((a, b) => {
      const aActive = isActiveLiveStatus(a.status);
      const bActive = isActiveLiveStatus(b.status);
      if (aActive && !bActive) return -1;
      if (bActive && !aActive) return 1;
      return b.last_activity_ms - a.last_activity_ms;
    });
  }

  const activeCount = [...pinnedRows, ...recentRows].filter((r) => isActiveLiveStatus(r.status)).length;
  return { pinned: pinnedRows, recent: recentRows, pinnedTotal, recentTotal, activeCount };
}

// --- formatting ---

function shortModel(m: string): string {
  if (!m) return "-";
  const low = m.toLowerCase();
  if (low.includes("opus")) return low.includes("4-6") || low.includes("4.6") ? "opus-4.6" : low.includes("4-5") || low.includes("4.5") ? "opus-4.5" : "opus-4";
  if (low.includes("sonnet")) return low.includes("4-6") || low.includes("4.6") ? "son-4.6" : "son-4";
  if (low.includes("haiku")) return "haiku-4";
  if (low.includes("codex") || low.includes("gpt-5")) return "codex";
  return m.length > 12 ? m.slice(0, 11) + "…" : m;
}

function compact(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(0) + "k";
  return String(n);
}

function formatMem(kb: number | undefined): string {
  if (!kb || kb <= 0) return "-";
  if (kb < 1024) return `${kb}K`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)}M`;
  return `${(mb / 1024).toFixed(2)}G`;
}

function cpuColor(pct: number | undefined): string {
  if (pct === undefined) return chalk.gray("-");
  const s = `${pct.toFixed(0)}%`;
  if (pct >= 80) return chalk.red(s);
  if (pct >= 30) return chalk.yellow(s);
  return chalk.green(s);
}

function ctxColor(pct: number): string {
  if (pct < 0) return chalk.gray("-");
  const s = `${pct.toFixed(0)}%`;
  if (pct >= 90) return chalk.red.bold(s);
  if (pct >= 70) return chalk.yellow(s);
  return chalk.gray(s);
}

function renderSection(rows: MonitorRow[]): string {
  if (rows.length === 0) return chalk.gray("  (none)");
  const table = new Table({
    head: [
      chalk.cyan("Session"),
      chalk.cyan("Model"),
      chalk.cyan("Project"),
      chalk.cyan("CPU"),
      chalk.cyan("Mem"),
      chalk.cyan("CTX"),
      chalk.cyan("Tokens in/out/ch"),
      chalk.cyan("Task"),
    ],
    colWidths: [15, 11, 16, 6, 7, 6, 18, 14],
    style: { head: [] },
  });
  for (const r of rows) {
    const proj = r.project_path ? basename(r.project_path) || r.project_path : "-";
    // in/out in plain text, cached shown gray so the three fields stay legible.
    const tok = `${compact(r.tokens_in)}/${compact(r.tokens_out)}/${chalk.gray(compact(r.tokens_cache))}`;
    // Task column: prefer current_task (file path / command), fall back to "<tool>×<count>".
    let task = r.current_task;
    if (!task) task = r.last_tool ? `${r.last_tool}×${r.tool_count}` : "-";
    table.push([
      `${liveBadge(r.status)} ${shortSessionId(r.session_id)}`,
      shortModel(r.model),
      proj.length > 15 ? proj.slice(0, 14) + "…" : proj,
      cpuColor(r.cpu_pct),
      formatMem(r.mem_kb),
      ctxColor(r.ctx_pct),
      tok,
      task.length > 13 ? task.slice(0, 12) + "…" : task,
    ]);
  }
  return table.toString();
}

function renderSnapshot(snap: Snapshot, tick?: number): string {
  const header = chalk.bold("Starling monitor");
  const tickInfo = tick !== undefined ? chalk.gray(`  refresh 3s  tick ${tick}`) : "";
  const shown = snap.pinned.length;
  const pinnedTitle =
    shown < snap.pinnedTotal
      ? chalk.bold(`\nPinned (${shown} of ${snap.pinnedTotal})`)
      : chalk.bold(`\nPinned (${snap.pinnedTotal})`);
  const pinnedSection = renderSection(snap.pinned);
  let out = `${header}${tickInfo}${pinnedTitle}\n${pinnedSection}`;
  if (snap.recent.length > 0) {
    const rshown = snap.recent.length;
    const recentTitle =
      rshown < snap.recentTotal
        ? chalk.bold(`\nRecent unpinned (${rshown} of ${snap.recentTotal})`)
        : chalk.bold(`\nRecent unpinned (${snap.recentTotal})`);
    out += recentTitle + "\n" + renderSection(snap.recent);
  }
  out +=
    chalk.gray(`\nactive ${snap.activeCount}`) +
    chalk.gray(tick !== undefined ? "  ·  Ctrl-C to exit\n" : "\n");
  return out;
}

function clearScreen(): void {
  process.stdout.write("\x1Bc");
}

export function registerMonitorCommand(program: Command): void {
  const monitor = new Command("monitor")
    .description("Live per-session monitoring (CPU/mem/CTX%/tokens). Pinned sessions first; unpinned only with --recent.")
    .argument("[catalog]", "filter to a catalog's pinned sessions (name, path, or id)")
    .option("-c, --catalog <catalog>", "filter to a catalog (name, path, or id)")
    .option("-n, --limit <n>", "max pinned sessions to display (default 30)")
    .option("--recent", "also show recent unpinned sessions")
    .option("--watch", "live monitoring mode (re-render every 3s)")
    .option("--json", "output the current snapshot as JSON")
    .action(async (arg: string | undefined, opts: { catalog?: string; limit?: string; recent?: boolean; watch?: boolean; json?: boolean }) => {
      const catalogFilter = opts.catalog ?? arg;
      const parsedLimit = Number(opts.limit);
      const pinnedLimit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.floor(parsedLimit) : undefined;
      const includeRecent = !!opts.recent;
      const snapshotOpts = { catalogFilter, pinnedLimit, includeRecent };

      const snapshotError = (msg: string): never => {
        console.error(chalk.red(msg));
        return process.exit(1) as never;
      };

      if (opts.json) {
        const snap = await buildSnapshot(snapshotOpts);
        if (snap.error) snapshotError(snap.error);
        console.log(
          JSON.stringify(
            {
              pinned_total: snap.pinnedTotal,
              recent_total: snap.recentTotal,
              active: snap.activeCount,
              pinned: snap.pinned,
              recent: snap.recent,
            },
            null,
            2
          )
        );
        return;
      }

      if (!opts.watch) {
        const snap = await buildSnapshot(snapshotOpts);
        if (snap.error) snapshotError(snap.error);
        console.log(renderSnapshot(snap));
        return;
      }

      // Watch mode.
      resetCpuSampler();
      // Track status with the tick it was first seen at, so we can suppress
      // chatty transitions (thinking ↔ executing) until they hold for ≥2 ticks.
      let previous = new Map<string, { status: LiveStatus; since: number; tool: string | null }>();
      let tick = 0;
      let stopped = false;
      // Re-read state files only when their mtime advances. The session index
      // is the dominant cost on large fleets (12MB+ JSON parse) and changes
      // rarely, so mtime-checking it avoids re-parsing on every 3s tick.
      const caches: SnapshotCaches = {};
      const stop = () => {
        if (stopped) return;
        stopped = true;
        clearScreen();
        process.exit(0);
      };
      process.on("SIGINT", stop);

      const TERMINAL_STATES: ReadonlySet<LiveStatus> = new Set(["done", "rate_limited"]);

      const renderOnce = async () => {
        tick++;
        const snap = await buildSnapshot(snapshotOpts, caches);
        const all = [...snap.pinned, ...snap.recent];
        const current = new Map<string, { status: LiveStatus; tool: string | null }>(
          all.map((r) => [r.session_id, { status: r.status, tool: r.last_tool }])
        );

        const events: string[] = [];
        const next = new Map<string, { status: LiveStatus; since: number; tool: string | null }>();
        for (const [sid, cur] of current) {
          const prev = previous.get(sid);
          // Carry forward the "since" tick when the status hasn't changed; otherwise reset.
          const since = prev && prev.status === cur.status ? prev.since : tick;
          next.set(sid, { status: cur.status, since, tool: cur.tool });

          if (!prev) continue;
          if (prev.status !== cur.status) {
            // Suppress churn: only emit on terminal transitions or after the new
            // state has held for ≥ 2 ticks.
            const isTerminal = TERMINAL_STATES.has(cur.status);
            const stable = tick - since >= 1; // since===tick means first observation; ≥1 means seen at least twice
            if (isTerminal || stable) {
              events.push(
                `[${new Date().toISOString().slice(11, 19)}] ${shortSessionId(sid)} ${prev.status} → ${cur.status}`
              );
            }
          }
          if (prev.tool !== cur.tool && cur.tool) {
            events.push(`[${new Date().toISOString().slice(11, 19)}] ${shortSessionId(sid)} tool ${prev.tool ?? "-"} → ${cur.tool}`);
          }
        }
        previous = next;

        clearScreen();
        const filterLine = catalogFilter ? chalk.gray(`catalog: ${catalogFilter}\n`) : "";
        process.stdout.write(filterLine + renderSnapshot(snap, tick));
        if (events.length > 0) {
          process.stdout.write(chalk.gray("\n— transitions —\n") + events.map((e) => chalk.gray(e)).join("\n") + "\n");
        }
      };

      await renderOnce();
      // Coalesce ticks: never start a new render while one is in flight, and
      // never schedule a fresh one closer than TICK_MS from the previous start.
      // This prevents pile-up on slow systems (large fleets, slow disks) where
      // a single render can take longer than the tick interval.
      const TICK_MS = 3000;
      let renderInFlight = false;
      let lastStart = 0;
      const interval = setInterval(() => {
        if (renderInFlight) return;
        if (Date.now() - lastStart < TICK_MS) return;
        renderInFlight = true;
        lastStart = Date.now();
        renderOnce()
          .catch(() => undefined)
          .finally(() => {
            renderInFlight = false;
          });
      }, 500);
      interval.unref?.();
    });

  program.addCommand(monitor);
}
