import { existsSync, readFileSync, readdirSync, writeFileSync, chmodSync, unlinkSync, renameSync } from "fs";
import { basename, extname, isAbsolute, join, resolve } from "path";
import { DEFAULT_CODEX_HOME, DEFAULT_CODEX_SETTINGS_DIR, DEFAULT_STARLING_HOME } from "../constants.js";
import { atomicWriteJSON, ensureDir } from "../utils/fs.js";

export interface CodexProviderProfileSummary {
  name: string;
  filePath: string;
  extension: string;
  hasAuth: boolean;
  hasConfig: boolean;
}

export interface CodexProviderActivationResult {
  name: string;
  sourcePath: string;
  wroteAuth: boolean;
  wroteConfig: boolean;
}

export interface CodexProviderProfilePatch {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  modelProvider?: string;
  wireApi?: string;
  config?: Record<string, unknown>;
  auth?: Record<string, unknown>;
}

export interface CodexProviderProfileFile {
  auth: Record<string, unknown> | null;
  config: Record<string, unknown> | null;
  filePath: string;
}

const CODEX_PROVIDER_HISTORY_PATH = join(DEFAULT_STARLING_HOME, "codex-provider.json");
const CODEX_PROVIDER_EXTENSIONS = [".toml", ".json", ".jsonc"];

interface CodexProfileState {
  provider: string;
  sourcePath: string;
  updatedAt: string;
}

interface CodexProfileData {
  filePath: string;
  hasAuth: boolean;
  hasConfig: boolean;
}

export function listCodexProviderProfiles(): CodexProviderProfileSummary[] {
  if (!existsSync(DEFAULT_CODEX_SETTINGS_DIR)) return [];

  const entries = readdirSync(DEFAULT_CODEX_SETTINGS_DIR, { withFileTypes: true });
  const result: CodexProviderProfileSummary[] = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;

    const filePath = join(DEFAULT_CODEX_SETTINGS_DIR, entry.name);
    const extension = extname(filePath).toLowerCase();
    if (!CODEX_PROVIDER_EXTENSIONS.includes(extension)) continue;

    const name = entry.name.slice(0, entry.name.length - extension.length);
    try {
      const parsed = inspectCodexProfile(filePath);
      result.push({
        name,
        filePath,
        extension,
        hasAuth: parsed.hasAuth,
        hasConfig: parsed.hasConfig,
      });
    } catch {
      continue;
    }
  }

  result.sort((a, b) => a.name.localeCompare(b.name));
  return result;
}

export function getCodexProviderProfile(profileName: string): CodexProviderProfileSummary | null {
  const sourcePath = resolveCodexConfigPath(profileName);
  if (!sourcePath) return null;
  const extension = extname(sourcePath).toLowerCase();
  const name = basename(sourcePath, extension);
  const parsed = inspectCodexProfile(sourcePath);
  return {
    name,
    filePath: sourcePath,
    extension,
    hasAuth: parsed.hasAuth,
    hasConfig: parsed.hasConfig,
  };
}

export function readCodexProviderProfileFile(profileName: string): CodexProviderProfileFile {
  const sourcePath = resolveCodexConfigPathOrThrow(profileName);
  const extension = extname(sourcePath).toLowerCase();
  if (extension === ".toml") {
    return {
      auth: null,
      config: null,
      filePath: sourcePath,
    };
  }

  if (extension === ".json" || extension === ".jsonc") {
    const parsed = parseCodexJsonProfile(sourcePath, extension === ".jsonc");
    return {
      auth: parsed.auth,
      config: parsed.configObject,
      filePath: sourcePath,
    };
  }

  throw new Error(`Unsupported codex profile type: ${sourcePath}`);
}

export function saveCodexProviderProfile(
  profileName: string,
  patch: CodexProviderProfilePatch
): CodexProviderProfileSummary {
  const safeName = normalizeProfileName(profileName);
  const existingPath = resolveCodexConfigPath(safeName);
  const targetPath = existingPath && extname(existingPath).toLowerCase() !== ".toml"
    ? existingPath
    : join(DEFAULT_CODEX_SETTINGS_DIR, `${safeName}.json`);

  const existing = existsSync(targetPath)
    ? parseCodexJsonProfile(targetPath, extname(targetPath).toLowerCase() === ".jsonc")
    : { auth: null, config: null, configObject: null };

  const auth = mergeAuthPatch(existing.auth, patch);
  const config = mergeConfigPatch(existing.configObject, patch);
  const payload: Record<string, unknown> = {};
  if (auth && Object.keys(auth).length > 0) payload.auth = auth;
  if (config && Object.keys(config).length > 0) payload.config = config;

  if (!payload.auth && !payload.config) {
    throw new Error("Codex provider profile needs at least auth or config content.");
  }

  atomicWriteJSON(targetPath, payload);
  return getCodexProviderProfile(safeName)!;
}

