import { execFile } from "child_process";
import { promisify } from "util";
import * as vscode from "vscode";

const execFileAsync = promisify(execFile);
const DEFAULT_MAX_BUFFER = 50 * 1024 * 1024;
const DEFAULT_JSON_TIMEOUT = 60_000;
const DEFAULT_TEXT_TIMEOUT = 30_000;
const DEFAULT_CACHE_TTL_SECONDS = 30;
const DEFAULT_SESSION_ALL_FALLBACK_LIMIT = 10000;

type CliExecOptions = {
  timeout: number;
  maxBuffer?: number;
};

export class StarlingCliNotFoundError extends Error {
  constructor(public readonly cliPath: string) {
    super(`Starling CLI was not found: ${cliPath}`);
    this.name = "StarlingCliNotFoundError";
  }
}

export interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  cache_tokens?: number;
}

export interface SessionMeta {
  session_id: string;
  provider: string;
  model: string | null;
  project_path: string | null;
  file_path: string;
  created_at: string;
  modified_at: string;
  first_prompt: string | null;
  token_usage?: TokenUsage;
  catalogs?: Array<{ id: string; name: string }>;
}

export interface Note {
  id: string;
  content: string;
  created_at: string;
}

export interface Bookmark {
  id: string;
  provider: string;
  session_id: string;
  title: string;
  category: string;
  tags: string[];
  project_path: string;
  first_prompt: string;
  notes: Note[];
  space_ids: string[];
  created_at: string;
  updated_at: string;
}

export interface Space {
  id: string;
  name: string;
  description: string;
  parent_id: string | null;
  tags: string[];
  created_at: string;
  updated_at: string;
}

export interface SpaceWithPins extends Space {
  pins?: Bookmark[];
  session_count?: number;
  pin_count?: number;
}

export interface ProjectSummary {
  project_path: string;
  session_count: number;
  agents: Record<string, number>;
  models: Record<string, number>;
  first_active: string;
  last_active: string;
}

export interface ProjectDetails extends ProjectSummary {
  sessions: SessionMeta[];
}

type CacheEntry = {
  expiresAt: number;
  value: Promise<unknown>;
};

const commandCache = new Map<string, CacheEntry>();

function cacheTtlMs(): number {
  const configured = vscode.workspace.getConfiguration("starling").get<number>("cacheTtlSeconds", DEFAULT_CACHE_TTL_SECONDS);
  const normalized = Number(configured);
  if (!Number.isFinite(normalized) || normalized < 0) return DEFAULT_CACHE_TTL_SECONDS * 1000;
  return normalized * 1000;
}

function getCachedResult<T>(cacheKey: string, fetcher: () => Promise<T>): Promise<T> {
  const ttl = cacheTtlMs();
  if (ttl <= 0) {
    return fetcher();
  }

  const cached = commandCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value as Promise<T>;
  }

  const promise = fetcher();
  const expiresAt = Date.now() + ttl;
  const value = promise as Promise<unknown>;
  commandCache.set(cacheKey, { expiresAt, value });

  promise.catch(() => {
    const entry = commandCache.get(cacheKey);
    if (entry && entry.value === value) {
      commandCache.delete(cacheKey);
    }
  });

  return promise;
}

function cacheKeyForCommand(args: string[]): string {
  const command = starlingCommand(args);
  return [command.file, ...command.args].join("\u0000");
}

export function clearCliCache(prefix?: string): void {
  if (!prefix) {
    commandCache.clear();
    return;
  }
  for (const key of commandCache.keys()) {
    if (key.startsWith(prefix)) {
      commandCache.delete(key);
    }
  }
}

function starlingBin(): string {
  return vscode.workspace.getConfiguration("starling").get<string>("cliPath", "starling");
}

function starlingCommand(args: string[]): { file: string; args: string[] } {
  const configured = process.env.STARLING_BIN;
  if (configured) {
    return { file: configured, args };
  }
  return { file: starlingBin(), args };
}

