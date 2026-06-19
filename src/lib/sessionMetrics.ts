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

export type ChatRole = "user" | "assistant";

export interface ToolCallEntry {
  name: string;
  /** file path / command prefix / pattern, truncated to MAX_TOOL_ARG_LEN. */
  arg: string;
  /** 0 when unknown. */
  duration_ms: number;
}

export interface ChatMessageEntry {
  role: ChatRole;
  /** redacted, truncated to MAX_CHAT_TEXT_LEN. */
  text: string;
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
  /** Epoch ms of first entry. 0 when tail-only read missed it. */
  startedAtMs: number;
  /** Last assistant turn with tool_use blocks not yet followed by a matching
   * user/tool_result. 0 when none in flight. */
  pendingSinceMs: number;
  /** Last user turn (prompt or tool_result) not yet followed by an assistant
   * response. 0 when none in flight. */
  thinkingSinceMs: number;
  /** Cumulative tokens at each assistant turn, tail-truncated to 32. */
  tokenHistory: number[];
  /** Context size at each assistant turn, tail-truncated to 32. */
  contextHistory: number[];
  /** Count of >30% drops between consecutive context_history entries. */
  compactionCount: number;
  /** Argument of the most-recent tool_use (file path / command / pattern). */
  currentTask: string;
  /** Tail of tool invocations (newest last), max 12. */
  toolCallsTail: ToolCallEntry[];
  /** Tail of user/assistant text (newest last), max 6. Tool inputs/results excluded. */
  chatTail: ChatMessageEntry[];
}

const FULL_READ_THRESHOLD = 8 * 1024 * 1024; // 8MB
const TAIL_BYTES = 65536;
const MAX_LINES = 100000;

const DEFAULT_WINDOW = 200000;

const MAX_TOKEN_HISTORY = 32;
const MAX_TOOL_TAIL = 12;
const MAX_CHAT_TAIL = 6;
const MAX_TOOL_ARG_LEN = 60;
const MAX_CHAT_TEXT_LEN = 200;
const COMPACTION_DROP_RATIO = 0.3;

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

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

function extractToolUseArg(name: string, input: unknown): string {
  if (!isRecord(input)) return "";
  const lowName = name.toLowerCase();
  if (lowName === "bash") {
    const c = input.command;
    return typeof c === "string" ? c : "";
  }
  if (lowName === "grep" || lowName === "glob") {
    const p = input.pattern;
    return typeof p === "string" ? p : "";
  }
  const fp = input.file_path;
  if (typeof fp === "string") return fp;
  const sat = input.subagent_type;
  if (typeof sat === "string") return sat;
  const desc = input.description;
  if (typeof desc === "string") return desc;
  try {
    return JSON.stringify(input);
  } catch {
    return "";
  }
}

function parseEntryTimestamp(entry: JsonlEntry): number {
  const ts = entry.timestamp;
  if (typeof ts === "string") {
    const ms = Date.parse(ts);
    return Number.isFinite(ms) ? ms : 0;
  }
  if (typeof ts === "number" && Number.isFinite(ts)) {
    return ts > 1e12 ? ts : ts * 1000; // seconds → ms
  }
  return 0;
}

interface ContentBlocks {
  text: string[];
  toolResult: boolean;
  toolUse: { name: string; input: unknown }[];
}

/**
 * Single pass over `message.content` — collects text / tool_use / tool_result
 * parts in one walk so the reducer doesn't iterate the content array twice
 * per assistant turn (matters on long transcripts with many turns).
 */
function extractContentBlocks(entry: JsonlEntry): ContentBlocks {
  const msg = isRecord(entry.message) ? entry.message : null;
  const out: ContentBlocks = { text: [], toolResult: false, toolUse: [] };
  if (!msg) return out;
  if (typeof msg.content === "string") {
    out.text.push(msg.content);
    return out;
  }
  if (Array.isArray(msg.content)) {
    for (const part of msg.content) {
      if (!isRecord(part)) continue;
      if (part.type === "text" && typeof part.text === "string") {
        out.text.push(part.text);
      } else if (part.type === "tool_use" && typeof part.name === "string") {
        out.toolUse.push({ name: part.name, input: part.input });
      } else if (part.type === "tool_result") {
        out.toolResult = true;
      }
    }
  }
  return out;
}

