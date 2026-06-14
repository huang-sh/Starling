import { createReadStream } from "fs";
import { createInterface } from "readline";
import type { SessionMeta } from "../types.js";

export interface JsonlEntry {
  type?: string;
  [key: string]: unknown;
}

type TokenUsage = NonNullable<SessionMeta["token_usage"]>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function mergeTokenUsage(target: TokenUsage, source: TokenUsage): void {
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

function hasNonZeroTokenUsage(usage: TokenUsage | null): usage is TokenUsage {
  if (!usage) return false;
  return Boolean(
    (usage.input_tokens ?? 0) > 0 ||
    (usage.output_tokens ?? 0) > 0 ||
    (usage.total_tokens ?? 0) > 0 ||
    (usage.cache_tokens ?? 0) > 0
  );
}

function addTokenUsage(target: TokenUsage, source: TokenUsage): void {
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
  if (target.input_tokens !== undefined || target.output_tokens !== undefined) {
    target.total_tokens = input + output;
  } else if (typeof source.total_tokens === "number") {
    target.total_tokens = (target.total_tokens ?? 0) + source.total_tokens;
  }
}

function normalizeCacheTokens(raw: Record<string, unknown>): number | undefined {
  const direct =
    asNumber(raw.cache_tokens) ??
    asNumber(raw.cacheTokens) ??
    asNumber(raw.cached_input_tokens) ??
    asNumber(raw.cachedInputTokens);
  if (typeof direct === "number") return direct;

  const fromCreation = asNumber(raw.cache_creation_input_tokens) ?? asNumber(raw.cacheCreationInputTokens);
  const fromRead = asNumber(raw.cache_read_input_tokens) ?? asNumber(raw.cacheReadInputTokens);
  if (typeof fromCreation === "number" || typeof fromRead === "number") {
    return (fromCreation ?? 0) + (fromRead ?? 0);
  }

  return undefined;
}

function extractTokenUsageFromValue(value: unknown, depth = 0): TokenUsage | null {
  if (depth > 16) return null;

  if (Array.isArray(value)) {
    const usage: TokenUsage = {};
    let found = false;
    for (const item of value) {
      const nestedUsage = extractTokenUsageFromValue(item, depth + 1);
      if (nestedUsage) {
        mergeTokenUsage(usage, nestedUsage);
        found = true;
      }
    }
    return found ? usage : null;
  }

  if (!isRecord(value)) return null;

  const totalUsageSource = isRecord(value.total_token_usage)
    ? value.total_token_usage
    : isRecord(value.totalTokenUsage)
      ? value.totalTokenUsage
      : null;
  if (totalUsageSource) {
    const totalUsage = extractTokenUsageFromValue(totalUsageSource, depth + 1);
    if (hasNonZeroTokenUsage(totalUsage)) return totalUsage;

    const lastUsageSource = isRecord(value.last_token_usage)
      ? value.last_token_usage
      : isRecord(value.lastTokenUsage)
        ? value.lastTokenUsage
        : null;
    const lastUsage = lastUsageSource ? extractTokenUsageFromValue(lastUsageSource, depth + 1) : null;
    return hasNonZeroTokenUsage(lastUsage) ? lastUsage : totalUsage;
  }

  const input =
    asNumber(value.input_tokens) ??
    asNumber(value.inputTokens) ??
    asNumber(value.prompt_tokens) ??
    asNumber(value.promptTokens);

  const output =
    asNumber(value.output_tokens) ??
    asNumber(value.outputTokens) ??
    asNumber(value.completion_tokens) ??
    asNumber(value.completionTokens);

  const total =
    asNumber(value.total_tokens) ??
    asNumber(value.totalTokens) ??
    (typeof input === "number" && typeof output === "number" ? input + output : undefined);

  const cache = normalizeCacheTokens(value);

  const usage: TokenUsage = {};
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

  if (
    usage.input_tokens === undefined &&
    usage.output_tokens === undefined &&
    usage.total_tokens === undefined &&
    usage.cache_tokens === undefined
  ) {
    return null;
  }

  return usage;
}

function extractTokenUsage(entry: JsonlEntry): TokenUsage | null {
  return extractTokenUsageFromValue(entry);
}

function hasCumulativeTokenUsage(value: unknown, depth = 0): boolean {
  if (depth > 16) return false;
  if (Array.isArray(value)) return value.some((item) => hasCumulativeTokenUsage(item, depth + 1));
  if (!isRecord(value)) return false;
  if (isRecord(value.total_token_usage) || isRecord(value.totalTokenUsage)) return true;
  return Object.values(value).some((candidate) => hasCumulativeTokenUsage(candidate, depth + 1));
}

export async function parseJsonlHead(filePath: string, maxLines = 500): Promise<JsonlEntry[]> {
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

export async function parseJsonlFile(filePath: string): Promise<JsonlEntry[]> {
  return parseJsonlHead(filePath, Infinity);
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
  const tokenUsage: TokenUsage = {};
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
        const msgModel = (entry.message as { model?: string }).model;
        if (msgModel && typeof msgModel === "string") candidate = msgModel;
      }
      // Skip synthetic/internal model placeholders
      if (candidate && !candidate.startsWith("<") && candidate !== "synthetic") {
        model = candidate;
      }
    }
    if (entry.cwd && typeof entry.cwd === "string" && !projectPath) {
      projectPath = entry.cwd;
    }
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
    ...(hasTokenUsage ? { token_usage: tokenUsage } : {}),
  };
}

export function extractCodexSessionMeta(
  entries: JsonlEntry[],
  filePath: string,
  modifiedAt: string
): SessionMeta | null {
  let sessionId = "";
  let model = "";
  let projectPath = "";
  let firstPrompt = "";
  const tokenUsage: TokenUsage = {};
  let hasTokenUsage = false;

  for (const entry of entries) {
    // Codex uses type: "session_meta" with payload
    if (entry.type === "session_meta" && entry.payload && typeof entry.payload === "object") {
      const p = entry.payload as {
        id?: string;
        cwd?: string;
        model_provider?: string;
        source?: string;
      };
      if (p.id && !sessionId) sessionId = p.id;
      if (p.cwd && !projectPath) projectPath = p.cwd;
      if (p.model_provider && !model) model = p.model_provider;
    }
    // Extract first user message from event_msg
    if (entry.type === "event_msg" && entry.payload && typeof entry.payload === "object") {
      const p = entry.payload as { type?: string; content?: string };
      if (p.type === "user_message" && p.content && !firstPrompt) {
        firstPrompt = p.content;
      }
    }
    // Codex turn_context has the actual model name
    if (entry.type === "turn_context" && entry.payload && typeof entry.payload === "object") {
      const p = entry.payload as { model?: string };
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
    ...(hasTokenUsage ? { token_usage: tokenUsage } : {}),
  };
}