export function removeCodexProviderProfile(profileName: string): string {
  const sourcePath = resolveCodexConfigPathOrThrow(profileName);
  unlinkSync(sourcePath);
  const state = getCurrentCodexProviderState();
  if (state?.provider === basename(sourcePath, extname(sourcePath))) {
    try {
      unlinkSync(CODEX_PROVIDER_HISTORY_PATH);
    } catch {
      // best-effort cleanup
    }
  }
  return sourcePath;
}

export function renameCodexProviderProfile(profileName: string, nextName: string): CodexProviderProfileSummary {
  const sourcePath = resolveCodexConfigPathOrThrow(profileName);
  const safeName = normalizeProfileName(nextName);
  const nextPath = join(DEFAULT_CODEX_SETTINGS_DIR, `${safeName}${extname(sourcePath).toLowerCase() || ".json"}`);
  if (existsSync(nextPath)) {
    throw new Error(`Codex provider already exists: ${safeName}`);
  }
  ensureDir(nextPath);
  renameSync(sourcePath, nextPath);

  const state = getCurrentCodexProviderState();
  if (state?.provider === basename(sourcePath, extname(sourcePath))) {
    setCurrentCodexProvider(safeName, nextPath);
  }

  return getCodexProviderProfile(safeName)!;
}

export function resolveCodexConfigPath(nameOrPath?: string): string | null {
  if (!nameOrPath) return null;

  if (isAbsolute(nameOrPath) || existsSync(nameOrPath)) {
    if (!existsSync(nameOrPath)) {
      return null;
    }
    return resolve(nameOrPath);
  }

  const base = join(DEFAULT_CODEX_SETTINGS_DIR, basename(nameOrPath));
  const extension = extname(base);

  if (extension && existsSync(base)) return base;
  if (extension) return null;

  for (const ext of CODEX_PROVIDER_EXTENSIONS) {
    const candidate = `${base}${ext}`;
    if (existsSync(candidate)) return candidate;
  }

  return null;
}

export function resolveCodexConfigPathOrThrow(nameOrPath?: string): string {
  const resolved = resolveCodexConfigPath(nameOrPath);
  if (!resolved) {
    const base = nameOrPath ? join(DEFAULT_CODEX_SETTINGS_DIR, basename(nameOrPath)) : "";
    const detail = base ? `\nExpected path: ${base}` : "";
    throw new Error(`Config file not found: ${nameOrPath}${detail}`);
  }
  return resolved;
}