function reduceEntries(entries: JsonlEntry[], lastActivityMs: number, truncated: boolean): SessionLive {
  let model = "";
  const tokens: SessionTokens = { input: 0, output: 0, cache: 0, total: 0 };
  let lastUsage: AssistantUsage | null = null;
  let lastTool: string | null = null;
  let toolCount = 0;
  let startedAtMs = 0;
  let pendingSinceMs = 0;
  let thinkingSinceMs = 0;
  let currentTask = "";
  const tokenHistory: number[] = [];
  const contextHistory: number[] = [];
  const toolCallsTail: ToolCallEntry[] = [];
  const chatTail: ChatMessageEntry[] = [];

  for (const entry of entries) {
    if (!model) {
      const m = extractModel(entry);
      if (m) model = m;
    }
    const ts = parseEntryTimestamp(entry);
    if (startedAtMs === 0 && ts > 0) startedAtMs = ts;

    const usage = extractAssistantUsage(entry);
    if (usage) {
      tokens.input += usage.input;
      tokens.output += usage.output;
      tokens.cache += usage.cacheCreation + usage.cacheRead;
      lastUsage = usage;
    }

    const isAssistant = entry.type === "assistant" || entry.type === "function_call";
    const isUser = entry.type === "user" || entry.type === "human" || entry.type === "function_call_output";

    // Skip content extraction entirely for entries that never carry user/assistant
    // content (summaries, custom-titles, system lines, …) — most transcripts are
    // dominated by these, so this early-out avoids an empty ContentBlocks alloc
    // and a redundant msg.content lookup per entry.
    const blocks = isAssistant || isUser ? extractContentBlocks(entry) : null;
    // Codex function_call carries .name + .arguments directly (no message.content).
    let toolUses = blocks?.toolUse ?? [];
    if (toolUses.length === 0 && entry.type === "function_call" && typeof entry.name === "string") {
      let input: unknown = {};
      const args = entry.arguments;
      if (typeof args === "string") {
        try { input = JSON.parse(args); } catch { /* ignore */ }
      } else if (isRecord(args)) {
        input = args;
      }
      toolUses = [{ name: entry.name, input }];
    }

    if (toolUses.length > 0) {
      toolCount += toolUses.length;
      const lastUse = toolUses[toolUses.length - 1]!;
      lastTool = lastUse.name;
      currentTask = truncate(extractToolUseArg(lastUse.name, lastUse.input), MAX_TOOL_ARG_LEN);
      for (const tu of toolUses) {
        const arg = truncate(extractToolUseArg(tu.name, tu.input), MAX_TOOL_ARG_LEN);
        toolCallsTail.push({ name: tu.name, arg, duration_ms: 0 });
        if (toolCallsTail.length > MAX_TOOL_TAIL) toolCallsTail.shift();
      }
    }

    // Token/context history: capture at each assistant turn that has usage.
    if (isAssistant && usage) {
      const ctxSize = usage.input + usage.cacheCreation + usage.cacheRead;
      tokenHistory.push(tokens.input + tokens.output + tokens.cache);
      if (tokenHistory.length > MAX_TOKEN_HISTORY) tokenHistory.shift();
      contextHistory.push(ctxSize);
      if (contextHistory.length > MAX_TOKEN_HISTORY) contextHistory.shift();
    }

    // State machine for pending/thinking + chat tail.
    if (isAssistant) {
      thinkingSinceMs = 0;
      if (toolUses.length > 0) pendingSinceMs = ts || lastActivityMs;
      if (blocks) {
        for (const t of blocks.text) {
          if (t.trim()) {
            chatTail.push({ role: "assistant", text: truncate(t, MAX_CHAT_TEXT_LEN) });
            if (chatTail.length > MAX_CHAT_TAIL) chatTail.shift();
          }
        }
      }
    } else if (isUser && blocks) {
      pendingSinceMs = 0;
      thinkingSinceMs = ts || lastActivityMs;
      // Skip tool_result-only entries — they don't carry user-facing text.
      if (!blocks.toolResult) {
        for (const t of blocks.text) {
          if (t.trim()) {
            chatTail.push({ role: "user", text: truncate(t, MAX_CHAT_TEXT_LEN) });
            if (chatTail.length > MAX_CHAT_TAIL) chatTail.shift();
          }
        }
      }
    }
  }

  tokens.total = tokens.input + tokens.output;

  let ctxPct = -1;
  if (lastUsage) {
    const ctxInput = lastUsage.input + lastUsage.cacheCreation + lastUsage.cacheRead;
    const window = modelContextWindow(model);
    if (window > 0) ctxPct = (ctxInput / window) * 100;
  }

  let compactionCount = 0;
  for (let i = 1; i < contextHistory.length; i++) {
    const prev = contextHistory[i - 1]!;
    const cur = contextHistory[i]!;
    if (prev > 0 && cur < prev * (1 - COMPACTION_DROP_RATIO)) compactionCount++;
  }

  return {
    model,
    tokens,
    ctxPct,
    lastTool,
    toolCount,
    lastActivityMs,
    truncated,
    startedAtMs,
    pendingSinceMs,
    thinkingSinceMs,
    tokenHistory,
    contextHistory,
    compactionCount,
    currentTask,
    toolCallsTail,
    chatTail,
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
    startedAtMs: 0,
    pendingSinceMs: 0,
    thinkingSinceMs: 0,
    tokenHistory: [],
    contextHistory: [],
    compactionCount: 0,
    currentTask: "",
    toolCallsTail: [],
    chatTail: [],
  };
}
