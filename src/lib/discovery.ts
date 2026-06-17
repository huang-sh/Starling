import { readdirSync, statSync } from "fs";
import { join, basename } from "path";
import { CLAUDE_SESSIONS_DIR, CODEX_SESSIONS_DIR } from "../constants.js";
import { parseJsonlHead, extractClaudeSessionMeta, extractCodexSessionMeta } from "./session.js";
import type { SessionMeta } from "../types.js";

interface FileEntry {
  path: string;
  mtime: number;
}

/**
 * Collect JSONL files sorted by mtime (newest first).
 * Optimized: sort parent dirs by mtime first, then only walk the newest ones
 * until we have enough candidates.
 */
function collectJsonlFilesSorted(dir: string, limit: number): FileEntry[] {
  // Get immediate children sorted by mtime (newest first)
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  const children = entries
    .map((name) => {
      const full = join(dir, name);
      try {
        return { name, full, st: statSync(full) };
      } catch {
        return null;
      }
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  // Sort by mtime descending
  children.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);

  const results: FileEntry[] = [];

  for (const child of children) {
    if (results.length >= limit * 3) break; // over-collect a bit

    if (child.st.isDirectory()) {
      if (child.name === "subagents") continue;
      // Recurse into directory
      const nested = collectJsonlFilesSorted(child.full, limit);
      results.push(...nested);
    } else if (child.name.endsWith(".jsonl")) {
      results.push({ path: child.full, mtime: child.st.mtimeMs });
    }

    results.sort((a, b) => b.mtime - a.mtime);
  }

  return results.slice(0, limit * 3);
}

type Provider = "claude" | "codex";

const PROVIDER_DIRS: [Provider, string][] = [
  ["claude", CLAUDE_SESSIONS_DIR],
  ["codex", CODEX_SESSIONS_DIR],
];

export async function findSessions(limit = 50, providerFilter?: Provider): Promise<SessionMeta[]> {
  const results: SessionMeta[] = [];
  for await (const meta of streamSessions(providerFilter, limit)) {
    results.push(meta);
    if (results.length >= limit) break;
  }
  return results;
}

export async function* streamSessions(
  providerFilter?: Provider,
  collectLimit = Infinity
): AsyncGenerator<SessionMeta> {
  const allFiles: (FileEntry & { provider: Provider })[] = [];

  for (const [provider, dir] of PROVIDER_DIRS) {
    if (providerFilter && provider !== providerFilter) continue;
    const files = collectJsonlFilesSorted(dir, collectLimit);
    for (const f of files) allFiles.push({ ...f, provider });
  }
  allFiles.sort((a, b) => b.mtime - a.mtime);

  for (const file of allFiles) {
    try {
      const modifiedAt = new Date(file.mtime).toISOString();
      const entries = await parseJsonlHead(file.path);
      const extract = file.provider === "codex" ? extractCodexSessionMeta : extractClaudeSessionMeta;
      const meta = extract(entries, file.path, modifiedAt);
      if (meta) yield meta;
    } catch {
      // skip unreadable files
    }
  }
}

function matchSessionId(candidate: string, sessionId: string): boolean {
  if (!candidate || !sessionId) return false;
  const normalizedCandidate = candidate.toLowerCase();
  const normalizedSessionId = sessionId.toLowerCase();
  return (
    normalizedCandidate === normalizedSessionId ||
    normalizedCandidate.startsWith(normalizedSessionId) ||
    normalizedCandidate.includes(normalizedSessionId) ||
    normalizedSessionId.startsWith(normalizedCandidate)
  );
}

export function looksLikeSessionIdQuery(input: string): boolean {
  const normalized = input.trim().toLowerCase();
  if (normalized.length < 8) return false;
  if (!/^[0-9a-f-]+$/.test(normalized)) return false;

  const compact = normalized.replace(/-/g, "");
  if (compact.length < 8 || compact.length > 32) return false;
  return /^[0-9a-f]+$/.test(compact);
}

function collectSessionFilesForId(dir: string, sessionId: string, accumulator: string[]): void {
  if (accumulator.length > 5000) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry === "subagents") continue;
    const full = join(dir, entry);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(full);
    } catch {
      continue;
    }

    if (st.isDirectory()) {
      collectSessionFilesForId(full, sessionId, accumulator);
      continue;
    }

    if (!entry.endsWith(".jsonl")) continue;
    if (!entry.toLowerCase().includes(sessionId.toLowerCase())) continue;
    accumulator.push(full);
    if (accumulator.length > 5000) return;
  }
}

async function collectSessionCandidatesByFilename(sessionId: string): Promise<SessionMeta[]> {
  const matches = new Map<string, SessionMeta>();
  const normalizedId = sessionId.toLowerCase();
  const matchedFiles: string[] = [];

  for (const [, dir] of PROVIDER_DIRS) {
    collectSessionFilesForId(dir, normalizedId, matchedFiles);
  }

  for (const filePath of matchedFiles) {
    try {
      const fileName = basename(filePath);
      let provider: Provider = "claude";
      if (filePath.includes(CODEX_SESSIONS_DIR)) {
        provider = "codex";
      }
      const st = statSync(filePath);
      const modifiedAt = new Date(st.mtimeMs).toISOString();
      const entries = await parseJsonlHead(filePath);
      const extract = provider === "codex" ? extractCodexSessionMeta : extractClaudeSessionMeta;
      const meta = extract(entries, filePath, modifiedAt);
      if (!meta) continue;

      const byId = meta.session_id.toLowerCase();
      if (matchSessionId(byId, normalizedId)) {
        const existing = matches.get(meta.session_id);
        if (!existing || meta.modified_at > existing.modified_at) {
          matches.set(meta.session_id, meta);
        }
      }
    } catch {
      continue;
    }
  }

  if (matches.size > 0) {
    return [...matches.values()].sort((a, b) => b.modified_at.localeCompare(a.modified_at));
  }

  return [];
}

export async function findSessionCandidates(sessionId: string): Promise<SessionMeta[]> {
  if (!looksLikeSessionIdQuery(sessionId)) return [];

  const filenameMatches = await collectSessionCandidatesByFilename(sessionId);
  if (filenameMatches.length > 0) {
    return filenameMatches;
  }

  const matches: Map<string, SessionMeta> = new Map();

  const fallbackLimit = 2500;
  for await (const meta of streamSessions(undefined, fallbackLimit)) {
    if (!matchSessionId(meta.session_id, sessionId)) continue;
    const existing = matches.get(meta.session_id);
    if (!existing || meta.modified_at > existing.modified_at) {
      matches.set(meta.session_id, meta);
    }
  }

  return [...matches.values()].sort((a, b) => b.modified_at.localeCompare(a.modified_at));
}

export async function findSessionById(sessionId: string): Promise<SessionMeta | null> {
  const matches = await findSessionCandidates(sessionId);
  return matches.find((m) => m.session_id === sessionId) ?? matches[0] ?? null;
}
