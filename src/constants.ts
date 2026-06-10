import { homedir } from "os";
import { join } from "path";

export const DEFAULT_CONFIG_DIR = join(homedir(), ".config", "starling");
export const DEFAULT_STORE_PATH = join(DEFAULT_CONFIG_DIR, "store.json");
export const STORE_VERSION = 1;

export const CLAUDE_SESSIONS_DIR = join(homedir(), ".claude", "projects");

export const ENV_CONFIG_KEY = "STARLING_CONFIG";
