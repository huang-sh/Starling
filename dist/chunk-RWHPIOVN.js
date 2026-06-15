#!/usr/bin/env node

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

// src/utils/fs.ts
import { existsSync as existsSync2, mkdirSync, readFileSync as readFileSync2, writeFileSync, renameSync, unlinkSync, mkdtempSync, chmodSync } from "fs";
import { dirname, join as join2 } from "path";
function ensureDir(filePath) {
  const dir = dirname(filePath);
  if (!existsSync2(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}
function atomicWriteJSON(filePath, data) {
  ensureDir(filePath);
  const dir = dirname(filePath);
  const tmpDir = join2(dir, ".starling-tmp");
  if (!existsSync2(tmpDir)) mkdirSync(tmpDir, { recursive: true });
  const prefix = join2(tmpDir, "starling-");
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

export {
  CLI_CONFIG_PATH,
  STARLING_HOME_SOURCE,
  DEFAULT_STARLING_HOME,
  DEFAULT_STORE_PATH,
  STORE_VERSION,
  DEFAULT_STARLING_SETTINGS_DIR,
  DEFAULT_CLAUDE_SETTINGS_DIR,
  DEFAULT_CODEX_SETTINGS_DIR,
  DEFAULT_CODEX_HOME,
  CLAUDE_SESSIONS_DIR,
  CODEX_SESSIONS_DIR,
  ENV_CONFIG_KEY,
  ensureDir,
  atomicWriteJSON,
  readJSON
};
