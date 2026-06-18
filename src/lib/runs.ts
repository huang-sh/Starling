import chalk from "chalk";
import { DEFAULT_RUNS_PATH, RUNS_VERSION } from "../constants.js";
import type { Bookmark, RunRecord, RunStatus, RunsFile } from "../types.js";
import { atomicWriteJSON, readJSON } from "../utils/fs.js";
import { mapProcessesToSessions } from "./processMap.js";

const MAX_RUN_RECORDS = 500;

/**
 * Location of runs.json. Mirrors store.json's placement (sibling of store.json in
 * all STARLING_HOME / config-homePath configurations). Uses its own STARLING_RUNS
 * override so it never collides with STARLING_CONFIG (which targets store.json).
 */
export function runsPath(): string {
  const env = process.env.STARLING_RUNS;
  return env ?? DEFAULT_RUNS_PATH;
}

function emptyRuns(): RunsFile {
  return { version: RUNS_VERSION, runs: [] };
}

export function loadRuns(): RunsFile {
  let data: RunsFile | null;
  try {
    data = readJSON<RunsFile>(runsPath());
  } catch {
    return emptyRuns();
  }
  if (!data || typeof data !== "object" || !Array.isArray((data as RunsFile).runs)) {
    return emptyRuns();
  }
  return { version: RUNS_VERSION, runs: (data as RunsFile).runs };
}

export function saveRuns(data: RunsFile): void {
  // Bound history: keep every running record, trim oldest terminal records.
  if (data.runs.length > MAX_RUN_RECORDS) {
    const running = data.runs.filter((r) => r.status === "running");
    const terminal = data.runs
      .filter((r) => r.status !== "running")
      .sort((a, b) => (b.ended_at ?? b.started_at).localeCompare(a.ended_at ?? a.started_at));
    data = { version: RUNS_VERSION, runs: [...running, ...terminal].slice(0, MAX_RUN_RECORDS) };
  }
  atomicWriteJSON(runsPath(), data);
}

// --- Lifecycle mutators ---

export function createRun(record: RunRecord): void {
  const data = loadRuns();
  data.runs.push(record);
  saveRuns(data);
}

export interface FinalizePatch {
  status: RunStatus;
  exit_code?: number;
  ended_at?: string;
  session_id?: string;
}

export function finalizeRun(runId: string, patch: FinalizePatch): void {
  const data = loadRuns();
  const idx = data.runs.findIndex((r) => r.run_id === runId);
  if (idx === -1) return;
  const existing = data.runs[idx]!;
  data.runs[idx] = {
    ...existing,
    status: patch.status,
    exit_code: patch.exit_code ?? existing.exit_code,
    ended_at: patch.ended_at ?? new Date().toISOString(),
    session_id: patch.session_id ?? existing.session_id,
  };
  saveRuns(data);
}

export function markRunCrashed(runId: string): void {
  finalizeRun(runId, { status: "crashed", ended_at: new Date().toISOString() });
}

export function removeRun(runId: string): boolean {
  const data = loadRuns();
  const before = data.runs.length;
  data.runs = data.runs.filter((r) => r.run_id !== runId);
  if (data.runs.length === before) return false;
  saveRuns(data);
  return true;
}

export function clearRuns(filter?: { session_id?: string; status?: RunStatus }): number {
  const data = loadRuns();
  const before = data.runs.length;
  data.runs = data.runs.filter((r) => {
    if (filter?.session_id && r.session_id !== filter.session_id) return true;
    if (filter?.status && r.status !== filter.status) return true;
    return false;
  });
  const removed = before - data.runs.length;
  if (removed > 0) saveRuns(data);
  return removed;
}

// --- Queries ---

export function findRun(runId: string): RunRecord | undefined {
  return loadRuns().runs.find((r) => r.run_id === runId);
}

export function findRunsBySession(sessionId: string): RunRecord[] {
  return loadRuns()
    .runs.filter((r) => r.session_id === sessionId)
    .sort((a, b) => b.started_at.localeCompare(a.started_at));
}