export function getCurrentCodexProvider(): string | null {
  if (!existsSync(CODEX_PROVIDER_HISTORY_PATH)) return null;

  try {
    const raw = readFileSync(CODEX_PROVIDER_HISTORY_PATH, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (isRecord(parsed) && typeof parsed.provider === "string" && parsed.provider.trim()) {
      return parsed.provider;
    }
  } catch {
    return null;
  }

  return null;
}

export function getCurrentCodexProviderState(): CodexProfileState | null {
  if (!existsSync(CODEX_PROVIDER_HISTORY_PATH)) return null;

  try {
    const raw = readFileSync(CODEX_PROVIDER_HISTORY_PATH, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (isRecord(parsed)) {
      const provider = typeof parsed.provider === "string" && parsed.provider.trim() ? parsed.provider : null;
      const sourcePath =
        typeof parsed.sourcePath === "string" && parsed.sourcePath.trim() ? parsed.sourcePath : null;
      const updatedAt = typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString();
      if (provider && sourcePath) {
        return { provider, sourcePath, updatedAt };
      }
    }
  } catch {
    return null;
  }

  return null;
}

export function setCurrentCodexProvider(profileName: string, sourcePath: string): void {
  atomicWriteJSON(CODEX_PROVIDER_HISTORY_PATH, {
    provider: profileName,
    sourcePath,
    updatedAt: new Date().toISOString(),
  } satisfies CodexProfileState);
}

export function useCodexProvider(profileName: string): CodexProviderActivationResult {
  const sourcePath = resolveCodexConfigPathOrThrow(profileName);
  inspectCodexProfile(sourcePath);

  let wroteAuth = false;
  let wroteConfig = false;

  const extension = extname(sourcePath).toLowerCase();

  if (extension === ".toml") {
    const text = readFileSync(sourcePath, "utf-8");
    writeCodexConfigText(text);
    wroteConfig = true;
  } else if (extension === ".json" || extension === ".jsonc") {
    const profile = parseCodexJsonProfile(sourcePath, extension === ".jsonc");

    if (profile.config) {
      writeCodexConfigText(profile.config);
      wroteConfig = true;
    }

    if (profile.auth && Object.keys(profile.auth).length > 0) {
      const merged = mergeAuthWithLive(profile.auth);
      atomicWriteJSON(join(DEFAULT_CODEX_HOME, "auth.json"), merged);
      wroteAuth = true;
    }
  } else {
    throw new Error(`Unsupported codex profile type: ${sourcePath}`);
  }

  const ext = extname(sourcePath);
  const baseName = basename(sourcePath, ext);
  setCurrentCodexProvider(baseName, sourcePath);

  return {
    name: baseName,
    sourcePath,
    wroteAuth,
    wroteConfig,
  };
}

function inspectCodexProfile(filePath: string): CodexProfileData {
  const extension = extname(filePath).toLowerCase();

  if (extension === ".toml") {
    return {
      filePath,
      hasConfig: true,
      hasAuth: false,
    };
  }

  if (extension === ".json" || extension === ".jsonc") {
    const parsed = parseCodexJsonProfile(filePath, extension === ".jsonc");
    return {
      filePath,
      hasConfig: typeof parsed.config === "string" && parsed.config.trim().length > 0,
      hasAuth: parsed.auth !== null,
    };
  }

  return { filePath, hasConfig: false, hasAuth: false };
}

interface ParsedCodexProfile {
  auth: Record<string, unknown> | null;
  config: string | null;
  configObject: Record<string, unknown> | null;
}

function parseCodexJsonProfile(filePath: string, allowComments: boolean): ParsedCodexProfile {
  const raw = readFileSync(filePath, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(allowComments ? stripJsonComments(raw) : raw) as unknown;
  } catch {
    throw new Error(`Invalid JSON profile: ${filePath}`);
  }

  if (!isRecord(parsed)) {
    throw new Error(`Invalid codex profile object: ${filePath}`);
  }

  const auth = resolveProfileAuth(parsed);
  const configObject = resolveProfileConfigObject(parsed);
  const config = typeof parsed.config === "string" ? parsed.config : (configObject ? convertJsonToToml(configObject) : null);

  if (!auth && !config) {
    throw new Error(`Codex profile has no recognized auth/config content: ${filePath}`);
  }

  return { auth, config, configObject };
}

function resolveProfileAuth(value: Record<string, unknown>): Record<string, unknown> | null {
  if (isRecord(value.auth)) {
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

function resolveProfileConfigObject(value: Record<string, unknown>): Record<string, unknown> | null {
  if (isRecord(value.config)) {
    return cloneRecord(value.config);
  }

  return null;
}

function mergeAuthPatch(
  existing: Record<string, unknown> | null,
  patch: CodexProviderProfilePatch
): Record<string, unknown> | null {
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

function mergeConfigPatch(
  existing: Record<string, unknown> | null,
  patch: CodexProviderProfilePatch
): Record<string, unknown> | null {
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
    const providers = isRecord(merged.model_providers) ? merged.model_providers : {};
    const providerConfig = isRecord(providers[providerName]) ? providers[providerName] as Record<string, unknown> : {};
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

function deepMerge(target: Record<string, unknown>, patch: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (typeof value === "undefined") continue;
    if (isRecord(value) && isRecord(target[key])) {
      deepMerge(target[key] as Record<string, unknown>, value);
      continue;
    }
    target[key] = isRecord(value) ? cloneRecord(value) : value;
  }
}

function normalizeProfileName(profileName: string): string {
  const name = basename(profileName).replace(/\.(jsonc?|toml)$/i, "").trim();
  if (!name || name === "." || name === "..") {
    throw new Error(`Invalid codex provider name: ${profileName}`);
  }
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error("Codex provider name may only contain letters, numbers, dot, dash, and underscore.");
  }
  return name;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function mergeAuthWithLive(patch: Record<string, unknown>): Record<string, unknown> {
  const authPath = join(DEFAULT_CODEX_HOME, "auth.json");
  const live = isRecord(readAuthJson(authPath)) ? readAuthJson(authPath) as Record<string, unknown> : {};
  return { ...live, ...patch };
}

function readAuthJson(filePath: string): unknown {
  if (!existsSync(filePath)) return {};
  try {
    const raw = readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as unknown;
  } catch {
    return {};
  }
}

function stripJsonComments(raw: string): string {
  return raw.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

function writeCodexConfigText(rawText: string): void {
  const filePath = join(DEFAULT_CODEX_HOME, "config.toml");
  ensureDir(filePath);
  writeFileSync(filePath, rawText.endsWith("\n") ? rawText : `${rawText}\n`, "utf-8");
  chmodSync(filePath, 0o600);
}

function convertJsonToToml(value: Record<string, unknown>): string {
  const lines: string[] = [];
  serializeTomlObject(value, [], lines);
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

function serializeTomlObject(value: Record<string, unknown>, prefix: string[], lines: string[]): void {
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "undefined") continue;
    if (isRecord(child)) {
      const nextPath = [...prefix, key];
      lines.push("");
      lines.push(`[${[...nextPath].map(toTomlKey).join(".")}]`);
      serializeTomlObject(child, nextPath, lines);
      continue;
    }
    if (Array.isArray(child)) {
      lines.push(`${toTomlKey(key)} = ${toTomlValue(child)}`);
      continue;
    }
    lines.push(`${toTomlKey(key)} = ${toTomlValue(child)}`);
  }
}

function toTomlValue(value: unknown): string {
  if (isRecord(value)) {
    const entries: string[] = [];
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

function toTomlKey(key: string): string {
  return /^\w+$/.test(key) ? key : JSON.stringify(key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
