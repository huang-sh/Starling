import { existsSync, readFileSync, readdirSync, statSync, unlinkSync } from "fs";
import { dirname, join } from "path";
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

interface IndexedSessionFile {
  session_id: string;
  provider: Provider;
  path: string;
  mtimeMs: number;
}

interface IndexedSessionDirectory {
  provider: Provider;
  path: string;
  mtimeMs: number;
}

export interface ProjectSummary {
  project_path: string;
  session_count: number;
  agents: Record<string, number>;
  models: Record<string, number>;
  first_active: string;
  last_active: string;
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
  files?: IndexedSessionFile[];
  directories?: IndexedSessionDirectory[];
  projects?: ProjectSummary[];
}

interface LoadSessionIndexOptions {
  refreshKnownFiles?: boolean;
}

export const SESSION_INDEX_PATH = join(DEFAULT_STARLING_HOME, "session-index.json");

export async function rebuildSessionIndex(provider?: "claude" | "codex"): Promise<SessionIndex> {
  const sessions: SessionMeta[] = [];
  for await (const session of streamSessions(provider, Infinity)) {
    sessions.push(session);
  }
  return writeSessionIndex(sessions, collectSessionDirectoryEntries(provider));
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
  return loadSessionIndexWithNewFiles(provider, { refreshKnownFiles: true });
}

export async function loadSessionIndexWithNewFiles(
  provider?: Provider,
  options: LoadSessionIndexOptions = {}
): Promise<SessionIndex> {
  const index = loadSessionIndex();
  if (!index) {
    return rebuildSessionIndex();
  }

  const refresh = options.refreshKnownFiles
    ? await refreshIndexedSessionFiles(index, provider)
    : { index, sessions: index.sessions, changed: false };
  const indexedPaths = new Set(refresh.sessions.map((session) => session.file_path).filter(Boolean));
  const discovery = collectNewSessionFileEntries(provider, index, indexedPaths);
  if (discovery.newFiles.length === 0 && !refresh.changed) return refresh.index;

  const sessions = [...refresh.sessions];
  for (const entry of discovery.newFiles) {
    const session = await parseSessionFileEntry(entry);
    if (session) upsertSession(sessions, session);
  }

  return writeSessionIndex(sessions, mergeDirectoryEntries(index.directories ?? [], discovery.directories, provider));
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

  return changed ? writeSessionIndex(sessions, index.directories ?? []) : index;
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
  writeSessionIndex(sessions, index.directories ?? []);
  return true;
}

export function removeSessionFromIndex(sessionId: string): boolean {
  const index = loadSessionIndex();
  if (!index) return false;

  const normalized = sessionId.toLowerCase();
  const sessions = index.sessions.filter((session) => session.session_id.toLowerCase() !== normalized);
  if (sessions.length === index.sessions.length) return false;
  writeSessionIndex(sessions, index.directories ?? []);
  return true;
}

