import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const STARLING_HOME_ENV = process.env.STARLING_HOME?.trim();
export const DEFAULT_CONFIG_DIR = join(homedir(), ".config", "starling");
export const CLI_CONFIG_PATH = process.env.STARLING_CLI_CONFIG?.trim() || join(DEFAULT_CONFIG_DIR, "config.json");

function readConfiguredStarlingHome(): string | null {
  if (!existsSync(CLI_CONFIG_PATH)) return null;
  try {
    const parsed = JSON.parse(readFileSync(CLI_CONFIG_PATH, "utf-8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const homePath = (parsed as { homePath?: unknown }).homePath;
    return typeof homePath === "string" && homePath.trim() ? homePath.trim() : null;
  } catch {
    return null;
  }
}

function expandHomePath(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

const STARLING_HOME_CONFIG = readConfiguredStarlingHome();
const STARLING_HOME_VALUE = STARLING_HOME_ENV || STARLING_HOME_CONFIG;

export const STARLING_HOME_SOURCE = STARLING_HOME_ENV ? "env" : STARLING_HOME_CONFIG ? "config" : "default";
export const DEFAULT_STARLING_HOME = STARLING_HOME_VALUE ? expandHomePath(STARLING_HOME_VALUE) : join(homedir(), ".starling");
export const DEFAULT_STORE_PATH = STARLING_HOME_VALUE ? join(DEFAULT_STARLING_HOME, "store.json") : join(DEFAULT_CONFIG_DIR, "store.json");
export const DEFAULT_RUNS_PATH = STARLING_HOME_VALUE ? join(DEFAULT_STARLING_HOME, "runs.json") : join(DEFAULT_CONFIG_DIR, "runs.json");
export const STORE_VERSION = 1;
export const RUNS_VERSION = 1;

export const DEFAULT_STARLING_SETTINGS_DIR = join(DEFAULT_STARLING_HOME, "settings");
export const DEFAULT_CLAUDE_SETTINGS_DIR = join(DEFAULT_STARLING_SETTINGS_DIR, "claude");
export const DEFAULT_CODEX_SETTINGS_DIR = join(DEFAULT_STARLING_SETTINGS_DIR, "codex");
export const DEFAULT_CODEX_HOME = join(homedir(), ".codex");

/**
 * Claude / Codex session-file roots honor CLAUDE_CONFIG_DIR / CODEX_HOME (the
 * native agent-home env vars), so sessions written under isolated homes (e.g.
 * benchmark-harness `.claude_iso_*` dirs) are discoverable. When the env vars
 * are unset, behavior is unchanged: ~/.claude/projects and ~/.codex/sessions.
 *
 * Live process detection (lib/processMap.ts) additionally reads each TARGET
 * process's own environ, so a Starling process running in the default home can
 * still observe sessions belonging to agents launched under a different
 * CLAUDE_CONFIG_DIR.
 */
function resolveClaudeConfigDir(): string {
  const env = process.env.CLAUDE_CONFIG_DIR?.trim();
  return env ? expandHomePath(env) : join(homedir(), ".claude");
}
function resolveCodexHome(): string {
  const env = process.env.CODEX_HOME?.trim();
  return env ? expandHomePath(env) : join(homedir(), ".codex");
}

export function claudeSessionRoots(): string[] {
  return [join(resolveClaudeConfigDir(), "projects")];
}
/**
 * Codex writes live sessions under `<CODEX_HOME>/sessions/YYYY/MM/` and moves
 * finished ones to `<CODEX_HOME>/archived_sessions/`. Both are returned so
 * discovery / indexing / monitor see archived sessions too.
 */
export function codexSessionRoots(): string[] {
  const home = resolveCodexHome();
  return [join(home, "sessions"), join(home, "archived_sessions")];
}

/** Env-aware single-root alias. Prefer claudeSessionRoots() for new code. */
export const CLAUDE_SESSIONS_DIR = claudeSessionRoots()[0]!;
/**
 * Env-aware primary-root alias (live sessions only). Use codexSessionRoots()
 * for discovery — this omits archived_sessions/. Kept for callers that write
 * new session files (run.ts) or only care about the live root.
 */
export const CODEX_SESSIONS_DIR = codexSessionRoots()[0]!;

export const ENV_CONFIG_KEY = "STARLING_CONFIG";
