import { readdirSync, statSync } from "fs";
import { join } from "path";
import { CLAUDE_SESSIONS_DIR } from "../constants.js";
import { parseJsonlHead, extractClaudeSessionMeta } from "./session.js";
import type { SessionMeta } from "../types.js";

function* walkJsonlFiles(dir: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      yield* walkJsonlFiles(full);
    } else if (entry.endsWith(".jsonl")) {
      yield full;
    }
  }
}

export async function findSessions(limit = 50): Promise<SessionMeta[]> {
  const results: SessionMeta[] = [];

  // Claude Code sessions
  for (const filePath of walkJsonlFiles(CLAUDE_SESSIONS_DIR)) {
    try {
      const st = statSync(filePath);
      const modifiedAt = st.mtime.toISOString();
      const entries = await parseJsonlHead(filePath);
      const meta = extractClaudeSessionMeta(entries, filePath, modifiedAt);
      if (meta) {
        results.push(meta);
      }
    } catch {
      // skip unreadable files
    }
    if (results.length >= limit * 2) break; // over-collect for sorting
  }

  // Sort by modified_at descending (most recent first)
  results.sort((a, b) => b.modified_at.localeCompare(a.modified_at));

  return results.slice(0, limit);
}

export async function findSessionById(sessionId: string): Promise<SessionMeta | null> {
  for (const filePath of walkJsonlFiles(CLAUDE_SESSIONS_DIR)) {
    if (filePath.includes(sessionId)) {
      try {
        const st = statSync(filePath);
        const entries = await parseJsonlHead(filePath);
        return extractClaudeSessionMeta(entries, filePath, st.mtime.toISOString());
      } catch {
        continue;
      }
    }
  }
  return null;
}
