import { existsSync, readFileSync, readdirSync, statSync, unlinkSync } from "fs";
import { join } from "path";
import { CLAUDE_SESSIONS_DIR, CODEX_SESSIONS_DIR, DEFAULT_STARLING_HOME } from "../constants.js";
import { atomicWriteJSON } from "../utils/fs.js";
import { streamSessions } from "./discovery.js";
import { extractClaudeSessionMeta, extractCodexSessionMeta, parseJsonlHead } from "./session.js";
import type { SessionMeta } from "../types.js";

type Provider = "claude" | "codex";

interface SessionFileEntry {
  provider: Provider;
  path: string;
  mtimeMs: number;
}

export interface ProjectStats {
  project_path: string;
  session_count: number;
  agents: Record<string, number>;
  models: Record<string, number>;
  first_active: string;
  last_active: string;
  sessions: SessionMeta[];
}

export interface SessionIndex {
  version: 1;
  built_at: string;
  session_count: number;
  project_count: number;
  sessions: SessionMeta[];
}

export const SESSION_INDEX_PATH = join(DEFAULT_STARLING_HOME, "session-index.json");

export async function rebuildSessionIndex(provider?: "claude" | "codex"): Promise<SessionIndex> {
  const sessions: SessionMeta[] = [];
  for await (const session of streamSessions(provider, Infinity)) {
    sessions.push(session);
  }
  return writeSessionIndex(sessions);
}

export function loadSessionIndex(): SessionIndex | null {
  if (!existsSync(SESSION_INDEX_PATH)) return null;
  try {
    const parsed = JSON.parse(readFileSync(SESSION_INDEX_PATH, "utf-8")) as unknown;
    if (!isRecord(parsed)) return null;
    if (parsed.version !== 1 || !Array.isArray(parsed.sessions)) return null;
    if (typeof parsed.built_at !== "string") return null;
    if (typeof parsed.session_count !== "number") return null;
    if (typeof parsed.project_count !== "number") return null;
    return parsed as unknown as SessionIndex;
  } catch {
    return null;
  }
}

export async function loadFreshSessionIndex(provider?: "claude" | "codex"): Promise<SessionIndex> {
  const index = loadSessionIndex();
  if (!index || isSessionIndexStale(provider)) {
    return rebuildSessionIndex();
  }
  return index;
}

export async function loadSessionIndexWithNewFiles(provider?: Provider): Promise<SessionIndex> {
  const index = loadSessionIndex();
  if (!index) {
    return rebuildSessionIndex();
  }

  const indexedPaths = new Set(index.sessions.map((session) => session.file_path).filter(Boolean));
  const newFiles = collectSessionFileEntries(provider).filter((entry) => !indexedPaths.has(entry.path));
  if (newFiles.length === 0) return index;

  const sessions = [...index.sessions];
  for (const entry of newFiles) {
    const session = await parseSessionFileEntry(entry);
    if (session) upsertSession(sessions, session);
  }

  return writeSessionIndex(sessions);
}

export async function refreshIndexedSessionsById(
  sessionIds: string[],
  provider?: Provider
): Promise<SessionIndex> {
  const index = await loadSessionIndexWithNewFiles(provider);
  const wantedIds = new Set(sessionIds.map((sessionId) => sessionId.toLowerCase()));
  if (wantedIds.size === 0) return index;

  const sessions = [...index.sessions];
  let changed = false;

  for (const session of index.sessions) {
    if (provider && session.provider !== provider) continue;
    if (!matchesSessionId(wantedIds, session.session_id)) continue;
    if (!session.file_path) continue;

    try {
      const stat = statSync(session.file_path);
      if (new Date(stat.mtimeMs).toISOString() <= session.modified_at) continue;
      const refreshed = await parseSessionFileEntry({
        provider: session.provider === "codex" ? "codex" : "claude",
        path: session.file_path,
        mtimeMs: stat.mtimeMs,
      });
      if (!refreshed) continue;
      upsertSession(sessions, refreshed);
      changed = true;
    } catch {
      // keep stale entry when the underlying file cannot be read
    }
  }

  return changed ? writeSessionIndex(sessions) : index;
}

export function isSessionIndexStale(provider?: "claude" | "codex"): boolean {
  if (!existsSync(SESSION_INDEX_PATH)) return true;

  let indexMtime = 0;
  try {
    indexMtime = statSync(SESSION_INDEX_PATH).mtimeMs;
  } catch {
    return true;
  }

  const newestSessionMtime = newestSessionRootMtime(provider);
  return newestSessionMtime > indexMtime;
}

export function clearSessionIndex(): boolean {
  if (!existsSync(SESSION_INDEX_PATH)) return false;
  unlinkSync(SESSION_INDEX_PATH);
  return true;
}

export function upsertSessionInIndex(session: SessionMeta): boolean {
  const index = loadSessionIndex();
  if (!index) return false;

  const sessions = [...index.sessions];
  upsertSession(sessions, session);
  writeSessionIndex(sessions);
  return true;
}