async function execStarlingRaw(args: string[], options: Partial<CliExecOptions> = {}): Promise<string> {
  const command = starlingCommand(args);
  try {
    const { stdout } = await execFileAsync(command.file, command.args, {
      maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
      timeout: options.timeout ?? DEFAULT_TEXT_TIMEOUT,
    });
    return stdout as string;
  } catch (err) {
    if (isCommandNotFoundError(err)) {
      throw new StarlingCliNotFoundError(command.file);
    }
    const message = err instanceof Error ? err.message : String(err);
    const anyError = err as {
      stdout?: string;
      stderr?: string;
      code?: number | string;
    };
    const stdout = sanitizeCliOutput(anyError?.stdout);
    const stderr = sanitizeCliOutput(anyError?.stderr);
    const commandText = `${command.file} ${command.args.join(" ")}`;
    const details: string[] = [];
    if (stdout) details.push(`stdout=${stdout}`);
    if (stderr) details.push(`stderr=${stderr}`);
    if (anyError?.code !== undefined) details.push(`code=${anyError.code}`);
    throw new Error(`starling command failed: ${commandText}${details.length ? `: ${details.join(" | ")}` : ""}`);
  }
}

function isCommandNotFoundError(err: unknown): boolean {
  const anyError = err as { code?: unknown; errno?: unknown; syscall?: unknown; path?: unknown; message?: unknown };
  if (anyError?.code === "ENOENT") return true;
  const message = typeof anyError?.message === "string" ? anyError.message : "";
  return message.includes("ENOENT") || message.includes("not found");
}

function sanitizeCliOutput(value: string | undefined): string {
  if (!value) return "";
  const trimmed = String(value).replace(/\x1b\[[0-9;]*m/g, "").replace(/\r/g, "").trim();
  if (!trimmed) return "";
  return trimmed.length > 300 ? `${trimmed.slice(0, 297)}…` : trimmed;
}

function parseJsonOutput<T>(stdout: string, commandLabel: string): T {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error(`${commandLabel} returned empty output`);
  }
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    const jsonText = extractJsonText(trimmed);
    if (!jsonText) {
      throw new Error(`${commandLabel} returned invalid JSON. Output preview: ${trimmed.slice(0, 300)}`);
    }
    try {
      return JSON.parse(jsonText) as T;
    } catch {
      throw new Error(`${commandLabel} returned invalid JSON. Output preview: ${trimmed.slice(0, 300)}`);
    }
  }
}

function extractJsonText(text: string): string | undefined {
  const start = Math.min(indexOfAny(text, "{"), indexOfAny(text, "["));
  if (start === Number.POSITIVE_INFINITY) return undefined;
  const open = text[start] as "{" | "[";
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === "\"") {
        inString = false;
      }
      continue;
    }

    if (ch === "\"") {
      inString = true;
      continue;
    }

    if (ch === open) {
      depth += 1;
      continue;
    }

    if (ch === close) {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }

  return undefined;
}

function indexOfAny(text: string, targets: "{" | "["): number {
  const index = text.indexOf(targets);
  return index === -1 ? Number.POSITIVE_INFINITY : index;
}

async function execStarlingJson<T>(args: string[], options: Partial<CliExecOptions> = {}): Promise<T> {
  const stdout = await execStarlingRaw(args, options);
  const commandLabel = `starling ${args.join(" ")}`;
  return parseJsonOutput<T>(stdout, commandLabel);
}

export async function listSessions(
  limit = 50,
  agent?: string,
  options: { all?: boolean } = {}
): Promise<SessionMeta[]> {
  const baseArgs = ["session", "list", "--json"];
  if (options.all) {
    const allArgs = [...baseArgs, "--all"];
    if (agent) allArgs.push("-a", agent);

    const cacheKeyAll = `sessionList:${cacheKeyForCommand(allArgs)}`;
    return getCachedResult<SessionMeta[]>(cacheKeyAll, async () => {
      try {
        return await execStarlingJson<SessionMeta[]>(allArgs, { timeout: DEFAULT_JSON_TIMEOUT });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!/invalid JSON|not found|failed|timed out|ENOBUFS/i.test(message)) {
          throw err;
        }
        const fallbackLimit = Math.max(limit || DEFAULT_SESSION_ALL_FALLBACK_LIMIT, 1);
        const fallbackArgs = [...baseArgs, "-n", String(fallbackLimit)];
        if (agent) fallbackArgs.push("-a", agent);
        return execStarlingJson<SessionMeta[]>(fallbackArgs, { timeout: DEFAULT_JSON_TIMEOUT });
      }
    });
  } else {
    const args = [...baseArgs, "-n", String(limit)];
    if (agent) args.push("--agent", agent);
    return getCachedResult<SessionMeta[]>(`sessionList:${cacheKeyForCommand(args)}`, () => execStarlingJson<SessionMeta[]>(args));
  }
}

export async function checkStarlingAvailable(): Promise<void> {
  await execStarlingRaw(["--version"], {
    timeout: 5_000,
    maxBuffer: 1024 * 1024,
  });
}