export function aggregateProjectsFromSessions(
  sessions: SessionMeta[],
  providerFilter?: "claude" | "codex"
): ProjectStats[] {
  const map = new Map<string, ProjectStats>();

  for (const meta of sessions) {
    if (providerFilter && meta.provider !== providerFilter) continue;
    if (!meta.project_path) continue;
    const key = meta.project_path;
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

export function aggregateProjectSummariesFromSessions(
  sessions: SessionMeta[],
  providerFilter?: "claude" | "codex"
): ProjectSummary[] {
  return aggregateProjectsFromSessions(sessions, providerFilter).map(({ sessions: _sessions, ...project }) => project);
}

export async function findIndexedSessionById(
  sessionId: string,
  provider?: Provider
): Promise<SessionMeta | null> {
  const matches = await findIndexedSessionCandidates(sessionId, provider);
  return matches.find((session) => session.session_id === sessionId) ?? matches[0] ?? null;
}

export async function findIndexedSessionCandidates(
  sessionId: string,
  provider?: Provider
): Promise<SessionMeta[]> {
  const index = await refreshIndexedSessionsById([sessionId], provider);
  const matches = index.sessions.filter((session) => {
    if (provider && session.provider !== provider) return false;
    return matchesSessionId(new Set([sessionId.toLowerCase()]), session.session_id);
  });
  matches.sort((a, b) => b.modified_at.localeCompare(a.modified_at));
  return matches;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function writeSessionIndex(
  sessions: SessionMeta[],
  directories: IndexedSessionDirectory[] = []
): SessionIndex {
  sessions.sort((a, b) => b.modified_at.localeCompare(a.modified_at));
  const projects = aggregateProjectSummariesFromSessions(sessions);
  const index: SessionIndex = {
    version: 1,
    built_at: new Date().toISOString(),
    session_count: sessions.length,
    project_count: projects.length,
    sessions,
    files: indexedFilesFromSessions(sessions),
    directories,
    projects,
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

async function refreshIndexedSessionFiles(
  index: SessionIndex,
  provider?: Provider
): Promise<{ index: SessionIndex; sessions: SessionMeta[]; changed: boolean }> {
  const sessions: SessionMeta[] = [];
  let changed = false;

  for (const session of index.sessions) {
    if (provider && session.provider !== provider) {
      sessions.push(session);
      continue;
    }
    if (!session.file_path) {
      sessions.push(session);
      continue;
    }

    try {
      const stat = statSync(session.file_path);
      const indexedMtime = indexedFileMtime(index, session) ?? Date.parse(session.modified_at);
      if (Number.isFinite(indexedMtime) && stat.mtimeMs <= indexedMtime) {
        sessions.push(session);
        continue;
      }

      const refreshed = await parseSessionFileEntry({
        provider: session.provider === "codex" ? "codex" : "claude",
        path: session.file_path,
        mtimeMs: stat.mtimeMs,
      });
      if (refreshed) {
        sessions.push(refreshed);
        changed = true;
      } else {
        sessions.push(session);
      }
    } catch {
      changed = true;
    }
  }

  if (!changed) return { index, sessions: index.sessions, changed: false };
  return { index, sessions, changed: true };
}

function indexedFileMtime(index: SessionIndex, session: SessionMeta): number | null {
  const filePath = session.file_path;
  if (!filePath) return null;
  const entry = index.files?.find((file) => file.path === filePath);
  if (entry && Number.isFinite(entry.mtimeMs)) return entry.mtimeMs;
  const parsed = Date.parse(session.modified_at);
  return Number.isFinite(parsed) ? parsed : null;
}

function indexedFilesFromSessions(sessions: SessionMeta[]): IndexedSessionFile[] {
  return sessions
    .filter((session) => Boolean(session.file_path))
    .map((session) => ({
      session_id: session.session_id,
      provider: session.provider === "codex" ? "codex" : "claude",
      path: session.file_path,
      mtimeMs: Date.parse(session.modified_at) || 0,
    }));
}

function collectSessionDirectoryEntries(provider?: Provider): IndexedSessionDirectory[] {
  const roots: Array<{ provider: Provider; path: string }> = [];
  if (!provider || provider === "claude") roots.push({ provider: "claude", path: CLAUDE_SESSIONS_DIR });
  if (!provider || provider === "codex") roots.push({ provider: "codex", path: CODEX_SESSIONS_DIR });

  const directories: IndexedSessionDirectory[] = [];
  for (const root of roots) {
    collectSessionDirectoryEntriesInDir(root.provider, root.path, directories);
  }
  return directories;
}

function collectSessionDirectoryEntriesInDir(provider: Provider, dir: string, directories: IndexedSessionDirectory[]): void {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(dir);
  } catch {
    return;
  }
  if (!stat.isDirectory()) return;
  directories.push({ provider, path: dir, mtimeMs: stat.mtimeMs });

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
      const childStat = statSync(full);
      if (childStat.isDirectory()) {
        collectSessionDirectoryEntriesInDir(provider, full, directories);
      }
    } catch {
      // skip unreadable entries
    }
  }
}

function collectNewSessionFileEntries(
  provider: Provider | undefined,
  index: SessionIndex,
  indexedPaths: Set<string>
): { newFiles: SessionFileEntry[]; directories: IndexedSessionDirectory[] } {
  const roots: Array<{ provider: Provider; path: string }> = [];
  if (!provider || provider === "claude") roots.push({ provider: "claude", path: CLAUDE_SESSIONS_DIR });
  if (!provider || provider === "codex") roots.push({ provider: "codex", path: CODEX_SESSIONS_DIR });

  const previousDirectories = index.directories ?? [];
  const previousDirMtimes = new Map(previousDirectories.map((entry) => [entry.path, entry.mtimeMs]));
  const previousChildDirs = mapIndexedChildDirectories(previousDirectories);
  const newFiles: SessionFileEntry[] = [];
  const directories: IndexedSessionDirectory[] = [];

  for (const root of roots) {
    collectNewSessionFileEntriesInDir(root.provider, root.path, previousDirMtimes, previousChildDirs, indexedPaths, newFiles, directories);
  }

  return { newFiles, directories };
}

function mapIndexedChildDirectories(directories: IndexedSessionDirectory[]): Map<string, string[]> {
  const children = new Map<string, string[]>();
  for (const entry of directories) {
    const parent = dirname(entry.path);
    const paths = children.get(parent) ?? [];
    paths.push(entry.path);
    children.set(parent, paths);
  }
  return children;
}

function mergeDirectoryEntries(
  existing: IndexedSessionDirectory[],
  refreshed: IndexedSessionDirectory[],
  provider?: Provider
): IndexedSessionDirectory[] {
  if (!provider) return refreshed;
  return [...existing.filter((entry) => entry.provider !== provider), ...refreshed];
}

function collectNewSessionFileEntriesInDir(
  provider: Provider,
  dir: string,
  previousDirMtimes: Map<string, number>,
  previousChildDirs: Map<string, string[]>,
  indexedPaths: Set<string>,
  files: SessionFileEntry[],
  directories: IndexedSessionDirectory[]
): void {
  let dirStat: ReturnType<typeof statSync>;
  try {
    dirStat = statSync(dir);
  } catch {
    return;
  }
  if (!dirStat.isDirectory()) return;
  directories.push({ provider, path: dir, mtimeMs: dirStat.mtimeMs });

  const previousMtime = previousDirMtimes.get(dir);
  const directoryChanged = previousMtime === undefined || dirStat.mtimeMs > previousMtime;

  if (!directoryChanged) {
    for (const childDir of previousChildDirs.get(dir) ?? []) {
      collectNewSessionFileEntriesInDir(provider, childDir, previousDirMtimes, previousChildDirs, indexedPaths, files, directories);
    }
    return;
  }

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
        collectNewSessionFileEntriesInDir(provider, full, previousDirMtimes, previousChildDirs, indexedPaths, files, directories);
      } else if (directoryChanged && entry.endsWith(".jsonl") && !indexedPaths.has(full)) {
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
