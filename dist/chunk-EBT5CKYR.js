#!/usr/bin/env node
import {
  extractClaudeSessionMeta,
  extractCodexSessionMeta,
  parseJsonlFile,
  parseJsonlHead,
  streamSessions
} from "./chunk-FBJPGCDT.js";
import {
  CLAUDE_SESSIONS_DIR,
  CODEX_SESSIONS_DIR,
  DEFAULT_STARLING_HOME,
  atomicWriteJSON
} from "./chunk-RWHPIOVN.js";

// src/lib/sessionIndex.ts
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync } from "fs";
import { dirname, join } from "path";
var SESSION_INDEX_PATH = join(DEFAULT_STARLING_HOME, "session-index.json");
async function rebuildSessionIndex(provider) {
  const sessions = [];
  for await (const session of streamSessions(provider, Infinity)) {
    sessions.push(session);
  }
  return writeSessionIndex(sessions, collectSessionDirectoryEntries(provider));
}
function loadSessionIndex() {
  if (!existsSync(SESSION_INDEX_PATH)) return null;
  try {
    const parsed = JSON.parse(readFileSync(SESSION_INDEX_PATH, "utf-8"));
    if (!isRecord(parsed)) return null;
    if (parsed.version !== 1 || !Array.isArray(parsed.sessions)) return null;
    if (typeof parsed.built_at !== "string") return null;
    if (typeof parsed.session_count !== "number") return null;
    if (typeof parsed.project_count !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}
async function loadSessionIndexWithNewFiles(provider, options = {}) {
  const index = loadSessionIndex();
  if (!index) {
    return rebuildSessionIndex();
  }
  const refresh = options.refreshKnownFiles ? await refreshIndexedSessionFiles(index, provider) : { index, sessions: index.sessions, changed: false };
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
async function refreshIndexedSessionsById(sessionIds, provider, options = {}) {
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
      const indexedMtime = indexedFileMtime(index, session) ?? Date.parse(session.modified_at);
      const sessionHasFileIndex = Boolean(session.file_path && index.files?.some((file) => file.path === session.file_path));
      if (!options.refreshMatchedFiles && sessionHasFileIndex && Number.isFinite(indexedMtime) && stat.mtimeMs <= indexedMtime) continue;
      const refreshed = await parseSessionFileEntry({
        provider: session.provider === "codex" ? "codex" : "claude",
        path: session.file_path,
        mtimeMs: stat.mtimeMs
      }, { full: options.refreshMatchedFiles });
      if (!refreshed) continue;
      upsertSession(sessions, refreshed);
      changed = true;
    } catch {
    }
  }
  return changed ? writeSessionIndex(sessions, index.directories ?? []) : index;
}
function clearSessionIndex() {
  if (!existsSync(SESSION_INDEX_PATH)) return false;
  unlinkSync(SESSION_INDEX_PATH);
  return true;
}
function removeSessionFromIndex(sessionId) {
  const index = loadSessionIndex();
  if (!index) return false;
  const normalized = sessionId.toLowerCase();
  const sessions = index.sessions.filter((session) => session.session_id.toLowerCase() !== normalized);
  if (sessions.length === index.sessions.length) return false;
  writeSessionIndex(sessions, index.directories ?? []);
  return true;
}
function aggregateProjectsFromSessions(sessions, providerFilter) {
  const map = /* @__PURE__ */ new Map();
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
        sessions: []
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
function aggregateProjectSummariesFromSessions(sessions, providerFilter) {
  return aggregateProjectsFromSessions(sessions, providerFilter).map(({ sessions: _sessions, ...project }) => project);
}
var LOOKUP_FRESH_TTL_MS = 6e4;
function isSessionIndexFresh(provider, now = Date.now()) {
  const index = loadSessionIndex();
  if (!index) return false;
  const builtAt = Date.parse(index.built_at);
  if (!Number.isFinite(builtAt)) return false;
  if (now - builtAt < LOOKUP_FRESH_TTL_MS) return true;
  const roots = [];
  if (!provider || provider === "claude") roots.push(CLAUDE_SESSIONS_DIR);
  if (!provider || provider === "codex") roots.push(CODEX_SESSIONS_DIR);
  for (const root of roots) {
    try {
      const stat = statSync(root);
      if (stat.mtimeMs > builtAt) return false;
    } catch {
      return false;
    }
  }
  return true;
}
async function lookupIndexedSessions(sessionIds, provider) {
  const result = /* @__PURE__ */ new Map();
  if (sessionIds.length === 0) return result;
  const wantedIds = new Set(sessionIds.map((id) => id.toLowerCase()));
  if (wantedIds.size === 0) return result;
  const index = isSessionIndexFresh(provider) ? loadSessionIndex() : await loadSessionIndexWithNewFiles(provider);
  if (!index) return result;
  for (const session of index.sessions) {
    if (provider && session.provider !== provider) continue;
    if (!matchesSessionId(wantedIds, session.session_id)) continue;
    if (result.has(session.session_id)) continue;
    result.set(session.session_id, session);
  }
  return result;
}
async function findIndexedSessionCandidates(sessionId, provider) {
  const index = await refreshIndexedSessionsById([sessionId], provider, { refreshMatchedFiles: true });
  const matches = index.sessions.filter((session) => {
    if (provider && session.provider !== provider) return false;
    return matchesSessionId(/* @__PURE__ */ new Set([sessionId.toLowerCase()]), session.session_id);
  });
  matches.sort((a, b) => b.modified_at.localeCompare(a.modified_at));
  return matches;
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function writeSessionIndex(sessions, directories = []) {
  sessions.sort((a, b) => b.modified_at.localeCompare(a.modified_at));
  const projects = aggregateProjectSummariesFromSessions(sessions);
  const index = {
    version: 1,
    built_at: (/* @__PURE__ */ new Date()).toISOString(),
    session_count: sessions.length,
    project_count: projects.length,
    sessions,
    files: indexedFilesFromSessions(sessions),
    directories,
    projects
  };
  try {
    atomicWriteJSON(SESSION_INDEX_PATH, index);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Warning: failed to write session index ${SESSION_INDEX_PATH}: ${message}
`);
  }
  return index;
}
function upsertSession(sessions, session) {
  const existingIndex = sessions.findIndex((entry) => entry.session_id === session.session_id);
  if (existingIndex >= 0) {
    sessions[existingIndex] = session;
  } else {
    sessions.push(session);
  }
}
function matchesSessionId(wantedIds, sessionId) {
  const normalizedSessionId = sessionId.toLowerCase();
  if (wantedIds.has(normalizedSessionId)) return true;
  for (const wantedId of wantedIds) {
    if (wantedId && normalizedSessionId.startsWith(wantedId)) return true;
  }
  return false;
}
async function parseSessionFileEntry(entry, options = {}) {
  try {
    const entries = options.full ? await parseJsonlFile(entry.path) : await parseJsonlHead(entry.path);
    const modifiedAt = new Date(entry.mtimeMs).toISOString();
    if (entry.provider === "claude") {
      return extractClaudeSessionMeta(entries, entry.path, modifiedAt);
    }
    return extractCodexSessionMeta(entries, entry.path, modifiedAt);
  } catch {
    return null;
  }
}
async function refreshIndexedSessionFiles(index, provider) {
  const sessions = [];
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
        mtimeMs: stat.mtimeMs
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
function indexedFileMtime(index, session) {
  const filePath = session.file_path;
  if (!filePath) return null;
  const entry = index.files?.find((file) => file.path === filePath);
  if (entry && Number.isFinite(entry.mtimeMs)) return entry.mtimeMs;
  const parsed = Date.parse(session.modified_at);
  return Number.isFinite(parsed) ? parsed : null;
}
function indexedFilesFromSessions(sessions) {
  return sessions.filter((session) => Boolean(session.file_path)).map((session) => ({
    session_id: session.session_id,
    provider: session.provider === "codex" ? "codex" : "claude",
    path: session.file_path,
    mtimeMs: Date.parse(session.modified_at) || 0
  }));
}
function collectSessionDirectoryEntries(provider) {
  const roots = [];
  if (!provider || provider === "claude") roots.push({ provider: "claude", path: CLAUDE_SESSIONS_DIR });
  if (!provider || provider === "codex") roots.push({ provider: "codex", path: CODEX_SESSIONS_DIR });
  const directories = [];
  for (const root of roots) {
    collectSessionDirectoryEntriesInDir(root.provider, root.path, directories);
  }
  return directories;
}
function collectSessionDirectoryEntriesInDir(provider, dir, directories) {
  let stat;
  try {
    stat = statSync(dir);
  } catch {
    return;
  }
  if (!stat.isDirectory()) return;
  directories.push({ provider, path: dir, mtimeMs: stat.mtimeMs });
  let entries;
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
    }
  }
}
function collectNewSessionFileEntries(provider, index, indexedPaths) {
  const roots = [];
  if (!provider || provider === "claude") roots.push({ provider: "claude", path: CLAUDE_SESSIONS_DIR });
  if (!provider || provider === "codex") roots.push({ provider: "codex", path: CODEX_SESSIONS_DIR });
  const previousDirectories = index.directories ?? [];
  const previousDirMtimes = new Map(previousDirectories.map((entry) => [entry.path, entry.mtimeMs]));
  const previousChildDirs = mapIndexedChildDirectories(previousDirectories);
  const newFiles = [];
  const directories = [];
  for (const root of roots) {
    collectNewSessionFileEntriesInDir(root.provider, root.path, previousDirMtimes, previousChildDirs, indexedPaths, newFiles, directories);
  }
  return { newFiles, directories };
}
function mapIndexedChildDirectories(directories) {
  const children = /* @__PURE__ */ new Map();
  for (const entry of directories) {
    const parent = dirname(entry.path);
    const paths = children.get(parent) ?? [];
    paths.push(entry.path);
    children.set(parent, paths);
  }
  return children;
}
function mergeDirectoryEntries(existing, refreshed, provider) {
  if (!provider) return refreshed;
  return [...existing.filter((entry) => entry.provider !== provider), ...refreshed];
}
function collectNewSessionFileEntriesInDir(provider, dir, previousDirMtimes, previousChildDirs, indexedPaths, files, directories) {
  let dirStat;
  try {
    dirStat = statSync(dir);
  } catch {
    return;
  }
  if (!dirStat.isDirectory()) return;
  directories.push({ provider, path: dir, mtimeMs: dirStat.mtimeMs });
  const previousMtime = previousDirMtimes.get(dir);
  const directoryChanged = previousMtime === void 0 || dirStat.mtimeMs > previousMtime;
  if (!directoryChanged) {
    for (const childDir of previousChildDirs.get(dir) ?? []) {
      collectNewSessionFileEntriesInDir(provider, childDir, previousDirMtimes, previousChildDirs, indexedPaths, files, directories);
    }
    return;
  }
  let entries;
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
    }
  }
}

export {
  SESSION_INDEX_PATH,
  rebuildSessionIndex,
  loadSessionIndex,
  loadSessionIndexWithNewFiles,
  refreshIndexedSessionsById,
  clearSessionIndex,
  removeSessionFromIndex,
  aggregateProjectsFromSessions,
  lookupIndexedSessions,
  findIndexedSessionCandidates
};