export async function listSessionsText(opts: {
  limit?: number;
  all?: boolean;
  agent?: string;
} = {}): Promise<string> {
  const args = ["session", "list"];
  if (opts.all) {
    args.push("--all");
  } else {
    args.push("-n", String(opts.limit ?? 20));
  }
  if (opts.agent) args.push("--agent", opts.agent);
  return execStarlingRaw(args, { timeout: DEFAULT_TEXT_TIMEOUT });
}

export async function sessionIndexStatusText(): Promise<string> {
  return execStarlingRaw(["session", "index", "status"], { timeout: DEFAULT_TEXT_TIMEOUT });
}

export async function sessionIndexRebuildText(agent?: string): Promise<string> {
  const args = ["session", "index", "rebuild"];
  if (agent) args.push("-a", agent);
  clearCliCache();
  return execStarlingRaw(args, { timeout: DEFAULT_JSON_TIMEOUT });
}

export async function sessionIndexClearText(): Promise<string> {
  clearCliCache();
  return execStarlingRaw(["session", "index", "clear"], { timeout: DEFAULT_TEXT_TIMEOUT });
}

export async function getSession(id: string): Promise<SessionMeta> {
  const args = ["session", "show", id, "--json"];
  return getCachedResult<SessionMeta>(`sessionGet:${cacheKeyForCommand(args)}`, () => execStarlingJson<SessionMeta>(args));
}

export async function getSessionText(id: string): Promise<string> {
  return execStarlingRaw(["session", "show", id]);
}

export async function resumeSession(id: string): Promise<string> {
  return execStarlingRaw(["session", "resume", id], { timeout: DEFAULT_TEXT_TIMEOUT });
}

export async function pinSession(
  sessionId: string,
  opts: {
    title?: string;
    tags?: string;
    to?: string;
    current?: boolean;
  } = {}
): Promise<string> {
  const args = ["pin", sessionId];
  if (opts.title) args.push("--title", opts.title);
  if (opts.tags) args.push("--tags", opts.tags);
  if (opts.to) args.push("--to", opts.to);
  if (opts.current) args.push("--current");
  return execStarlingRaw(args, { timeout: DEFAULT_TEXT_TIMEOUT });
}

export async function unpinSession(sessionId: string): Promise<string> {
  clearCliCache();
  return execStarlingRaw(["session", "unpin", sessionId], { timeout: DEFAULT_TEXT_TIMEOUT });
}

export async function deleteSession(sessionId: string): Promise<string> {
  clearCliCache();
  return execStarlingRaw(["session", "delete", sessionId, "--yes"], { timeout: DEFAULT_TEXT_TIMEOUT });
}

export async function listPins(space?: string): Promise<Bookmark[]> {
  const args = ["catalog", "list", "--pins", "--json"];
  const cacheKey = `pinList:${space ?? "all"}:${cacheKeyForCommand(args)}`;
  return getCachedResult<Bookmark[]>(cacheKey, async () => {
    const catalogs = await execStarlingJson<SpaceWithPins[]>(args);
    const pins = space
      ? catalogs
        .filter((catalog) => catalog.id === space || catalog.name === space)
        .flatMap((catalog) => catalog.pins ?? [])
      : catalogs.flatMap((catalog) => catalog.pins ?? []);
    const uniquePins = new Map<string, Bookmark>();
    for (const pin of pins) {
      uniquePins.set(pin.id, pin);
    }
    return [...uniquePins.values()];
  });
}

export async function listSpaces(withPins = false): Promise<Space[] | SpaceWithPins[]> {
  const args = ["catalog", "list", "--json"];
  if (withPins) args.push("--pins");
  return getCachedResult<Space[] | SpaceWithPins[]>(`spaceList:${cacheKeyForCommand(args)}`, () => execStarlingJson<Space[] | SpaceWithPins[]>(args));
}

export async function catalogListText(opts: { pins?: boolean } = {}): Promise<string> {
  const args = ["catalog", "list"];
  if (opts.pins) args.push("--pins");
  return execStarlingRaw(args);
}

export async function catalogTreeText(opts: { sessions?: boolean } = {}): Promise<string> {
  const args = ["catalog", "tree"];
  if (opts.sessions) args.push("--sessions");
  return execStarlingRaw(args);
}

export async function modelListText(agent?: string): Promise<string> {
  const args = ["model", "ls"];
  if (agent) args.push("--agent", agent);
  return execStarlingRaw(args);
}

export async function catalogShowText(name: string): Promise<string> {
  return execStarlingRaw(["catalog", "show", name]);
}

