#!/usr/bin/env node
import {
  CLAUDE_SESSIONS_DIR,
  CODEX_SESSIONS_DIR
} from "./chunk-RWHPIOVN.js";

// src/lib/session.ts
import { createReadStream } from "fs";
import { createInterface } from "readline";
function isRecord(value) {
  return typeof value === "object" && value !== null;
}
function asNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? n : void 0;
  }
  return void 0;
}
function mergeTokenUsage(target, source) {
  if (typeof source.input_tokens === "number") {
    target.input_tokens = source.input_tokens;
  }
  if (typeof source.output_tokens === "number") {
    target.output_tokens = source.output_tokens;
  }
  if (typeof source.total_tokens === "number") {
    target.total_tokens = source.total_tokens;
  }
  if (typeof source.cache_tokens === "number") {
    target.cache_tokens = source.cache_tokens;
  }
}
function hasNonZeroTokenUsage(usage) {
  if (!usage) return false;
  return Boolean(
    (usage.input_tokens ?? 0) > 0 || (usage.output_tokens ?? 0) > 0 || (usage.total_tokens ?? 0) > 0 || (usage.cache_tokens ?? 0) > 0
  );
}
function addTokenUsage(target, source) {
  if (typeof source.input_tokens === "number") {
    target.input_tokens = (target.input_tokens ?? 0) + source.input_tokens;
  }
  if (typeof source.output_tokens === "number") {
    target.output_tokens = (target.output_tokens ?? 0) + source.output_tokens;
  }
  if (typeof source.cache_tokens === "number") {
    target.cache_tokens = (target.cache_tokens ?? 0) + source.cache_tokens;
  }
  const input = target.input_tokens ?? 0;
  const output = target.output_tokens ?? 0;
  if (target.input_tokens !== void 0 || target.output_tokens !== void 0) {
    target.total_tokens = input + output;
  } else if (typeof source.total_tokens === "number") {
    target.total_tokens = (target.total_tokens ?? 0) + source.total_tokens;
  }
}
function normalizeCacheTokens(raw) {
  const direct = asNumber(raw.cache_tokens) ?? asNumber(raw.cacheTokens) ?? asNumber(raw.cached_input_tokens) ?? asNumber(raw.cachedInputTokens);
  if (typeof direct === "number") return direct;
  const fromCreation = asNumber(raw.cache_creation_input_tokens) ?? asNumber(raw.cacheCreationInputTokens);
  const fromRead = asNumber(raw.cache_read_input_tokens) ?? asNumber(raw.cacheReadInputTokens);
  if (typeof fromCreation === "number" || typeof fromRead === "number") {
    return (fromCreation ?? 0) + (fromRead ?? 0);
  }
  return void 0;
}
function extractTokenUsageFromValue(value, depth = 0) {
  if (depth > 16) return null;
  if (Array.isArray(value)) {
    const usage2 = {};
    let found = false;
    for (const item of value) {
      const nestedUsage = extractTokenUsageFromValue(item, depth + 1);
      if (nestedUsage) {
        mergeTokenUsage(usage2, nestedUsage);
        found = true;
      }
    }
    return found ? usage2 : null;
  }
  if (!isRecord(value)) return null;
  const totalUsageSource = isRecord(value.total_token_usage) ? value.total_token_usage : isRecord(value.totalTokenUsage) ? value.totalTokenUsage : null;
  if (totalUsageSource) {
    const totalUsage = extractTokenUsageFromValue(totalUsageSource, depth + 1);
    if (hasNonZeroTokenUsage(totalUsage)) return totalUsage;
    const lastUsageSource = isRecord(value.last_token_usage) ? value.last_token_usage : isRecord(value.lastTokenUsage) ? value.lastTokenUsage : null;
    const lastUsage = lastUsageSource ? extractTokenUsageFromValue(lastUsageSource, depth + 1) : null;
    return hasNonZeroTokenUsage(lastUsage) ? lastUsage : totalUsage;
  }
  const input = asNumber(value.input_tokens) ?? asNumber(value.inputTokens) ?? asNumber(value.prompt_tokens) ?? asNumber(value.promptTokens);
  const output = asNumber(value.output_tokens) ?? asNumber(value.outputTokens) ?? asNumber(value.completion_tokens) ?? asNumber(value.completionTokens);
  const total = asNumber(value.total_tokens) ?? asNumber(value.totalTokens) ?? (typeof input === "number" && typeof output === "number" ? input + output : void 0);
  const cache = normalizeCacheTokens(value);
  const usage = {};
  if (typeof input === "number") usage.input_tokens = input;
  if (typeof output === "number") usage.output_tokens = output;
  if (typeof total === "number") usage.total_tokens = total;
  if (typeof cache === "number") usage.cache_tokens = cache;
  const nestedValues = Object.values(value);
  for (const candidate of nestedValues) {
    const nestedUsage = extractTokenUsageFromValue(candidate);
    if (nestedUsage) {
      mergeTokenUsage(usage, nestedUsage);
    }
  }
  if (usage.input_tokens === void 0 && usage.output_tokens === void 0 && usage.total_tokens === void 0 && usage.cache_tokens === void 0) {
    return null;
  }
  return usage;
}
function extractTokenUsage(entry) {
  return extractTokenUsageFromValue(entry);
}
function hasCumulativeTokenUsage(value, depth = 0) {
  if (depth > 16) return false;
  if (Array.isArray(value)) return value.some((item) => hasCumulativeTokenUsage(item, depth + 1));
  if (!isRecord(value)) return false;
  if (isRecord(value.total_token_usage) || isRecord(value.totalTokenUsage)) return true;
  return Object.values(value).some((candidate) => hasCumulativeTokenUsage(candidate, depth + 1));
}
async function parseJsonlHead(filePath, maxLines = 500) {
  const entries = [];
  const rl = createInterface({ input: createReadStream(filePath, "utf-8"), crlfDelay: Infinity });
  let count = 0;
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
    }
    count++;
    if (count >= maxLines) break;
  }
  return entries;
}
async function parseJsonlFile(filePath) {
  return parseJsonlHead(filePath, Infinity);
}
function extractClaudeSessionMeta(entries, filePath, modifiedAt) {
  let sessionId = "";
  let model = "";
  let projectPath = "";
  let firstPrompt = "";
  const tokenUsage = {};
  let hasTokenUsage = false;
  for (const entry of entries) {
    if (entry.sessionId && typeof entry.sessionId === "string" && !sessionId) {
      sessionId = entry.sessionId;
    }
    if (!model) {
      let candidate = "";
      if (entry.model && typeof entry.model === "string") {
        candidate = entry.model;
      } else if (entry.message && typeof entry.message === "object") {
        const msgModel = entry.message.model;
        if (msgModel && typeof msgModel === "string") candidate = msgModel;
      }
      if (candidate && !candidate.startsWith("<") && candidate !== "synthetic") {
        model = candidate;
      }
    }
    if (entry.cwd && typeof entry.cwd === "string" && !projectPath) {
      projectPath = entry.cwd;
    }
    if ((entry.type === "user" || entry.type === "human") && entry.message && typeof entry.message === "object") {
      const msg = entry.message;
      if (!firstPrompt && msg.content) {
        if (typeof msg.content === "string") {
          firstPrompt = msg.content;
        } else if (Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (typeof part === "object" && part !== null && "text" in part && typeof part.text === "string") {
              firstPrompt = part.text;
              break;
            }
          }
        }
      }
    }
    const entryUsage = extractTokenUsage(entry);
    if (entryUsage) {
      if (hasCumulativeTokenUsage(entry)) {
        mergeTokenUsage(tokenUsage, entryUsage);
      } else {
        addTokenUsage(tokenUsage, entryUsage);
      }
      hasTokenUsage = true;
    }
  }
  if (!sessionId) {
    const parts = filePath.split("/");
    const filename = parts[parts.length - 1].replace(".jsonl", "");
    sessionId = filename;
  }
  return {
    session_id: sessionId,
    provider: "claude",
    model,
    project_path: projectPath,
    first_prompt: firstPrompt.slice(0, 200),
    file_path: filePath,
    created_at: modifiedAt,
    modified_at: modifiedAt,
    ...hasTokenUsage ? { token_usage: tokenUsage } : {}
  };
}
function extractCodexSessionMeta(entries, filePath, modifiedAt) {
  let sessionId = "";
  let model = "";
  let projectPath = "";
  let firstPrompt = "";
  const tokenUsage = {};
  let hasTokenUsage = false;
  for (const entry of entries) {
    if (entry.type === "session_meta" && entry.payload && typeof entry.payload === "object") {
      const p = entry.payload;
      if (p.id && !sessionId) sessionId = p.id;
      if (p.cwd && !projectPath) projectPath = p.cwd;
      if (p.model_provider && !model) model = p.model_provider;
    }
    if (entry.type === "event_msg" && entry.payload && typeof entry.payload === "object") {
      const p = entry.payload;
      if (p.type === "user_message" && p.content && !firstPrompt) {
        firstPrompt = p.content;
      }
    }
    if (entry.type === "turn_context" && entry.payload && typeof entry.payload === "object") {
      const p = entry.payload;
      if (p.model && model === "openai") model = p.model;
    }
    const entryUsage = extractTokenUsage(entry);
    if (entryUsage) {
      mergeTokenUsage(tokenUsage, entryUsage);
      hasTokenUsage = true;
    }
  }
  if (!sessionId) {
    const parts = filePath.split("/");
    const filename = parts[parts.length - 1].replace(".jsonl", "");
    sessionId = filename;
  }
  return {
    session_id: sessionId,
    provider: "codex",
    model,
    project_path: projectPath,
    first_prompt: firstPrompt.slice(0, 200),
    file_path: filePath,
    created_at: modifiedAt,
    modified_at: modifiedAt,
    ...hasTokenUsage ? { token_usage: tokenUsage } : {}
  };
}

