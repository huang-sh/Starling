#!/usr/bin/env node

// src/index.ts
import { Command as Command8 } from "commander";

// src/commands/session.ts
import { Command } from "commander";
import chalk2 from "chalk";
import { spawn, spawnSync } from "child_process";
import { existsSync as existsSync4, unlinkSync as unlinkSync3 } from "fs";

// src/lib/discovery.ts
import { readdirSync, statSync } from "fs";
import { join as join2 } from "path";

// src/constants.ts
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
var STARLING_HOME_ENV = process.env.STARLING_HOME?.trim();
var DEFAULT_CONFIG_DIR = join(homedir(), ".config", "starling");
var CLI_CONFIG_PATH = process.env.STARLING_CLI_CONFIG?.trim() || join(DEFAULT_CONFIG_DIR, "config.json");
function readConfiguredStarlingHome() {
  if (!existsSync(CLI_CONFIG_PATH)) return null;
  try {
    const parsed = JSON.parse(readFileSync(CLI_CONFIG_PATH, "utf-8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const homePath = parsed.homePath;
    return typeof homePath === "string" && homePath.trim() ? homePath.trim() : null;
  } catch {
    return null;
  }
}
function expandHomePath(value) {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}
var STARLING_HOME_CONFIG = readConfiguredStarlingHome();
var STARLING_HOME_VALUE = STARLING_HOME_ENV || STARLING_HOME_CONFIG;
var STARLING_HOME_SOURCE = STARLING_HOME_ENV ? "env" : STARLING_HOME_CONFIG ? "config" : "default";
var DEFAULT_STARLING_HOME = STARLING_HOME_VALUE ? expandHomePath(STARLING_HOME_VALUE) : join(homedir(), ".starling");
var DEFAULT_STORE_PATH = STARLING_HOME_VALUE ? join(DEFAULT_STARLING_HOME, "store.json") : join(DEFAULT_CONFIG_DIR, "store.json");
var STORE_VERSION = 1;
var DEFAULT_STARLING_SETTINGS_DIR = join(DEFAULT_STARLING_HOME, "settings");
var DEFAULT_CLAUDE_SETTINGS_DIR = join(DEFAULT_STARLING_SETTINGS_DIR, "claude");
var DEFAULT_CODEX_SETTINGS_DIR = join(DEFAULT_STARLING_SETTINGS_DIR, "codex");
var DEFAULT_CODEX_HOME = join(homedir(), ".codex");
var CLAUDE_SESSIONS_DIR = join(homedir(), ".claude", "projects");
var CODEX_SESSIONS_DIR = join(homedir(), ".codex", "sessions");
var ENV_CONFIG_KEY = "STARLING_CONFIG";

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
function collectJsonlFilesSorted(dir, limit) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const children = entries.map((name) => {
    const full = join2(dir, name);
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
    const full = join2(dir, entry);
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

// src/lib/format.ts
import chalk from "chalk";
import Table from "cli-table3";

// src/lib/sessionDisplay.ts
var SHORT_SESSION_ID_LENGTH = 13;
function shortSessionId(sessionId) {
  return sessionId.slice(0, SHORT_SESSION_ID_LENGTH);
}

// src/lib/format.ts
function formatSessionTable(sessions) {
  const formatToken = (value) => {
    return value === void 0 ? "-" : String(value);
  };
  const table = new Table({
    head: [
      chalk.cyan("Session ID"),
      chalk.cyan("Agent"),
      chalk.cyan("Model"),
      chalk.cyan("Project"),
      chalk.cyan("Modified"),
      chalk.cyan("Input"),
      chalk.cyan("Output"),
      chalk.cyan("Total"),
      chalk.cyan("Cache")
    ],
    colWidths: [15, 8, 16, 30, 20, 10, 10, 10, 10],
    style: { head: [] }
  });
  for (const s of sessions) {
    const shortId = shortSessionId(s.session_id);
    const agent = s.provider === "codex" ? "codex" : "claude";
    const shortProject = s.project_path ? s.project_path.length > 36 ? "\u2026" + s.project_path.slice(-35) : s.project_path : "-";
    const shortDate = s.modified_at.slice(0, 19).replace("T", " ");
    table.push([
      shortId,
      agent,
      s.model || "-",
      shortProject,
      shortDate,
      formatToken(s.token_usage?.input_tokens),
      formatToken(s.token_usage?.output_tokens),
      formatToken(s.token_usage?.total_tokens),
      formatToken(s.token_usage?.cache_tokens)
    ]);
  }
  return table.toString();
}
function formatSpaceTree(spaces, bookmarks) {
  if (spaces.length === 0) return chalk.yellow("No catalogs created yet.");
  const childrenMap = /* @__PURE__ */ new Map();
  for (const s of spaces) {
    const parent = s.parent_id ?? null;
    if (!childrenMap.has(parent)) childrenMap.set(parent, []);
    childrenMap.get(parent).push(s);
  }
  const bookmarkBySpace = /* @__PURE__ */ new Map();
  for (const b of bookmarks) {
    for (const sid of b.space_ids) {
      if (!bookmarkBySpace.has(sid)) bookmarkBySpace.set(sid, []);
      bookmarkBySpace.get(sid).push(b);
    }
  }
  function renderNode(space, prefix, isLast) {
    const connector = isLast ? "\u2514\u2500\u2500 " : "\u251C\u2500\u2500 ";
    const lines2 = [];
    const tagStr = space.tags.length > 0 ? chalk.gray(` [${space.tags.join(", ")}]`) : "";
    lines2.push(`${prefix}${connector}${chalk.bold(space.name)}${tagStr}`);
    const childPrefix = prefix + (isLast ? "    " : "\u2502   ");
    const bk = bookmarkBySpace.get(space.id) || [];
    for (let i = 0; i < bk.length; i++) {
      const bIsLast = i === bk.length - 1 && !childrenMap.has(space.id);
      const bConn = bIsLast ? "\u2514\u2500\u2500 " : "\u251C\u2500\u2500 ";
      lines2.push(`${childPrefix}${bConn}${chalk.cyan(bk[i].title)} ${chalk.gray(`[${bk[i].session_id}]`)}`);
    }
    const children = childrenMap.get(space.id) || [];
    for (let i = 0; i < children.length; i++) {
      lines2.push(...renderNode(children[i], childPrefix, i === children.length - 1 && bk.length === 0));
    }
    return lines2;
  }
  const roots = childrenMap.get(null) || [];
  const lines = [chalk.bold("starling")];
  for (let i = 0; i < roots.length; i++) {
    lines.push(...renderNode(roots[i], "", i === roots.length - 1));
  }
  return lines.join("\n");
}

// src/utils/fs.ts
import { existsSync as existsSync2, mkdirSync, readFileSync as readFileSync2, writeFileSync, renameSync, unlinkSync, mkdtempSync, chmodSync } from "fs";
import { dirname, join as join3 } from "path";
function ensureDir(filePath) {
  const dir = dirname(filePath);
  if (!existsSync2(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}
function atomicWriteJSON(filePath, data) {
  ensureDir(filePath);
  const dir = dirname(filePath);
  const tmpDir = join3(dir, ".starling-tmp");
  if (!existsSync2(tmpDir)) mkdirSync(tmpDir, { recursive: true });
  const prefix = join3(tmpDir, "starling-");
  const tmpPath = mkdtempSync(prefix) + "/tmp.json";
  try {
    writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
    chmodSync(tmpPath, 384);
    renameSync(tmpPath, filePath);
  } finally {
    if (existsSync2(tmpPath)) {
      unlinkSync(tmpPath);
    }
  }
}
function readJSON(filePath) {
  if (!existsSync2(filePath)) return null;
  const raw = readFileSync2(filePath, "utf-8");
  return JSON.parse(raw);
}

// src/lib/id.ts
function generateBookmarkId(bookmarks) {
  let max = 0;
  for (const b of bookmarks) {
    const num = parseInt(b.id.replace("starling_", ""), 10);
    if (!isNaN(num) && num > max) max = num;
  }
  return `starling_${String(max + 1).padStart(4, "0")}`;
}
function generateSpaceId(spaces) {
  let max = 0;
  for (const s of spaces) {
    const normalizedId = s.id.replace(/^cat_/, "").replace(/^space_/, "");
    const num = parseInt(normalizedId, 10);
    if (!isNaN(num) && num > max) max = num;
  }
  return `cat_${String(max + 1).padStart(4, "0")}`;
}
function generateNoteId() {
  return `note_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// src/lib/store.ts
function storePath() {
  const env = process.env[ENV_CONFIG_KEY];
  return env ?? DEFAULT_STORE_PATH;
}
function loadStore() {
  const path = storePath();
  const data = readJSON(path);
  if (!data) {
    const now = (/* @__PURE__ */ new Date()).toISOString();
    return {
      version: STORE_VERSION,
      bookmarks: [],
      spaces: [
        { id: "cat_0001", name: "claude", description: "Claude Code sessions", tags: [], parent_id: null, created_at: now, updated_at: now },
        { id: "cat_0002", name: "codex", description: "Codex sessions", tags: [], parent_id: null, created_at: now, updated_at: now }
      ],
      categories: []
    };
  }
  let migrated = false;
  const legacyIdMap = /* @__PURE__ */ new Map();
  const usedCatalogIds = new Set(data.spaces.map((space) => space.id).filter((id) => id.startsWith("cat_")));
  let nextId = 1;
  const nextCatalogId = () => {
    while (usedCatalogIds.has(`cat_${String(nextId).padStart(4, "0")}`)) {
      nextId += 1;
    }
    const id = `cat_${String(nextId).padStart(4, "0")}`;
    usedCatalogIds.add(id);
    nextId += 1;
    return id;
  };
  for (const space of data.spaces) {
    if (space.id.startsWith("space_")) {
      const newId = nextCatalogId();
      legacyIdMap.set(space.id, newId);
      space.id = newId;
      migrated = true;
    }
  }
  if (migrated) {
    for (const bookmark of data.bookmarks) {
      bookmark.space_ids = bookmark.space_ids.map((sid) => legacyIdMap.get(sid) ?? sid);
    }
    for (const space of data.spaces) {
      if (space.parent_id && legacyIdMap.has(space.parent_id)) {
        space.parent_id = legacyIdMap.get(space.parent_id);
      }
    }
  }
  if (!data.spaces.some((s) => s.name === "claude")) {
    const now = (/* @__PURE__ */ new Date()).toISOString();
    data.spaces.push({ id: generateSpaceId(data.spaces), name: "claude", description: "Claude Code sessions", tags: [], parent_id: null, created_at: now, updated_at: now });
    migrated = true;
  }
  if (!data.spaces.some((s) => s.name === "codex")) {
    const now = (/* @__PURE__ */ new Date()).toISOString();
    data.spaces.push({ id: generateSpaceId(data.spaces), name: "codex", description: "Codex sessions", tags: [], parent_id: null, created_at: now, updated_at: now });
    migrated = true;
  }
  if (migrated) {
    saveStore(data);
  }
  return data;
}
function saveStore(store) {
  atomicWriteJSON(storePath(), store);
}
function addBookmark(bookmark) {
  const store = loadStore();
  store.bookmarks.push(bookmark);
  if (bookmark.category && !store.categories.includes(bookmark.category)) {
    store.categories.push(bookmark.category);
  }
  saveStore(store);
  return bookmark;
}
function findBookmark(id) {
  return loadStore().bookmarks.find((b) => b.id === id || b.session_id === id);
}
function updateBookmark(id, patch) {
  const store = loadStore();
  const idx = store.bookmarks.findIndex((b) => b.id === id || b.session_id === id);
  if (idx === -1) return null;
  store.bookmarks[idx] = { ...store.bookmarks[idx], ...patch, updated_at: (/* @__PURE__ */ new Date()).toISOString() };
  if (patch.category && !store.categories.includes(patch.category)) {
    store.categories.push(patch.category);
  }
  saveStore(store);
  return store.bookmarks[idx];
}
function removeBookmark(id) {
  const store = loadStore();
  const idx = store.bookmarks.findIndex((b) => b.id === id || b.session_id === id);
  if (idx === -1) return false;
  store.bookmarks.splice(idx, 1);
  saveStore(store);
  return true;
}
function listBookmarks(filter) {
  const store = loadStore();
  let result = store.bookmarks;
  if (filter?.category) {
    result = result.filter((b) => b.category === filter.category);
  }
  if (filter?.tag) {
    result = result.filter((b) => b.tags.includes(filter.tag));
  }
  return result;
}
function addSpace(space) {
  const store = loadStore();
  store.spaces.push(space);
  saveStore(store);
  return space;
}
function findSpaceCandidates(idNameOrPath) {
  const store = loadStore();
  const exactId = store.spaces.find((space) => space.id === idNameOrPath);
  if (exactId) return [exactId];
  if (idNameOrPath.includes("/")) {
    return findSpacePathCandidates(idNameOrPath, store.spaces);
  }
  return store.spaces.filter((space) => space.name === idNameOrPath);
}
function findSpacePathCandidates(pathRef, spaces) {
  const parts = pathRef.split("/").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return [];
  let candidates = spaces.filter((space) => space.name === parts[0] && space.parent_id === null);
  for (const part of parts.slice(1)) {
    const parentIds = new Set(candidates.map((space) => space.id));
    candidates = spaces.filter((space) => space.name === part && space.parent_id !== null && parentIds.has(space.parent_id));
    if (candidates.length === 0) return [];
  }
  return candidates;
}
function hasSiblingSpaceName(name, parentId, excludeId) {
  return loadStore().spaces.some(
    (space) => space.name === name && space.parent_id === parentId && space.id !== excludeId
  );
}
function updateSpace(id, patch) {
  const store = loadStore();
  const idx = store.spaces.findIndex((s) => s.id === id || s.name === id);
  if (idx === -1) return null;
  store.spaces[idx] = { ...store.spaces[idx], ...patch, updated_at: (/* @__PURE__ */ new Date()).toISOString() };
  saveStore(store);
  return store.spaces[idx];
}
function removeSpace(id) {
  const store = loadStore();
  const idx = store.spaces.findIndex((s) => s.id === id || s.name === id);
  if (idx === -1) return false;
  const space = store.spaces[idx];
  const idsToRemove = /* @__PURE__ */ new Set([space.id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const candidate of store.spaces) {
      if (candidate.parent_id && idsToRemove.has(candidate.parent_id) && !idsToRemove.has(candidate.id)) {
        idsToRemove.add(candidate.id);
        changed = true;
      }
    }
  }
  for (const b of store.bookmarks) {
    b.space_ids = b.space_ids.filter((sid) => !idsToRemove.has(sid));
  }
  store.spaces = store.spaces.filter((s) => !idsToRemove.has(s.id));
  saveStore(store);
  return true;
}
function listSpaces() {
  return loadStore().spaces;
}

// src/lib/catalogResolver.ts
function resolveCatalogReference(ref) {
  const matches = findSpaceCandidates(ref);
  if (matches.length === 1) {
    return { kind: "found", space: matches[0] };
  }
  if (matches.length === 0) {
    return { kind: "not_found" };
  }
  return { kind: "ambiguous", matches };
}
function catalogPath(space, spaces = listSpaces()) {
  const parts = [space.name];
  let current = space;
  const seen = /* @__PURE__ */ new Set();
  while (current.parent_id && !seen.has(current.parent_id)) {
    seen.add(current.parent_id);
    const parent = spaces.find((candidate) => candidate.id === current.parent_id);
    if (!parent) break;
    parts.unshift(parent.name);
    current = parent;
  }
  return parts.join("/");
}

// src/lib/sessionIndex.ts
import { existsSync as existsSync3, readFileSync as readFileSync3, readdirSync as readdirSync2, statSync as statSync2, unlinkSync as unlinkSync2 } from "fs";
import { dirname as dirname2, join as join4 } from "path";
var SESSION_INDEX_PATH = join4(DEFAULT_STARLING_HOME, "session-index.json");
async function rebuildSessionIndex(provider) {
  const sessions = [];
  for await (const session of streamSessions(provider, Infinity)) {
    sessions.push(session);
  }
  return writeSessionIndex(sessions, collectSessionDirectoryEntries(provider));
}
function loadSessionIndex() {
  if (!existsSync3(SESSION_INDEX_PATH)) return null;
  try {
    const parsed = JSON.parse(readFileSync3(SESSION_INDEX_PATH, "utf-8"));
    if (!isRecord2(parsed)) return null;
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
      const stat = statSync2(session.file_path);
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
  if (!existsSync3(SESSION_INDEX_PATH)) return false;
  unlinkSync2(SESSION_INDEX_PATH);
  return true;
}
function upsertSessionInIndex(session) {
  const index = loadSessionIndex();
  if (!index) return false;
  const sessions = [...index.sessions];
  upsertSession(sessions, session);
  writeSessionIndex(sessions, index.directories ?? []);
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
      const stat = statSync2(root);
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
function isRecord2(value) {
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
      const stat = statSync2(session.file_path);
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
    stat = statSync2(dir);
  } catch {
    return;
  }
  if (!stat.isDirectory()) return;
  directories.push({ provider, path: dir, mtimeMs: stat.mtimeMs });
  let entries;
  try {
    entries = readdirSync2(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === "subagents") continue;
    const full = join4(dir, entry);
    try {
      const childStat = statSync2(full);
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
    const parent = dirname2(entry.path);
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
    dirStat = statSync2(dir);
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
    entries = readdirSync2(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === "subagents") continue;
    const full = join4(dir, entry);
    try {
      const stat = statSync2(full);
      if (stat.isDirectory()) {
        collectNewSessionFileEntriesInDir(provider, full, previousDirMtimes, previousChildDirs, indexedPaths, files, directories);
      } else if (directoryChanged && entry.endsWith(".jsonl") && !indexedPaths.has(full)) {
        files.push({ provider, path: full, mtimeMs: stat.mtimeMs });
      }
    } catch {
    }
  }
}

// src/commands/session.ts
function formatSessionLine(s) {
  const agent = s.provider === "codex" ? "codex" : "claude";
  const shortId = shortSessionId(s.session_id);
  const shortProject = s.project_path ? s.project_path.length > 40 ? "\u2026" + s.project_path.slice(-39) : s.project_path : "-";
  const date = s.modified_at.slice(0, 16).replace("T", " ");
  const inputTokens = s.token_usage?.input_tokens ?? "-";
  const outputTokens = s.token_usage?.output_tokens ?? "-";
  const totalTokens = s.token_usage?.total_tokens ?? "-";
  const cacheTokens = s.token_usage?.cache_tokens ?? "-";
  return `${chalk2.cyan(shortId.padEnd(15))}  ${chalk2.gray(agent.padEnd(7))}  ${(s.model || "-").padEnd(18)}  ${shortProject.padEnd(42)}  ${chalk2.gray(date)}  ${chalk2.yellow(String(inputTokens)).padEnd(10)} ${chalk2.yellow(String(outputTokens)).padEnd(10)} ${chalk2.yellow(String(totalTokens)).padEnd(10)} ${chalk2.yellow(String(cacheTokens)).padEnd(10)}`;
}
function registerSessionCommand(program2) {
  const session = new Command("session").description("Discover and manage agent sessions");
  session.command("list").alias("ls").description("List recent agent sessions").option("-n, --limit <number>", "max sessions to show", "20").option("-a, --agent <agent>", "filter by agent: claude | codex").option("--cataloged", "only show sessions assigned to any catalog").option("-c, --catalog <catalog>", "only show sessions assigned to a catalog").option("--all", "list all sessions (streaming with pager)").option("--json", "output as JSON").action(async (opts) => {
    const provider = opts.agent;
    const hasCatalogFilter = Boolean(opts.cataloged || opts.catalog);
    if (opts.all) {
      const filteredSessions = hasCatalogFilter ? await findCatalogSessions(opts.cataloged, opts.catalog, provider) : await collectStreamedSessions(provider);
      if (opts.json) {
        console.log(JSON.stringify(filteredSessions, null, 2));
        return;
      }
      const header = `${"SESSION".padEnd(15)}  ${"AGENT".padEnd(7)}  ${"MODEL".padEnd(18)}  ${"PROJECT".padEnd(42)}  MODIFIED  ${"INPUT".padEnd(10)} ${"OUTPUT".padEnd(10)} ${"TOTAL".padEnd(10)} ${"CACHE".padEnd(10)}
${"\u2500".repeat(145)}`;
      const usePager = process.stdout.isTTY;
      const pager = usePager ? spawn("less", ["-RFX"], { stdio: ["pipe", "inherit", "inherit"] }) : null;
      let pipeBroken = false;
      if (pager) {
        pager.stdin.on("error", () => {
          pipeBroken = true;
        });
        pager.on("close", () => {
          pipeBroken = true;
        });
      }
      const out = (line) => {
        if (pipeBroken) return;
        if (pager) {
          pager.stdin.write(line + "\n");
        } else {
          console.log(line);
        }
      };
      out(header);
      let count = 0;
      for (const meta of filteredSessions) {
        if (pipeBroken) break;
        out(formatSessionLine(meta));
        count++;
      }
      if (!pipeBroken) out(chalk2.gray(`
Total: ${count} sessions`));
      if (pager && !pipeBroken) {
        pager.stdin.end();
        await new Promise((resolve4) => pager.on("close", () => resolve4()));
      }
      return;
    }
    const limit = parseInt(opts.limit, 10) || 20;
    const catalogSessions = hasCatalogFilter ? await findCatalogSessions(opts.cataloged, opts.catalog, provider) : null;
    const sessions = catalogSessions ? catalogSessions.slice(0, limit) : await findSessions(limit, provider);
    if (sessions.length === 0) {
      console.log(chalk2.yellow("No sessions found."));
      return;
    }
    const total = catalogSessions ? catalogSessions.length : indexedSessionTotal(provider);
    const truncatedHint = formatTruncationHint(sessions.length, total, limit);
    if (opts.json) {
      console.log(JSON.stringify(sessions, null, 2));
      if (truncatedHint) process.stderr.write(chalk2.gray(truncatedHint + "\n"));
      return;
    }
    console.log(formatSessionTable(sessions));
    if (truncatedHint) console.log(chalk2.gray(truncatedHint));
  });
  const index = new Command("index").description("Manage the local session index");
  index.command("status").description("Show session index status").option("--json", "output as JSON").action((opts) => {
    const current = loadSessionIndex();
    const payload = current ? {
      path: SESSION_INDEX_PATH,
      exists: true,
      built_at: current.built_at,
      session_count: current.session_count,
      project_count: current.project_count
    } : {
      path: SESSION_INDEX_PATH,
      exists: false
    };
    if (opts.json) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }
    if (!current) {
      console.log(chalk2.yellow("No session index found."));
      console.log(chalk2.gray(`  Path: ${SESSION_INDEX_PATH}`));
      return;
    }
    console.log(chalk2.green("Session index"));
    console.log(`  Path:     ${SESSION_INDEX_PATH}`);
    console.log(`  Built:    ${current.built_at}`);
    console.log(`  Sessions: ${current.session_count}`);
    console.log(`  Projects: ${current.project_count}`);
  });
  index.command("rebuild").description("Rebuild ~/.starling/session-index.json").option("-a, --agent <agent>", "filter by agent: claude | codex").option("--json", "output as JSON").action(async (opts) => {
    const provider = opts.agent;
    const rebuilt = await rebuildSessionIndex(provider);
    if (opts.json) {
      console.log(JSON.stringify({ path: SESSION_INDEX_PATH, ...rebuilt }, null, 2));
      return;
    }
    console.log(chalk2.green("Rebuilt session index"));
    console.log(`  Path:     ${SESSION_INDEX_PATH}`);
    console.log(`  Sessions: ${rebuilt.session_count}`);
    console.log(`  Projects: ${rebuilt.project_count}`);
  });
  index.command("clear").description("Remove ~/.starling/session-index.json").action(() => {
    const removed = clearSessionIndex();
    console.log(removed ? chalk2.green("Session index removed.") : chalk2.yellow("No session index found."));
  });
  session.addCommand(index);
  session.command("show <session-id>").description("Show session details").option("--json", "output as JSON").action(async (sessionId, opts) => {
    const meta = await resolveSessionById(sessionId);
    if (!meta) {
      console.error(chalk2.red(`Session not found: ${sessionId}`));
      process.exit(1);
    }
    const catalogs = findSessionCatalogs(meta.session_id);
    const metadata = findSessionBookmark(meta.session_id);
    if (opts.json) {
      console.log(JSON.stringify({ ...meta, catalogs, metadata: metadata ?? null }, null, 2));
      return;
    }
    console.log(chalk2.bold.cyan(`Session: ${meta.session_id}`));
    console.log(`  Provider:    ${meta.provider}`);
    console.log(`  Model:       ${meta.model || "-"}`);
    console.log(`  Project:     ${meta.project_path || "-"}`);
    console.log(`  File:        ${meta.file_path}`);
    console.log(`  Modified:    ${meta.modified_at}`);
    console.log(`  Catalogs:    ${catalogs.length > 0 ? catalogs.map((catalog2) => `${catalog2.name} (${catalog2.id})`).join(", ") : "-"}`);
    if (metadata) {
      console.log(`  Title:       ${metadata.title || "-"}`);
      console.log(`  Tags:        ${metadata.tags.join(", ") || "-"}`);
      if (metadata.notes.length > 0) {
        console.log("  Notes:");
        for (const note of metadata.notes) {
          console.log(`    ${note.id}: ${note.content}`);
        }
      }
    }
    const tokenUsage = meta.token_usage;
    if (tokenUsage) {
      console.log("  Token Usage:");
      console.log(`    Input:   ${tokenUsage.input_tokens ?? "-"}`);
      console.log(`    Output:  ${tokenUsage.output_tokens ?? "-"}`);
      console.log(`    Total:   ${tokenUsage.total_tokens ?? "-"}`);
      console.log(`    Cache:   ${tokenUsage.cache_tokens ?? "-"}`);
    }
    if (meta.first_prompt) {
      console.log(`  First Prompt:`);
      console.log(`    ${meta.first_prompt}`);
    }
  });
  session.command("lookup <session-ids...>").description("Look up many sessions by id in one pass (read-only)").option("-a, --agent <agent>", "filter by agent: claude | codex").option("--json", "output as JSON").action(async (sessionIds, opts) => {
    const provider = opts.agent;
    const found = await lookupIndexedSessions(sessionIds, provider);
    const sessions = [...found.values()].sort((a, b) => b.modified_at.localeCompare(a.modified_at));
    const requested = sessionIds.length;
    const resolved = sessions.length;
    if (opts.json) {
      console.log(JSON.stringify(sessions, null, 2));
      if (resolved < requested) {
        process.stderr.write(chalk2.gray(`Resolved ${resolved}/${requested} sessions.
`));
      }
      return;
    }
    if (sessions.length === 0) {
      console.log(chalk2.yellow(`No sessions found for ${requested} id(s).`));
      return;
    }
    console.log(formatSessionTable(sessions));
    if (resolved < requested) {
      console.log(chalk2.gray(`Resolved ${resolved}/${requested} sessions.`));
    }
  });
  session.command("resume <session-id>").description("Resume an agent session").action(async (sessionId) => {
    await resumeSession(sessionId);
  });
  session.command("meta <session-id>").description("Create or update session metadata").option("-t, --title <title>", "session title").option("--tags <tags>", "comma-separated tags (replaces existing)").option("--add-tags <tags>", "add tags (appends)").action(async (sessionId, opts) => {
    const meta = await resolveSessionMeta(sessionId);
    const bookmark = ensureSessionBookmark(meta);
    const patch = {};
    if (opts.title !== void 0) patch.title = opts.title;
    if (opts.tags !== void 0) patch.tags = parseTags(opts.tags);
    if (opts.addTags !== void 0) {
      patch.tags = [.../* @__PURE__ */ new Set([...bookmark.tags, ...parseTags(opts.addTags)])];
    }
    if (Object.keys(patch).length === 0) {
      console.log(chalk2.yellow(`No metadata changes provided for ${bookmark.id}.`));
      return;
    }
    const updated = updateBookmark(bookmark.id, patch);
    console.log(chalk2.green(`Updated session metadata: ${updated?.id ?? bookmark.id}`));
  });
  session.command("note <session-id> <content...>").description("Add a note to a session").action(async (sessionId, contentParts) => {
    const content = contentParts.join(" ").trim();
    if (!content) {
      console.error(chalk2.red("Note content is required."));
      process.exit(1);
    }
    const meta = await resolveSessionMeta(sessionId);
    const bookmark = ensureSessionBookmark(meta);
    const note = { id: generateNoteId(), content, created_at: (/* @__PURE__ */ new Date()).toISOString() };
    const notes = [...bookmark.notes, note];
    updateBookmark(bookmark.id, { notes });
    console.log(chalk2.green(`Note added to ${bookmark.id}: ${note.id}`));
  });
  session.command("unpin <session-id>").description("Remove Starling metadata for a session without deleting the session file").action((sessionId) => {
    const bookmark = findSessionBookmark(sessionId);
    if (!bookmark) {
      console.log(chalk2.yellow(`Session metadata not found: ${sessionId}`));
      return;
    }
    removeBookmark(bookmark.id);
    console.log(chalk2.green(`Removed pin metadata for ${shortSessionId(bookmark.session_id)}`));
  });
  session.command("delete <session-id>").description("Delete a session file and remove Starling metadata").option("-y, --yes", "confirm deletion").action(async (sessionId, opts) => {
    if (!opts.yes) {
      console.error(chalk2.red("Deleting a session file requires --yes."));
      process.exit(1);
    }
    const meta = await resolveSessionMeta(sessionId);
    if (!meta.file_path) {
      console.error(chalk2.red(`Session file path is unknown: ${meta.session_id}`));
      process.exit(1);
    }
    if (!existsSync4(meta.file_path)) {
      console.error(chalk2.red(`Session file not found: ${meta.file_path}`));
      process.exit(1);
    }
    unlinkSync3(meta.file_path);
    const bookmark = findSessionBookmark(meta.session_id);
    if (bookmark) {
      removeBookmark(bookmark.id);
    }
    removeSessionFromIndex(meta.session_id);
    console.log(chalk2.green(`Deleted session ${shortSessionId(meta.session_id)}`));
    console.log(chalk2.gray(`  File: ${meta.file_path}`));
    if (bookmark) {
      console.log(chalk2.gray(`  Removed pin: ${bookmark.id}`));
    }
  });
  const catalog = new Command("catalog").description("Manage session catalog assignments");
  catalog.command("add <session-id> <catalog>").description("Add a session to a catalog").option("-t, --title <title>", "pin title when creating a new pin").option("--tags <tags>", "comma-separated tags when creating a new pin").action(async (sessionId, catalog2, opts) => {
    const catalogEntry = resolveCatalog(catalog2);
    const meta = await resolveSessionMeta(sessionId);
    const bookmark = ensureSessionBookmark(meta, {
      title: opts.title,
      tags: opts.tags ? parseTags(opts.tags) : void 0
    });
    if (bookmark.space_ids.includes(catalogEntry.id)) {
      console.log(chalk2.yellow(`Session already in catalog "${catalogEntry.name}".`));
      return;
    }
    updateBookmark(bookmark.id, { space_ids: [...bookmark.space_ids, catalogEntry.id] });
    console.log(chalk2.green(`Added session ${shortSessionId(bookmark.session_id)} to catalog "${catalogEntry.name}"`));
  });
  catalog.command("remove <session-id> <catalog>").alias("rm").description("Remove a session from a catalog").action((sessionId, catalog2) => {
    const catalogEntry = resolveCatalog(catalog2);
    const bookmark = findSessionBookmark(sessionId);
    if (!bookmark) {
      console.error(chalk2.red(`Session metadata not found: ${sessionId}`));
      process.exit(1);
    }
    if (!bookmark.space_ids.includes(catalogEntry.id)) {
      console.log(chalk2.yellow(`Session is not in catalog "${catalogEntry.name}".`));
      return;
    }
    updateBookmark(bookmark.id, {
      space_ids: bookmark.space_ids.filter((catalogId) => catalogId !== catalogEntry.id)
    });
    console.log(chalk2.green(`Removed session ${shortSessionId(bookmark.session_id)} from catalog "${catalogEntry.name}"`));
  });
  catalog.command("clear <session-id>").description("Remove a session from all catalogs").action((sessionId) => {
    const bookmark = findSessionBookmark(sessionId);
    if (!bookmark) {
      console.error(chalk2.red(`Session metadata not found: ${sessionId}`));
      process.exit(1);
    }
    updateBookmark(bookmark.id, { space_ids: [] });
    console.log(chalk2.green(`Removed session ${shortSessionId(bookmark.session_id)} from all catalogs`));
  });
  session.addCommand(catalog);
  program2.addCommand(session);
}
function findSessionCatalogs(sessionId) {
  const bookmark = findSessionBookmark(sessionId);
  if (!bookmark) return [];
  const spaces = listSpaces();
  return bookmark.space_ids.map((catalogId) => {
    const catalog = spaces.find((space) => space.id === catalogId);
    return {
      id: catalogId,
      name: catalog?.name ?? catalogId
    };
  });
}
async function collectStreamedSessions(provider) {
  const sessions = [];
  for await (const meta of streamSessions(provider)) {
    sessions.push(meta);
  }
  return sessions;
}
function indexedSessionTotal(provider) {
  const index = loadSessionIndex();
  if (!index) return -1;
  if (!provider) return index.session_count;
  return index.sessions.filter((session) => session.provider === provider).length;
}
function formatTruncationHint(shown, total, limit) {
  if (total >= 0) {
    if (total <= shown) return "";
    return `Showing ${shown} of ${total} sessions. Use --all to list all.`;
  }
  if (shown < limit) return "";
  return `Showing ${shown} sessions. Use --all to list all.`;
}
async function findCatalogSessions(cataloged, catalogRef, provider) {
  const sessionIds = getCatalogSessionIds(cataloged, catalogRef);
  const wantedIds = new Set(sessionIds.map((sessionId) => sessionId.toLowerCase()));
  const index = await refreshIndexedSessionsById(sessionIds, provider);
  const sessions = index.sessions.filter((session) => {
    if (provider && session.provider !== provider) return false;
    return matchesCatalogSessionId(wantedIds, session.session_id);
  });
  sessions.sort((a, b) => b.modified_at.localeCompare(a.modified_at));
  return sessions;
}
function matchesCatalogSessionId(wantedIds, sessionId) {
  const normalizedSessionId = sessionId.toLowerCase();
  if (wantedIds.has(normalizedSessionId)) return true;
  for (const wantedId of wantedIds) {
    if (wantedId && normalizedSessionId.startsWith(wantedId)) return true;
  }
  return false;
}
function getCatalogSessionIds(cataloged, catalogRef) {
  const bookmarks = listBookmarks();
  if (catalogRef) {
    const catalog = resolveCatalog(catalogRef);
    return unique(
      bookmarks.filter((bookmark) => bookmark.space_ids.includes(catalog.id)).map((bookmark) => bookmark.session_id)
    );
  }
  if (cataloged) {
    return unique(
      bookmarks.filter((bookmark) => bookmark.space_ids.length > 0).map((bookmark) => bookmark.session_id)
    );
  }
  return [];
}
function unique(values) {
  return [...new Set(values)];
}
function findSessionBookmark(sessionId) {
  return listBookmarks().find((entry) => entry.session_id === sessionId);
}
function resolveCatalog(catalogRef) {
  const resolution = resolveCatalogReference(catalogRef);
  if (resolution.kind === "found") {
    return { id: resolution.space.id, name: resolution.space.name };
  }
  if (resolution.kind === "not_found") {
    console.error(chalk2.red(`Catalog not found: ${catalogRef}`));
    process.exit(1);
  }
  console.error(chalk2.red(`Ambiguous catalog reference: ${catalogRef}`));
  console.error(chalk2.red("Use a catalog path like parent/child or the catalog id."));
  for (const match of resolution.matches) {
    console.error(chalk2.gray(`  ${catalogPath(match, listSpaces())} (${match.id})`));
  }
  process.exit(1);
}
function parseTags(value) {
  return value.split(",").map((tag) => tag.trim()).filter(Boolean);
}
async function resolveSessionMeta(input) {
  const inputLooksLikeSessionId = looksLikeSessionIdQuery(input);
  if (inputLooksLikeSessionId) {
    const indexedCandidates = await findIndexedSessionCandidates(input);
    if (indexedCandidates.length > 0) return pickSessionCandidate(input, indexedCandidates);
    console.error(chalk2.red(`No session matches: ${input}`));
    process.exit(1);
  }
  const candidates = await findSessionCandidates(input);
  if (candidates.length === 0) {
    console.error(chalk2.red(`No session matches: ${input}`));
    process.exit(1);
  }
  return pickSessionCandidate(input, candidates);
}
async function resolveSessionById(input) {
  if (!looksLikeSessionIdQuery(input)) return null;
  const found = await lookupIndexedSessions([input]);
  const values = [...found.values()];
  return values.find((session) => session.session_id === input) ?? values[0] ?? null;
}
function pickSessionCandidate(input, candidates) {
  if (candidates.length === 1) return candidates[0];
  const exact = candidates.find((candidate) => candidate.session_id === input);
  if (exact) return exact;
  console.error(chalk2.red(`Ambiguous session id: ${input}`));
  console.error(chalk2.red("Please rerun with full session id."));
  process.exit(1);
}
function ensureSessionBookmark(meta, defaults = {}) {
  const existing = findSessionBookmark(meta.session_id);
  if (existing) return existing;
  const now = (/* @__PURE__ */ new Date()).toISOString();
  return addBookmark({
    id: generateBookmarkId(listBookmarks()),
    provider: meta.provider || "unknown",
    session_id: meta.session_id,
    title: defaults.title ?? meta.first_prompt?.slice(0, 60) ?? meta.session_id.slice(0, 16),
    category: "",
    tags: defaults.tags ?? [],
    project_path: meta.project_path ?? "",
    first_prompt: meta.first_prompt ?? "",
    notes: [],
    space_ids: [],
    created_at: now,
    updated_at: now
  });
}
async function resumeSession(sessionId) {
  const meta = await resolveSessionById(sessionId);
  if (!meta) {
    console.error(chalk2.red(`Session not found: ${sessionId}`));
    process.exit(1);
  }
  const cwd = meta.project_path || void 0;
  if (meta.provider === "claude") {
    console.log(chalk2.green(`Resuming claude session: ${shortSessionId(meta.session_id)}\u2026`));
    if (cwd) console.log(chalk2.gray(`  Project: ${cwd}`));
    const result = spawnSync("claude", ["--resume", meta.session_id], { stdio: "inherit", cwd });
    if (result.status !== 0) {
      process.exit(1);
    }
  } else if (meta.provider === "codex") {
    console.log(chalk2.green(`Resuming codex session: ${shortSessionId(meta.session_id)}\u2026`));
    if (cwd) console.log(chalk2.gray(`  Project: ${cwd}`));
    const result = spawnSync("codex", ["resume", meta.session_id], { stdio: "inherit", cwd });
    if (result.status !== 0) {
      process.exit(1);
    }
  } else {
    console.error(chalk2.red(`Unknown provider: ${meta.provider}`));
    process.exit(1);
  }
}

// src/commands/pin.ts
import { Command as Command2 } from "commander";
import chalk3 from "chalk";
import { createInterface as createInterface2 } from "readline/promises";
import { stdin, stdout } from "process";
function registerPinCommand(program2) {
  const pin = new Command2("pin").description("Pin and annotate agent sessions").argument("[session-id]", "session ID to pin").option("-t, --title <title>", "pin title").option("--tags <tags>", "comma-separated tags").option("--to <catalog>", "add pin to a catalog").option("--current", "pin the most recent session").action(async (sessionId, opts) => {
    if (!sessionId && !opts.current) {
      pin.help();
      return;
    }
    let targetSessionId = sessionId;
    if (opts.current && !targetSessionId) {
      const sessions = await findSessions(1);
      if (sessions.length === 0) {
        console.error(chalk3.red("No sessions found."));
        process.exit(1);
      }
      targetSessionId = sessions[0].session_id;
    }
    if (!targetSessionId) {
      console.error(chalk3.red("Please provide a session-id or use --current"));
      process.exit(1);
    }
    const { sessionId: resolvedSessionId, meta: existingMeta } = await resolveSessionOrSelect(targetSessionId);
    const meta = existingMeta;
    let resolvedCatalog;
    const existing = findBookmark(resolvedSessionId);
    if (existing) {
      if (opts.to) {
        const space = resolveCatalogRef(opts.to);
        if (!existing.space_ids.includes(space.id)) {
          existing.space_ids.push(space.id);
          updateBookmark(existing.id, { space_ids: existing.space_ids });
          console.log(chalk3.green(`Added ${existing.id} to catalog "${space.name}" (${space.id})`));
        } else {
          console.log(chalk3.yellow(`Already in catalog "${space.name}".`));
        }
        return;
      }
      console.log(chalk3.yellow(`Already pinned as: ${existing.id}`));
      return;
    }
    const now = (/* @__PURE__ */ new Date()).toISOString();
    let spaceIds = [];
    if (opts.to) {
      const space = resolveCatalogRef(opts.to);
      spaceIds = [space.id];
      resolvedCatalog = { id: space.id, name: space.name };
    }
    const bookmark = {
      id: generateBookmarkId(listBookmarks()),
      provider: meta?.provider ?? "unknown",
      session_id: resolvedSessionId,
      title: opts.title ?? meta?.first_prompt?.slice(0, 60) ?? resolvedSessionId.slice(0, 16),
      category: "",
      tags: opts.tags ? opts.tags.split(",").map((t) => t.trim()) : [],
      project_path: meta?.project_path ?? "",
      first_prompt: meta?.first_prompt ?? "",
      notes: [],
      space_ids: spaceIds,
      created_at: now,
      updated_at: now
    };
    addBookmark(bookmark);
    console.log(chalk3.green(`Pinned: ${bookmark.id}`));
    console.log(`  Title:    ${bookmark.title}`);
    console.log(`  Tags:     ${bookmark.tags.join(", ") || "(none)"}`);
    if (spaceIds.length > 0) {
      console.log(
        `  Catalog:  ${resolvedCatalog?.name ?? "Unknown"} (${resolvedCatalog?.id ?? opts.to})`
      );
    }
  });
  program2.addCommand(pin);
}
function resolveCatalogRef(ref) {
  const resolution = resolveCatalogReference(ref);
  if (resolution.kind === "found") return resolution.space;
  if (resolution.kind === "not_found") {
    console.error(chalk3.red(`Catalog not found: ${ref}`));
    process.exit(1);
  }
  console.error(chalk3.red(`Ambiguous catalog reference: ${ref}`));
  console.error(chalk3.red("Use a catalog path like parent/child or the catalog id."));
  for (const match of resolution.matches) {
    console.error(chalk3.gray(`  ${catalogPath(match, listSpaces())} (${match.id})`));
  }
  process.exit(1);
}
async function resolveSessionOrSelect(input) {
  const candidates = await findSessionCandidates(input);
  if (candidates.length === 0) {
    console.error(chalk3.red(`No session matches: ${input}`));
    process.exit(1);
  }
  if (candidates.length === 1) {
    return { sessionId: candidates[0].session_id, meta: candidates[0] };
  }
  if (!stdin.isTTY) {
    console.error(chalk3.red(`Ambiguous session id: ${input}`));
    console.error(chalk3.red("Please rerun with full session id."));
    process.exit(1);
  }
  console.log(chalk3.yellow(`
Found ${candidates.length} sessions for "${input}":`));
  candidates.forEach((candidate, index) => {
    const shortId = shortSessionId(candidate.session_id);
    const date = candidate.modified_at.slice(0, 16).replace("T", " ");
    const project = candidate.project_path ? candidate.project_path.length > 35 ? "\u2026" + candidate.project_path.slice(-34) : candidate.project_path : "-";
    const model = candidate.model || "-";
    const provider = candidate.provider === "codex" ? "codex" : "claude";
    console.log(
      `  ${index + 1}. ${chalk3.cyan(shortId.padEnd(15))}  ${chalk3.gray(provider.padEnd(7))}  ${model.padEnd(18)}  ${chalk3.gray(project.padEnd(38))}  ${chalk3.gray(date)}`
    );
  });
  const rl = createInterface2({ input: stdin, output: stdout });
  const answer = await rl.question("Select one by number: ");
  rl.close();
  const choice = Number(answer.trim());
  if (!Number.isInteger(choice) || choice < 1 || choice > candidates.length) {
    console.error(chalk3.red(`Invalid selection: ${answer.trim() || "(empty)"}`));
    process.exit(1);
  }
  return { sessionId: candidates[choice - 1].session_id, meta: candidates[choice - 1] };
}

// src/commands/space.ts
import { Command as Command3 } from "commander";
import chalk4 from "chalk";
import Table2 from "cli-table3";
function registerSpaceCommand(program2) {
  const space = new Command3("catalog").alias("cat").description("Organize sessions into catalogs with hierarchical nesting");
  space.command("create <name>").description("Create a new catalog").option("-d, --description <desc>", "catalog description").option("--tags <tags>", "comma-separated tags").option("-p, --parent <parent>", "parent catalog name, path, or id").action((name, opts) => {
    let parentId = null;
    if (opts.parent) {
      const parent = resolveCatalogRef2(opts.parent);
      parentId = parent.id;
    }
    const isPathCreate = name.split("/").map((part) => part.trim()).filter(Boolean).length > 1;
    const created = createCatalogPath(name, parentId, {
      description: opts.description,
      tags: opts.tags ? opts.tags.split(",").map((t) => t.trim()).filter(Boolean) : [],
      allowExistingLeaf: isPathCreate
    });
    console.log(chalk4.green(`Created catalog: ${created.id} "${catalogPath(created)}"`));
    console.log(chalk4.gray(`  Parent: ${created.parent_id ?? "-"}`));
  });
  space.command("list").alias("ls").description("List all catalogs (flat)").option("--pins", "show pins in each catalog").option("--json", "output as JSON").action((opts) => {
    const spaces = listSpaces();
    if (spaces.length === 0) {
      console.log(chalk4.yellow("No catalogs created yet."));
      return;
    }
    const allBookmarks = listBookmarks();
    const rows = spaces.map((s) => {
      const pins = allBookmarks.filter((b) => b.space_ids.includes(s.id));
      const sessionCount = new Set(pins.map((b) => b.session_id)).size;
      const parentCatalog = s.parent_id ? spaces.find((candidate) => candidate.id === s.parent_id) : void 0;
      const parent = parentCatalog ? parentCatalog.name : s.parent_id ?? "-";
      return {
        space: s,
        id: s.id,
        name: s.name,
        sessions: sessionCount,
        pins: pins.length,
        parent,
        description: s.description || "-"
      };
    });
    if (opts.json) {
      const output = rows.map((row) => {
        if (opts.pins) {
          const pins = allBookmarks.filter((b) => b.space_ids.includes(row.id));
          return { ...row.space, session_count: row.sessions, pin_count: row.pins, pins };
        }
        return { ...row.space, session_count: row.sessions, pin_count: row.pins };
      });
      console.log(JSON.stringify(output, null, 2));
      return;
    }
    const table = new Table2({
      head: [
        chalk4.green("Catalog ID"),
        chalk4.green("Name"),
        chalk4.green("Sessions"),
        chalk4.green("Pins"),
        chalk4.green("Parent"),
        chalk4.green("Description")
      ],
      colWidths: [12, 20, 10, 10, 20, 34],
      style: { head: [] }
    });
    const truncate2 = (value, max) => value.length > max ? value.slice(0, max - 1) + "\u2026" : value;
    for (const row of rows) {
      table.push([
        row.id,
        chalk4.bold(row.name),
        String(row.sessions),
        String(row.pins),
        row.parent,
        truncate2(row.description, 34)
      ]);
    }
    console.log(table.toString());
    if (opts.pins) {
      for (const row of rows) {
        const pins = allBookmarks.filter((b) => b.space_ids.includes(row.id));
        if (pins.length === 0) continue;
        console.log(`
${chalk4.yellow(`Pins in ${row.name} (${row.id})`)}`);
        for (const p of pins) {
          const shortId = p.session_id.length > 13 ? shortSessionId(p.session_id) + "\u2026" : p.session_id;
          console.log(`  ${chalk4.cyan(p.id)}  ${p.title}  ${chalk4.gray(shortId)}  ${chalk4.gray(p.provider)}`);
        }
      }
    }
  });
  space.command("tree").description("Display catalogs as a hierarchical tree").option("--sessions", "show sessions assigned to each catalog").action((opts) => {
    const spaces = listSpaces();
    const bookmarks = opts.sessions ? listBookmarks() : [];
    console.log(formatSpaceTree(spaces, bookmarks));
  });
  space.command("add <catalog> <session-id>").description("Add a session to a catalog").option("-t, --title <title>", "pin title when creating a new pin").option("--tags <tags>", "comma-separated tags when creating a new pin").action(async (catalog, sessionId, opts) => {
    const s = resolveCatalogRef2(catalog);
    const existing = findBookmarkBySessionRef(sessionId);
    if (existing) {
      if (existing.space_ids.includes(s.id)) {
        console.log(chalk4.yellow(`Already in catalog "${s.name}".`));
        return;
      }
      updateBookmark(existing.id, { space_ids: [...existing.space_ids, s.id] });
      console.log(chalk4.green(`Added ${existing.id} to catalog "${s.name}" (${s.id})`));
      return;
    }
    const meta = await resolveSessionMeta2(sessionId);
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const bookmark = {
      id: generateBookmarkId(listBookmarks()),
      provider: meta.provider || "unknown",
      session_id: meta.session_id,
      title: opts.title ?? meta.first_prompt?.slice(0, 60) ?? meta.session_id.slice(0, 16),
      category: "",
      tags: opts.tags ? opts.tags.split(",").map((t) => t.trim()).filter(Boolean) : [],
      project_path: meta.project_path ?? "",
      first_prompt: meta.first_prompt ?? "",
      notes: [],
      space_ids: [s.id],
      created_at: now,
      updated_at: now
    };
    addBookmark(bookmark);
    console.log(chalk4.green(`Added ${bookmark.id} to catalog "${s.name}" (${s.id})`));
  });
  space.command("show <name>").description("Show catalog details and contents").action((name) => {
    const s = resolveCatalogRef2(name);
    const pins = listBookmarks().filter((b) => b.space_ids.includes(s.id));
    const sessions = new Set(pins.map((b) => b.session_id)).size;
    const updated = s.updated_at.slice(0, 10);
    console.log(chalk4.bold(`Catalog: ${s.name}`));
    console.log(`Description: ${s.description || "(none)"}`);
    console.log(`Pins: ${pins.length}`);
    console.log(`Sessions: ${sessions}`);
    console.log(`Tags: ${s.tags.join(", ") || "(none)"}`);
    console.log(`Updated: ${updated}`);
    if (pins.length > 0) {
      console.log("");
      for (const p of pins) {
        const shortId = p.session_id.length > 36 ? shortSessionId(p.session_id) + "\u2026" : p.session_id;
        console.log(`  ${chalk4.cyan(p.id)}  ${p.title}  ${chalk4.gray(shortId)}  ${chalk4.gray(p.provider)}`);
      }
    }
  });
  space.command("detach <catalog> <session-id>").description("Detach a session from a catalog").action((catalog, sessionId) => {
    const s = resolveCatalogRef2(catalog);
    const bookmark = findBookmarkBySessionRef(sessionId);
    if (!bookmark) {
      console.error(chalk4.red(`Session pin not found: ${sessionId}`));
      process.exit(1);
    }
    if (!bookmark.space_ids.includes(s.id)) {
      console.log(chalk4.yellow(`Session is not in catalog "${s.name}".`));
      return;
    }
    const spaceIds = bookmark.space_ids.filter((sid) => sid !== s.id);
    updateBookmark(bookmark.id, { space_ids: spaceIds });
    console.log(chalk4.green(`Removed "${bookmark.title}" from catalog "${s.name}"`));
  });
  space.command("clear <catalog>").description("Remove all sessions from a catalog").action((catalog) => {
    const s = resolveCatalogRef2(catalog);
    for (const bookmark of listBookmarks()) {
      if (!bookmark.space_ids.includes(s.id)) continue;
      updateBookmark(bookmark.id, {
        space_ids: bookmark.space_ids.filter((sid) => sid !== s.id)
      });
    }
    console.log(chalk4.green(`Cleared catalog: "${s.name}" (${s.id})`));
  });
  space.command("delete <catalog>").alias("del").description("Remove a catalog").action((catalog) => {
    const s = resolveCatalogRef2(catalog);
    removeSpace(s.id);
    console.log(chalk4.green(`Removed catalog: "${s.name}" (${s.id})`));
  });
  space.command("tag <name> <tags...>").description("Add tags to a catalog").action((name, newTags) => {
    const s = resolveCatalogRef2(name);
    const merged = [.../* @__PURE__ */ new Set([...s.tags, ...newTags])];
    updateSpace(s.id, { tags: merged });
    console.log(chalk4.green(`Tagged "${s.name}": ${merged.join(", ")}`));
  });
  space.command("rename <catalog> <new-name>").description("Rename a catalog").action((catalog, newName) => {
    const updated = renameCatalog(catalog, newName);
    console.log(chalk4.green(`Renamed catalog: "${updated.name}" (${updated.id})`));
  });
  space.command("move <catalog>").description("Move a catalog under another parent catalog").option("-p, --parent <parent>", "new parent catalog name, path, or id").option("--root", "move catalog to the root level").action((catalog, opts) => {
    const updated = moveCatalog(catalog, opts);
    console.log(chalk4.green(`Moved catalog: "${updated.name}" (${updated.id})`));
    console.log(chalk4.gray(`  Path: ${catalogPath(updated)}`));
  });
  space.command("edit <name>").description("Edit catalog metadata").option("-d, --description <desc>", "new description").option("--rename <new-name>", "rename the catalog").option("--parent <parent>", "set parent catalog").option("--root", "move catalog to the root level").action((name, opts) => {
    const s = resolveCatalogRef2(name);
    const patch = {};
    if (opts.description) patch.description = opts.description;
    if (opts.rename) {
      const nextName2 = validateCatalogName(opts.rename);
      patch.name = nextName2;
    }
    if (opts.parent && opts.root) {
      console.error(chalk4.red("Use either --parent or --root, not both."));
      process.exit(1);
    }
    if (opts.parent || opts.root) {
      patch.parent_id = resolveMoveParentId(s, opts);
    }
    const nextName = patch.name ?? s.name;
    const nextParentId = Object.prototype.hasOwnProperty.call(patch, "parent_id") ? patch.parent_id ?? null : s.parent_id;
    if (hasSiblingSpaceName(nextName, nextParentId, s.id)) {
      console.error(chalk4.red(`Catalog already exists under this parent: ${nextName}`));
      process.exit(1);
    }
    const updated = updateSpace(s.id, patch);
    if (updated) {
      console.log(chalk4.green(`Updated catalog: "${updated.name}" (${updated.id})`));
    }
  });
  program2.addCommand(space);
}
function renameCatalog(catalog, newName) {
  const s = resolveCatalogRef2(catalog);
  const trimmedName = validateCatalogName(newName);
  if (hasSiblingSpaceName(trimmedName, s.parent_id, s.id)) {
    console.error(chalk4.red(`Catalog already exists under this parent: ${trimmedName}`));
    process.exit(1);
  }
  const updated = updateSpace(s.id, { name: trimmedName });
  if (!updated) {
    console.error(chalk4.red(`Catalog not found: ${catalog}`));
    process.exit(1);
  }
  return updated;
}
function moveCatalog(catalog, opts) {
  const s = resolveCatalogRef2(catalog);
  const parentId = resolveMoveParentId(s, opts);
  if (hasSiblingSpaceName(s.name, parentId, s.id)) {
    console.error(chalk4.red(`Catalog already exists under this parent: ${s.name}`));
    process.exit(1);
  }
  const updated = updateSpace(s.id, { parent_id: parentId });
  if (!updated) {
    console.error(chalk4.red(`Catalog not found: ${catalog}`));
    process.exit(1);
  }
  return updated;
}
function resolveMoveParentId(catalog, opts) {
  if (opts.parent && opts.root) {
    console.error(chalk4.red("Use either --parent or --root, not both."));
    process.exit(1);
  }
  if (!opts.parent && !opts.root) {
    console.error(chalk4.red("Specify --parent <catalog> or --root."));
    process.exit(1);
  }
  if (opts.root) {
    return null;
  }
  const parent = resolveCatalogRef2(opts.parent);
  if (parent.id === catalog.id) {
    console.error(chalk4.red("A catalog cannot be its own parent."));
    process.exit(1);
  }
  if (isDescendantCatalog(parent, catalog, listSpaces())) {
    console.error(chalk4.red("A catalog cannot use its descendant as parent."));
    process.exit(1);
  }
  return parent.id;
}
function validateCatalogName(newName) {
  const trimmedName = newName.trim();
  if (!trimmedName) {
    console.error(chalk4.red("Catalog name cannot be empty."));
    process.exit(1);
  }
  if (trimmedName.includes("/")) {
    console.error(chalk4.red("Catalog rename expects a single catalog name, not a path."));
    process.exit(1);
  }
  return trimmedName;
}
function isDescendantCatalog(candidate, root, spaces) {
  let current = candidate;
  const seen = /* @__PURE__ */ new Set();
  while (current?.parent_id) {
    if (current.parent_id === root.id) return true;
    if (seen.has(current.parent_id)) return false;
    seen.add(current.parent_id);
    current = spaces.find((space) => space.id === current?.parent_id);
  }
  return false;
}
function createCatalogPath(pathRef, parentId, opts) {
  const parts = pathRef.split("/").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) {
    console.error(chalk4.red("Catalog name cannot be empty."));
    process.exit(1);
  }
  let currentParentId = parentId;
  let currentSpace;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    const existing = findSiblingSpace(part, currentParentId);
    const isLeaf = index === parts.length - 1;
    if (existing) {
      if (isLeaf && !opts.allowExistingLeaf) {
        console.error(chalk4.red(`Catalog already exists under this parent: ${part}`));
        process.exit(1);
      }
      currentSpace = existing;
      currentParentId = existing.id;
      continue;
    }
    const now = (/* @__PURE__ */ new Date()).toISOString();
    currentSpace = {
      id: generateSpaceId(listSpaces()),
      name: part,
      description: isLeaf ? opts.description ?? "" : "",
      tags: isLeaf ? opts.tags ?? [] : [],
      parent_id: currentParentId,
      created_at: now,
      updated_at: now
    };
    addSpace(currentSpace);
    currentParentId = currentSpace.id;
  }
  return currentSpace;
}
function findSiblingSpace(name, parentId) {
  return listSpaces().find((space) => space.name === name && space.parent_id === parentId);
}
function resolveCatalogRef2(ref) {
  const resolution = resolveCatalogReference(ref);
  if (resolution.kind === "found") {
    return resolution.space;
  }
  if (resolution.kind === "not_found") {
    console.error(chalk4.red(`Catalog not found: ${ref}`));
    process.exit(1);
  }
  console.error(chalk4.red(`Ambiguous catalog reference: ${ref}`));
  console.error(chalk4.red("Use a catalog path like parent/child or the catalog id."));
  for (const match of resolution.matches) {
    console.error(chalk4.gray(`  ${catalogPath(match, listSpaces())} (${match.id})`));
  }
  process.exit(1);
}
function findBookmarkBySessionRef(ref) {
  return listBookmarks().find((bookmark) => bookmark.id === ref || bookmark.session_id === ref);
}
async function resolveSessionMeta2(input) {
  const candidates = await findSessionCandidates(input);
  if (candidates.length === 0) {
    console.error(chalk4.red(`No session matches: ${input}`));
    process.exit(1);
  }
  if (candidates.length > 1) {
    const exact = candidates.find((candidate) => candidate.session_id === input);
    if (exact) return exact;
    console.error(chalk4.red(`Ambiguous session id: ${input}`));
    console.error(chalk4.red("Please rerun with full session id."));
    process.exit(1);
  }
  return candidates[0];
}

// src/commands/project.ts
import { Command as Command4 } from "commander";
import chalk5 from "chalk";
import Table3 from "cli-table3";
async function aggregateByProject(providerFilter, limit, useIndex = true, refreshIndex = false) {
  if (useIndex) {
    const index = refreshIndex ? await rebuildSessionIndex(providerFilter) : await loadSessionIndexWithNewFiles(providerFilter);
    if (index) {
      if (!providerFilter && index.projects) {
        return index.projects.map(projectSummaryToStats);
      }
      return aggregateProjectsFromSessions(index.sessions, providerFilter);
    }
  }
  const map = /* @__PURE__ */ new Map();
  let count = 0;
  for await (const meta of streamSessions(providerFilter)) {
    if (limit && ++count > limit) break;
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
  projects.sort((a, b) => b.last_active.localeCompare(a.last_active));
  return projects;
}
async function findProjectStats(path, providerFilter, useIndex = true, refreshIndex = false) {
  if (useIndex) {
    const index = refreshIndex ? await rebuildSessionIndex(providerFilter) : await loadSessionIndexWithNewFiles(providerFilter);
    const projectSessions2 = index.sessions.filter((session) => {
      if (providerFilter && session.provider !== providerFilter) return false;
      return Boolean(session.project_path && matchesProjectPath(session.project_path, path));
    });
    return pickProjectMatch(aggregateProjectsFromSessions(projectSessions2, providerFilter), path);
  }
  const projectSessions = [];
  for await (const meta of streamSessions(providerFilter)) {
    if (meta.project_path && matchesProjectPath(meta.project_path, path)) {
      projectSessions.push(meta);
    }
  }
  return pickProjectMatch(aggregateProjectsFromSessions(projectSessions, providerFilter), path);
}
function projectSummaryToStats(summary) {
  return {
    ...summary,
    sessions: []
  };
}
function matchesProjectPath(projectPath, input) {
  return projectPath === input || projectPath.endsWith(input) || projectPath.endsWith("/" + input);
}
function pickProjectMatch(projects, input) {
  const exact = projects.find((project) => project.project_path === input);
  return exact ?? projects[0] ?? null;
}
function shortPath(p, maxLen) {
  if (p.length <= maxLen) return p;
  return "\u2026" + p.slice(-(maxLen - 1));
}
function formatAgentModelSummary(counts) {
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}(${v})`).join(", ");
}
function topModel(models) {
  const entries = Object.entries(models).sort((a, b) => b[1] - a[1]);
  return entries[0]?.[0] || "-";
}
function parseLimit(value) {
  return parseInt(value || "100", 10) || 100;
}
function registerProjectCommand(program2) {
  const project = new Command4("project").alias("prj").description("Manage projects \u2014 aggregate sessions by project directory");
  project.command("list").alias("ls").description("List all projects with session statistics").option("-a, --agent <agent>", "filter by agent: claude | codex").option("-n, --limit <number>", "max projects to show", "100").option("--all", "show all projects").option("--refresh-index", "rebuild ~/.starling/session-index.json before listing").option("--no-index", "scan session files instead of using ~/.starling/session-index.json").option("--json", "output as JSON").action(
    async (opts) => {
      const provider = opts.agent;
      const projectLimit = opts.all ? void 0 : parseLimit(opts.limit);
      const scanLimit = opts.index === false ? projectLimit : void 0;
      const allProjects = await aggregateByProject(provider, scanLimit, opts.index !== false, Boolean(opts.refreshIndex));
      const projects = projectLimit ? allProjects.slice(0, projectLimit) : allProjects;
      if (projects.length === 0) {
        if (opts.json) {
          console.log("[]");
          return;
        }
        console.log(chalk5.yellow("No projects found."));
        return;
      }
      if (opts.json) {
        console.log(
          JSON.stringify(
            projects.map(({ sessions, ...rest }) => rest),
            null,
            2
          )
        );
        return;
      }
      const table = new Table3({
        head: [
          chalk5.gray("PROJECT"),
          chalk5.gray("SESSIONS"),
          chalk5.gray("AGENTS"),
          chalk5.gray("TOP MODEL"),
          chalk5.gray("LAST ACTIVE")
        ],
        colWidths: [42, 10, 18, 22, 20],
        style: { head: [], border: ["gray"] },
        chars: {
          mid: "",
          "left-mid": "",
          "mid-mid": "",
          "right-mid": ""
        }
      });
      for (const p of projects) {
        table.push([
          shortPath(p.project_path, 40),
          String(p.session_count),
          formatAgentModelSummary(p.agents),
          topModel(p.models),
          p.last_active.slice(0, 16).replace("T", " ")
        ]);
      }
      console.log(table.toString());
    }
  );
  project.command("show <path>").description("Show project details and session list").option("-a, --agent <agent>", "filter by agent: claude | codex").option("--refresh-index", "rebuild ~/.starling/session-index.json before showing").option("--no-index", "scan session files instead of using ~/.starling/session-index.json").option("--json", "output as JSON").action(
    async (path, opts) => {
      const provider = opts.agent;
      const p = await findProjectStats(path, provider, opts.index !== false, Boolean(opts.refreshIndex));
      if (!p) {
        console.error(chalk5.red(`Project not found: ${path}`));
        process.exit(1);
      }
      if (opts.json) {
        console.log(JSON.stringify(p, null, 2));
        return;
      }
      console.log(chalk5.bold(`Project: ${p.project_path}`));
      console.log(`  Sessions: ${p.session_count}`);
      console.log(`  Agents:   ${formatAgentModelSummary(p.agents)}`);
      console.log(`  Models:   ${formatAgentModelSummary(p.models)}`);
      console.log(
        `  First session: ${p.first_active.slice(0, 10)}`
      );
      console.log(
        `  Last active:   ${p.last_active.slice(0, 16).replace("T", " ")}`
      );
      console.log("");
      console.log(chalk5.bold("Recent sessions:"));
      const sorted = [...p.sessions].sort(
        (a, b) => b.modified_at.localeCompare(a.modified_at)
      );
      for (const s of sorted.slice(0, 20)) {
        const short = shortSessionId(s.session_id);
        const agent = s.provider === "codex" ? "codex" : "claude";
        const date = s.modified_at.slice(0, 16).replace("T", " ");
        const prompt = s.first_prompt ? s.first_prompt.length > 40 ? s.first_prompt.slice(0, 37) + "\u2026" : s.first_prompt : "";
        console.log(
          `  ${chalk5.cyan(short)}  ${chalk5.gray(agent.padEnd(7))}  ${(s.model || "-").padEnd(22)}  ${chalk5.gray(date)}  ${chalk5.gray(prompt)}`
        );
      }
    }
  );
  program2.addCommand(project);
}

// src/commands/run.ts
import { Command as Command5 } from "commander";
import chalk6 from "chalk";
import { randomUUID as randomUUID2 } from "crypto";
import { chmodSync as chmodSync4, existsSync as existsSync7, readFileSync as readFileSync6, readdirSync as readdirSync4, statSync as statSync4, unlinkSync as unlinkSync6, writeFileSync as writeFileSync4 } from "fs";
import { createInterface as createInterface3 } from "readline/promises";
import { spawn as spawn2 } from "child_process";
import { basename as basename2, extname as extname3, isAbsolute as isAbsolute2, join as join7, resolve as resolve2 } from "path";

// src/lib/codexProvider.ts
import { existsSync as existsSync5, readFileSync as readFileSync4, readdirSync as readdirSync3, writeFileSync as writeFileSync2, chmodSync as chmodSync2, unlinkSync as unlinkSync4, renameSync as renameSync2 } from "fs";
import { basename, extname as extname2, isAbsolute, join as join5, resolve } from "path";

// src/lib/configPaths.ts
import { extname } from "path";
function hasKnownConfigExtension(fileName, extensions) {
  const extension = extname(fileName).toLowerCase();
  return extension.length > 0 && extensions.includes(extension);
}

// src/lib/codexProvider.ts
var CODEX_PROVIDER_HISTORY_PATH = join5(DEFAULT_STARLING_HOME, "codex-provider.json");
var CODEX_PROVIDER_EXTENSIONS = [".toml", ".json", ".jsonc"];
function getCodexProviderProfile(profileName) {
  migrateCodexJsonProfilesToToml();
  const sourcePath = resolveCodexConfigPath(profileName);
  if (!sourcePath) return null;
  const extension = extname2(sourcePath).toLowerCase();
  const name = basename(sourcePath, extension);
  const parsed = inspectCodexProfile(sourcePath);
  return {
    name,
    filePath: sourcePath,
    extension,
    hasAuth: parsed.hasAuth,
    hasConfig: parsed.hasConfig
  };
}
function saveCodexProviderProfile(profileName, patch) {
  migrateCodexJsonProfilesToToml();
  const safeName = normalizeProfileName(profileName);
  const existingPath = resolveCodexConfigPath(safeName);
  const targetPath = existingPath ?? join5(DEFAULT_CODEX_SETTINGS_DIR, `${safeName}.toml`);
  const existing = existsSync5(targetPath) ? parseCodexProfile(targetPath) : { auth: null, config: null, configObject: null };
  const auth = mergeAuthPatch(existing.auth, patch);
  const config = mergeConfigPatch(existing.configObject, patch);
  if ((!auth || Object.keys(auth).length === 0) && (!config || Object.keys(config).length === 0)) {
    throw new Error("Codex provider profile needs at least auth or config content.");
  }
  writeCodexProfileToml(targetPath, auth, config);
  return getCodexProviderProfile(safeName);
}
function resolveCodexConfigPath(nameOrPath) {
  migrateCodexJsonProfilesToToml();
  if (!nameOrPath) return null;
  if (isAbsolute(nameOrPath) || existsSync5(nameOrPath)) {
    if (!existsSync5(nameOrPath)) {
      return null;
    }
    return resolve(nameOrPath);
  }
  const base = join5(DEFAULT_CODEX_SETTINGS_DIR, basename(nameOrPath));
  if (hasKnownConfigExtension(base, CODEX_PROVIDER_EXTENSIONS) && existsSync5(base)) return base;
  if (hasKnownConfigExtension(base, CODEX_PROVIDER_EXTENSIONS)) return null;
  for (const ext of CODEX_PROVIDER_EXTENSIONS) {
    const candidate = `${base}${ext}`;
    if (existsSync5(candidate)) return candidate;
  }
  return null;
}
function inspectCodexProfile(filePath) {
  const extension = extname2(filePath).toLowerCase();
  if (extension === ".toml") {
    const parsed = parseCodexTomlProfile(filePath);
    return {
      filePath,
      hasConfig: true,
      hasAuth: parsed.auth !== null
    };
  }
  if (extension === ".json" || extension === ".jsonc") {
    const parsed = parseCodexJsonProfile(filePath, extension === ".jsonc");
    return {
      filePath,
      hasConfig: typeof parsed.config === "string" && parsed.config.trim().length > 0,
      hasAuth: parsed.auth !== null
    };
  }
  return { filePath, hasConfig: false, hasAuth: false };
}
function migrateCodexJsonProfilesToToml() {
  if (!existsSync5(DEFAULT_CODEX_SETTINGS_DIR)) return [];
  const migrated = [];
  const entries = readdirSync3(DEFAULT_CODEX_SETTINGS_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const sourcePath = join5(DEFAULT_CODEX_SETTINGS_DIR, entry.name);
    const extension = extname2(sourcePath).toLowerCase();
    if (extension !== ".json" && extension !== ".jsonc") continue;
    const name = entry.name.slice(0, entry.name.length - extension.length);
    const targetPath = join5(DEFAULT_CODEX_SETTINGS_DIR, `${name}.toml`);
    const backupPath = `${sourcePath}.bak`;
    try {
      if (!existsSync5(targetPath)) {
        const parsed = parseCodexJsonProfile(sourcePath, extension === ".jsonc");
        writeCodexProfileToml(targetPath, parsed.auth, parsed.configObject);
        migrated.push(targetPath);
      }
      if (!existsSync5(backupPath)) {
        renameSync2(sourcePath, backupPath);
      } else if (existsSync5(targetPath)) {
        unlinkSync4(sourcePath);
      }
    } catch {
    }
  }
  return migrated;
}
function parseCodexProfile(filePath) {
  const extension = extname2(filePath).toLowerCase();
  if (extension === ".toml") return parseCodexTomlProfile(filePath);
  if (extension === ".json" || extension === ".jsonc") {
    return parseCodexJsonProfile(filePath, extension === ".jsonc");
  }
  throw new Error(`Unsupported codex profile type: ${filePath}`);
}
function parseCodexJsonProfile(filePath, allowComments) {
  const raw = readFileSync4(filePath, "utf-8");
  let parsed;
  try {
    parsed = JSON.parse(allowComments ? stripJsonComments(raw) : raw);
  } catch {
    throw new Error(`Invalid JSON profile: ${filePath}`);
  }
  if (!isRecord3(parsed)) {
    throw new Error(`Invalid codex profile object: ${filePath}`);
  }
  const auth = resolveProfileAuth(parsed);
  const configObject = resolveProfileConfigObject(parsed);
  const config = typeof parsed.config === "string" ? parsed.config : configObject ? convertJsonToToml(configObject) : null;
  if (!auth && !config) {
    throw new Error(`Codex profile has no recognized auth/config content: ${filePath}`);
  }
  return { auth, config, configObject };
}
function parseCodexTomlProfile(filePath) {
  const raw = readFileSync4(filePath, "utf-8");
  const configObject = parseSimpleToml(raw);
  const providerName = stringValue(configObject.model_provider);
  const providers = isRecord3(configObject.model_providers) ? configObject.model_providers : {};
  const providerConfig = providerName && isRecord3(providers[providerName]) ? providers[providerName] : {};
  const token = stringValue(providerConfig.experimental_bearer_token) || stringValue(configObject.OPENAI_API_KEY);
  const auth = token ? { OPENAI_API_KEY: token } : null;
  return {
    auth,
    config: raw.endsWith("\n") ? raw : `${raw}
`,
    configObject
  };
}
function resolveProfileAuth(value) {
  if (isRecord3(value.auth)) {
    return value.auth;
  }
  const candidateKeys = ["OPENAI_API_KEY", "openai_api_key", "apiKey", "api_key"];
  for (const key of candidateKeys) {
    const v = value[key];
    if (typeof v === "string" && v.trim()) {
      return { OPENAI_API_KEY: v };
    }
  }
  if (typeof value.token === "string" && value.token.trim()) {
    return { OPENAI_API_KEY: value.token };
  }
  return null;
}
function resolveProfileConfigObject(value) {
  if (isRecord3(value.config)) {
    return cloneRecord(value.config);
  }
  return null;
}
function mergeAuthPatch(existing, patch) {
  const merged = existing ? { ...existing } : {};
  if (patch.auth) {
    for (const [key, value] of Object.entries(patch.auth)) {
      if (typeof value !== "undefined") merged[key] = value;
    }
  }
  if (typeof patch.apiKey === "string" && patch.apiKey.trim()) {
    merged.OPENAI_API_KEY = patch.apiKey.trim();
  }
  return Object.keys(merged).length > 0 ? merged : null;
}
function mergeConfigPatch(existing, patch) {
  const merged = existing ? cloneRecord(existing) : {};
  if (patch.config) {
    deepMerge(merged, patch.config);
  }
  const providerName = patch.modelProvider?.trim() || stringValue(merged.model_provider) || "custom";
  if (patch.modelProvider || patch.baseUrl || patch.wireApi || patch.apiKey || patch.model) {
    merged.model_provider = providerName;
  }
  if (typeof patch.model === "string" && patch.model.trim()) {
    merged.model = patch.model.trim();
  }
  if (patch.baseUrl || patch.wireApi) {
    const providers = isRecord3(merged.model_providers) ? merged.model_providers : {};
    const providerConfig = isRecord3(providers[providerName]) ? providers[providerName] : {};
    providerConfig.name = stringValue(providerConfig.name) || providerName;
    if (typeof patch.baseUrl === "string" && patch.baseUrl.trim()) {
      providerConfig.base_url = patch.baseUrl.trim();
    }
    if (typeof patch.wireApi === "string" && patch.wireApi.trim()) {
      providerConfig.wire_api = patch.wireApi.trim();
    }
    if (typeof providerConfig.requires_openai_auth === "undefined") {
      providerConfig.requires_openai_auth = true;
    }
    providers[providerName] = providerConfig;
    merged.model_providers = providers;
  }
  return Object.keys(merged).length > 0 ? merged : null;
}
function writeCodexProfileToml(targetPath, auth, config) {
  const normalized = config ? cloneRecord(config) : {};
  const token = auth ? stringValue(auth.OPENAI_API_KEY) || stringValue(auth.api_key) || stringValue(auth.apiKey) : "";
  if (token) {
    const providerName = stringValue(normalized.model_provider) || "custom";
    normalized.model_provider = providerName;
    const providers = isRecord3(normalized.model_providers) ? normalized.model_providers : {};
    const providerConfig = isRecord3(providers[providerName]) ? providers[providerName] : {};
    providerConfig.name = stringValue(providerConfig.name) || providerName;
    providerConfig.requires_openai_auth = typeof providerConfig.requires_openai_auth === "boolean" ? providerConfig.requires_openai_auth : true;
    providerConfig.experimental_bearer_token = token;
    providers[providerName] = providerConfig;
    normalized.model_providers = providers;
  }
  normalizeThirdPartyChatProviderConfig(normalized);
  ensureDir(targetPath);
  writeFileSync2(targetPath, convertJsonToToml(normalized), "utf-8");
  chmodSync2(targetPath, 384);
}
function normalizeThirdPartyChatProviderConfig(config) {
  const providerName = stringValue(config.model_provider);
  const providers = isRecord3(config.model_providers) ? config.model_providers : {};
  const providerConfig = providerName && isRecord3(providers[providerName]) ? providers[providerName] : {};
  if (isOfficialOpenAiProvider(providerName, providerConfig)) return;
  config.api_format = "openai_chat";
  providerConfig.api_format = "openai_chat";
  if (!stringValue(providerConfig.wire_api)) {
    providerConfig.wire_api = "responses";
  }
  if (providerName) {
    providers[providerName] = providerConfig;
    config.model_providers = providers;
  }
}
function isOfficialOpenAiProvider(providerName, providerConfig) {
  const name = `${providerName} ${stringValue(providerConfig.name)}`.toLowerCase();
  const baseUrl = stringValue(providerConfig.base_url).toLowerCase();
  return name.includes("openai") || baseUrl.includes("api.openai.com");
}
function deepMerge(target, patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (typeof value === "undefined") continue;
    if (isRecord3(value) && isRecord3(target[key])) {
      deepMerge(target[key], value);
      continue;
    }
    target[key] = isRecord3(value) ? cloneRecord(value) : value;
  }
}
function normalizeProfileName(profileName) {
  const name = basename(profileName).replace(/\.(jsonc?|toml)$/i, "").trim();
  if (!name || name === "." || name === "..") {
    throw new Error(`Invalid codex provider name: ${profileName}`);
  }
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error("Codex provider name may only contain letters, numbers, dot, dash, and underscore.");
  }
  return name;
}
function stringValue(value) {
  return typeof value === "string" ? value : "";
}
function cloneRecord(value) {
  return JSON.parse(JSON.stringify(value));
}
function stripJsonComments(raw) {
  return raw.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}
function parseSimpleToml(raw) {
  const root = {};
  let current = root;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const section = trimmed.match(/^\[([^\]]+)\]$/);
    if (section) {
      current = root;
      for (const part of splitTomlPath(section[1])) {
        const existing = current[part];
        if (!isRecord3(existing)) current[part] = {};
        current = current[part];
      }
      continue;
    }
    const kv = trimmed.match(/^([A-Za-z0-9_.-]+|"(?:\\.|[^"])+")\s*=\s*(.+?)\s*(?:#.*)?$/);
    if (!kv) continue;
    current[unquoteTomlKey(kv[1])] = parseTomlScalar(kv[2].trim());
  }
  return root;
}
function splitTomlPath(value) {
  const parts = [];
  let current = "";
  let inQuote = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === '"' && value[index - 1] !== "\\") {
      inQuote = !inQuote;
      current += char;
      continue;
    }
    if (char === "." && !inQuote) {
      parts.push(unquoteTomlKey(current.trim()));
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) parts.push(unquoteTomlKey(current.trim()));
  return parts;
}
function unquoteTomlKey(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}
function parseTomlScalar(value) {
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  return value;
}
function convertJsonToToml(value) {
  const lines = [];
  serializeTomlObject(value, [], lines);
  return lines.length > 0 ? `${lines.join("\n")}
` : "";
}
function serializeTomlObject(value, prefix, lines) {
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "undefined" || isRecord3(child)) continue;
    lines.push(`${toTomlKey(key)} = ${toTomlValue(child)}`);
  }
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "undefined") continue;
    if (isRecord3(child)) {
      const nextPath = [...prefix, key];
      if (hasDirectTomlValues(child)) {
        lines.push("");
        lines.push(`[${[...nextPath].map(toTomlKey).join(".")}]`);
      }
      serializeTomlObject(child, nextPath, lines);
    }
  }
}
function hasDirectTomlValues(value) {
  return Object.values(value).some((child) => typeof child !== "undefined" && !isRecord3(child));
}
function toTomlValue(value) {
  if (isRecord3(value)) {
    const entries = [];
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === "undefined") continue;
      entries.push(`${toTomlKey(k)} = ${toTomlValue(v)}`);
    }
    return `{ ${entries.join(", ")} }`;
  }
  if (Array.isArray(value)) {
    const items = value.filter((entry) => typeof entry !== "undefined").map((entry) => toTomlValue(entry));
    return `[${items.join(", ")}]`;
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null) {
    throw new Error("Codex config values cannot be null.");
  }
  return JSON.stringify(String(value));
}
function toTomlKey(key) {
  return /^\w+$/.test(key) ? key : JSON.stringify(key);
}
function isRecord3(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// src/lib/codexChatProxy.ts
import { createServer } from "http";
import { randomUUID } from "crypto";
var JSON_HEADERS = { "content-type": "application/json" };
var SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache",
  connection: "keep-alive"
};
async function startCodexChatProxy(options) {
  const history = /* @__PURE__ */ new Map();
  const upstreamBaseUrl = normalizeUpstreamBaseUrl(options.upstreamBaseUrl);
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      if (req.method === "GET" && isModelsPath(url.pathname)) {
        await handleModels(req, res, upstreamBaseUrl, options.apiKey, url.search);
        return;
      }
      if (req.method === "POST" && isResponsesPath(url.pathname)) {
        const body = await readJsonBody(req);
        await handleResponses(res, body, {
          upstreamBaseUrl,
          apiKey: options.apiKey,
          defaultModel: options.model,
          history
        });
        return;
      }
      writeJson(res, 404, { error: { message: `Unsupported Codex proxy path: ${url.pathname}` } });
    } catch (error) {
      writeJson(res, 500, {
        error: {
          message: error instanceof Error ? error.message : String(error),
          type: "starling_codex_proxy_error"
        }
      });
    }
  });
  await new Promise((resolve4, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve4();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not resolve Starling Codex proxy listen address.");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: () => closeServer(server)
  };
}
function closeServer(server) {
  return new Promise((resolve4) => {
    server.close(() => resolve4());
  });
}
async function handleModels(req, res, upstreamBaseUrl, apiKey, search) {
  const upstream = await fetch(`${upstreamBaseUrl}/models${search}`, {
    method: "GET",
    headers: forwardHeaders(req, apiKey)
  });
  const body = await upstream.json().catch(() => null);
  if (!upstream.ok) {
    writeJson(res, upstream.status, body ?? { models: [] });
    return;
  }
  writeJson(res, 200, normalizeModelsResponse(body));
}
async function handleResponses(res, body, context) {
  if (!isRecord4(body)) {
    writeJson(res, 400, { error: { message: "Responses request body must be a JSON object." } });
    return;
  }
  const chatRequest = responsesToChatRequest(body, context.defaultModel, context.history);
  const upstream = await fetch(`${context.upstreamBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${context.apiKey}`
    },
    body: JSON.stringify(chatRequest)
  });
  const contentType = upstream.headers.get("content-type") || "";
  if (!upstream.ok) {
    const errorText = await upstream.text();
    writeJson(res, upstream.status, chatErrorToResponsesError(errorText, upstream.status));
    return;
  }
  if (chatRequest.stream || contentType.includes("text/event-stream")) {
    await streamChatToResponses(upstream, res, chatRequest.model, context.history, chatRequest.toolMetadata);
    return;
  }
  const chatResponse = await upstream.json();
  const { response, storedMessages } = chatCompletionToResponse(chatResponse, chatRequest.model, chatRequest.toolMetadata);
  if (typeof response.id === "string") {
    context.history.set(response.id, { messages: [...chatRequest.messages, ...storedMessages] });
  }
  writeJson(res, 200, response);
}
function responsesToChatRequest(body, defaultModel, history) {
  const model = stringValue2(body.model) || defaultModel || "deepseek-v4-pro";
  const messages = [];
  const previousResponseId = stringValue2(body.previous_response_id);
  if (previousResponseId) {
    messages.push(...history.get(previousResponseId)?.messages ?? []);
  }
  const instructions = stringValue2(body.instructions);
  if (instructions) messages.push({ role: "system", content: instructions });
  messages.push(...responsesInputToChatMessages(body.input));
  const result = {
    model,
    messages,
    stream: body.stream !== false,
    toolMetadata: /* @__PURE__ */ new Map()
  };
  const { tools, metadata } = responsesToolsToChatToolsWithMetadata(body.tools, messages);
  result.toolMetadata = metadata;
  if (tools.length > 0) result.tools = tools;
  copyIfPresent(body, result, "temperature");
  copyIfPresent(body, result, "top_p");
  copyIfPresent(body, result, "parallel_tool_calls");
  copyIfPresent(body, result, "tool_choice");
  copyIfPresent(body, result, "stop");
  copyIfPresent(body, result, "frequency_penalty");
  copyIfPresent(body, result, "presence_penalty");
  copyIfPresent(body, result, "seed");
  copyIfPresent(body, result, "stream_options");
  copyIfPresent(body, result, "n");
  if (typeof body.max_output_tokens === "number") result.max_tokens = body.max_output_tokens;
  if (typeof body.max_completion_tokens === "number") result.max_tokens = body.max_completion_tokens;
  const effort = readReasoningEffort(body);
  if (effort) result.reasoning_effort = effort;
  const reasoningObject = body.reasoning;
  if (typeof reasoningObject === "string" && reasoningObject.trim()) {
    copyIfPresent(body, result, "reasoning");
  } else if (isRecord4(reasoningObject) && typeof reasoningObject.effort === "string") {
    result.reasoning_effort = reasoningObject.effort;
    copyIfPresent(body, result, "reasoning");
  }
  return result;
}
function responsesInputToChatMessages(input) {
  if (typeof input === "string") return [{ role: "user", content: input }];
  if (!Array.isArray(input)) return [];
  const messages = [];
  let pendingToolCalls = [];
  const pendingReasoning = [];
  const flushPendingReasoning = () => {
    if (pendingReasoning.length === 0) return;
    messages.push({
      role: "system",
      content: `Reasoning: ${pendingReasoning.join("\n")}`
    });
    pendingReasoning.length = 0;
  };
  const flushPendingToolCalls = () => {
    if (pendingToolCalls.length === 0) return;
    flushPendingReasoning();
    messages.push({ role: "assistant", content: null, tool_calls: pendingToolCalls });
    pendingToolCalls = [];
  };
  for (const item of input) {
    if (!isRecord4(item)) continue;
    const type = stringValue2(item.type);
    if (type === "function_call" || type === "custom_tool_call" || type === "tool_search_call") {
      const callId = stringValue2(item.call_id) || stringValue2(item.id) || `call_${randomUUID().replace(/-/g, "")}`;
      const namespace = stringValue2(item.namespace);
      const callName = stringValue2(item.name) || stringValue2(item.tool_name) || "tool_call";
      const name = safeChatToolName(namespace ? `${namespace}_${callName}` : callName);
      const args = stringValue2(item.arguments) || stringifyContent(item.input) || "{}";
      pendingToolCalls.push({
        id: callId,
        type: "function",
        function: {
          name,
          arguments: args
        }
      });
      continue;
    }
    if (type === "function_call_output" || type === "custom_tool_call_output" || type === "tool_search_output") {
      flushPendingToolCalls();
      const callId = stringValue2(item.call_id) || stringValue2(item.id) || "";
      messages.push({
        role: "tool",
        tool_call_id: callId || void 0,
        content: stringifyContent(item.output ?? item)
      });
      continue;
    }
    if (type === "reasoning") {
      const text = extractReasoningFromInputItem(item);
      if (text) pendingReasoning.push(text);
      continue;
    }
    if (type === "message" || item.role) {
      flushPendingToolCalls();
      flushPendingReasoning();
      const role = normalizeChatRole(stringValue2(item.role));
      if (!role || role === "tool") continue;
      const content = responsesContentToText(item.content);
      const message = { role, content };
      if (item.reasoning) {
        const attached = extractReasoningFromInputItem(item);
        if (attached) {
          const existing = message.content || "";
          message.content = existing ? `${existing}

Reasoning: ${attached}` : `Reasoning: ${attached}`;
        }
      }
      messages.push(message);
    }
  }
  flushPendingToolCalls();
  flushPendingReasoning();
  return messages;
}
function responsesContentToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return stringifyContent(content);
  const parts = [];
  for (const part of content) {
    if (typeof part === "string") {
      parts.push(part);
      continue;
    }
    if (!isRecord4(part)) continue;
    const text = stringValue2(part.text) || stringValue2(part.input_text) || stringValue2(part.output_text);
    if (text) parts.push(text);
  }
  return parts.join("\n");
}
function responsesToolsToChatToolsWithMetadata(tools, messages = []) {
  if (!Array.isArray(tools)) return { tools: [], metadata: /* @__PURE__ */ new Map() };
  const result = [];
  const metadata = /* @__PURE__ */ new Map();
  const seen = /* @__PURE__ */ new Set();
  const runningProcessIds = extractRunningProcessIds(messages);
  const addFunctionTool = (name, tool, namespace, responseType = "function_call", extraMetadata = {}) => {
    const displayName = safeChatToolName(namespace ? `${namespace}_${name}` : name);
    if (displayName === "write_stdin" && runningProcessIds.length === 0) return;
    if (seen.has(displayName)) return;
    seen.add(displayName);
    metadata.set(displayName, {
      responseType,
      responseName: responseType === "custom_tool_call" ? name : displayName,
      ...extraMetadata
    });
    result.push({
      type: "function",
      function: {
        name: displayName,
        description: toolDescriptionForChat(displayName, tool, runningProcessIds),
        parameters: toolParametersForChat(displayName, tool, runningProcessIds)
      }
    });
  };
  const visitTool = (tool, namespace = null) => {
    if (typeof tool === "string") {
      const name2 = tool.trim();
      if (!name2) return;
      addFunctionTool(
        name2,
        {
          description: "",
          parameters: { type: "object", properties: {} }
        },
        namespace
      );
      return;
    }
    if (!isRecord4(tool)) return;
    const toolType = stringValue2(tool.type);
    if (toolType === "namespace") {
      const ns = stringValue2(tool.name);
      if (!ns) return;
      const children = Array.isArray(tool.tools) ? tool.tools : isRecord4(tool.tools) ? [] : Array.isArray(tool.children) ? tool.children : [];
      for (const child of children) {
        visitTool(child, ns);
      }
      return;
    }
    if (toolType === "tool_search") {
      const displayName = "tool_search";
      if (seen.has(displayName)) return;
      seen.add(displayName);
      result.push({
        type: "function",
        function: {
          name: displayName,
          description: "Search and load Codex tools, plugins, connectors, and MCP namespaces for the current task.",
          parameters: { type: "object", properties: { query: { type: "string" }, limit: { type: "integer" } }, required: ["query"] }
        }
      });
      return;
    }
    const name = stringValue2(tool.name);
    if (!name) return;
    if (toolType === "custom") {
      if (name === "apply_patch") {
        addApplyPatchProxyTools(name, tool, namespace);
        return;
      }
      addFunctionTool(
        name,
        {
          description: stringValue2(tool.description) || "",
          parameters: {
            type: "object",
            properties: {
              input: { type: "string", description: "Tool input" }
            },
            required: ["input"]
          }
        },
        namespace,
        "custom_tool_call"
      );
      return;
    }
    if (toolType === "function" || !toolType) {
      addFunctionTool(name, tool, namespace);
    }
  };
  for (const tool of tools) {
    visitTool(tool);
  }
  return { tools: result, metadata };
  function addApplyPatchProxyTools(name, tool, namespace) {
    const baseDescription = stringValue2(tool.description) || "Apply a source code patch.";
    const addProxy = (suffix, description, parameters) => {
      addFunctionTool(
        `${name}_${suffix}`,
        {
          description: `${baseDescription}

${description}`,
          parameters
        },
        namespace,
        "custom_tool_call",
        {
          responseName: name,
          applyPatchProxy: suffix
        }
      );
    };
    addProxy(
      "add_file",
      "Create one new file by providing a target path and full file content. Do not include patch '+' prefixes in content.",
      {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string", description: "Target file path." },
          content: { type: "string", description: "Full file content without patch '+' prefixes." }
        },
        required: ["path", "content"]
      }
    );
    addProxy(
      "delete_file",
      "Delete one file by providing a target path.",
      {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string", description: "Target file path." }
        },
        required: ["path"]
      }
    );
    addProxy(
      "update_file",
      "Edit one existing file with structured hunks.",
      {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string", description: "Target file path." },
          move_to: { type: "string", description: "Optional destination path for move operations." },
          hunks: applyPatchHunksSchema()
        },
        required: ["path", "hunks"]
      }
    );
    addProxy(
      "replace_file",
      "Replace one existing file by providing a target path and full new file content.",
      {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string", description: "Target file path." },
          content: { type: "string", description: "Full replacement content." }
        },
        required: ["path", "content"]
      }
    );
    addProxy(
      "batch",
      "Edit files by providing ordered structured patch operations.",
      {
        type: "object",
        additionalProperties: false,
        properties: {
          operations: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                type: { type: "string", enum: ["add_file", "delete_file", "update_file", "replace_file"] },
                path: { type: "string" },
                move_to: { type: "string", description: "Optional destination path for update_file move operations." },
                content: { type: "string", description: "Full content for add_file or replace_file." },
                hunks: applyPatchHunksSchema()
              },
              required: ["type", "path"]
            }
          }
        },
        required: ["operations"]
      }
    );
  }
}
function extractRunningProcessIds(messages) {
  const ids = /* @__PURE__ */ new Set();
  for (const message of messages) {
    if (typeof message.content !== "string") continue;
    for (const match of message.content.matchAll(/Process running with session ID\s+(\d+)/g)) {
      const id = Number(match[1]);
      if (Number.isFinite(id)) ids.add(id);
    }
  }
  return [...ids].sort((a, b) => a - b);
}
function toolDescriptionForChat(displayName, tool, runningProcessIds) {
  const description = stringValue2(tool.description) || "";
  if (displayName !== "write_stdin") return description;
  return [
    description,
    `Only use this tool to poll or send input to a process that is still running from a previous exec_command result. Valid session_id values for this request: ${runningProcessIds.join(", ")}.`,
    "Do not use write_stdin to create or edit files; use exec_command or apply_patch instead."
  ].filter(Boolean).join("\n");
}
function toolParametersForChat(displayName, tool, runningProcessIds) {
  const parameters = isRecord4(tool.parameters) ? JSON.parse(JSON.stringify(tool.parameters)) : { type: "object", properties: {} };
  if (displayName !== "write_stdin") return parameters;
  if (!isRecord4(parameters.properties)) {
    parameters.properties = {};
  }
  const properties = parameters.properties;
  const sessionId = isRecord4(properties.session_id) ? { ...properties.session_id } : { type: "integer" };
  sessionId.enum = runningProcessIds;
  properties.session_id = sessionId;
  parameters.properties = properties;
  return parameters;
}
function safeChatToolName(value) {
  const normalized = value.trim().replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  return normalized || "tool_call";
}
async function streamChatToResponses(upstream, res, model, history, toolMetadata) {
  res.writeHead(200, SSE_HEADERS);
  const responseId = `resp_starling_${randomUUID().replace(/-/g, "")}`;
  const createdAt = Math.floor(Date.now() / 1e3);
  const state = createResponseState(responseId, model, createdAt);
  const assistantMessage = { role: "assistant", content: "" };
  writeSse(res, "response.created", {
    type: "response.created",
    response: responseEnvelope(state, "in_progress", [])
  });
  const reader = upstream.body?.getReader();
  if (!reader) throw new Error("Upstream response did not provide a readable stream.");
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += new TextDecoder().decode(value, { stream: true });
    const blocks = splitSseBlocks(buffer);
    buffer = blocks.remainder;
    for (const block of blocks.complete) {
      const data = parseSseData(block);
      if (!data || data === "[DONE]") continue;
      const chunk = JSON.parse(data);
      for (const event of chatChunkToResponseEvents(chunk, state, toolMetadata)) {
        writeSse(res, event.event, event.data);
      }
    }
  }
  const completedOutput = finalizeResponseState(state, toolMetadata);
  for (const event of completedOutput.events) {
    writeSse(res, event.event, event.data);
  }
  const response = responseEnvelope(state, "completed", completedOutput.items);
  writeSse(res, "response.completed", { type: "response.completed", response });
  res.end();
  assistantMessage.content = state.text;
  const toolCalls = [...state.toolItems.values()].filter((tool) => tool.started).map((tool) => ({
    id: tool.callId,
    type: "function",
    function: {
      name: tool.name,
      arguments: toolArgumentsForChatHistory(tool, toolMetadata.get(tool.name))
    }
  }));
  if (toolCalls.length > 0) assistantMessage.tool_calls = toolCalls;
  history.set(responseId, { messages: [assistantMessage] });
}
function chatChunkToResponseEvents(chunk, state, toolMetadata) {
  if (!isRecord4(chunk)) return [];
  const model = stringValue2(chunk.model);
  if (model) state.model = model;
  const choice = Array.isArray(chunk.choices) && isRecord4(chunk.choices[0]) ? chunk.choices[0] : null;
  const delta = isRecord4(choice?.delta) ? choice.delta : null;
  const events = [];
  const content = stringValue2(delta?.content);
  if (content) events.push(...pushTextDelta(state, content));
  const reasoning = stringValue2(delta?.reasoning);
  if (reasoning) events.push(...pushReasoningDelta(state, reasoning));
  if (Array.isArray(delta?.tool_calls)) {
    for (const callDelta of delta.tool_calls) {
      if (!isRecord4(callDelta)) continue;
      const index = typeof callDelta.index === "number" ? callDelta.index : 0;
      const current = state.toolItems.get(index) ?? {
        itemId: `fc_${randomUUID().replace(/-/g, "")}`,
        callId: stringValue2(callDelta.id) || `call_${randomUUID().replace(/-/g, "")}`,
        name: "",
        arguments: "",
        started: false,
        done: false,
        outputIndex: -1
      };
      if (stringValue2(callDelta.id)) {
        current.callId = stringValue2(callDelta.id) || current.callId;
      }
      const fn = isRecord4(callDelta.function) ? callDelta.function : {};
      const name = stringValue2(fn.name);
      const args = stringValue2(fn.arguments);
      if (name) current.name = name;
      if (args) current.arguments += args;
      state.toolItems.set(index, current);
      events.push(...pushToolDelta(state, current, args || "", toolMetadata));
    }
  }
  return events;
}
function createResponseState(responseId, model, createdAt) {
  return {
    responseId,
    model,
    createdAt,
    text: "",
    textStarted: false,
    textOutputIndex: 0,
    nextOutputIndex: 0,
    reasoning: {
      text: "",
      started: false,
      done: false,
      outputIndex: -1,
      itemId: `${responseId}_reason`
    },
    outputItems: /* @__PURE__ */ new Map(),
    toolItems: /* @__PURE__ */ new Map()
  };
}
function pushTextDelta(state, delta) {
  const itemId = `${state.responseId}_msg`;
  const events = [];
  if (!state.textStarted) {
    state.textStarted = true;
    state.textOutputIndex = state.nextOutputIndex++;
    const item = { id: itemId, type: "message", status: "in_progress", role: "assistant", content: [] };
    events.push({
      event: "response.output_item.added",
      data: { type: "response.output_item.added", output_index: state.textOutputIndex, item }
    });
    events.push({
      event: "response.content_part.added",
      data: {
        type: "response.content_part.added",
        item_id: itemId,
        output_index: state.textOutputIndex,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] }
      }
    });
  }
  state.text += delta;
  events.push({
    event: "response.output_text.delta",
    data: {
      type: "response.output_text.delta",
      item_id: itemId,
      output_index: state.textOutputIndex,
      content_index: 0,
      delta
    }
  });
  return events;
}
function pushToolDelta(state, current, delta, toolMetadata) {
  const outputIndex = current.outputIndex < 0 ? state.nextOutputIndex++ : current.outputIndex;
  current.outputIndex = outputIndex;
  const events = [];
  const metadata = toolMetadata.get(current.name) || inferApplyPatchMetadataFromToolName(current.name);
  if (!current.started) {
    current.started = true;
    const item = metadata?.responseType === "custom_tool_call" ? {
      id: current.itemId,
      type: "custom_tool_call",
      status: "in_progress",
      call_id: current.callId,
      name: metadata.responseName,
      input: ""
    } : {
      id: current.itemId,
      type: "function_call",
      status: "in_progress",
      call_id: current.callId,
      name: current.name,
      arguments: ""
    };
    events.push({
      event: "response.output_item.added",
      data: {
        type: "response.output_item.added",
        output_index: outputIndex,
        item
      }
    });
  }
  return events;
}
function responseToolItem(tool, metadata, status) {
  const effectiveMetadata = metadata || inferApplyPatchMetadataFromToolName(tool.name);
  if (effectiveMetadata?.responseType === "custom_tool_call") {
    return {
      id: tool.itemId,
      type: "custom_tool_call",
      status,
      call_id: tool.callId,
      name: effectiveMetadata.responseName,
      input: status === "completed" ? customToolInputFromChatArguments(tool.arguments, effectiveMetadata) : ""
    };
  }
  return {
    id: tool.itemId,
    type: "function_call",
    status,
    call_id: tool.callId,
    name: tool.name,
    arguments: status === "completed" ? functionToolArgumentsFromChatArguments(tool.arguments) : ""
  };
}
function inferApplyPatchMetadataFromToolName(name) {
  if (name === "apply_patch") {
    return { responseType: "custom_tool_call", responseName: "apply_patch" };
  }
  const suffix = name.startsWith("apply_patch_") ? name.slice("apply_patch_".length) : "";
  if (!["add_file", "delete_file", "update_file", "replace_file", "batch"].includes(suffix)) {
    return void 0;
  }
  return {
    responseType: "custom_tool_call",
    responseName: "apply_patch",
    applyPatchProxy: suffix
  };
}
function customToolInputFromChatArguments(args, metadata) {
  const trimmed = args.trim();
  if (!trimmed) return "";
  if (metadata?.applyPatchProxy) {
    return applyPatchProxyInputFromChatArguments(trimmed, metadata.applyPatchProxy);
  }
  let input = args;
  try {
    const parsed = JSON.parse(trimmed);
    if (isRecord4(parsed) && typeof parsed.input === "string") {
      input = parsed.input;
    }
  } catch {
    if (trimmed.includes("*** Begin Patch")) {
      return normalizeCustomToolInput(trimmed);
    }
  }
  return normalizeCustomToolInput(input);
}
function functionToolArgumentsFromChatArguments(args) {
  const trimmed = args.trim();
  if (!trimmed) return "{}";
  try {
    JSON.parse(trimmed);
    return trimmed;
  } catch {
    return JSON.stringify({
      _starling_invalid_arguments: trimmed
    });
  }
}
function toolArgumentsForChatHistory(tool, metadata) {
  const effectiveMetadata = metadata || (tool.name ? inferApplyPatchMetadataFromToolName(tool.name) : void 0);
  return effectiveMetadata?.responseType === "custom_tool_call" ? JSON.stringify({ input: customToolInputFromChatArguments(tool.arguments, effectiveMetadata) }) : functionToolArgumentsFromChatArguments(tool.arguments);
}
function normalizeCustomToolInput(input) {
  const withoutFence = stripMarkdownFence(input);
  if (!withoutFence.includes("*** Begin Patch")) return withoutFence;
  return normalizeApplyPatchInput(withoutFence);
}
function stripMarkdownFence(input) {
  const trimmed = input.trim();
  const match = trimmed.match(/^```(?:\w+)?\s*\n([\s\S]*?)\n```$/);
  return match ? match[1].trim() : input;
}
function normalizeApplyPatchInput(input) {
  const begin = input.indexOf("*** Begin Patch");
  if (begin < 0) return input;
  const fromBegin = input.slice(begin);
  const endMarker = "*** End Patch";
  const end = fromBegin.indexOf(endMarker);
  if (end < 0) return fromBegin.trimEnd();
  return fromBegin.slice(0, end + endMarker.length);
}
function applyPatchHunksSchema() {
  return {
    type: "array",
    description: "Structured update hunks.",
    items: {
      type: "object",
      additionalProperties: false,
      properties: {
        context: { type: "string", description: "Optional @@ context header text." },
        lines: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              op: { type: "string", enum: ["context", "add", "remove"] },
              text: { type: "string" }
            },
            required: ["op", "text"]
          }
        }
      },
      required: ["lines"]
    }
  };
}
function applyPatchProxyInputFromChatArguments(args, kind) {
  if (args.includes("*** Begin Patch")) return normalizeApplyPatchInput(args);
  let parsed;
  try {
    parsed = JSON.parse(args);
  } catch {
    return args;
  }
  const operations = kind === "batch" ? applyPatchOperationsFromBatch(parsed) : [applyPatchOperationFromRecord(kind, parsed)];
  if (!operations.length || operations.some((operation) => !operation)) {
    return args;
  }
  return formatApplyPatchOperations(operations);
}
function applyPatchOperationsFromBatch(parsed) {
  if (!isRecord4(parsed) || !Array.isArray(parsed.operations)) return [];
  return parsed.operations.map((operation) => {
    if (!isRecord4(operation)) return null;
    const type = stringValue2(operation.type);
    if (!["add_file", "delete_file", "update_file", "replace_file"].includes(type)) return null;
    return applyPatchOperationFromRecord(type, operation);
  });
}
function applyPatchOperationFromRecord(kind, parsed) {
  if (kind === "batch" || !isRecord4(parsed)) return null;
  const path = stringValue2(parsed.path);
  if (!path) return null;
  return {
    type: kind,
    path,
    moveTo: stringValue2(parsed.move_to) || stringValue2(parsed.moveTo) || void 0,
    content: stringValue2(parsed.content) ?? void 0,
    hunks: Array.isArray(parsed.hunks) ? parsed.hunks : void 0
  };
}
function formatApplyPatchOperations(operations) {
  const lines = ["*** Begin Patch"];
  for (const operation of operations) {
    if (operation.type === "add_file") {
      lines.push(`*** Add File: ${operation.path}`);
      lines.push(...plusPrefixedLines(operation.content || ""));
      continue;
    }
    if (operation.type === "delete_file") {
      lines.push(`*** Delete File: ${operation.path}`);
      continue;
    }
    if (operation.type === "replace_file") {
      lines.push(`*** Delete File: ${operation.path}`);
      lines.push(`*** Add File: ${operation.path}`);
      lines.push(...plusPrefixedLines(operation.content || ""));
      continue;
    }
    lines.push(`*** Update File: ${operation.path}`);
    if (operation.moveTo) lines.push(`*** Move to: ${operation.moveTo}`);
    lines.push(...formatApplyPatchHunks(operation.hunks || []));
  }
  lines.push("*** End Patch");
  return lines.join("\n");
}
function plusPrefixedLines(content) {
  const withoutTrailingNewline = content.endsWith("\n") ? content.slice(0, -1) : content;
  if (!withoutTrailingNewline) return ["+"];
  return withoutTrailingNewline.split("\n").map((line) => `+${line}`);
}
function formatApplyPatchHunks(hunks) {
  const lines = [];
  for (const hunk of hunks) {
    if (!isRecord4(hunk)) continue;
    const context = stringValue2(hunk.context);
    lines.push(context ? context.startsWith("@@") ? context : `@@ ${context}` : "@@");
    const hunkLines = Array.isArray(hunk.lines) ? hunk.lines : [];
    for (const line of hunkLines) {
      if (!isRecord4(line)) continue;
      const op = stringValue2(line.op);
      const text = stringValue2(line.text) ?? "";
      if (op === "add") {
        lines.push(`+${text}`);
      } else if (op === "remove") {
        lines.push(`-${text}`);
      } else {
        lines.push(` ${text}`);
      }
    }
  }
  return lines;
}
function finalizeResponseState(state, toolMetadata) {
  const events = [];
  const items = [];
  if (state.reasoning.started && !state.reasoning.done) {
    const summary = state.reasoning.text.trim();
    const outputIndex = state.reasoning.outputIndex < 0 ? state.nextOutputIndex++ : state.reasoning.outputIndex;
    state.reasoning.outputIndex = outputIndex;
    state.reasoning.done = true;
    state.outputItems.set(outputIndex, {
      id: state.reasoning.itemId,
      type: "reasoning",
      status: "completed",
      summary: [{ type: "summary_text", text: summary }]
    });
    events.push({
      event: "response.reasoning_summary_text.done",
      data: {
        type: "response.reasoning_summary_text.done",
        item_id: state.reasoning.itemId,
        output_index: outputIndex,
        summary_index: 0,
        text: summary
      }
    });
    events.push({
      event: "response.output_item.done",
      data: {
        type: "response.output_item.done",
        output_index: outputIndex,
        item: {
          id: state.reasoning.itemId,
          type: "reasoning",
          status: "completed",
          summary: [{ type: "summary_text", text: summary }]
        }
      }
    });
  }
  if (state.textStarted) {
    const itemId = `${state.responseId}_msg`;
    const outputIndex = state.textOutputIndex;
    const item = {
      id: itemId,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: state.text, annotations: [] }]
    };
    events.push({
      event: "response.output_text.done",
      data: {
        type: "response.output_text.done",
        item_id: itemId,
        output_index: outputIndex,
        content_index: 0,
        text: state.text
      }
    });
    events.push({
      event: "response.content_part.done",
      data: {
        type: "response.content_part.done",
        item_id: itemId,
        output_index: outputIndex,
        content_index: 0,
        part: { type: "output_text", text: state.text, annotations: [] }
      }
    });
    events.push({
      event: "response.output_item.done",
      data: { type: "response.output_item.done", output_index: outputIndex, item }
    });
    items.push(item);
    state.outputItems.set(outputIndex, item);
  }
  for (const tool of state.toolItems.values()) {
    const outputIndex = tool.outputIndex < 0 ? state.nextOutputIndex++ : tool.outputIndex;
    tool.outputIndex = outputIndex;
    const metadata = toolMetadata.get(tool.name);
    if (!tool.started) {
      tool.started = true;
      events.push({
        event: "response.output_item.added",
        data: {
          type: "response.output_item.added",
          output_index: outputIndex,
          item: responseToolItem(tool, metadata, "in_progress")
        }
      });
    }
    const item = responseToolItem(tool, metadata, "completed");
    if (metadata?.responseType !== "custom_tool_call") {
      const argumentsJson = functionToolArgumentsFromChatArguments(tool.arguments);
      events.push({
        event: "response.function_call_arguments.delta",
        data: {
          type: "response.function_call_arguments.delta",
          item_id: tool.itemId,
          output_index: outputIndex,
          delta: argumentsJson
        }
      });
      events.push({
        event: "response.function_call_arguments.done",
        data: {
          type: "response.function_call_arguments.done",
          item_id: tool.itemId,
          output_index: outputIndex,
          arguments: argumentsJson
        }
      });
    }
    events.push({
      event: "response.output_item.done",
      data: { type: "response.output_item.done", output_index: outputIndex, item }
    });
    items.push(item);
    state.outputItems.set(outputIndex, item);
  }
  const orderedItems = [...state.outputItems.entries()].sort((a, b) => a[0] - b[0]).map(([, item]) => item);
  return { events, items: orderedItems };
}
function pushReasoningDelta(state, delta) {
  const events = [];
  if (!state.reasoning.started) {
    state.reasoning.started = true;
    state.reasoning.outputIndex = state.nextOutputIndex++;
    state.outputItems.set(state.reasoning.outputIndex, {
      id: state.reasoning.itemId,
      type: "reasoning",
      status: "in_progress",
      summary: [{ type: "summary_text", text: "" }]
    });
    events.push({
      event: "response.output_item.added",
      data: {
        type: "response.output_item.added",
        output_index: state.reasoning.outputIndex,
        item: {
          id: state.reasoning.itemId,
          type: "reasoning",
          status: "in_progress",
          summary: [{ type: "summary_text", text: "" }]
        }
      }
    });
  }
  state.reasoning.text += delta;
  events.push({
    event: "response.reasoning_summary_text.delta",
    data: {
      type: "response.reasoning_summary_text.delta",
      item_id: state.reasoning.itemId,
      output_index: state.reasoning.outputIndex,
      summary_index: 0,
      delta
    }
  });
  return events;
}
function chatCompletionToResponse(chatResponse, defaultModel, toolMetadata) {
  const responseId = isRecord4(chatResponse) && stringValue2(chatResponse.id) ? `resp_${stringValue2(chatResponse.id)}` : `resp_starling_${randomUUID().replace(/-/g, "")}`;
  const choice = isRecord4(chatResponse) && Array.isArray(chatResponse.choices) && isRecord4(chatResponse.choices[0]) ? chatResponse.choices[0] : {};
  const message = isRecord4(choice.message) ? choice.message : {};
  const [text, inlineReasoning] = splitReasoningFromContent(stringValue2(message.content) || "");
  const reasoningText = [stringifyContent(message.reasoning), inlineReasoning].map((value) => value.trim()).filter(Boolean).join("\n");
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const output = [];
  if (reasoningText) {
    output.push({
      id: `${responseId}_reason`,
      type: "reasoning",
      status: "completed",
      summary: [{ type: "summary_text", text: reasoningText }]
    });
  }
  if (text) {
    output.push({
      id: `${responseId}_msg`,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text, annotations: [] }]
    });
  }
  for (const tool of toolCalls) {
    if (!isRecord4(tool)) continue;
    const fn = isRecord4(tool.function) ? tool.function : {};
    const name = stringValue2(fn.name) || "";
    output.push(responseToolItem({
      itemId: `fc_${randomUUID().replace(/-/g, "")}`,
      callId: stringValue2(tool.id) || `call_${randomUUID().replace(/-/g, "")}`,
      name,
      arguments: stringValue2(fn.arguments) || ""
    }, toolMetadata.get(name), "completed"));
  }
  const response = responseEnvelope(
    {
      responseId,
      model: isRecord4(chatResponse) && stringValue2(chatResponse.model) || defaultModel,
      createdAt: isRecord4(chatResponse) && typeof chatResponse.created === "number" ? chatResponse.created : Math.floor(Date.now() / 1e3)
    },
    "completed",
    output
  );
  return {
    response,
    storedMessages: [{ role: "assistant", content: text, ...toolCalls.length > 0 ? { tool_calls: toolCalls } : {} }]
  };
}
function extractReasoningFromInputItem(item) {
  const reasoning = item.reasoning;
  if (typeof reasoning === "string" && reasoning.trim()) return reasoning.trim();
  if (isRecord4(reasoning)) {
    const summary = reasonSummaryTextFromContainer(reasoning);
    if (summary) return summary.trim();
  }
  if (typeof item.summary === "string" && item.summary.trim()) return item.summary.trim();
  if (Array.isArray(item.summary)) {
    const summary = reasonSummaryTextFromItems(item.summary);
    if (summary) return summary.trim();
  }
  if (isRecord4(item.summary)) {
    const summary = reasonSummaryTextFromContainer(item.summary);
    if (summary) return summary.trim();
  }
  const text = stringifyContent(item.text);
  return text ? text.trim() : null;
}
function reasonSummaryTextFromItems(value) {
  const chunks = [];
  for (const entry of value) {
    if (!isRecord4(entry)) continue;
    const text = typeof entry.text === "string" ? entry.text : reasonSummaryTextFromContainer(entry) || "";
    if (text) chunks.push(text);
  }
  return chunks.length > 0 ? chunks.join("\n") : null;
}
function reasonSummaryTextFromContainer(container) {
  const summary = container.summary;
  if (typeof summary === "string") return summary;
  if (Array.isArray(summary)) {
    const chunks = [];
    for (const entry of summary) {
      if (!isRecord4(entry)) continue;
      const text = typeof entry.text === "string" ? entry.text : "";
      if (text) chunks.push(text);
    }
    return chunks.length > 0 ? chunks.join("\n") : null;
  }
  if (isRecord4(summary) && typeof summary.text === "string") return summary.text;
  return null;
}
function splitReasoningFromContent(content) {
  if (!content) return ["", ""];
  const normalized = content.trim();
  if (!normalized) return ["", ""];
  const reasonParts = [];
  let remaining = normalized;
  const reasonRegex = /<reasoning>([\s\S]*?)<\/reasoning>/gi;
  remaining = remaining.replace(reasonRegex, (_, captured) => {
    const text = typeof captured === "string" ? captured.trim() : "";
    if (text) reasonParts.push(text);
    return "";
  });
  const thinkRegex = /<think>([\s\S]*?)<\/think>/gi;
  remaining = remaining.replace(thinkRegex, (_, captured) => {
    const text = typeof captured === "string" ? captured.trim() : "";
    if (text) reasonParts.push(text);
    return "";
  });
  const finalRemaining = remaining.replace(/^\s*\n+|\s+$/g, "").replace(/\n{3,}/g, "\n\n");
  const reasoningText = reasonParts.join("\n").trim();
  return [finalRemaining, reasoningText];
}
function responseEnvelope(state, status, output) {
  return {
    id: state.responseId,
    object: "response",
    created_at: state.createdAt,
    status,
    model: state.model,
    output,
    parallel_tool_calls: true,
    usage: null
  };
}
function chatErrorToResponsesError(errorText, status) {
  let parsed;
  try {
    parsed = JSON.parse(errorText);
  } catch {
    parsed = null;
  }
  const message = isRecord4(parsed) && isRecord4(parsed.error) && stringValue2(parsed.error.message) || isRecord4(parsed) && stringValue2(parsed.message) || errorText || `Upstream error ${status}`;
  return { error: { message, type: "upstream_error", code: status } };
}
function normalizeModelsResponse(body) {
  if (isRecord4(body) && Array.isArray(body.models)) return body;
  const source = isRecord4(body) && Array.isArray(body.data) ? body.data : [];
  const models = source.filter(isRecord4).map((model, index) => {
    const id = stringValue2(model.id) || stringValue2(model.name);
    const name = stringValue2(model.name) || id;
    return {
      id,
      slug: id,
      name,
      display_name: name,
      description: name,
      default_reasoning_level: "high",
      supported_reasoning_levels: [
        { effort: "low", description: "Fast responses with lighter reasoning" },
        { effort: "medium", description: "Balances speed and reasoning depth" },
        { effort: "high", description: "Greater reasoning depth for complex tasks" }
      ],
      shell_type: "shell_command",
      visibility: "list",
      supported_in_api: true,
      object: stringValue2(model.object) || "model",
      owned_by: stringValue2(model.owned_by) || "deepseek",
      context_window: 1e6,
      max_context_window: 1e6,
      priority: 1e3 + index,
      additional_speed_tiers: [],
      service_tiers: [],
      availability_nux: null,
      upgrade: null,
      base_instructions: "You are Codex, a coding agent. Help the user with software engineering tasks in the current workspace.",
      model_messages: {
        instructions_template: "You are Codex, a coding agent. Help the user with software engineering tasks in the current workspace."
      },
      supports_reasoning_summaries: false,
      default_reasoning_summary: "none",
      support_verbosity: true,
      default_verbosity: "low",
      apply_patch_tool_type: "freeform",
      web_search_tool_type: "text_and_image",
      truncation_policy: { mode: "tokens", limit: 1e4 },
      supports_parallel_tool_calls: true,
      supports_image_detail_original: true,
      effective_context_window_percent: 95,
      experimental_supported_tools: [],
      input_modalities: ["text"],
      supports_search_tool: true,
      use_responses_lite: false
    };
  }).filter((model) => model.id && model.slug);
  return { models };
}
function normalizeUpstreamBaseUrl(value) {
  return value.replace(/\/+$/, "");
}
function isModelsPath(pathname) {
  return pathname === "/models" || pathname === "/v1/models";
}
function isResponsesPath(pathname) {
  return pathname === "/responses" || pathname === "/v1/responses" || pathname === "/v1/responses/compact";
}
function forwardHeaders(req, apiKey) {
  const headers = { authorization: `Bearer ${apiKey}` };
  const accept = req.headers.accept;
  if (typeof accept === "string") headers.accept = accept;
  return headers;
}
async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf-8");
  return text ? JSON.parse(text) : {};
}
function writeJson(res, status, body) {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}
function writeSse(res, event, data) {
  res.write(`event: ${event}
`);
  res.write(`data: ${JSON.stringify(data)}

`);
}
function splitSseBlocks(buffer) {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const parts = normalized.split("\n\n");
  return { complete: parts.slice(0, -1), remainder: parts.at(-1) ?? "" };
}
function parseSseData(block) {
  return block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
}
function readReasoningEffort(body) {
  if (isRecord4(body.reasoning)) {
    const effort = stringValue2(body.reasoning.effort);
    if (effort) return effort;
  }
  return stringValue2(body.model_reasoning_effort);
}
function copyIfPresent(source, target, key) {
  if (typeof source[key] !== "undefined") target[key] = source[key];
}
function normalizeChatRole(value) {
  if (value === "system" || value === "user" || value === "assistant" || value === "tool") return value;
  return value ? "user" : null;
}
function stringifyContent(value) {
  if (typeof value === "string") return value;
  if (value == null) return "";
  return JSON.stringify(value);
}
function stringValue2(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}
function isRecord4(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// src/lib/codexDefaultGuard.ts
import { existsSync as existsSync6, readFileSync as readFileSync5, statSync as statSync3, unlinkSync as unlinkSync5, writeFileSync as writeFileSync3, chmodSync as chmodSync3 } from "fs";
import { join as join6 } from "path";
function snapshotCodexDefaultConfig() {
  return {
    files: [
      snapshotFile(join6(DEFAULT_CODEX_HOME, "config.toml")),
      snapshotFile(join6(DEFAULT_CODEX_HOME, "auth.json"))
    ]
  };
}
function restoreCodexDefaultConfig(snapshot) {
  if (!snapshot) return;
  for (const file of snapshot.files) {
    restoreFile(file);
  }
}
function snapshotFile(path) {
  if (!existsSync6(path)) {
    return { path, existed: false };
  }
  const st = statSync3(path);
  return {
    path,
    existed: true,
    content: readFileSync5(path, "utf-8"),
    mode: st.mode & 511
  };
}
function restoreFile(snapshot) {
  if (!snapshot.existed) {
    if (existsSync6(snapshot.path)) {
      unlinkSync5(snapshot.path);
    }
    return;
  }
  ensureDir(snapshot.path);
  writeFileSync3(snapshot.path, snapshot.content ?? "", "utf-8");
  if (snapshot.mode !== void 0) {
    chmodSync3(snapshot.path, snapshot.mode);
  }
}

// src/commands/run.ts
var RUN_SESSION_SCAN_LIMIT = 500;
var RUN_SESSION_CATALOG_SCAN_LIMIT = 2e3;
var RUN_SESSION_DETECT_ATTEMPTS = 8;
var RUN_SESSION_DETECT_INTERVAL_MS = 300;
var RUN_SESSION_DETECT_FULL_SCAN_THRESHOLD_MS = 200;
var RUN_SESSION_EXIT_SETTLE_MS = 200;
var RUN_FAST_FAILURE_SKIP_SCAN_MS = 2e3;
var RUN_PIN_ATTEMPT_DRAIN_TIMEOUT_MS = 1500;
function registerRunCommand(program2) {
  const run = new Command5("run").description("Launch claude/codex with auto catalog assignment for the created session").argument("<agent>", "agent binary: claude | codex | agent").argument("[agent-args...]", "arguments passed verbatim to the agent CLI").option("-c, --catalog <catalog>", "add created session to catalog").option("--config <config>", "Starling settings profile under ~/.starling/settings/{claude|codex}").option("--title <title>", "pin title for created session").option("--tags <tags>", "pin tags for created session, comma-separated").option("--cwd <path>", "working directory for agent launch").allowUnknownOption().passThroughOptions().addHelpText(
    "after",
    "\nStarling options must be placed before <agent>. Everything after <agent> is passed to claude/codex."
  ).action(async (agentRaw, agentArgs, opts, command) => {
    const provider = normalizeAgent(agentRaw);
    if (!provider) {
      console.error(chalk6.red(`Unknown agent: ${agentRaw}`));
      console.error(chalk6.gray("Allowed values: claude, codex, agent"));
      process.exit(1);
    }
    const rawArgs = command.rawArgs;
    const requestedConfig = opts.config;
    const resolvedConfig = provider === "codex" ? resolveCodexConfigPath(requestedConfig) : resolveConfigFilePath(provider, opts.config);
    if (provider === "codex" && requestedConfig && !resolvedConfig) {
      const expectedPath = join7(DEFAULT_CODEX_SETTINGS_DIR, requestedConfig);
      console.error(chalk6.red(`Config file not found: ${requestedConfig}`));
      console.error(chalk6.gray(`Expected path: ${expectedPath}`));
      process.exit(1);
    }
    const normalizedCwd = opts.cwd ? resolve2(opts.cwd) : process.cwd();
    const catalog = await resolveCatalog2(opts.catalog);
    const codexDefaultSnapshot = provider === "codex" ? snapshotCodexDefaultConfig() : null;
    let codexConfig = provider === "codex" ? await createCodexRunConfig(resolvedConfig) : null;
    if (provider === "codex" && catalog) {
      codexConfig = ensureCodexRunHookConfig(codexConfig);
    }
    const hookRun = provider === "claude" && catalog ? createClaudeRunHookSettings(resolvedConfig) : null;
    const effectiveConfig = hookRun?.settingsPath ?? resolvedConfig;
    const args = resolveAgentArgs(provider, rawArgs, agentArgs, effectiveConfig, codexConfig);
    const cwd = opts.cwd;
    const binary = provider === "claude" ? "claude" : "codex";
    const startedAt = (/* @__PURE__ */ new Date()).toISOString();
    const runStartedAtMs = Date.now();
    const beforeRun = hookRun ? /* @__PURE__ */ new Map() : await snapshotSessions(provider);
    const beforeRunProjectFiles = provider === "claude" && !hookRun ? snapshotProjectSessions(normalizedCwd) : /* @__PURE__ */ new Map();
    const cleanupRunState = async () => {
      syncClaudeProfileSettingsFromRunSettings(resolvedConfig, hookRun?.settingsPath ?? null);
      cleanupClaudeRunHookSettings(hookRun);
      await cleanupCodexRunConfig(codexConfig);
      restoreCodexDefaultConfig(codexDefaultSnapshot);
    };
    let catalogPinned = false;
    let agentClosed = false;
    let stopAutoPinWatcher = false;
    let hintedSessionId;
    let pinAttempt = null;
    const startAutoPinWatcher = async () => {
      if (!catalog || catalogPinned) return;
      if (pinAttempt) return;
      pinAttempt = (async () => {
        const startedTime = Date.parse(startedAt);
        let attemptsAfterClose = 0;
        for (let i = 0; !stopAutoPinWatcher; i++) {
          const sessionId = hintedSessionId ?? readRunHookSessionId(hookRun?.eventsPath ?? codexConfig?.eventsPath);
          if (!sessionId) {
            if (provider === "codex") {
              const candidate2 = await findSingleCodexSessionForRunningAgent(startedTime, beforeRun, normalizedCwd);
              if (candidate2) {
                hintedSessionId = candidate2.session_id;
                await pinSessionToCatalog(candidate2, opts, catalog);
                catalogPinned = true;
                return;
              }
            }
            if (agentClosed || stopAutoPinWatcher) return;
            await sleep(250);
            continue;
          }
          hintedSessionId = sessionId;
          const candidate = hookRun && provider === "claude" ? await findClaudeSessionInProjectById(sessionId, normalizedCwd) : await findKnownSessionForRun(sessionId, provider, normalizedCwd, i);
          if (isRunSessionCandidate(candidate, provider, startedTime, beforeRun, sessionId)) {
            await pinSessionToCatalog(candidate, opts, catalog);
            catalogPinned = true;
            return;
          }
          if (agentClosed || stopAutoPinWatcher) {
            attemptsAfterClose++;
            if (attemptsAfterClose >= 20) break;
          }
          await sleep(250);
        }
        const fallback = provider === "claude" ? await detectSessionInCurrentClaudeProject(
          Date.parse(startedAt),
          beforeRun,
          normalizedCwd,
          beforeRunProjectFiles
        ) : await findSingleCodexSessionForRunningAgent(
          Date.parse(startedAt),
          beforeRun,
          normalizedCwd
        );
        if (fallback && fallback.provider === provider && (!hintedSessionId || fallback.session_id === hintedSessionId)) {
          await pinSessionToCatalog(fallback, opts, catalog);
          catalogPinned = true;
        }
      })().finally(() => {
        pinAttempt = null;
      });
      pinAttempt.catch((error) => {
        if (process.env.NODE_ENV !== "test") {
          const sessionLabel = hintedSessionId ? ` ${hintedSessionId}` : "";
          console.error(chalk6.yellow(`Failed to auto-pin session${sessionLabel} to catalog ${catalog?.name}: ${String(error)}`));
        }
      });
    };
    if (hookRun || provider === "codex" && catalog) {
      void startAutoPinWatcher();
    }
    let runResult;
    try {
      runResult = await runAgent(binary, args, cwd, {
        preserveSignals: true,
        env: buildAgentEnv(provider, codexConfig?.env)
      });
    } catch (error) {
      await cleanupRunState();
      throw error;
    }
    agentClosed = true;
    syncCodexProfileProjectTrustFromRunConfig(resolvedConfig, codexConfig);
    const exitCode = runResult.exitCode;
    if (exitCode !== 0) {
      await sleep(RUN_SESSION_EXIT_SETTLE_MS);
    }
    const knownSessionId = hintedSessionId ?? readRunHookSessionId(hookRun?.eventsPath ?? codexConfig?.eventsPath) ?? void 0;
    if (exitCode !== 0 && Date.now() - runStartedAtMs < RUN_FAST_FAILURE_SKIP_SCAN_MS && !knownSessionId) {
      await cleanupRunState();
      process.exit(exitCode);
    }
    if (hookRun && !knownSessionId) {
      await cleanupRunState();
      if (exitCode !== 0) {
        process.exit(exitCode);
      }
      console.log(chalk6.yellow("No Claude session id was reported by SessionStart hook."));
      return;
    }
    const newSessionMeta = hookRun && knownSessionId ? await resolveHookReportedClaudeSession(knownSessionId, normalizedCwd) : await detectSessionStartedAfterRun(
      provider,
      startedAt,
      beforeRun,
      normalizedCwd,
      beforeRunProjectFiles,
      knownSessionId
    );
    if (!newSessionMeta) {
      if (exitCode !== 0) {
        await cleanupRunState();
        process.exit(exitCode);
      }
      console.log(chalk6.yellow("No new session found, or session metadata is not ready yet."));
      await cleanupRunState();
      return;
    }
    if (catalog && !catalogPinned) {
      if (knownSessionId && newSessionMeta.session_id === knownSessionId) {
        await pinSessionToCatalog(newSessionMeta, opts, catalog);
        catalogPinned = true;
      } else {
        const candidates = await collectRunSessionCandidates(
          provider,
          Date.parse(startedAt),
          beforeRun,
          normalizedCwd,
          beforeRunProjectFiles
        );
        const sameProjectCandidates = candidates.filter(
          (session) => normalizeProjectPath(session.project_path) === normalizedCwd
        );
        const targetCandidates = sameProjectCandidates.length > 0 ? sameProjectCandidates : candidates;
        if (targetCandidates.length === 0) {
          console.log(chalk6.yellow("Could not find a stable candidate session for catalog assignment."));
        } else if (targetCandidates.length === 1) {
          await pinSessionToCatalog(targetCandidates[0], opts, catalog);
          catalogPinned = true;
        } else {
          const header = `Found ${targetCandidates.length} possible sessions created after run, can't choose automatically.`;
          console.log(chalk6.yellow(header));
          targetCandidates.slice(0, 5).forEach((session, index) => {
            const shortId = shortSessionId(session.session_id);
            const date = session.modified_at.slice(0, 16).replace("T", " ");
            const project = session.project_path ? session.project_path.length > 36 ? `\u2026${session.project_path.slice(-35)}` : session.project_path : "-";
            console.log(`  ${index + 1}. ${chalk6.cyan(shortId)}  ${date}  ${project}`);
          });
          console.log(chalk6.gray(`Use: starling pin <session_id> --to ${catalog.id} to assign manually.`));
        }
      }
    }
    console.log(chalk6.green(`Session started: ${newSessionMeta.session_id}`));
    updateSessionIndexInBackground(newSessionMeta);
    if (pinAttempt) {
      stopAutoPinWatcher = true;
      await drainPinAttempt(pinAttempt);
    }
    if (exitCode !== 0) {
      await cleanupRunState();
      process.exit(exitCode);
    }
    await cleanupRunState();
  });
  program2.addCommand(run);
}
async function drainPinAttempt(pinAttempt) {
  await Promise.race([
    pinAttempt,
    sleep(RUN_PIN_ATTEMPT_DRAIN_TIMEOUT_MS)
  ]);
}
function updateSessionIndexInBackground(session) {
  setImmediate(() => {
    try {
      upsertSessionInIndex(session);
    } catch {
    }
  });
}
var CONFIG_FILE_EXTENSIONS = [".json", ".jsonc", ".toml", ".yaml", ".yml", ".js", ".ts"];
var SESSION_ID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
function buildAgentEnv(provider, overrides) {
  if (provider !== "codex" && !overrides) return void 0;
  const env = { ...process.env, ...overrides ?? {} };
  if (provider === "codex") {
    for (const key of Object.keys(env)) {
      if (key.startsWith("CODEX_") && key !== "CODEX_HOME") {
        delete env[key];
      }
    }
  }
  return env;
}
function parseSessionIdFromText(text) {
  const resumeMatch = text.match(new RegExp(`--resume\\s+(${SESSION_ID_PATTERN.source})`, "i"));
  if (resumeMatch?.[1]) return resumeMatch[1];
  const sessionMatch = text.match(new RegExp(`session\\s+id\\s*[:=]\\s*(${SESSION_ID_PATTERN.source})`, "i"));
  if (sessionMatch?.[1]) return sessionMatch[1];
  const genericMatch = SESSION_ID_PATTERN.exec(text)?.[0];
  if (genericMatch) return genericMatch;
  return null;
}
function createClaudeRunHookSettings(configPath) {
  const runId = randomUUID2();
  const baseDir = join7(DEFAULT_STARLING_HOME, "run-hooks");
  const eventsPath = join7(baseDir, `${runId}.jsonl`);
  const settingsPath = join7(baseDir, `${runId}.settings.json`);
  ensureDir(eventsPath);
  const settings = readClaudeSettingsObject(configPath);
  if (!settings) return null;
  const hooks = isRecord5(settings.hooks) ? { ...settings.hooks } : {};
  const sessionStart = Array.isArray(hooks.SessionStart) ? [...hooks.SessionStart] : [];
  sessionStart.push({
    hooks: [
      {
        type: "command",
        command: `bash -c 'cat >> "$1"; printf "\\n" >> "$1"' _ ${shellQuote(eventsPath)}`
      }
    ]
  });
  hooks.SessionStart = sessionStart;
  atomicWriteJSON(settingsPath, { ...settings, hooks });
  return { settingsPath, eventsPath };
}
function cleanupClaudeRunHookSettings(hookRun) {
  if (!hookRun) return;
  for (const path of [hookRun.settingsPath, hookRun.eventsPath]) {
    try {
      unlinkSync6(path);
    } catch {
    }
  }
}
var CLAUDE_SETTINGS_SYNC_KEYS = [
  "permissions",
  "projects",
  "trust",
  "trustedProjects",
  "enableAllProjectMcpServers",
  "enabledMcpjsonServers",
  "disabledMcpjsonServers"
];
function syncClaudeProfileSettingsFromRunSettings(sourceConfigPath, runSettingsPath) {
  if (!sourceConfigPath || !runSettingsPath || !existsSync7(runSettingsPath)) return false;
  const sourceExt = extname3(sourceConfigPath).toLowerCase();
  if (sourceExt !== ".json" && sourceExt !== ".jsonc") return false;
  try {
    const sourceSettings = readSettingsJsonObject(sourceConfigPath, sourceExt === ".jsonc");
    const runSettings = readSettingsJsonObject(runSettingsPath, false);
    if (!sourceSettings || !runSettings) return false;
    let changed = false;
    for (const key of CLAUDE_SETTINGS_SYNC_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(runSettings, key)) continue;
      if (jsonStable(sourceSettings[key]) === jsonStable(runSettings[key])) continue;
      sourceSettings[key] = cloneJsonValue(runSettings[key]);
      changed = true;
    }
    if (!changed) return false;
    atomicWriteJSON(sourceConfigPath, sourceSettings);
    return true;
  } catch (error) {
    console.error(chalk6.yellow(`Could not sync Claude settings to ${sourceConfigPath}: ${String(error)}`));
    return false;
  }
}
async function createCodexRunConfig(configPath) {
  if (!configPath) {
    return null;
  }
  const ext = extname3(configPath).toLowerCase();
  if (ext === ".toml") {
    const profile = readCodexTomlProfileForRun(configPath);
    return createCodexRunConfigFromProfile(profile);
  }
  if (ext === ".json" || ext === ".jsonc") {
    const profile = readCodexJsonProfileForRun(configPath, ext === ".jsonc");
    return createCodexRunConfigFromProfile(profile);
  }
  console.error(chalk6.red(`Unsupported Codex config file type: ${configPath}`));
  console.error(chalk6.gray("Use .json, .jsonc, or .toml under ~/.starling/settings/codex."));
  process.exit(1);
}
function ensureCodexRunHookConfig(config) {
  const runId = randomUUID2();
  const baseDir = join7(DEFAULT_STARLING_HOME, "run-hooks");
  const eventsPath = join7(baseDir, `${runId}.codex.jsonl`);
  ensureDir(eventsPath);
  const hookText = codexSessionStartHookToml(eventsPath);
  if (config?.cleanupPaths[0] && config.args.includes("--profile")) {
    const profilePath2 = config.cleanupPaths[0];
    const existing = readFileSync6(profilePath2, "utf-8");
    writeFileSync4(profilePath2, `${existing.trimEnd()}

${hookText}`, "utf-8");
    return {
      ...config,
      args: addCodexHookTrustBypassArg(config.args),
      cleanupPaths: [...config.cleanupPaths, eventsPath],
      eventsPath
    };
  }
  const profileName = `starling-run-${randomUUID2()}`;
  const profilePath = join7(DEFAULT_CODEX_HOME, `${profileName}.config.toml`);
  ensureDir(profilePath);
  writeFileSync4(profilePath, hookText, "utf-8");
  chmodSync4(profilePath, 384);
  return {
    args: ["--profile", profileName, ...addCodexHookTrustBypassArg(config?.args ?? [])],
    cleanupPaths: [profilePath, eventsPath, ...config?.cleanupPaths ?? []],
    cleanupTasks: config?.cleanupTasks,
    env: config?.env,
    eventsPath
  };
}
function codexSessionStartHookToml(eventsPath) {
  return [
    "[features]",
    "hooks = true",
    "",
    "[[hooks.SessionStart]]",
    'matcher = "startup"',
    "",
    "[[hooks.SessionStart.hooks]]",
    'type = "command"',
    `command = ${JSON.stringify(`bash -c 'cat >> "$1"; printf "\\n" >> "$1"' _ ${shellQuote(eventsPath)}`)}`,
    "timeout = 5"
  ].join("\n") + "\n";
}
function addCodexHookTrustBypassArg(args) {
  return args.includes("--dangerously-bypass-hook-trust") ? args : ["--dangerously-bypass-hook-trust", ...args];
}
async function createCodexRunConfigFromProfile(profile) {
  const args = [];
  const cleanupPaths = [];
  const cleanupTasks = [];
  let configText = profile.configText;
  if (profile.chatProxy) {
    const proxy = await startCodexChatProxy({
      upstreamBaseUrl: profile.chatProxy.upstreamBaseUrl,
      apiKey: profile.chatProxy.apiKey,
      model: profile.chatProxy.model
    });
    cleanupTasks.push(proxy.close);
    configText = codexProxyConfigText(profile.chatProxy.config, proxy.baseUrl);
    console.error(chalk6.gray(`Starling Codex adapter: routing ${profile.chatProxy.providerName} via ${proxy.baseUrl}`));
  }
  if (configText) {
    const profileName = `starling-run-${randomUUID2()}`;
    const profilePath = join7(DEFAULT_CODEX_HOME, `${profileName}.config.toml`);
    ensureDir(profilePath);
    writeFileSync4(profilePath, configText, "utf-8");
    chmodSync4(profilePath, 384);
    args.push("--profile", profileName);
    cleanupPaths.push(profilePath);
  }
  if (profile.inlineConfig) {
    for (const [key, value] of flattenCodexConfig(profile.inlineConfig)) {
      args.push("--config", `${key}=${toCodexConfigValue(value)}`);
    }
  }
  return { args, cleanupPaths, cleanupTasks, env: profile.env };
}
async function cleanupCodexRunConfig(config) {
  if (!config) return;
  for (const path of config.cleanupPaths) {
    try {
      unlinkSync6(path);
    } catch {
    }
  }
  for (const cleanup of config.cleanupTasks ?? []) {
    try {
      await cleanup();
    } catch {
    }
  }
}
function syncCodexProfileProjectTrustFromRunConfig(sourceConfigPath, runConfig) {
  if (!sourceConfigPath || !runConfig) return;
  const sourceExt = extname3(sourceConfigPath).toLowerCase();
  if (sourceExt !== ".json" && sourceExt !== ".jsonc" && sourceExt !== ".toml") return;
  const trustedProjects = /* @__PURE__ */ new Set();
  for (const path of runConfig.cleanupPaths) {
    if (!path.endsWith(".config.toml") || !existsSync7(path)) continue;
    for (const projectPath of readTrustedProjectsFromCodexToml(path)) {
      trustedProjects.add(projectPath);
    }
  }
  if (trustedProjects.size === 0) return;
  if (sourceExt === ".toml") {
    syncCodexTomlProjectTrust(sourceConfigPath, trustedProjects);
    return;
  }
  try {
    const raw = readFileSync6(sourceConfigPath, "utf-8");
    const parsed = JSON.parse(sourceExt === ".jsonc" ? stripJsonComments2(raw) : raw);
    if (!isRecord5(parsed)) return;
    const config = isRecord5(parsed.config) ? parsed.config : {};
    const projects = isRecord5(config.projects) ? config.projects : {};
    let changed = false;
    for (const projectPath of trustedProjects) {
      const project = isRecord5(projects[projectPath]) ? projects[projectPath] : {};
      if (project.trust_level === "trusted") continue;
      project.trust_level = "trusted";
      projects[projectPath] = project;
      changed = true;
    }
    if (!changed) return;
    config.projects = projects;
    parsed.config = config;
    atomicWriteJSON(sourceConfigPath, parsed);
  } catch (error) {
    console.error(chalk6.yellow(`Could not sync Codex project trust to ${sourceConfigPath}: ${String(error)}`));
  }
}
function syncCodexTomlProjectTrust(sourceConfigPath, trustedProjects) {
  try {
    let raw = readFileSync6(sourceConfigPath, "utf-8");
    let changed = false;
    for (const projectPath of trustedProjects) {
      const updated = upsertCodexTomlProjectTrust(raw, projectPath);
      if (updated !== raw) {
        raw = updated;
        changed = true;
      }
    }
    if (changed) writeFileSync4(sourceConfigPath, raw.endsWith("\n") ? raw : `${raw}
`, "utf-8");
  } catch (error) {
    console.error(chalk6.yellow(`Could not sync Codex project trust to ${sourceConfigPath}: ${String(error)}`));
  }
}
function upsertCodexTomlProjectTrust(raw, projectPath) {
  const header = `[projects.${JSON.stringify(projectPath)}]`;
  const lines = raw.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => line.trim() === header);
  if (headerIndex < 0) {
    return `${raw.trimEnd()}

${header}
trust_level = "trusted"
`;
  }
  let endIndex = lines.length;
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    if (/^\s*\[/.test(lines[index])) {
      endIndex = index;
      break;
    }
  }
  let hasTrust = false;
  const nextLines = [...lines];
  for (let index = endIndex - 1; index > headerIndex; index -= 1) {
    if (!/^\s*trust_level\s*=\s*["']trusted["']\s*(?:#.*)?$/.test(nextLines[index])) continue;
    if (hasTrust) {
      nextLines.splice(index, 1);
      endIndex -= 1;
      continue;
    }
    hasTrust = true;
  }
  if (!hasTrust) {
    nextLines.splice(endIndex, 0, 'trust_level = "trusted"');
  }
  return nextLines.join("\n").replace(/\n{3,}/g, "\n\n");
}
function readTrustedProjectsFromCodexToml(filePath) {
  const raw = readFileSync6(filePath, "utf-8");
  const trusted = [];
  let currentProject = null;
  let currentTrusted = false;
  const flush = () => {
    if (currentProject && currentTrusted) trusted.push(currentProject);
  };
  for (const line of raw.split(/\r?\n/)) {
    const section = line.match(/^\s*\[projects\.(?:"([^"]+)"|'([^']+)'|([^\]]+))\]\s*$/);
    if (section) {
      flush();
      currentProject = section[1] ?? section[2] ?? section[3] ?? null;
      currentTrusted = false;
      continue;
    }
    if (!currentProject) continue;
    const trust = line.match(/^\s*trust_level\s*=\s*(?:"trusted"|'trusted')\s*(?:#.*)?$/);
    if (trust) currentTrusted = true;
  }
  flush();
  return trusted;
}
function readCodexJsonProfileForRun(configPath, allowComments) {
  try {
    const raw = readFileSync6(configPath, "utf-8");
    const parsed = JSON.parse(allowComments ? stripJsonComments2(raw) : raw);
    if (!isRecord5(parsed)) {
      console.error(chalk6.red(`Codex config must be a JSON object: ${configPath}`));
      process.exit(1);
    }
    const auth = resolveCodexProfileAuth(parsed);
    const chatProxy = resolveCodexChatProxySpec(parsed, auth);
    const configText = chatProxy ? convertCodexJsonToToml(chatProxy.config) : resolveCodexProfileConfigText(parsed);
    const env = chatProxy ? resolveStringEnv(parsed.env) : resolveCodexProfileEnv(parsed, auth, configText);
    const inlineConfig = resolveCodexInlineConfig(parsed);
    return { inlineConfig, configText, env, chatProxy };
  } catch (error) {
    console.error(chalk6.red(`Could not parse Codex config JSON: ${configPath}`));
    console.error(chalk6.gray(String(error)));
    process.exit(1);
  }
}
function readCodexTomlProfileForRun(configPath) {
  try {
    const configText = readFileSync6(configPath, "utf-8");
    const config = parseSimpleToml2(configText);
    const auth = resolveCodexTomlAuth(config);
    const profile = { config };
    const chatProxy = resolveCodexChatProxySpec(profile, auth);
    const env = chatProxy ? {} : resolveCodexProfileEnv(profile, auth, configText);
    return {
      inlineConfig: null,
      configText: configText.trim() ? configText.endsWith("\n") ? configText : `${configText}
` : null,
      env,
      chatProxy
    };
  } catch (error) {
    console.error(chalk6.red(`Could not parse Codex config TOML: ${configPath}`));
    console.error(chalk6.gray(String(error)));
    process.exit(1);
  }
}
function resolveCodexTomlAuth(config) {
  const providerName = resolveCodexModelProviderName(config);
  const providers = isRecord5(config.model_providers) ? config.model_providers : {};
  const providerConfig = providerName && isRecord5(providers[providerName]) ? providers[providerName] : {};
  const token = stringValue3(providerConfig.experimental_bearer_token) || stringValue3(config.OPENAI_API_KEY);
  return token ? { OPENAI_API_KEY: token } : null;
}
function resolveCodexProfileConfigText(profile) {
  const value = profile.config;
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  if (isRecord5(value)) {
    const toml = convertCodexJsonToToml(value);
    return toml.trim() ? toml : null;
  }
  return null;
}
function resolveCodexProfileAuth(profile) {
  if (isRecord5(profile.auth)) {
    return profile.auth;
  }
  const candidateKeys = ["OPENAI_API_KEY", "openai_api_key", "apiKey", "api_key"];
  for (const key of candidateKeys) {
    const value = profile[key];
    if (typeof value === "string" && value.trim()) {
      return { OPENAI_API_KEY: value };
    }
  }
  if (typeof profile.token === "string" && profile.token.trim()) {
    return { OPENAI_API_KEY: profile.token };
  }
  return null;
}
function resolveCodexProfileEnv(profile, auth, configText) {
  const env = {};
  const candidateKeys = ["OPENAI_API_KEY", "openai_api_key", "apiKey", "api_key", "token"];
  for (const key of candidateKeys) {
    const value = auth?.[key] ?? (key !== "token" && isRecord5(profile.env) ? profile.env[key] : void 0);
    if (typeof value === "string" && value.trim()) {
      env.OPENAI_API_KEY = value;
    }
  }
  if (isRecord5(profile.env)) {
    for (const [key, value] of Object.entries(profile.env)) {
      if (typeof value === "string" && value.trim()) {
        env[key] = value;
      }
    }
  }
  if (configText && isRecord5(profile.config) && typeof profile.config === "object" && profile.config !== null) {
    const providerName = resolveCodexModelProviderName(profile.config);
    const baseUrl = resolveCodexCustomProviderBaseUrl(profile.config, providerName);
    if (typeof baseUrl === "string" && baseUrl.trim()) {
      env.OPENAI_BASE_URL = env.OPENAI_BASE_URL || baseUrl;
      env.OPENAI_API_BASE_URL = env.OPENAI_API_BASE_URL || baseUrl;
      env.BASE_URL = env.BASE_URL || baseUrl;
    }
  }
  return env;
}
function resolveStringEnv(value) {
  const env = {};
  if (!isRecord5(value)) return env;
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "string" && child.trim()) {
      env[key] = child;
    }
  }
  return env;
}
function resolveCodexChatProxySpec(profile, auth) {
  if (!isRecord5(profile.config)) return null;
  const providerName = resolveCodexModelProviderName(profile.config);
  if (!providerName) return null;
  const providers = profile.config.model_providers;
  if (!isRecord5(providers)) return null;
  const providerConfig = providers[providerName];
  if (!isRecord5(providerConfig)) return null;
  const upstreamBaseUrl = typeof providerConfig.base_url === "string" ? providerConfig.base_url.trim() : "";
  if (!upstreamBaseUrl) return null;
  const apiFormat = resolveCodexApiFormat(profile, profile.config, providerConfig);
  const providerLabel = `${providerName} ${stringValue3(providerConfig.name)} ${stringValue3(profile.config.model)} ${upstreamBaseUrl}`.toLowerCase();
  const shouldProxy = apiFormat === "openai_chat" || providerLabel.includes("deepseek");
  if (!shouldProxy) return null;
  const apiKey = resolveCodexApiKey(auth, profile);
  if (!apiKey) {
    console.error(chalk6.red("Codex chat adapter requires an API key in auth.OPENAI_API_KEY or OPENAI_API_KEY."));
    process.exit(1);
  }
  return {
    providerName,
    upstreamBaseUrl,
    apiKey,
    model: typeof profile.config.model === "string" ? profile.config.model : void 0,
    config: cloneRecord2(profile.config)
  };
}
function codexProxyConfigText(config, proxyBaseUrl) {
  const cloned = cloneRecord2(config);
  const providerName = resolveCodexModelProviderName(cloned);
  if (!providerName || !isRecord5(cloned.model_providers)) {
    return convertCodexJsonToToml(cloned);
  }
  const providerConfig = cloned.model_providers[providerName];
  if (isRecord5(providerConfig)) {
    providerConfig.base_url = proxyBaseUrl;
    providerConfig.wire_api = "responses";
    providerConfig.requires_openai_auth = false;
    delete providerConfig.env_key;
    delete providerConfig.experimental_bearer_token;
    delete providerConfig.auth;
  }
  return convertCodexJsonToToml(cloned);
}
function resolveCodexApiFormat(...values) {
  for (const value of values) {
    const apiFormat = stringValue3(value.api_format) || stringValue3(value.apiFormat);
    if (apiFormat) return apiFormat;
  }
  return null;
}
function resolveCodexApiKey(auth, profile) {
  const candidateKeys = ["OPENAI_API_KEY", "openai_api_key", "apiKey", "api_key", "token"];
  for (const key of candidateKeys) {
    const value = auth?.[key] ?? profile[key] ?? (isRecord5(profile.env) ? profile.env[key] : void 0);
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}
function cloneRecord2(value) {
  return JSON.parse(JSON.stringify(value));
}
function stringValue3(value) {
  return typeof value === "string" ? value : "";
}
function resolveCodexModelProviderName(configValue) {
  const provider = configValue.model_provider;
  if (typeof provider === "string" && provider.trim()) return provider.trim();
  return null;
}
function resolveCodexCustomProviderBaseUrl(configValue, providerName) {
  if (!providerName) return null;
  const providers = configValue.model_providers;
  if (!isRecord5(providers)) return null;
  const providerConfig = providers[providerName];
  if (!isRecord5(providerConfig)) return null;
  const baseUrl = providerConfig.base_url;
  if (typeof baseUrl === "string" && baseUrl.trim()) return baseUrl.trim();
  return null;
}
function resolveCodexInlineConfig(profile) {
  if (typeof profile.config !== "undefined" && typeof profile.config !== "string") {
    return null;
  }
  const config = { ...profile };
  delete config.auth;
  delete config.config;
  return Object.keys(config).length > 0 ? config : null;
}
function stripJsonComments2(value) {
  return value.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}
function parseSimpleToml2(raw) {
  const root = {};
  let current = root;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const section = trimmed.match(/^\[([^\]]+)\]$/);
    if (section) {
      current = root;
      for (const part of splitTomlPath2(section[1])) {
        const existing = current[part];
        if (!isRecord5(existing)) current[part] = {};
        current = current[part];
      }
      continue;
    }
    const kv = trimmed.match(/^([A-Za-z0-9_.-]+|"(?:\\.|[^"])+")\s*=\s*(.+?)\s*(?:#.*)?$/);
    if (!kv) continue;
    current[unquoteTomlKey2(kv[1])] = parseTomlScalar2(kv[2].trim());
  }
  return root;
}
function splitTomlPath2(value) {
  const parts = [];
  let current = "";
  let inQuote = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === '"' && value[index - 1] !== "\\") {
      inQuote = !inQuote;
      current += char;
      continue;
    }
    if (char === "." && !inQuote) {
      parts.push(unquoteTomlKey2(current.trim()));
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) parts.push(unquoteTomlKey2(current.trim()));
  return parts;
}
function unquoteTomlKey2(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}
function parseTomlScalar2(value) {
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  return value;
}
function flattenCodexConfig(value, prefix = "") {
  const entries = [];
  for (const [key, nestedValue] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isRecord5(nestedValue)) {
      entries.push(...flattenCodexConfig(nestedValue, path));
      continue;
    }
    entries.push([path, nestedValue]);
  }
  return entries;
}
function toCodexConfigValue(value) {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null) {
    console.error(chalk6.red("Codex config values cannot be null."));
    process.exit(1);
  }
  return JSON.stringify(value);
}
function toTomlValue2(value) {
  if (isRecord5(value)) {
    const segments = [];
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === "undefined") continue;
      segments.push(`${toTomlKey2(k)} = ${toTomlValue2(v)}`);
    }
    return `{ ${segments.join(", ")} }`;
  }
  if (Array.isArray(value)) {
    const entries = value.filter((item) => typeof item !== "undefined").map((item) => toTomlValue2(item));
    return `[${entries.join(", ")}]`;
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null) {
    console.error(chalk6.red("Codex config values cannot be null."));
    process.exit(1);
  }
  return JSON.stringify(String(value));
}
function toTomlKey2(key) {
  return /^\w+$/.test(key) ? key : JSON.stringify(key);
}
function serializeTomlObject2(value, prefix, lines) {
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "undefined" || isRecord5(child)) continue;
    lines.push(`${toTomlKey2(key)} = ${toTomlValue2(child)}`);
  }
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "undefined") continue;
    if (isRecord5(child)) {
      const nextPath = [...prefix, key];
      if (hasDirectTomlValues2(child)) {
        lines.push("");
        lines.push(`[${[...nextPath].map(toTomlKey2).join(".")}]`);
      }
      serializeTomlObject2(child, nextPath, lines);
    }
  }
}
function hasDirectTomlValues2(value) {
  return Object.values(value).some((child) => typeof child !== "undefined" && !isRecord5(child));
}
function convertCodexJsonToToml(value) {
  const lines = [];
  serializeTomlObject2(value, [], lines);
  return lines.length > 0 ? `${lines.join("\n")}
` : "";
}
function readRunHookSessionId(eventsPath) {
  if (!eventsPath || !existsSync7(eventsPath)) return null;
  let raw = "";
  try {
    raw = readFileSync6(eventsPath, "utf-8");
  } catch {
    return null;
  }
  const lines = raw.trim().split(/\r?\n/).filter(Boolean).reverse();
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      const sessionId = readSessionIdFromHookEntry(entry);
      if (sessionId) return sessionId;
    } catch {
      const sessionId = parseSessionIdFromText(line);
      if (sessionId) return sessionId;
    }
  }
  return null;
}
function readSessionIdFromHookEntry(value) {
  if (!isRecord5(value)) return null;
  const direct = value.session_id ?? value.sessionId;
  if (typeof direct === "string" && SESSION_ID_PATTERN.test(direct)) return direct;
  for (const nested of Object.values(value)) {
    const found = readSessionIdFromHookEntry(nested);
    if (found) return found;
  }
  return null;
}
function readClaudeSettingsObject(configPath) {
  if (!configPath) return {};
  try {
    const parsed = readSettingsJsonObject(configPath, extname3(configPath).toLowerCase() === ".jsonc");
    if (parsed) return parsed;
  } catch {
    console.log(chalk6.yellow("Could not add Claude SessionStart hook because settings is not parseable JSON."));
  }
  return null;
}
function readSettingsJsonObject(filePath, allowComments) {
  const raw = readFileSync6(filePath, "utf-8");
  const parsed = JSON.parse(allowComments ? stripJsonComments2(raw) : raw);
  return isRecord5(parsed) ? parsed : null;
}
function jsonStable(value) {
  return JSON.stringify(value);
}
function cloneJsonValue(value) {
  return value === void 0 ? void 0 : JSON.parse(JSON.stringify(value));
}
function isRecord5(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function shellQuote(value) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
function resolveConfigFilePath(provider, configFile) {
  if (!configFile) return null;
  if (isAbsolute2(configFile) || existsSync7(configFile)) {
    if (!existsSync7(configFile)) {
      console.error(chalk6.red(`Config file not found: ${configFile}`));
      process.exit(1);
    }
    return configFile;
  }
  const baseDir = provider === "claude" ? DEFAULT_CLAUDE_SETTINGS_DIR : DEFAULT_CODEX_SETTINGS_DIR;
  const fileName = basename2(configFile);
  const candidate = join7(baseDir, fileName);
  if (existsSync7(candidate)) return candidate;
  const candidatesTried = [candidate];
  if (!hasKnownConfigExtension(fileName, CONFIG_FILE_EXTENSIONS)) {
    for (const ext of CONFIG_FILE_EXTENSIONS) {
      const candidateWithExtension = `${candidate}${ext}`;
      candidatesTried.push(candidateWithExtension);
      if (existsSync7(candidateWithExtension)) return candidateWithExtension;
    }
  }
  console.error(chalk6.red(`Config file not found: ${configFile}`));
  console.error(chalk6.gray(`Expected path: ${candidate}`));
  console.error(
    chalk6.gray(`Tried: ${candidatesTried.map((path) => path.replace(`${DEFAULT_CLAUDE_SETTINGS_DIR}/`, "").replace(`${DEFAULT_CODEX_SETTINGS_DIR}/`, "")).join(", ")}`)
  );
  process.exit(1);
}
async function resolveCatalog2(catalog) {
  if (!catalog) return null;
  const existing = resolveCatalogReference(catalog);
  if (existing.kind === "found") return existing.space;
  if (existing.kind === "ambiguous") {
    console.error(chalk6.red(`Ambiguous catalog reference: ${catalog}`));
    console.error(chalk6.red("Use a catalog path like parent/child or the catalog id."));
    for (const match of existing.matches) {
      console.error(chalk6.gray(`  ${catalogPath(match, listSpaces())} (${match.id})`));
    }
    process.exit(1);
  }
  if (!process.stdin.isTTY) {
    console.error(chalk6.red(`Catalog not found: ${catalog}`));
    console.error(chalk6.yellow(`Create it first: starling catalog create ${catalog}`));
    process.exit(1);
  }
  const input = await askCreateCatalog(catalog);
  if (!input) {
    console.error(chalk6.yellow(`Catalog not found: ${catalog}`));
    process.exit(1);
  }
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const created = createCatalogPath2(catalog, now);
  console.log(chalk6.green(`Created catalog: ${created.id} "${catalogPath(created)}"`));
  return created;
}
async function askCreateCatalog(catalog) {
  const rl = createInterface3({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`Catalog not found: ${chalk6.yellow(catalog)}. Create it now? (y/N) `);
    const normalized = answer.trim().toLowerCase();
    return normalized === "y" || normalized === "yes";
  } catch (error) {
    if (isReadlineAbort(error)) {
      return false;
    }
    throw error;
  } finally {
    rl.close();
  }
}
function isReadlineAbort(error) {
  return Boolean(
    error && typeof error === "object" && "code" in error && error.code === "ABORT_ERR"
  );
}
function createCatalogPath2(pathRef, now) {
  const parts = pathRef.split("/").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) {
    console.error(chalk6.red("Catalog name cannot be empty."));
    process.exit(1);
  }
  let parentId = null;
  let currentSpace;
  for (const part of parts) {
    const existing = findSiblingCatalog(part, parentId);
    if (existing) {
      currentSpace = existing;
      parentId = existing.id;
      continue;
    }
    currentSpace = {
      id: generateSpaceId(listSpaces()),
      name: part,
      description: "",
      tags: [],
      parent_id: parentId,
      created_at: now,
      updated_at: now
    };
    addSpace(currentSpace);
    parentId = currentSpace.id;
  }
  return currentSpace;
}
function findSiblingCatalog(name, parentId) {
  return listSpaces().find((space) => space.name === name && space.parent_id === parentId);
}
function resolveAgentArgs(provider, rawArgs, parsedArgs, configPath, codexConfig) {
  const args = rawArgs ? parsePassthroughArgs(rawArgs, parsedArgs) : parsedArgs;
  if (provider === "codex") {
    return [...codexConfig?.args ?? [], ...args];
  }
  if (!configPath) return args;
  return ["--settings", configPath, ...args];
}
function parsePassthroughArgs(rawArgs, parsedArgs) {
  if (!rawArgs) return parsedArgs;
  const separatorIndex = rawArgs.lastIndexOf("--");
  if (separatorIndex === -1) return parsedArgs;
  return rawArgs.slice(separatorIndex + 1);
}
async function runAgent(binary, args, cwd, options) {
  return new Promise((resolvePromise, reject) => {
    const childEnv = options?.env;
    const child = spawn2(binary, args, {
      stdio: "inherit",
      cwd,
      env: childEnv
    });
    let terminalInterrupted = false;
    let settled = false;
    const onSigInt = () => {
      terminalInterrupted = true;
      child.kill("SIGINT");
    };
    const cleanupListeners = () => {
      if (options?.preserveSignals) {
        process.off("SIGINT", onSigInt);
      }
    };
    const settle = (exitCode) => {
      if (settled) return;
      settled = true;
      cleanupListeners();
      resolvePromise({ exitCode });
    };
    if (options?.preserveSignals) {
      process.on("SIGINT", onSigInt);
    }
    child.on("error", (err) => {
      cleanupListeners();
      reject(err);
    });
    child.on("exit", (code) => {
      if (terminalInterrupted) {
        settle(130);
        return;
      }
      settle(code ?? 0);
    });
    child.on("close", (code) => {
      if (terminalInterrupted) {
        settle(130);
        return;
      }
      settle(code ?? 0);
    });
  });
}
async function snapshotSessions(provider) {
  const sessions = await findSessions(RUN_SESSION_SCAN_LIMIT, provider);
  const snapshot = /* @__PURE__ */ new Map();
  for (const session of sessions) {
    const modifiedAt = Date.parse(session.modified_at);
    snapshot.set(session.session_id, Number.isFinite(modifiedAt) ? modifiedAt : 0);
  }
  return snapshot;
}
function wasSessionTouchedAfterRun(session, startedAt, beforeRun) {
  const modifiedAt = Date.parse(session.modified_at);
  if (!Number.isFinite(modifiedAt) || modifiedAt < startedAt) return false;
  const previousModifiedAt = beforeRun.get(session.session_id);
  if (previousModifiedAt === void 0) return true;
  return modifiedAt > previousModifiedAt;
}
function isRunSessionCandidate(session, provider, startedAt, beforeRun, reportedSessionId) {
  if (!session || session.provider !== provider) return false;
  if (reportedSessionId && session.session_id === reportedSessionId) return true;
  return wasSessionTouchedAfterRun(session, startedAt, beforeRun);
}
async function detectSessionStartedAfterRun(provider, startedAt, beforeRun, cwd, beforeRunProjectFiles = /* @__PURE__ */ new Map(), knownSessionId) {
  const startedTime = Date.parse(startedAt);
  const graceUntil = Date.now() + RUN_SESSION_DETECT_FULL_SCAN_THRESHOLD_MS;
  const normalizedCwd = cwd ? normalizeProjectPath(cwd) : "";
  if (knownSessionId) {
    const hintedSession = await tryResolveKnownSession(
      knownSessionId,
      provider,
      startedTime,
      beforeRun,
      normalizedCwd
    );
    if (hintedSession) {
      return hintedSession;
    }
  }
  if (provider === "claude" && normalizedCwd) {
    const projectMatch = await detectSessionInCurrentClaudeProject(
      startedTime,
      beforeRun,
      normalizedCwd,
      beforeRunProjectFiles
    );
    if (projectMatch) {
      return projectMatch;
    }
  }
  for (let attempt = 0; attempt < RUN_SESSION_DETECT_ATTEMPTS; attempt++) {
    if (provider === "codex") {
      const codexMatches = await collectSessionCandidatesByModifiedTime(
        CODEX_SESSIONS_DIR,
        startedTime,
        beforeRun,
        "codex"
      );
      if (codexMatches.length > 0) {
        return pickBestMatch(codexMatches, startedTime, beforeRun, cwd);
      }
    }
    const recentSessions = await findSessions(RUN_SESSION_SCAN_LIMIT, provider);
    const recentMatches = recentSessions.filter(
      (session) => wasSessionTouchedAfterRun(session, startedTime, beforeRun)
    );
    if (recentMatches.length > 0) {
      return pickBestMatch(recentMatches, startedTime, beforeRun, cwd);
    }
    const fallbackLimit = RUN_SESSION_SCAN_LIMIT * Math.max(1, Math.min(attempt + 1, 4));
    const allMatches = [];
    for await (const session of streamSessions(provider, fallbackLimit)) {
      if (!wasSessionTouchedAfterRun(session, startedTime, beforeRun)) {
        continue;
      }
      allMatches.push(session);
    }
    if (allMatches.length > 0) {
      return pickBestMatch(allMatches, startedTime, beforeRun, cwd);
    }
    if (provider === "claude" && normalizedCwd) {
      const projectMatch = await detectSessionInCurrentClaudeProject(
        startedTime,
        beforeRun,
        normalizedCwd,
        beforeRunProjectFiles
      );
      if (projectMatch) {
        return projectMatch;
      }
    }
    if (attempt + 1 < RUN_SESSION_DETECT_ATTEMPTS) {
      await sleep(RUN_SESSION_DETECT_INTERVAL_MS);
    }
  }
  const fullScanMatches = [];
  for await (const session of streamSessions(provider, Infinity)) {
    if (!wasSessionTouchedAfterRun(session, startedTime, beforeRun)) continue;
    fullScanMatches.push(session);
  }
  if (fullScanMatches.length > 0) {
    return pickBestMatch(fullScanMatches, startedTime, beforeRun, cwd);
  }
  if (provider === "claude" && normalizedCwd) {
    const projectMatch = await detectSessionInCurrentClaudeProject(
      startedTime,
      beforeRun,
      normalizedCwd,
      beforeRunProjectFiles
    );
    if (projectMatch) {
      return projectMatch;
    }
  }
  if (Date.now() < graceUntil) {
    await sleep(RUN_SESSION_DETECT_INTERVAL_MS);
    return detectSessionStartedAfterRun(
      provider,
      startedAt,
      beforeRun,
      cwd,
      beforeRunProjectFiles,
      knownSessionId
    );
  }
  return null;
}
function collectSessionFilesByModifiedTime(dir, sinceMs, accumulator, limit = 3e3) {
  if (accumulator.length >= limit) return;
  let entries;
  try {
    entries = readdirSync4(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === "subagents") continue;
    const full = join7(dir, entry);
    let st;
    try {
      st = statSync4(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      collectSessionFilesByModifiedTime(full, sinceMs, accumulator, limit);
      continue;
    }
    if (!entry.endsWith(".jsonl")) continue;
    if (st.mtimeMs < sinceMs) continue;
    accumulator.push(full);
    if (accumulator.length >= limit) return;
  }
}
async function collectSessionCandidatesByModifiedTime(baseDir, startedTime, beforeRun, provider, limit = 500) {
  const filePaths = [];
  collectSessionFilesByModifiedTime(baseDir, startedTime, filePaths, limit * 4);
  const matches = [];
  for (const filePath of filePaths) {
    try {
      const st = statSync4(filePath);
      const modifiedAt = new Date(st.mtimeMs).toISOString();
      const entries = await parseJsonlHead(filePath);
      const extract = provider === "codex" ? extractCodexSessionMeta : extractClaudeSessionMeta;
      const meta = extract(entries, filePath, modifiedAt);
      if (!meta) continue;
      if (wasSessionTouchedAfterRun(meta, startedTime, beforeRun)) {
        matches.push(meta);
      }
    } catch {
      continue;
    }
  }
  return dedupeById(matches).sort((a, b) => b.modified_at.localeCompare(a.modified_at));
}
async function findSingleCodexSessionForRunningAgent(startedTime, beforeRun, normalizedCwd) {
  const candidates = await collectSessionCandidatesByModifiedTime(
    CODEX_SESSIONS_DIR,
    startedTime,
    beforeRun,
    "codex"
  );
  const sameProjectCandidates = candidates.filter(
    (session) => normalizeProjectPath(session.project_path) === normalizedCwd
  );
  if (sameProjectCandidates.length !== 1) return null;
  return sameProjectCandidates[0];
}
async function collectRunSessionCandidates(provider, startedAtMs, beforeRun, cwd, beforeRunProjectFiles = /* @__PURE__ */ new Map()) {
  const normalizedCwd = cwd ? normalizeProjectPath(cwd) : "";
  const matches = [];
  for await (const session of streamSessions(provider, RUN_SESSION_CATALOG_SCAN_LIMIT)) {
    if (!wasSessionTouchedAfterRun(session, startedAtMs, beforeRun)) continue;
    if (normalizedCwd && normalizeProjectPath(session.project_path) !== normalizedCwd) continue;
    matches.push(session);
  }
  if (provider === "claude" && normalizedCwd) {
    const currentProjectFiles = snapshotProjectSessions(normalizedCwd);
    for (const [filePath, fileModifiedAt] of currentProjectFiles) {
      const beforeModifiedAt = beforeRunProjectFiles.get(filePath);
      if (beforeModifiedAt !== void 0 && fileModifiedAt <= beforeModifiedAt) continue;
      if (!Number.isFinite(fileModifiedAt) || fileModifiedAt < startedAtMs) continue;
      const modifiedAt = new Date(fileModifiedAt).toISOString();
      let parsed = null;
      try {
        const parsedEntries = await parseJsonlHead(filePath);
        const parsedMeta = extractClaudeSessionMeta(parsedEntries, filePath, modifiedAt);
        parsed = parsedMeta ?? null;
      } catch {
        parsed = null;
      }
      matches.push({
        session_id: parsed?.session_id || basename2(filePath, ".jsonl"),
        provider: "claude",
        model: parsed?.model || "",
        project_path: parsed?.project_path || normalizedCwd,
        first_prompt: parsed?.first_prompt || "",
        file_path: filePath,
        created_at: parsed?.created_at || modifiedAt,
        modified_at: modifiedAt,
        ...parsed?.token_usage ? { token_usage: parsed.token_usage } : {}
      });
    }
  }
  return dedupeById(matches).sort((a, b) => b.modified_at.localeCompare(a.modified_at));
}
async function resolveHookReportedClaudeSession(sessionId, normalizedCwd) {
  for (let i = 0; i < 20; i++) {
    const direct = await findClaudeSessionInProjectById(sessionId, normalizedCwd);
    if (direct) return direct;
    await sleep(250);
  }
  const now = (/* @__PURE__ */ new Date()).toISOString();
  return {
    session_id: sessionId,
    provider: "claude",
    model: "",
    project_path: normalizedCwd,
    first_prompt: "",
    file_path: join7(encodeClaudeProjectDirectory(normalizedCwd), `${sessionId}.jsonl`),
    created_at: now,
    modified_at: now
  };
}
async function findKnownSessionForRun(sessionId, provider, normalizedCwd, attempt) {
  if (provider === "claude" && normalizedCwd) {
    const direct = await findClaudeSessionInProjectById(sessionId, normalizedCwd);
    if (direct) return direct;
  }
  if (attempt % 8 !== 0) return null;
  return findSessionById(sessionId);
}
async function findClaudeSessionInProjectById(sessionId, normalizedCwd) {
  const filePath = join7(encodeClaudeProjectDirectory(normalizedCwd), `${sessionId}.jsonl`);
  let fileModifiedAt;
  try {
    const st = statSync4(filePath);
    if (!st.isFile()) return null;
    fileModifiedAt = st.mtimeMs;
  } catch {
    return null;
  }
  const modifiedAt = new Date(fileModifiedAt).toISOString();
  try {
    const parsedEntries = await parseJsonlHead(filePath);
    const parsedMeta = extractClaudeSessionMeta(parsedEntries, filePath, modifiedAt);
    if (parsedMeta) {
      return parsedMeta;
    }
  } catch {
  }
  return {
    session_id: sessionId,
    provider: "claude",
    model: "",
    project_path: normalizedCwd,
    first_prompt: "",
    file_path: filePath,
    created_at: modifiedAt,
    modified_at: modifiedAt
  };
}
async function tryResolveKnownSession(sessionId, provider, startedTime, beforeRun, cwd) {
  if (provider === "claude" && cwd) {
    const direct = await findClaudeSessionInProjectById(sessionId, normalizeProjectPath(cwd));
    if (direct && wasSessionTouchedAfterRun(direct, startedTime, beforeRun)) {
      return direct;
    }
  }
  const candidate = await findSessionById(sessionId);
  if (!candidate || candidate.provider !== provider) {
    return null;
  }
  if (wasSessionTouchedAfterRun(candidate, startedTime, beforeRun)) {
    return candidate;
  }
  if (!beforeRun.has(sessionId) && candidate.modified_at && Date.parse(candidate.modified_at) >= startedTime) {
    return candidate;
  }
  if (!cwd) return null;
  const normalizedCwd = normalizeProjectPath(cwd);
  if (!candidate.project_path) return null;
  return normalizeProjectPath(candidate.project_path) === normalizedCwd ? candidate : null;
}
function encodeClaudeProjectDirectory(cwd) {
  const normalized = resolve2(cwd);
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  return join7(CLAUDE_SESSIONS_DIR, `-${parts.join("-")}`);
}
function snapshotProjectSessions(projectDir) {
  const snapshot = /* @__PURE__ */ new Map();
  const absoluteProjectDir = encodeClaudeProjectDirectory(projectDir);
  const stack = [absoluteProjectDir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    let entries;
    try {
      entries = readdirSync4(current);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry === "subagents") {
        continue;
      }
      const fullPath = join7(current, entry);
      let stat;
      try {
        stat = statSync4(fullPath);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (entry.endsWith(".jsonl")) {
        snapshot.set(fullPath, stat.mtimeMs);
      }
    }
  }
  return snapshot;
}
async function detectSessionInCurrentClaudeProject(startedTime, beforeRun, normalizedCwd, beforeRunProjectFiles = /* @__PURE__ */ new Map()) {
  const currentProjectFiles = snapshotProjectSessions(normalizedCwd);
  if (currentProjectFiles.size === 0) return null;
  const candidates = [];
  for (const [filePath, fileModifiedAt] of currentProjectFiles) {
    if (fileModifiedAt < startedTime) continue;
    const beforeProjectModifiedAt = beforeRunProjectFiles.get(filePath);
    if (beforeProjectModifiedAt !== void 0 && fileModifiedAt <= beforeProjectModifiedAt) continue;
    const modifiedAt = new Date(fileModifiedAt).toISOString();
    let parsed = null;
    try {
      const parsedEntries = await parseJsonlHead(filePath);
      const parsedMeta = extractClaudeSessionMeta(parsedEntries, filePath, modifiedAt);
      parsed = parsedMeta ?? null;
    } catch {
      parsed = null;
    }
    const sessionId = parsed?.session_id || basename2(filePath, ".jsonl");
    const candidate = {
      session_id: sessionId,
      provider: "claude",
      model: parsed?.model || "",
      project_path: parsed?.project_path || normalizedCwd,
      first_prompt: parsed?.first_prompt || "",
      file_path: filePath,
      created_at: parsed?.created_at || modifiedAt,
      modified_at: modifiedAt,
      ...parsed?.token_usage ? { token_usage: parsed.token_usage } : {}
    };
    if (normalizeProjectPath(candidate.project_path) !== normalizedCwd) continue;
    if (!wasSessionTouchedAfterRun(candidate, startedTime, beforeRun)) continue;
    candidates.push(candidate);
  }
  if (candidates.length === 0) {
    const directCandidates = [];
    for (const [filePath, beforeModifiedAt] of beforeRunProjectFiles) {
      const after = currentProjectFiles.get(filePath);
      if (after === void 0) continue;
      if (!Number.isFinite(after) || after < startedTime || after <= beforeModifiedAt) continue;
      const sessionId = basename2(filePath, ".jsonl");
      directCandidates.push({
        session_id: sessionId,
        provider: "claude",
        model: "",
        project_path: normalizedCwd,
        first_prompt: "",
        file_path: filePath,
        created_at: new Date(after).toISOString(),
        modified_at: new Date(after).toISOString()
      });
    }
    if (directCandidates.length > 0) {
      directCandidates.sort((a, b) => b.modified_at.localeCompare(a.modified_at));
      return directCandidates[0];
    }
  }
  if (candidates.length === 0) return null;
  const deduped = dedupeById(candidates);
  if (deduped.length === 1) return deduped[0];
  deduped.sort((a, b) => b.modified_at.localeCompare(a.modified_at));
  return deduped[0];
}
function pickBestMatch(sessions, startedTime, beforeRun, cwd) {
  const matches = sessions.filter(
    (session) => wasSessionTouchedAfterRun(session, startedTime, beforeRun)
  );
  if (matches.length === 0) return matches[0];
  const deduped = dedupeById(matches);
  if (!cwd) {
    deduped.sort((a, b) => b.modified_at.localeCompare(a.modified_at));
    return deduped[0];
  }
  const cwdNormalized = resolve2(cwd);
  const exact = deduped.filter((session) => normalizeProjectPath(session.project_path) === cwdNormalized);
  if (exact.length > 0) {
    exact.sort((a, b) => b.modified_at.localeCompare(a.modified_at));
    return exact[0];
  }
  deduped.sort((a, b) => b.modified_at.localeCompare(a.modified_at));
  return deduped[0];
}
function normalizeProjectPath(value) {
  if (!value) return "";
  try {
    return resolve2(value);
  } catch {
    return value;
  }
}
function dedupeById(sessions) {
  const latest = /* @__PURE__ */ new Map();
  for (const session of sessions) {
    const current = latest.get(session.session_id);
    if (!current || session.modified_at > current.modified_at) {
      latest.set(session.session_id, session);
    }
  }
  return [...latest.values()];
}
function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
async function pinSessionToCatalog(session, opts, space) {
  const existing = findBookmark(session.session_id);
  if (existing) {
    if (!existing.space_ids.includes(space.id)) {
      existing.space_ids.push(space.id);
      updateBookmark(existing.id, { space_ids: existing.space_ids });
      console.log(chalk6.green(`Added ${existing.id} to catalog "${space.name}" (${space.id})`));
    } else {
      console.log(chalk6.yellow(`Session already in catalog "${space.name}".`));
    }
    return;
  }
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const bookmarkId = generateBookmarkId(listBookmarks());
  const title = opts.title || session.first_prompt.slice(0, 60) || session.session_id.slice(0, 16);
  const tagList = opts.tags ? opts.tags.split(",").map((tag) => tag.trim()).filter(Boolean) : [];
  addBookmark({
    id: bookmarkId,
    provider: session.provider,
    session_id: session.session_id,
    title,
    category: "",
    tags: tagList,
    project_path: session.project_path ?? "",
    first_prompt: session.first_prompt ?? "",
    notes: [],
    space_ids: [space.id],
    created_at: now,
    updated_at: now
  });
  console.log(chalk6.green(`Pinned: ${bookmarkId}`));
  console.log(`  Title:   ${title}`);
  console.log(`  Catalog: ${space.name} (${space.id})`);
}
function normalizeAgent(input) {
  if (input === "claude") return "claude";
  if (input === "codex" || input === "agent") return "codex";
  return null;
}

// src/commands/model.ts
import { Command as Command6 } from "commander";
import chalk7 from "chalk";
import Table4 from "cli-table3";
import { existsSync as existsSync8, readFileSync as readFileSync7, readdirSync as readdirSync5, unlinkSync as unlinkSync7 } from "fs";
import { basename as basename3, extname as extname4, join as join8 } from "path";
import { homedir as homedir2 } from "os";
var SUPPORTED_EXTENSIONS = /* @__PURE__ */ new Set([".json", ".jsonc", ".toml"]);
function registerModelCommand(program2) {
  const model = new Command6("model").description("Inspect model configurations");
  model.command("list").alias("ls").description("List current and Starling-managed model configurations").option("-a, --agent <agent>", "filter by agent: claude | codex | all", "all").option("--json", "output JSON").action((opts) => {
    const agent = normalizeAgent2(opts.agent);
    if (!agent) {
      console.error(chalk7.red(`Unknown agent: ${opts.agent}`));
      process.exit(1);
    }
    const rows = collectModelConfigs(agent);
    if (opts.json) {
      console.log(JSON.stringify(rows, null, 2));
      return;
    }
    printModelTable(rows);
  });
  model.command("add <name>").description("Add a Starling model profile").requiredOption("-a, --agent <agent>", "agent: claude | codex").requiredOption("--model <model>", "model name").option("--base-url <url>", "provider base URL").option("--api-key <key>", "API key/token").option("--provider <provider>", "provider name", "custom").option("--reasoning <effort>", "Codex reasoning effort").option("--wire-api <api>", "Codex wire_api: responses | chat", "responses").option("--force", "overwrite existing profile").option("--json", "output JSON").action((name, opts) => {
    const agent = normalizeAgent2(opts.agent);
    if (!agent || agent === "all") {
      console.error(chalk7.red(`Unknown agent: ${opts.agent}`));
      console.error(chalk7.gray("Allowed values: claude, codex"));
      process.exit(1);
    }
    const result = addModelProfile(name, agent, opts);
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(chalk7.green(`Added ${agent} model profile: ${result.name}`));
    console.log(chalk7.gray(`  Source: ${result.source}`));
  });
  model.command("delete <name>").aliases(["del", "rm"]).description("Delete a Starling model profile").requiredOption("-a, --agent <agent>", "agent: claude | codex").option("--json", "output JSON").action((name, opts) => {
    const agent = normalizeAgent2(opts.agent);
    if (!agent || agent === "all") {
      console.error(chalk7.red(`Unknown agent: ${opts.agent}`));
      console.error(chalk7.gray("Allowed values: claude, codex"));
      process.exit(1);
    }
    const result = deleteModelProfile(name, agent);
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(chalk7.green(`Deleted ${agent} model profile: ${result.name}`));
    for (const source of result.sources) {
      console.log(chalk7.gray(`  Removed: ${source}`));
    }
  });
  program2.addCommand(model);
}
function addModelProfile(name, agent, opts) {
  const profileName = normalizeProfileName2(name);
  if (agent === "codex") {
    const existing = getCodexProviderProfile(profileName);
    if (existing && !opts.force) {
      console.error(chalk7.red(`Model profile already exists: ${profileName}`));
      console.error(chalk7.gray(`  Source: ${existing.filePath}`));
      console.error(chalk7.gray("Use --force to overwrite it."));
      process.exit(1);
    }
  }
  const source = join8(DEFAULT_CLAUDE_SETTINGS_DIR, `${profileName}.json`);
  if (existsSync8(source) && !opts.force) {
    console.error(chalk7.red(`Model profile already exists: ${profileName}`));
    console.error(chalk7.gray(`  Source: ${source}`));
    console.error(chalk7.gray("Use --force to overwrite it."));
    process.exit(1);
  }
  const model = opts.model.trim();
  if (!model) {
    console.error(chalk7.red("Model name cannot be empty."));
    process.exit(1);
  }
  if (agent === "codex") {
    const saved = saveCodexProviderProfile(profileName, {
      apiKey: opts.apiKey?.trim() || "",
      baseUrl: opts.baseUrl?.trim() || "",
      model,
      modelProvider: opts.provider?.trim() || "custom",
      wireApi: opts.wireApi?.trim() || "responses",
      config: {
        model_reasoning_effort: opts.reasoning?.trim() || "",
        disable_response_storage: true
      }
    });
    return { agent, name: profileName, source: saved.filePath, model };
  }
  const payload = buildClaudeProfile(opts, model);
  atomicWriteJSON(source, payload);
  return { agent, name: profileName, source, model };
}
function deleteModelProfile(name, agent) {
  const profileName = normalizeProfileName2(name);
  const sources = findModelProfileSources(profileName, agent);
  if (sources.length === 0) {
    const dir = agent === "claude" ? DEFAULT_CLAUDE_SETTINGS_DIR : DEFAULT_CODEX_SETTINGS_DIR;
    const extensions = agent === "claude" ? ".json or .jsonc" : ".toml, .json, or .jsonc";
    console.error(chalk7.red(`Model profile not found: ${profileName}`));
    console.error(chalk7.gray(`  Agent: ${agent}`));
    console.error(chalk7.gray(`  Expected under: ${dir}`));
    console.error(chalk7.gray(`  Supported files: ${profileName}${extensions}`));
    process.exit(1);
  }
  for (const source of sources) {
    unlinkSync7(source);
  }
  return { agent, name: profileName, sources };
}
function findModelProfileSources(profileName, agent) {
  const dir = agent === "claude" ? DEFAULT_CLAUDE_SETTINGS_DIR : DEFAULT_CODEX_SETTINGS_DIR;
  const extensions = agent === "claude" ? [".json", ".jsonc"] : [".toml", ".json", ".jsonc"];
  return extensions.map((extension) => join8(dir, `${profileName}${extension}`)).filter((source) => existsSync8(source));
}
function buildClaudeProfile(opts, model) {
  const env = {
    ANTHROPIC_AUTH_TOKEN: opts.apiKey?.trim() || "",
    ANTHROPIC_BASE_URL: opts.baseUrl?.trim() || "",
    API_TIMEOUT_MS: "3000000",
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    ANTHROPIC_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model
  };
  return {
    env,
    enableAllProjectMcpServers: true,
    permissions: {
      allow: [
        "Edit:*",
        "Write:*",
        "MultiEdit:*",
        "NotebookEdit:*",
        "Bash:*"
      ],
      defaultMode: "plan"
    }
  };
}
function normalizeProfileName2(name) {
  const normalized = basename3(name).replace(/\.(jsonc?|toml)$/i, "").trim();
  if (!normalized || normalized === "." || normalized === "..") {
    console.error(chalk7.red(`Invalid model profile name: ${name}`));
    process.exit(1);
  }
  if (!/^[A-Za-z0-9._-]+$/.test(normalized)) {
    console.error(chalk7.red("Model profile name may only contain letters, numbers, dot, dash, and underscore."));
    process.exit(1);
  }
  return normalized;
}
function normalizeAgent2(value) {
  const normalized = (value || "all").trim().toLowerCase();
  if (normalized === "all") return "all";
  if (normalized === "claude") return "claude";
  if (normalized === "codex" || normalized === "code") return "codex";
  return null;
}
function collectModelConfigs(agent) {
  const rows = [];
  if (agent === "all" || agent === "claude") {
    rows.push(...collectClaudeConfigs());
  }
  if (agent === "all" || agent === "codex") {
    rows.push(...collectCodexConfigs());
  }
  return rows;
}
function collectClaudeConfigs() {
  const currentPath = join8(homedir2(), ".claude", "settings.json");
  return [
    summarizeClaudeJson(currentPath, "current", "current"),
    ...listProfileFiles(DEFAULT_CLAUDE_SETTINGS_DIR).map(
      (filePath) => summarizeClaudeProfile(filePath, basename3(filePath, extname4(filePath)))
    )
  ];
}
function collectCodexConfigs() {
  migrateCodexJsonProfilesToToml();
  const currentPath = join8(DEFAULT_CODEX_HOME, "config.toml");
  return [
    summarizeCodexToml(currentPath, "current", "current", readCodexAuthState()),
    ...listProfileFiles(DEFAULT_CODEX_SETTINGS_DIR).map(
      (filePath) => summarizeCodexProfile(filePath, basename3(filePath, extname4(filePath)))
    )
  ];
}
function listProfileFiles(dir) {
  if (!existsSync8(dir)) return [];
  return readdirSync5(dir, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => join8(dir, entry.name)).filter((filePath) => SUPPORTED_EXTENSIONS.has(extname4(filePath).toLowerCase())).sort((a, b) => a.localeCompare(b));
}
function summarizeClaudeProfile(filePath, name) {
  const extension = extname4(filePath).toLowerCase();
  if (extension !== ".json" && extension !== ".jsonc") {
    return {
      agent: "claude",
      scope: "profile",
      name,
      source: filePath,
      exists: true,
      error: `Unsupported Claude profile format: ${extension}`
    };
  }
  return summarizeClaudeJson(filePath, name, "profile");
}
function summarizeClaudeJson(filePath, name, scope) {
  const base = {
    agent: "claude",
    scope,
    name,
    source: filePath,
    exists: existsSync8(filePath)
  };
  if (!base.exists) return base;
  try {
    const parsed = parseJsonFile(filePath);
    const env = isRecord6(parsed.env) ? parsed.env : parsed;
    const model = stringValue4(env.ANTHROPIC_MODEL) || stringValue4(env.CLAUDE_MODEL) || stringValue4(env.ANTHROPIC_DEFAULT_SONNET_MODEL) || stringValue4(parsed.model);
    const provider = inferProviderName(stringValue4(env.ANTHROPIC_BASE_URL) || stringValue4(env.CLAUDE_BASE_URL));
    return {
      ...base,
      model,
      provider,
      baseUrl: stringValue4(env.ANTHROPIC_BASE_URL) || stringValue4(env.CLAUDE_BASE_URL),
      reasoning: stringValue4(env.ANTHROPIC_REASONING_EFFORT) || stringValue4(parsed.reasoning),
      auth: describeAuth(env, ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "CLAUDE_API_KEY"])
    };
  } catch (error) {
    return { ...base, error: formatError(error) };
  }
}
function summarizeCodexProfile(filePath, name) {
  const extension = extname4(filePath).toLowerCase();
  if (extension === ".toml") {
    return summarizeCodexToml(filePath, name, "profile", readCodexTomlAuthState(filePath));
  }
  if (extension !== ".json" && extension !== ".jsonc") {
    return {
      agent: "codex",
      scope: "profile",
      name,
      source: filePath,
      exists: true,
      error: `Unsupported Codex profile format: ${extension}`
    };
  }
  const base = {
    agent: "codex",
    scope: "profile",
    name,
    source: filePath,
    exists: true
  };
  try {
    const parsed = parseJsonFile(filePath);
    const config = isRecord6(parsed.config) ? parsed.config : parsed;
    const auth = isRecord6(parsed.auth) ? describeAuth(parsed.auth, ["OPENAI_API_KEY", "api_key", "apiKey"]) : "none";
    return summarizeCodexConfigObject(base, config, auth);
  } catch (error) {
    return { ...base, error: formatError(error) };
  }
}
function summarizeCodexToml(filePath, name, scope, auth) {
  const base = {
    agent: "codex",
    scope,
    name,
    source: filePath,
    exists: existsSync8(filePath),
    auth
  };
  if (!base.exists) return base;
  try {
    const raw = readFileSync7(filePath, "utf-8");
    const provider = parseTomlValue(raw, "model_provider");
    const providerSection = provider ? parseTomlSection(raw, `model_providers.${provider}`) : {};
    return {
      ...base,
      model: parseTomlValue(raw, "model"),
      provider: stringValue4(providerSection.name) || provider,
      baseUrl: stringValue4(providerSection.base_url),
      reasoning: parseTomlValue(raw, "model_reasoning_effort"),
      wireApi: stringValue4(providerSection.wire_api)
    };
  } catch (error) {
    return { ...base, error: formatError(error) };
  }
}
function summarizeCodexConfigObject(base, config, auth) {
  const providerKey = stringValue4(config.model_provider);
  const providers = isRecord6(config.model_providers) ? config.model_providers : {};
  const providerConfig = providerKey && isRecord6(providers[providerKey]) ? providers[providerKey] : {};
  const providerRecord = isRecord6(providerConfig) ? providerConfig : {};
  return {
    ...base,
    model: stringValue4(config.model),
    provider: stringValue4(providerRecord.name) || providerKey,
    baseUrl: stringValue4(providerRecord.base_url),
    reasoning: stringValue4(config.model_reasoning_effort),
    wireApi: stringValue4(providerRecord.wire_api),
    auth
  };
}
function readCodexAuthState() {
  const authPath = join8(DEFAULT_CODEX_HOME, "auth.json");
  if (!existsSync8(authPath)) return "none";
  try {
    const parsed = parseJsonFile(authPath);
    if (hasAnySecret(parsed, ["OPENAI_API_KEY", "api_key", "apiKey", "access_token", "refresh_token"])) {
      return "stored";
    }
    return Object.keys(parsed).length > 0 ? "stored" : "none";
  } catch {
    return "unreadable";
  }
}
function readCodexTomlAuthState(filePath) {
  if (!existsSync8(filePath)) return "none";
  try {
    const raw = readFileSync7(filePath, "utf-8");
    return /^\s*(experimental_bearer_token|OPENAI_API_KEY)\s*=\s*["'][^"']+["']/m.test(raw) ? "configured" : "none";
  } catch {
    return "unreadable";
  }
}
function printModelTable(rows) {
  if (rows.length === 0) {
    console.log(chalk7.yellow("No model configurations found."));
    return;
  }
  const claudeRows = rows.filter((row) => row.agent === "claude");
  const codexRows = rows.filter((row) => row.agent === "codex");
  if (claudeRows.length > 0) {
    console.log(chalk7.bold("Claude"));
    console.log(formatModelTable(claudeRows));
  }
  if (codexRows.length > 0) {
    if (claudeRows.length > 0) console.log("");
    console.log(chalk7.bold("Codex"));
    console.log(formatModelTable(codexRows));
  }
}
function formatModelTable(rows) {
  const table = new Table4({
    head: [
      chalk7.green("Name"),
      chalk7.green("Model"),
      chalk7.green("Auth"),
      chalk7.green("Source")
    ],
    colWidths: [12, 28, 12, 76],
    wordWrap: true,
    style: { head: [] }
  });
  for (const row of rows) {
    const source = row.exists ? row.source : chalk7.gray(`${row.source} (missing)`);
    const model = row.error ? chalk7.red("error") : row.model || "-";
    const auth = row.error ? truncate(row.error, 10) : row.auth || "-";
    table.push([
      row.scope === "current" && row.name === "current" ? "default" : row.name,
      model,
      auth,
      source
    ]);
  }
  return table.toString();
}
function parseJsonFile(filePath) {
  const raw = readFileSync7(filePath, "utf-8");
  const parsed = JSON.parse(stripJsonComments3(raw));
  if (!isRecord6(parsed)) {
    throw new Error("JSON root is not an object");
  }
  return parsed;
}
function stripJsonComments3(raw) {
  return raw.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}