export async function getSpace(name: string): Promise<SpaceWithPins> {
  const stdout = await execStarlingRaw(["catalog", "show", name], {
    maxBuffer: DEFAULT_MAX_BUFFER,
    timeout: DEFAULT_TEXT_TIMEOUT,
  });
  return JSON.parse(stdout.replaceAll("\n", "")) as SpaceWithPins;
}

export async function createCatalog(name: string, opts: { description?: string; tags?: string; parent?: string } = {}): Promise<string> {
  const args = ["catalog", "create", name];
  if (opts.description) args.push("-d", opts.description);
  if (opts.tags) args.push("--tags", opts.tags);
  if (opts.parent) args.push("--parent", opts.parent);
  return execStarlingRaw(args, { timeout: DEFAULT_TEXT_TIMEOUT });
}

export async function removeCatalog(name: string): Promise<string> {
  return execStarlingRaw(["catalog", "delete", name], { timeout: DEFAULT_TEXT_TIMEOUT });
}

export async function renameCatalog(name: string, newName: string): Promise<string> {
  return execStarlingRaw(["catalog", "rename", name, newName], { timeout: DEFAULT_TEXT_TIMEOUT });
}

export async function removeSessionFromCatalog(name: string, sessionId: string): Promise<string> {
  return execStarlingRaw(["catalog", "detach", name, sessionId], { timeout: DEFAULT_TEXT_TIMEOUT });
}

export async function tagCatalog(name: string, tags: string[]): Promise<string> {
  const args = ["catalog", "tag", name, ...tags];
  return execStarlingRaw(args, { timeout: DEFAULT_TEXT_TIMEOUT });
}

export async function editCatalog(
  name: string,
  opts: {
    description?: string;
    rename?: string;
    parent?: string;
  }
): Promise<string> {
  const args = ["catalog", "edit", name];
  if (opts.description) args.push("-d", opts.description);
  if (opts.rename) args.push("--rename", opts.rename);
  if (opts.parent) args.push("--parent", opts.parent);
  return execStarlingRaw(args, { timeout: DEFAULT_TEXT_TIMEOUT });
}

export async function projectListText(opts: {
  agent?: string;
  limit?: number;
  all?: boolean;
  refreshIndex?: boolean;
  noIndex?: boolean;
} = {}): Promise<string> {
  const args = ["project", "list"];
  if (opts.agent) args.push("-a", opts.agent);
  if (opts.refreshIndex) args.push("--refresh-index");
  if (opts.noIndex) args.push("--no-index");
  if (opts.all) {
    args.push("--all");
  } else {
    args.push("-n", String(opts.limit ?? 100));
  }
  return execStarlingRaw(args);
}

export async function projectShowText(path: string, agent?: string): Promise<string> {
  const args = ["project", "show", path];
  if (agent) args.push("-a", agent);
  return execStarlingRaw(args);
}

export async function listProjects(opts: {
  agent?: string;
  limit?: number;
  all?: boolean;
  refreshIndex?: boolean;
  noIndex?: boolean;
} = {}): Promise<ProjectSummary[]> {
  const args = ["project", "list", "--json"];
  if (opts.agent) args.push("-a", opts.agent);
  if (opts.refreshIndex) args.push("--refresh-index");
  if (opts.noIndex) args.push("--no-index");
  if (opts.all) {
    args.push("--all");
  } else {
    args.push("-n", String(opts.limit ?? 100));
  }
  const timeout = DEFAULT_JSON_TIMEOUT;
  return getCachedResult<ProjectSummary[]>(`projectList:${cacheKeyForCommand(args)}`, async () => {
    const stdout = await execStarlingRaw(args, { timeout });
    const trimmed = stdout.trim();
    if (trimmed === "No projects found.") return [];
    if (trimmed === "[]") return [];
    return parseJsonOutput<ProjectSummary[]>(stdout, "starling project list --json");
  });
}

export async function projectShowJson(path: string, agent?: string): Promise<ProjectDetails> {
  const args = ["project", "show", path, "--json"];
  if (agent) args.push("-a", agent);
  return getCachedResult<ProjectDetails>(`projectShow:${cacheKeyForCommand(args)}`, async () => {
    const stdout = await execStarlingRaw(args, { timeout: DEFAULT_JSON_TIMEOUT });
    const trimmed = stdout.trim();
    if (trimmed === "Project not found.") {
      throw new Error(`Project not found: ${path}`);
    }
    return parseJsonOutput<ProjectDetails>(stdout, `starling project show ${path} --json`);
  });
}
