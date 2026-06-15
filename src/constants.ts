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
export const STORE_VERSION = 1;

export const DEFAULT_STARLING_SETTINGS_DIR = join(DEFAULT_STARLING_HOME, "settings");
export const DEFAULT_CLAUDE_SETTINGS_DIR = join(DEFAULT_STARLING_SETTINGS_DIR, "claude");
export const DEFAULT_CODEX_SETTINGS_DIR = join(DEFAULT_STARLING_SETTINGS_DIR, "codex");
export const DEFAULT_CODEX_HOME = join(homedir(), ".codex");

export const CLAUDE_SESSIONS_DIR = join(homedir(), ".claude", "projects");
export const CODEX_SESSIONS_DIR = join(homedir(), ".codex", "sessions");

export const ENV_CONFIG_KEY = "STARLING_CONFIG";