export function listRuns(filter?: { status?: RunStatus; provider?: string; catalog_id?: string }): RunRecord[] {
  let runs = loadRuns().runs;
  if (filter?.status) runs = runs.filter((r) => r.status === filter.status);
  if (filter?.provider) runs = runs.filter((r) => r.provider === filter.provider);
  if (filter?.catalog_id) runs = runs.filter((r) => r.catalog_id === filter.catalog_id);
  return runs.sort((a, b) => b.started_at.localeCompare(a.started_at));
}

export function getLatestRunForSession(sessionId: string): RunRecord | undefined {
  return findRunsBySession(sessionId)[0];
}

export function getRunStatusForSession(sessionId: string): RunStatus {
  const latest = getLatestRunForSession(sessionId);
  return latest ? latest.status : "unknown";
}

// --- Formatting helpers ---

const STATUS_GLYPH: Record<RunStatus, string> = {
  running: "●",
  completed: "✓",
  errored: "✗",
  crashed: "⚡",
  stale: "~",
  unknown: "·",
};

const STATUS_COLOR: Record<RunStatus, (s: string) => string> = {
  running: chalk.green,
  completed: chalk.gray,
  errored: chalk.red,
  crashed: chalk.magenta,
  stale: chalk.yellow,
  unknown: chalk.gray,
};

export function statusGlyph(status: RunStatus): string {
  return STATUS_GLYPH[status] ?? "·";
}

export function statusBadge(status: RunStatus): string {
  const color = STATUS_COLOR[status] ?? chalk.gray;
  return color(STATUS_GLYPH[status] ?? "·");
}

export function summarizeRunStatus(bookmarks: Bookmark[], options?: { color?: boolean }): string {
  const color = options?.color ?? true;
  const counts = new Map<RunStatus, number>();
  for (const b of bookmarks) {
    const status = getRunStatusForSession(b.session_id);
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  const order: RunStatus[] = ["running", "errored", "crashed", "completed", "unknown"];
  const render = (status: RunStatus): string =>
    color ? statusBadge(status) : (STATUS_GLYPH[status] ?? "·");
  const parts: string[] = [];
  for (const status of order) {
    const n = counts.get(status);
    if (!n) continue;
    parts.push(`${render(status)}${n}`);
  }
  return parts.length > 0 ? parts.join(" ") : render("unknown");
}

// --- Reconciliation ---

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // ESRCH = process does not exist (dead). EPERM = exists but not ours (alive).
    return code === "EPERM";
  }
}

/** Mark "running" records whose pid is dead as "crashed". Returns count changed. */
export function reconcileStaleRuns(): number {
  const data = loadRuns();
  let changed = 0;
  const now = new Date().toISOString();
  for (const run of data.runs) {
    if (run.status !== "running") continue;
    if (run.pid !== undefined && !isPidAlive(run.pid)) {
      run.status = "crashed";
      run.ended_at = now;
      changed++;
    }
  }
  if (changed > 0) saveRuns(data);
  return changed;
}

// --- Liveness detection (Linux /proc scan, in-memory) ---

export interface DetectedSession {
  pid?: number;
  provider: "claude" | "codex";
  project_path?: string;
  file_path?: string;
  home?: string;
}

/**
 * Scan running claude/codex processes and map each to its session via processMap
 * (cmdline `--resume`, open .jsonl files, process-tree BFS, cwd+mtime fallback).
 * Returns session_id -> detection info. Linux-only (empty elsewhere). In-memory
 * — does not write runs.json.
 */
export async function detectRunningSessions(): Promise<Map<string, DetectedSession>> {
  const mapped = await mapProcessesToSessions();
  const detected = new Map<string, DetectedSession>();
  for (const [sessionId, info] of mapped) {
    detected.set(sessionId, {
      pid: info.pid,
      provider: info.provider,
      project_path: info.project_path,
      file_path: info.file_path,
      home: info.home,
    });
  }
  return detected;
}
