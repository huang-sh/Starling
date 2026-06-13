import { homedir } from "os";
import { join } from "path";

export const DEFAULT_CONFIG_DIR = join(homedir(), ".config", "starling");
export const DEFAULT_STORE_PATH = join(DEFAULT_CONFIG_DIR, "store.json");
export const STORE_VERSION = 1;

export const DEFAULT_STARLING_HOME = join(homedir(), ".starling");
export const DEFAULT_STARLING_SETTINGS_DIR = join(DEFAULT_STARLING_HOME, "settings");
export const DEFAULT_CLAUDE_SETTINGS_DIR = join(DEFAULT_STARLING_SETTINGS_DIR, "claude");
export const DEFAULT_CODEX_SETTINGS_DIR = join(DEFAULT_STARLING_SETTINGS_DIR, "codex");
export const DEFAULT_CODEX_HOME = join(homedir(), ".codex");

export const CLAUDE_SESSIONS_DIR = join(homedir(), ".claude", "projects");
export const CODEX_SESSIONS_DIR = join(homedir(), ".codex", "sessions");

export const ENV_CONFIG_KEY = "STARLING_CONFIG";