export function removeSessionFromIndex(sessionId: string): boolean {
  const index = loadSessionIndex();
  if (!index) return false;

  const normalized = sessionId.toLowerCase();
  const sessions = index.sessions.filter((session) => session.session_id.toLowerCase() !== normalized);
  if (sessions.length === index.sessions.length) return false;
  writeSessionIndex(sessions);
  return true;
}

export function aggregateProjectsFromSessions(
  sessions: SessionMeta[],
  providerFilter?: "claude" | "codex"
): ProjectStats[] {
  const map = new Map<string, ProjectStats>();

  for (const meta of sessions) {
    if (providerFilter && meta.provider !== providerFilter) continue;
    const key = meta.project_path || "(unknown)";
    let stats = map.get(key);
    if (!stats) {
      stats = {
        project_path: key,
        session_count: 0,
        agents: {},
        models: {},
        first_active: meta.modified_at,
        last_active: meta.modified_at,
        sessions: [],
      };
      map.set(key, stats);
    }

    stats.session_count++;
    stats.agents[meta.provider] = (stats.agents[meta.provider] || 0) + 1;
    const model = meta.model || "-";
    stats.models[model] = (stats.models[model] || 0) + 1;
    if (meta.modified_at < stats.first_active) stats.first_active = meta.modified_at;
    if (meta.modified_at > stats.last_active) stats.last_active = meta.modified_at;
    stats.sessions.push(meta);
  }

  const projects = [...map.values()];
  for (const project of projects) {
    project.sessions.sort((a, b) => b.modified_at.localeCompare(a.modified_at));
  }
  projects.sort((a, b) => b.last_active.localeCompare(a.last_active));
  return projects;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function writeSessionIndex(sessions: SessionMeta[]): SessionIndex {
  sessions.sort((a, b) => b.modified_at.localeCompare(a.modified_at));
  const projects = aggregateProjectsFromSessions(sessions);
  const index: SessionIndex = {
    version: 1,
    built_at: new Date().toISOString(),
    session_count: sessions.length,
    project_count: projects.length,
    sessions,
  };
  atomicWriteJSON(SESSION_INDEX_PATH, index);
  return index;
}

function upsertSession(sessions: SessionMeta[], session: SessionMeta): void {
  const existingIndex = sessions.findIndex((entry) => entry.session_id === session.session_id);
  if (existingIndex >= 0) {
    sessions[existingIndex] = session;
  } else {
    sessions.push(session);
  }
}

function matchesSessionId(wantedIds: Set<string>, sessionId: string): boolean {
  const normalizedSessionId = sessionId.toLowerCase();
  if (wantedIds.has(normalizedSessionId)) return true;
  for (const wantedId of wantedIds) {
    if (wantedId && normalizedSessionId.startsWith(wantedId)) return true;
  }
  return false;
}

async function parseSessionFileEntry(entry: SessionFileEntry): Promise<SessionMeta | null> {
  try {
    const entries = await parseJsonlHead(entry.path);
    const modifiedAt = new Date(entry.mtimeMs).toISOString();
    if (entry.provider === "claude") {
      return extractClaudeSessionMeta(entries, entry.path, modifiedAt);
    }
    return extractCodexSessionMeta(entries, entry.path, modifiedAt);
  } catch {
    return null;
  }
}

function collectSessionFileEntries(provider?: Provider): SessionFileEntry[] {
  const roots: Array<{ provider: Provider; path: string }> = [];
  if (!provider || provider === "claude") roots.push({ provider: "claude", path: CLAUDE_SESSIONS_DIR });
  if (!provider || provider === "codex") roots.push({ provider: "codex", path: CODEX_SESSIONS_DIR });

  const files: SessionFileEntry[] = [];
  for (const root of roots) {
    collectSessionFileEntriesInDir(root.provider, root.path, files);
  }
  return files;
}

function collectSessionFileEntriesInDir(provider: Provider, dir: string, files: SessionFileEntry[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry === "subagents") continue;
    const full = join(dir, entry);
    try {
      const stat = statSync(full);
      if (stat.isDirectory()) {
        collectSessionFileEntriesInDir(provider, full, files);
      } else if (entry.endsWith(".jsonl")) {
        files.push({ provider, path: full, mtimeMs: stat.mtimeMs });
      }
    } catch {
      // skip unreadable entries
    }
  }
}

function newestSessionRootMtime(provider?: "claude" | "codex"): number {
  const dirs: string[] = [];
  if (!provider || provider === "claude") dirs.push(CLAUDE_SESSIONS_DIR);
  if (!provider || provider === "codex") dirs.push(CODEX_SESSIONS_DIR);

  let newest = 0;
  for (const dir of dirs) {
    newest = Math.max(newest, newestMtimeInTree(dir));
  }
  return newest;
}

function newestMtimeInTree(dir: string): number {
  let newest = 0;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return newest;
  }

  for (const entry of entries) {
    if (entry === "subagents") continue;
    const full = join(dir, entry);
    try {
      const stat = statSync(full);
      if (stat.isDirectory()) {
        newest = Math.max(newest, newestMtimeInTree(full));
      } else if (entry.endsWith(".jsonl")) {
        newest = Math.max(newest, stat.mtimeMs);
      }
    } catch {
      // skip unreadable entries
    }
  }

  return newest;
}
