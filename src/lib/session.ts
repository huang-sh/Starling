import { createReadStream } from "fs";
import { createInterface } from "readline";
import type { SessionMeta } from "../types.js";

export interface JsonlEntry {
  type?: string;
  [key: string]: unknown;
}

export async function parseJsonlHead(filePath: string, maxLines = 50): Promise<JsonlEntry[]> {
  const entries: JsonlEntry[] = [];
  const rl = createInterface({ input: createReadStream(filePath, "utf-8"), crlfDelay: Infinity });
  let count = 0;
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // skip malformed lines
    }
    count++;
    if (count >= maxLines) break;
  }
  return entries;
}

export function extractClaudeSessionMeta(
  entries: JsonlEntry[],
  filePath: string,
  modifiedAt: string
): SessionMeta | null {
  let sessionId = "";
  let model = "";
  let projectPath = "";
  let firstPrompt = "";

  for (const entry of entries) {
    // Extract session_id from various entry types
    if (entry.sessionId && typeof entry.sessionId === "string" && !sessionId) {
      sessionId = entry.sessionId;
    }
    if (entry.session_id && typeof entry.session_id === "string" && !sessionId) {
      sessionId = entry.session_id;
    }
    // Extract model
    if (entry.model && typeof entry.model === "string" && !model) {
      model = entry.model;
    }
    // Extract project path from cwd or projectPath
    if (entry.cwd && typeof entry.cwd === "string" && !projectPath) {
      projectPath = entry.cwd;
    }
    if (entry.projectPath && typeof entry.projectPath === "string" && !projectPath) {
      projectPath = entry.projectPath;
    }
    // Extract first user message
    if (
      (entry.type === "user" || entry.type === "human") &&
      entry.message &&
      typeof entry.message === "object"
    ) {
      const msg = entry.message as { content?: unknown };
      if (!firstPrompt && msg.content) {
        if (typeof msg.content === "string") {
          firstPrompt = msg.content;
        } else if (Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (typeof part === "object" && part !== null && "text" in part && typeof (part as { text: string }).text === "string") {
              firstPrompt = (part as { text: string }).text;
              break;
            }
          }
        }
      }
    }
  }

  if (!sessionId) {
    // Fallback: use filename as session id
    const parts = filePath.split("/");
    const filename = parts[parts.length - 1].replace(".jsonl", "");
    sessionId = filename;
  }

  // Extract created_at from filePath pattern or use modified time
  const createdAt = modifiedAt;

  return {
    session_id: sessionId,
    provider: "claude",
    model,
    project_path: projectPath,
    first_prompt: firstPrompt.slice(0, 200),
    file_path: filePath,
    created_at: createdAt,
    modified_at: modifiedAt,
  };
}
