#!/usr/bin/env node
import {
  DEFAULT_CODEX_SETTINGS_DIR,
  DEFAULT_STARLING_HOME,
  ensureDir
} from "./chunk-RWHPIOVN.js";

// src/lib/configPaths.ts
import { extname } from "path";
function hasKnownConfigExtension(fileName, extensions) {
  const extension = extname(fileName).toLowerCase();
  return extension.length > 0 && extensions.includes(extension);
}

// src/lib/codexProvider.ts
import { existsSync, readFileSync, readdirSync, writeFileSync, chmodSync, unlinkSync, renameSync } from "fs";
import { basename, extname as extname2, isAbsolute, join, resolve } from "path";
var CODEX_PROVIDER_HISTORY_PATH = join(DEFAULT_STARLING_HOME, "codex-provider.json");
var CODEX_PROVIDER_EXTENSIONS = [".toml", ".json", ".jsonc"];
function getCodexProviderProfile(profileName) {
  migrateCodexJsonProfilesToToml();
  const sourcePath = resolveCodexConfigPath(profileName);
  if (!sourcePath) return null;
  const extension = extname2(sourcePath).toLowerCase();
  const name = basename(sourcePath, extension);
  const parsed = inspectCodexProfile(sourcePath);
  return {
    name,
    filePath: sourcePath,
    extension,
    hasAuth: parsed.hasAuth,
    hasConfig: parsed.hasConfig
  };
}
function saveCodexProviderProfile(profileName, patch) {
  migrateCodexJsonProfilesToToml();
  const safeName = normalizeProfileName(profileName);
  const existingPath = resolveCodexConfigPath(safeName);
  const targetPath = existingPath ?? join(DEFAULT_CODEX_SETTINGS_DIR, `${safeName}.toml`);
  const existing = existsSync(targetPath) ? parseCodexProfile(targetPath) : { auth: null, config: null, configObject: null };
  const auth = mergeAuthPatch(existing.auth, patch);
  const config = mergeConfigPatch(existing.configObject, patch);
  if ((!auth || Object.keys(auth).length === 0) && (!config || Object.keys(config).length === 0)) {
    throw new Error("Codex provider profile needs at least auth or config content.");
  }
  writeCodexProfileToml(targetPath, auth, config);
  return getCodexProviderProfile(safeName);
}
function resolveCodexConfigPath(nameOrPath) {
  migrateCodexJsonProfilesToToml();
  if (!nameOrPath) return null;
  if (isAbsolute(nameOrPath) || existsSync(nameOrPath)) {
    if (!existsSync(nameOrPath)) {
      return null;
    }
    return resolve(nameOrPath);
  }
  const base = join(DEFAULT_CODEX_SETTINGS_DIR, basename(nameOrPath));
  if (hasKnownConfigExtension(base, CODEX_PROVIDER_EXTENSIONS) && existsSync(base)) return base;
  if (hasKnownConfigExtension(base, CODEX_PROVIDER_EXTENSIONS)) return null;
  for (const ext of CODEX_PROVIDER_EXTENSIONS) {
    const candidate = `${base}${ext}`;
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
function inspectCodexProfile(filePath) {
  const extension = extname2(filePath).toLowerCase();
  if (extension === ".toml") {
    const parsed = parseCodexTomlProfile(filePath);
    return {
      filePath,
      hasConfig: true,
      hasAuth: parsed.auth !== null
    };
  }
  if (extension === ".json" || extension === ".jsonc") {
    const parsed = parseCodexJsonProfile(filePath, extension === ".jsonc");
    return {
      filePath,
      hasConfig: typeof parsed.config === "string" && parsed.config.trim().length > 0,
      hasAuth: parsed.auth !== null
    };
  }
  return { filePath, hasConfig: false, hasAuth: false };
}
function migrateCodexJsonProfilesToToml() {
  if (!existsSync(DEFAULT_CODEX_SETTINGS_DIR)) return [];
  const migrated = [];
  const entries = readdirSync(DEFAULT_CODEX_SETTINGS_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const sourcePath = join(DEFAULT_CODEX_SETTINGS_DIR, entry.name);
    const extension = extname2(sourcePath).toLowerCase();
    if (extension !== ".json" && extension !== ".jsonc") continue;
    const name = entry.name.slice(0, entry.name.length - extension.length);
    const targetPath = join(DEFAULT_CODEX_SETTINGS_DIR, `${name}.toml`);
    const backupPath = `${sourcePath}.bak`;
    try {
      if (!existsSync(targetPath)) {
        const parsed = parseCodexJsonProfile(sourcePath, extension === ".jsonc");
        writeCodexProfileToml(targetPath, parsed.auth, parsed.configObject);
        migrated.push(targetPath);
      }
      if (!existsSync(backupPath)) {
        renameSync(sourcePath, backupPath);
      } else if (existsSync(targetPath)) {
        unlinkSync(sourcePath);
      }
    } catch {
    }
  }
  return migrated;
}
function parseCodexProfile(filePath) {
  const extension = extname2(filePath).toLowerCase();
  if (extension === ".toml") return parseCodexTomlProfile(filePath);
  if (extension === ".json" || extension === ".jsonc") {
    return parseCodexJsonProfile(filePath, extension === ".jsonc");
  }
  throw new Error(`Unsupported codex profile type: ${filePath}`);
}
function parseCodexJsonProfile(filePath, allowComments) {
  const raw = readFileSync(filePath, "utf-8");
  let parsed;
  try {
    parsed = JSON.parse(allowComments ? stripJsonComments(raw) : raw);
  } catch {
    throw new Error(`Invalid JSON profile: ${filePath}`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`Invalid codex profile object: ${filePath}`);
  }
  const auth = resolveProfileAuth(parsed);
  const configObject = resolveProfileConfigObject(parsed);
  const config = typeof parsed.config === "string" ? parsed.config : configObject ? convertJsonToToml(configObject) : null;
  if (!auth && !config) {
    throw new Error(`Codex profile has no recognized auth/config content: ${filePath}`);
  }
  return { auth, config, configObject };
}
function parseCodexTomlProfile(filePath) {
  const raw = readFileSync(filePath, "utf-8");
  const configObject = parseSimpleToml(raw);
  const providerName = stringValue(configObject.model_provider);
  const providers = isRecord(configObject.model_providers) ? configObject.model_providers : {};
  const providerConfig = providerName && isRecord(providers[providerName]) ? providers[providerName] : {};
  const token = stringValue(providerConfig.experimental_bearer_token) || stringValue(configObject.OPENAI_API_KEY);
  const auth = token ? { OPENAI_API_KEY: token } : null;
  return {
    auth,
    config: raw.endsWith("\n") ? raw : `${raw}
`,
    configObject
  };
}
function resolveProfileAuth(value) {
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
function resolveProfileConfigObject(value) {
  if (isRecord(value.config)) {
    return cloneRecord(value.config);
  }
  return null;
}
function mergeAuthPatch(existing, patch) {
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
function mergeConfigPatch(existing, patch) {
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
    const providerConfig = isRecord(providers[providerName]) ? providers[providerName] : {};
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
function writeCodexProfileToml(targetPath, auth, config) {
  const normalized = config ? cloneRecord(config) : {};
  const token = auth ? stringValue(auth.OPENAI_API_KEY) || stringValue(auth.api_key) || stringValue(auth.apiKey) : "";
  if (token) {
    const providerName = stringValue(normalized.model_provider) || "custom";
    normalized.model_provider = providerName;
    const providers = isRecord(normalized.model_providers) ? normalized.model_providers : {};
    const providerConfig = isRecord(providers[providerName]) ? providers[providerName] : {};
    providerConfig.name = stringValue(providerConfig.name) || providerName;
    providerConfig.requires_openai_auth = typeof providerConfig.requires_openai_auth === "boolean" ? providerConfig.requires_openai_auth : true;
    providerConfig.experimental_bearer_token = token;
    providers[providerName] = providerConfig;
    normalized.model_providers = providers;
  }
  normalizeThirdPartyChatProviderConfig(normalized);
  ensureDir(targetPath);
  writeFileSync(targetPath, convertJsonToToml(normalized), "utf-8");
  chmodSync(targetPath, 384);
}
function normalizeThirdPartyChatProviderConfig(config) {
  const providerName = stringValue(config.model_provider);
  const providers = isRecord(config.model_providers) ? config.model_providers : {};
  const providerConfig = providerName && isRecord(providers[providerName]) ? providers[providerName] : {};
  if (isOfficialOpenAiProvider(providerName, providerConfig)) return;
  config.api_format = "openai_chat";
  providerConfig.api_format = "openai_chat";
  if (!stringValue(providerConfig.wire_api)) {
    providerConfig.wire_api = "responses";
  }
  if (providerName) {
    providers[providerName] = providerConfig;
    config.model_providers = providers;
  }
}
function isOfficialOpenAiProvider(providerName, providerConfig) {
  const name = `${providerName} ${stringValue(providerConfig.name)}`.toLowerCase();
  const baseUrl = stringValue(providerConfig.base_url).toLowerCase();
  return name.includes("openai") || baseUrl.includes("api.openai.com");
}
function deepMerge(target, patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (typeof value === "undefined") continue;
    if (isRecord(value) && isRecord(target[key])) {
      deepMerge(target[key], value);
      continue;
    }
    target[key] = isRecord(value) ? cloneRecord(value) : value;
  }
}
function normalizeProfileName(profileName) {
  const name = basename(profileName).replace(/\.(jsonc?|toml)$/i, "").trim();
  if (!name || name === "." || name === "..") {
    throw new Error(`Invalid codex provider name: ${profileName}`);
  }
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error("Codex provider name may only contain letters, numbers, dot, dash, and underscore.");
  }
  return name;
}
function stringValue(value) {
  return typeof value === "string" ? value : "";
}
function cloneRecord(value) {
  return JSON.parse(JSON.stringify(value));
}
function stripJsonComments(raw) {
  return raw.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}
function parseSimpleToml(raw) {
  const root = {};
  let current = root;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const section = trimmed.match(/^\[([^\]]+)\]$/);
    if (section) {
      current = root;
      for (const part of splitTomlPath(section[1])) {
        const existing = current[part];
        if (!isRecord(existing)) current[part] = {};
        current = current[part];
      }
      continue;
    }
    const kv = trimmed.match(/^([A-Za-z0-9_.-]+|"(?:\\.|[^"])+")\s*=\s*(.+?)\s*(?:#.*)?$/);
    if (!kv) continue;
    current[unquoteTomlKey(kv[1])] = parseTomlScalar(kv[2].trim());
  }
  return root;
}
function splitTomlPath(value) {
  const parts = [];
  let current = "";
  let inQuote = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === '"' && value[index - 1] !== "\\") {
      inQuote = !inQuote;
      current += char;
      continue;
    }
    if (char === "." && !inQuote) {
      parts.push(unquoteTomlKey(current.trim()));
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) parts.push(unquoteTomlKey(current.trim()));
  return parts;
}
function unquoteTomlKey(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}
function parseTomlScalar(value) {
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  return value;
}
function convertJsonToToml(value) {
  const lines = [];
  serializeTomlObject(value, [], lines);
  return lines.length > 0 ? `${lines.join("\n")}
` : "";
}
function serializeTomlObject(value, prefix, lines) {
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "undefined" || isRecord(child)) continue;
    lines.push(`${toTomlKey(key)} = ${toTomlValue(child)}`);
  }
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "undefined") continue;
    if (isRecord(child)) {
      const nextPath = [...prefix, key];
      if (hasDirectTomlValues(child)) {
        lines.push("");
        lines.push(`[${[...nextPath].map(toTomlKey).join(".")}]`);
      }
      serializeTomlObject(child, nextPath, lines);
    }
  }
}
function hasDirectTomlValues(value) {
  return Object.values(value).some((child) => typeof child !== "undefined" && !isRecord(child));
}
function toTomlValue(value) {
  if (isRecord(value)) {
    const entries = [];
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
function toTomlKey(key) {
  return /^\w+$/.test(key) ? key : JSON.stringify(key);
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export {
  hasKnownConfigExtension,
  getCodexProviderProfile,
  saveCodexProviderProfile,
  resolveCodexConfigPath,
  migrateCodexJsonProfilesToToml
};