// src/lib/discovery.ts
import { readdirSync, statSync } from "fs";
import { join } from "path";
function collectJsonlFilesSorted(dir, limit) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const children = entries.map((name) => {
    const full = join(dir, name);
    try {
      return { name, full, st: statSync(full) };
    } catch {
      return null;
    }
  }).filter((x) => x !== null);
  children.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
  const results = [];
  for (const child of children) {
    if (results.length >= limit * 3) break;
    if (child.st.isDirectory()) {
      if (child.name === "subagents") continue;
      const nested = collectJsonlFilesSorted(child.full, limit);
      results.push(...nested);
    } else if (child.name.endsWith(".jsonl")) {
      results.push({ path: child.full, mtime: child.st.mtimeMs });
    }
    results.sort((a, b) => b.mtime - a.mtime);
  }
  return results.slice(0, limit * 3);
}
var PROVIDER_DIRS = [
  ["claude", CLAUDE_SESSIONS_DIR],
  ["codex", CODEX_SESSIONS_DIR]
];
async function findSessions(limit = 50, providerFilter) {
  const results = [];
  for await (const meta of streamSessions(providerFilter, limit)) {
    results.push(meta);
    if (results.length >= limit) break;
  }
  return results;
}
async function* streamSessions(providerFilter, collectLimit = Infinity) {
  const allFiles = [];
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
    }
  }
}
function matchSessionId(candidate, sessionId) {
  if (!candidate || !sessionId) return false;
  const normalizedCandidate = candidate.toLowerCase();
  const normalizedSessionId = sessionId.toLowerCase();
  return normalizedCandidate === normalizedSessionId || normalizedCandidate.startsWith(normalizedSessionId) || normalizedCandidate.includes(normalizedSessionId) || normalizedSessionId.startsWith(normalizedCandidate);
}
function looksLikeSessionIdQuery(input) {
  const normalized = input.trim().toLowerCase();
  if (normalized.length < 8) return false;
  if (!/^[0-9a-f-]+$/.test(normalized)) return false;
  const compact = normalized.replace(/-/g, "");
  if (compact.length < 8 || compact.length > 32) return false;
  return /^[0-9a-f]+$/.test(compact);
}
function collectSessionFilesForId(dir, sessionId, accumulator) {
  if (accumulator.length > 5e3) return;
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === "subagents") continue;
    const full = join(dir, entry);
    let st;
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
    if (accumulator.length > 5e3) return;
  }
}
async function collectSessionCandidatesByFilename(sessionId) {
  const matches = /* @__PURE__ */ new Map();
  const normalizedId = sessionId.toLowerCase();
  const matchedFiles = [];
  for (const [, dir] of PROVIDER_DIRS) {
    collectSessionFilesForId(dir, normalizedId, matchedFiles);
  }
  for (const filePath of matchedFiles) {
    try {
      const fileName = filePath.split("/").pop() ?? "";
      let provider = "claude";
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
async function findSessionCandidates(sessionId) {
  if (!looksLikeSessionIdQuery(sessionId)) return [];
  const filenameMatches = await collectSessionCandidatesByFilename(sessionId);
  if (filenameMatches.length > 0) {
    return filenameMatches;
  }
  const matches = /* @__PURE__ */ new Map();
  const fallbackLimit = 2500;
  for await (const meta of streamSessions(void 0, fallbackLimit)) {
    if (!matchSessionId(meta.session_id, sessionId)) continue;
    const existing = matches.get(meta.session_id);
    if (!existing || meta.modified_at > existing.modified_at) {
      matches.set(meta.session_id, meta);
    }
  }
  return [...matches.values()].sort((a, b) => b.modified_at.localeCompare(a.modified_at));
}
async function findSessionById(sessionId) {
  const matches = await findSessionCandidates(sessionId);
  return matches.find((m) => m.session_id === sessionId) ?? matches[0] ?? null;
}

export {
  parseJsonlHead,
  parseJsonlFile,
  extractClaudeSessionMeta,
  extractCodexSessionMeta,
  findSessions,
  streamSessions,
  looksLikeSessionIdQuery,
  findSessionCandidates,
  findSessionById
};