function parseTomlValue(raw, key) {
  const pattern = new RegExp(`^\\s*${escapeRegex(key)}\\s*=\\s*(.+?)\\s*(?:#.*)?$`, "m");
  const match = raw.match(pattern);
  if (!match) return "";
  return unquoteTomlValue(match[1].trim());
}
function parseTomlSection(raw, section) {
  const result = {};
  const lines = raw.split(/\r?\n/);
  let inSection = false;
  for (const line of lines) {
    const sectionMatch = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (sectionMatch) {
      inSection = sectionMatch[1] === section;
      continue;
    }
    if (!inSection) continue;
    const kv = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=\s*(.+?)\s*(?:#.*)?$/);
    if (kv) result[kv[1]] = unquoteTomlValue(kv[2].trim());
  }
  return result;
}
function unquoteTomlValue(value) {
  if (value.startsWith('"') && value.endsWith('"') || value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return value;
}
function describeAuth(source, keys) {
  return hasAnySecret(source, keys) ? "configured" : "none";
}
function hasAnySecret(source, keys) {
  return keys.some((key) => typeof source[key] === "string" && source[key].trim().length > 0);
}
function inferProviderName(baseUrl) {
  if (!baseUrl) return "";
  try {
    const host = new URL(baseUrl).hostname.replace(/^api\./, "");
    return host.split(".")[0] || "";
  } catch {
    return "";
  }
}
function truncate(value, max) {
  return value.length > max ? `${value.slice(0, max - 1)}\u2026` : value;
}
function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}
function stringValue4(value) {
  return typeof value === "string" ? value : "";
}
function isRecord6(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// src/commands/config.ts
import { copyFileSync, cpSync, existsSync as existsSync9, readFileSync as readFileSync8 } from "fs";
import { homedir as homedir3 } from "os";
import { join as join9, resolve as resolve3 } from "path";
import { Command as Command7 } from "commander";
import chalk8 from "chalk";
function registerConfigCommand(program2) {
  const config = new Command7("config").description("Manage Starling CLI settings");
  config.command("show").alias("ls").description("Show Starling CLI settings").option("--json", "output JSON").action((opts) => {
    const fileConfig = readCliConfig();
    const payload = {
      configPath: CLI_CONFIG_PATH,
      configuredHomePath: fileConfig.homePath ?? null,
      effectiveHomePath: DEFAULT_STARLING_HOME,
      homeSource: STARLING_HOME_SOURCE,
      storePath: DEFAULT_STORE_PATH,
      settingsPath: DEFAULT_STARLING_SETTINGS_DIR
    };
    if (opts.json) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }
    console.log(chalk8.green("Starling config"));
    console.log(`  Config:   ${payload.configPath}`);
    console.log(`  Home:     ${payload.effectiveHomePath}`);
    console.log(`  Source:   ${payload.homeSource}`);
    if (payload.configuredHomePath) {
      console.log(`  Saved:    ${payload.configuredHomePath}`);
    }
    console.log(`  Store:    ${payload.storePath}`);
    console.log(`  Settings: ${payload.settingsPath}`);
  });
  config.command("set <key> <value>").description("Set a Starling CLI setting").option("--migrate", "copy existing Starling metadata into the new home when target files do not exist").action((key, value, opts) => {
    if (key !== "home") {
      console.error(chalk8.red(`Unknown config key: ${key}`));
      console.error(chalk8.gray("Allowed keys: home"));
      process.exit(1);
    }
    const homePath = normalizeHomePath(value);
    const migrated = opts.migrate ? migrateStarlingData(homePath) : [];
    const fileConfig = readCliConfig();
    fileConfig.homePath = homePath;
    atomicWriteJSON(CLI_CONFIG_PATH, fileConfig);
    console.log(chalk8.green("Updated Starling config"));
    console.log(`  Home:   ${homePath}`);
    console.log(`  Config: ${CLI_CONFIG_PATH}`);
    for (const entry of migrated) {
      console.log(chalk8.gray(`  Migrated: ${entry}`));
    }
    if (process.env.STARLING_HOME?.trim()) {
      console.log(chalk8.yellow("  Note: STARLING_HOME is currently set and overrides this saved value for this process."));
    }
  });
  config.command("unset <key>").description("Unset a Starling CLI setting").action((key) => {
    if (key !== "home") {
      console.error(chalk8.red(`Unknown config key: ${key}`));
      console.error(chalk8.gray("Allowed keys: home"));
      process.exit(1);
    }
    const fileConfig = readCliConfig();
    delete fileConfig.homePath;
    atomicWriteJSON(CLI_CONFIG_PATH, fileConfig);
    console.log(chalk8.green("Updated Starling config"));
    console.log("  Home:   default");
    console.log(`  Config: ${CLI_CONFIG_PATH}`);
  });
  program2.addCommand(config);
}
function readCliConfig() {
  if (!existsSync9(CLI_CONFIG_PATH)) return {};
  try {
    const parsed = JSON.parse(readFileSync8(CLI_CONFIG_PATH, "utf-8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const homePath = parsed.homePath;
    return typeof homePath === "string" && homePath.trim() ? { homePath: homePath.trim() } : {};
  } catch {
    return {};
  }
}
function normalizeHomePath(value) {
  const trimmed = value.trim();
  if (!trimmed) {
    console.error(chalk8.red("Home path cannot be empty."));
    process.exit(1);
  }
  if (trimmed === "~") return homedir3();
  if (trimmed.startsWith("~/")) return resolve3(homedir3(), trimmed.slice(2));
  return resolve3(trimmed);
}
function migrateStarlingData(targetHome) {
  const migrated = [];
  const targetStore = join9(targetHome, "store.json");
  if (existsSync9(DEFAULT_STORE_PATH) && !existsSync9(targetStore)) {
    ensureDir(targetStore);
    copyFileSync(DEFAULT_STORE_PATH, targetStore);
    migrated.push(targetStore);
  }
  const targetSettings = join9(targetHome, "settings");
  if (existsSync9(DEFAULT_STARLING_SETTINGS_DIR) && !existsSync9(targetSettings)) {
    ensureDir(targetSettings);
    cpSync(DEFAULT_STARLING_SETTINGS_DIR, targetSettings, { recursive: true });
    migrated.push(targetSettings);
  }
  for (const name of ["session-index.json", "project-session-index.json", "codex-provider.json"]) {
    const source = join9(DEFAULT_STARLING_HOME, name);
    const target = join9(targetHome, name);
    if (existsSync9(source) && !existsSync9(target)) {
      ensureDir(target);
      copyFileSync(source, target);
      migrated.push(target);
    }
  }
  return migrated;
}

// package.json
var package_default = {
  name: "starling-ai",
  version: "0.0.11",
  description: "Agent session manager \u2014 discover, bookmark, and organize AI coding sessions",
  type: "module",
  repository: {
    type: "git",
    url: "https://github.com/huang-sh/Starling"
  },
  bin: {
    starling: "dist/index.js"
  },
  files: [
    "dist",
    "skills",
    "scripts/install-agent-skills.js",
    "docs",
    "package.json",
    "README.md",
    "LICENSE"
  ],
  scripts: {
    build: "tsup",
    dev: "tsup --watch",
    postinstall: "node scripts/install-agent-skills.js",
    "install:skill": "node scripts/install-agent-skills.js",
    prepack: "npm run build",
    test: "vitest run",
    lint: "tsc --noEmit"
  },
  dependencies: {
    chalk: "^5.3.0",
    "cli-table3": "^0.6.5",
    commander: "^12.1.0"
  },
  devDependencies: {
    "@types/node": "^20.14.0",
    tsup: "^8.1.0",
    typescript: "^5.5.0",
    vitest: "^1.6.0"
  },
  engines: {
    node: ">=20.0.0"
  },
  license: "MIT"
};

// src/index.ts
var program = new Command8();
program.enablePositionalOptions();
program.name("starling").description("Agent session manager \u2014 discover, pin, and organize AI coding sessions").version(package_default.version);
registerSessionCommand(program);
registerPinCommand(program);
registerSpaceCommand(program);
registerProjectCommand(program);
registerRunCommand(program);
registerModelCommand(program);
registerConfigCommand(program);
program.command("resume <session-id>").description("Resume an agent session directly").action(async (sessionId) => {
  await resumeSession(sessionId);
});
program.parse();
