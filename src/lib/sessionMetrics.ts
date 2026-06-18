/**
 * Live per-session metrics parsed from a session JSONL file: cumulative tokens,
 * context-window pressure (CTX%), last tool, tool count, model. Results are
 * mtime-cached so a 3s monitor tick only re-parses files that changed.
 *
 * Small files (<= FULL_READ_THRESHOLD) are parsed in full so totals are exact.
 * Larger files fall back to a tail read so the "latest" values (CTX%, last
 * tool) stay fresh; totals are then marked truncated.
 */
import { openSync, readSync, closeSync, statSync } from "fs";
import { parseJsonlHead, type JsonlEntry } from "./session.js";

export interface SessionTokens {
  input: number;
  output: number;
  cache: number;
  total: number;
}

export interface SessionLive {
  model: string;
  tokens: SessionTokens;
  /** 0..100+ context-window pressure; -1 when unknown (no usage / no window). */
  ctxPct: number;
  lastTool: string | null;
  toolCount: number;
  lastActivityMs: number;
  truncated: boolean;
}

const FULL_READ_THRESHOLD = 8 * 1024 * 1024; // 8MB
const TAIL_BYTES = 65536;
const MAX_LINES = 100000;

const DEFAULT_WINDOW = 200000;

/** Context window (input tokens) for a model, matched by substring. */
export function modelContextWindow(model: string | null | undefined): number {
  if (!model) return DEFAULT_WINDOW;
  const m = model.toLowerCase();
  if (m.includes("1m") || m.includes("1000k")) return 1000000;
  // All modern Claude / Codex models we care about are 200k.
  return DEFAULT_WINDOW;
}

interface CacheEntry {
  mtimeMs: number;
  result: SessionLive;
}
const cache = new Map<string, CacheEntry>();

export function clearSessionMetricsCache(): void {
  cache.clear();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
function asNum(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return 0;
}

interface AssistantUsage {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
}

function extractAssistantUsage(entry: JsonlEntry): AssistantUsage | null {
  const msg = isRecord(entry.message) ? entry.message : null;
  const u = msg && isRecord(msg.usage) ? msg.usage : isRecord(entry.usage) ? entry.usage : null;
  if (!u) return null;
  const input =
    asNum(u.input_tokens ?? u.inputTokens) +
    asNum(u.prompt_tokens ?? u.promptTokens); // pick whichever is present
  const output = asNum(u.output_tokens ?? u.outputTokens ?? u.completion_tokens ?? u.completionTokens);
  const cacheCreation = asNum(u.cache_creation_input_tokens ?? u.cacheCreationInputTokens);
  const cacheRead = asNum(u.cache_read_input_tokens ?? u.cacheReadInputTokens);
  if (!input && !output && !cacheCreation && !cacheRead) return null;
  return { input, output, cacheCreation, cacheRead };
}

function extractModel(entry: JsonlEntry): string | null {
  const direct = typeof entry.model === "string" ? entry.model : null;
  if (direct && !direct.startsWith("<") && direct !== "synthetic") return direct;
  const msg = isRecord(entry.message) ? entry.message : null;
  const mm = msg && typeof msg.model === "string" ? msg.model : null;
  if (mm && !mm.startsWith("<") && mm !== "synthetic") return mm;
  return null;
}

function extractToolNames(entry: JsonlEntry): string[] {
  const names: string[] = [];
  // Claude: assistant message with content[].type === "tool_use"
  const msg = isRecord(entry.message) ? entry.message : null;
  const content = msg && Array.isArray(msg.content) ? msg.content : Array.isArray(entry.content) ? entry.content : null;
  if (content) {
    for (const part of content) {
      if (isRecord(part) && part.type === "tool_use" && typeof part.name === "string") {
        names.push(part.name);
      }
    }
  }
  // Codex: a function_call entry carries .name directly.
  if (entry.type === "function_call" && typeof entry.name === "string") names.push(entry.name);
  return names;
}

interface ReduceState {
  model: string;
  tokens: SessionTokens;
  lastUsage: AssistantUsage | null;
  lastTool: string | null;
  toolCount: number;
}

function reduceEntries(entries: JsonlEntry[], lastActivityMs: number, truncated: boolean): SessionLive {
  const st: ReduceState = {
    model: "",
    tokens: { input: 0, output: 0, cache: 0, total: 0 },
    lastUsage: null,
    lastTool: null,
    toolCount: 0,
  };

  for (const entry of entries) {
    if (!st.model) {
      const m = extractModel(entry);
      if (m) st.model = m;
    }
    const usage = extractAssistantUsage(entry);
    if (usage) {
      st.tokens.input += usage.input;
      st.tokens.output += usage.output;
      st.tokens.cache += usage.cacheCreation + usage.cacheRead;
      st.lastUsage = usage; // last wins → reflects current context size
    }
    const tools = extractToolNames(entry);
    if (tools.length > 0) {
      st.toolCount += tools.length;
      st.lastTool = tools[tools.length - 1]!;
    }
  }

  st.tokens.total = st.tokens.input + st.tokens.output;

  let ctxPct = -1;
  if (st.lastUsage) {
    const ctxInput = st.lastUsage.input + st.lastUsage.cacheCreation + st.lastUsage.cacheRead;
    const window = modelContextWindow(st.model);
    if (window > 0) ctxPct = (ctxInput / window) * 100;
  }

  return {
    model: st.model,
    tokens: st.tokens,
    ctxPct,
    lastTool: st.lastTool,
    toolCount: st.toolCount,
    lastActivityMs,
    truncated,
  };
}

function readTailEntries(filePath: string, size: number): JsonlEntry[] {
  const fd = openSync(filePath, "r");
  try {
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    let text = buf.toString("utf-8");
    // Drop the first (likely partial) line when we didn't start at byte 0.
    if (start > 0) {
      const nl = text.indexOf("\n");
      text = nl >= 0 ? text.slice(nl + 1) : "";
    }
    const entries: JsonlEntry[] = [];
    const lines = text.split("\n");
    for (let i = 0; i < lines.length && entries.length < MAX_LINES; i++) {
      const line = lines[i]!.trim();
      if (!line) continue;
      try {
        entries.push(JSON.parse(line));
      } catch {
        /* skip malformed */
      }
    }
    return entries;
  } finally {
    closeSync(fd);
  }
}

export async function getSessionLiveMetrics(filePath: string): Promise<SessionLive> {
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(filePath);
  } catch {
    return emptyLive(0);
  }

  const cached = cache.get(filePath);
  if (cached && cached.mtimeMs === st.mtimeMs) return cached.result;

  let result: SessionLive;
  if (st.size <= FULL_READ_THRESHOLD) {
    const entries = await parseJsonlHead(filePath, MAX_LINES);
    result = reduceEntries(entries, st.mtimeMs, false);
  } else {
    const entries = readTailEntries(filePath, st.size);
    result = reduceEntries(entries, st.mtimeMs, true);
  }

  cache.set(filePath, { mtimeMs: st.mtimeMs, result });
  return result;
}

export function emptyLive(lastActivityMs: number): SessionLive {
  return {
    model: "",
    tokens: { input: 0, output: 0, cache: 0, total: 0 },
    ctxPct: -1,
    lastTool: null,
    toolCount: 0,
    lastActivityMs,
    truncated: false,
  };
}
