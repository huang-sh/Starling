import chalk from "chalk";
import { randomUUID } from "crypto";
import { chmodSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { extname, join } from "path";
import { DEFAULT_CODEX_HOME } from "../constants.js";
import { startCodexChatProxy } from "./codexChatProxy.js";
import { ensureDir } from "../utils/fs.js";

/**
 * Codex run-config subsystem: load a Starling Codex profile (.json/.jsonc/.toml)
 * into a temp profile + CLI args, optionally routing chat-completions providers
 * through the local chat proxy. Extracted from src/commands/run.ts so both
 * `starling run` and `starling diagnose` share one implementation.
 *
 * Behavior (including process.exit on fatal config errors) is preserved verbatim
 * from run.ts to avoid changing `starling run` semantics.
 */

export interface CodexRunConfig {
  args: string[];
  cleanupPaths: string[];
  cleanupTasks?: Array<() => Promise<void>>;
  env?: NodeJS.ProcessEnv;
  eventsPath?: string;
}

interface CodexRunProfile {
  inlineConfig: Record<string, unknown> | null;
  configText: string | null;
  env: NodeJS.ProcessEnv;
  chatProxy: CodexChatProxySpec | null;
}

interface CodexChatProxySpec {
  providerName: string;
  upstreamBaseUrl: string;
  apiKey: string;
  model?: string;
  config: Record<string, unknown>;
}

export async function createCodexRunConfig(configPath: string | null): Promise<CodexRunConfig | null> {
  if (!configPath) {
    return null;
  }

  const ext = extname(configPath).toLowerCase();
  if (ext === ".toml") {
    const profile = readCodexTomlProfileForRun(configPath);
    return createCodexRunConfigFromProfile(profile);
  }

  if (ext === ".json" || ext === ".jsonc") {
    const profile = readCodexJsonProfileForRun(configPath, ext === ".jsonc");
    return createCodexRunConfigFromProfile(profile);
  }

  console.error(chalk.red(`Unsupported Codex config file type: ${configPath}`));
  console.error(chalk.gray("Use .json, .jsonc, or .toml under ~/.starling/settings/codex."));
  process.exit(1);
}

async function createCodexRunConfigFromProfile(profile: CodexRunProfile): Promise<CodexRunConfig> {
  const args: string[] = [];
  const cleanupPaths: string[] = [];
  const cleanupTasks: Array<() => Promise<void>> = [];
  let configText = profile.configText;

  if (profile.chatProxy) {
    const proxy = await startCodexChatProxy({
      upstreamBaseUrl: profile.chatProxy.upstreamBaseUrl,
      apiKey: profile.chatProxy.apiKey,
      model: profile.chatProxy.model,
    });
    cleanupTasks.push(proxy.close);
    configText = codexProxyConfigText(profile.chatProxy.config, proxy.baseUrl);
    console.error(chalk.gray(`Starling Codex adapter: routing ${profile.chatProxy.providerName} via ${proxy.baseUrl}`));
  }

  if (configText) {
    const profileName = `starling-run-${randomUUID()}`;
    const profilePath = join(DEFAULT_CODEX_HOME, `${profileName}.config.toml`);
    ensureDir(profilePath);
    writeFileSync(profilePath, configText, "utf-8");
    chmodSync(profilePath, 0o600);
    args.push("--profile", profileName);
    cleanupPaths.push(profilePath);
  }
  if (profile.inlineConfig) {
    for (const [key, value] of flattenCodexConfig(profile.inlineConfig)) {
      args.push("--config", `${key}=${toCodexConfigValue(value)}`);
    }
  }
  return { args, cleanupPaths, cleanupTasks, env: profile.env };
}

export async function cleanupCodexRunConfig(config: CodexRunConfig | null): Promise<void> {
  if (!config) return;
  for (const path of config.cleanupPaths) {
    try {
      unlinkSync(path);
    } catch {
      // best-effort cleanup
    }
  }
  for (const cleanup of config.cleanupTasks ?? []) {
    try {
      await cleanup();
    } catch {
      // best-effort cleanup
    }
  }
}

function readCodexJsonProfileForRun(configPath: string, allowComments: boolean): CodexRunProfile {
  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(allowComments ? stripJsonComments(raw) : raw) as unknown;
    if (!isRecord(parsed)) {
      console.error(chalk.red(`Codex config must be a JSON object: ${configPath}`));
      process.exit(1);
    }

    const auth = resolveCodexProfileAuth(parsed);
    const chatProxy = resolveCodexChatProxySpec(parsed, auth);
    const configText = chatProxy ? convertCodexJsonToToml(chatProxy.config) : resolveCodexProfileConfigText(parsed);
    const env = chatProxy ? resolveStringEnv(parsed.env) : resolveCodexProfileEnv(parsed, auth, configText);
    const inlineConfig = resolveCodexInlineConfig(parsed);
    return { inlineConfig, configText, env, chatProxy };
  } catch (error) {
    console.error(chalk.red(`Could not parse Codex config JSON: ${configPath}`));
    console.error(chalk.gray(String(error)));
    process.exit(1);
  }
}

function readCodexTomlProfileForRun(configPath: string): CodexRunProfile {
  try {
    const configText = readFileSync(configPath, "utf-8");
    const config = parseSimpleToml(configText);
    const auth = resolveCodexTomlAuth(config);
    const profile: Record<string, unknown> = { config };
    const chatProxy = resolveCodexChatProxySpec(profile, auth);
    const env = chatProxy ? {} : resolveCodexProfileEnv(profile, auth, configText);
    return {
      inlineConfig: null,
      configText: configText.trim() ? (configText.endsWith("\n") ? configText : `${configText}\n`) : null,
      env,
      chatProxy,
    };
  } catch (error) {
    console.error(chalk.red(`Could not parse Codex config TOML: ${configPath}`));
    console.error(chalk.gray(String(error)));
    process.exit(1);
  }
}

function resolveCodexTomlAuth(config: Record<string, unknown>): Record<string, unknown> | null {
  const providerName = resolveCodexModelProviderName(config);
  const providers = isRecord(config.model_providers) ? config.model_providers : {};
  const providerConfig = providerName && isRecord(providers[providerName]) ? providers[providerName] as Record<string, unknown> : {};
  const token = stringValue(providerConfig.experimental_bearer_token) || stringValue(config.OPENAI_API_KEY);
  return token ? { OPENAI_API_KEY: token } : null;
}

function resolveCodexProfileConfigText(profile: Record<string, unknown>): string | null {
  const value = profile.config;
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  if (isRecord(value)) {
    const toml = convertCodexJsonToToml(value);
    return toml.trim() ? toml : null;
  }

  return null;
}

function resolveCodexProfileAuth(profile: Record<string, unknown>): Record<string, unknown> | null {
  if (isRecord(profile.auth)) {
    return profile.auth;
  }

  const candidateKeys = ["OPENAI_API_KEY", "openai_api_key", "apiKey", "api_key"];
  for (const key of candidateKeys) {
    const value = profile[key];
    if (typeof value === "string" && value.trim()) {
      return { OPENAI_API_KEY: value };
    }
  }

  if (typeof profile.token === "string" && profile.token.trim()) {
    return { OPENAI_API_KEY: profile.token };
  }

  return null;
}

function resolveCodexProfileEnv(
  profile: Record<string, unknown>,
  auth: Record<string, unknown> | null,
  configText: string | null
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const candidateKeys = ["OPENAI_API_KEY", "openai_api_key", "apiKey", "api_key", "token"];
  for (const key of candidateKeys) {
    const value = auth?.[key] ??
      (key !== "token" && isRecord(profile.env) ? profile.env[key] : undefined);
    if (typeof value === "string" && value.trim()) {
      env.OPENAI_API_KEY = value;
    }
  }

  if (isRecord(profile.env)) {
    for (const [key, value] of Object.entries(profile.env)) {
      if (typeof value === "string" && value.trim()) {
        env[key] = value;
      }
    }
  }

  if (configText && isRecord(profile.config) && typeof profile.config === "object" && profile.config !== null) {
    const providerName = resolveCodexModelProviderName(profile.config);
    const baseUrl = resolveCodexCustomProviderBaseUrl(profile.config, providerName);
    if (typeof baseUrl === "string" && baseUrl.trim()) {
      env.OPENAI_BASE_URL = env.OPENAI_BASE_URL || baseUrl;
      env.OPENAI_API_BASE_URL = env.OPENAI_API_BASE_URL || baseUrl;
      env.BASE_URL = env.BASE_URL || baseUrl;
    }
  }

  return env;
}

function resolveStringEnv(value: unknown): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  if (!isRecord(value)) return env;
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "string" && child.trim()) {
      env[key] = child;
    }
  }
  return env;
}

function resolveCodexChatProxySpec(
  profile: Record<string, unknown>,
  auth: Record<string, unknown> | null
): CodexChatProxySpec | null {
  if (!isRecord(profile.config)) return null;
  const providerName = resolveCodexModelProviderName(profile.config);
  if (!providerName) return null;

  const providers = profile.config.model_providers;
  if (!isRecord(providers)) return null;
  const providerConfig = providers[providerName];
  if (!isRecord(providerConfig)) return null;

  const upstreamBaseUrl = typeof providerConfig.base_url === "string" ? providerConfig.base_url.trim() : "";
  if (!upstreamBaseUrl) return null;

  const apiFormat = resolveCodexApiFormat(profile, profile.config, providerConfig);
  const providerLabel = `${providerName} ${stringValue(providerConfig.name)} ${stringValue(profile.config.model)} ${upstreamBaseUrl}`.toLowerCase();
  const shouldProxy = apiFormat === "openai_chat" || providerLabel.includes("deepseek");
  if (!shouldProxy) return null;

  const apiKey = resolveCodexApiKey(auth, profile);
  if (!apiKey) {
    console.error(chalk.red("Codex chat adapter requires an API key in auth.OPENAI_API_KEY or OPENAI_API_KEY."));
    process.exit(1);
  }

  return {
    providerName,
    upstreamBaseUrl,
    apiKey,
    model: typeof profile.config.model === "string" ? profile.config.model : undefined,
    config: cloneRecord(profile.config),
  };
}

function codexProxyConfigText(config: Record<string, unknown>, proxyBaseUrl: string): string {
  const cloned = cloneRecord(config);
  const providerName = resolveCodexModelProviderName(cloned);
  if (!providerName || !isRecord(cloned.model_providers)) {
    return convertCodexJsonToToml(cloned);
  }

  const providerConfig = cloned.model_providers[providerName];
  if (isRecord(providerConfig)) {
    providerConfig.base_url = proxyBaseUrl;
    providerConfig.wire_api = "responses";
    providerConfig.requires_openai_auth = false;
    delete providerConfig.env_key;
    delete providerConfig.experimental_bearer_token;
    delete providerConfig.auth;
  }

  return convertCodexJsonToToml(cloned);
}

function resolveCodexApiFormat(...values: Array<Record<string, unknown>>): string | null {
  for (const value of values) {
    const apiFormat = stringValue(value.api_format) || stringValue(value.apiFormat);
    if (apiFormat) return apiFormat;
  }
  return null;
}

function resolveCodexApiKey(
  auth: Record<string, unknown> | null,
  profile: Record<string, unknown>
): string | null {
  const candidateKeys = ["OPENAI_API_KEY", "openai_api_key", "apiKey", "api_key", "token"];
  for (const key of candidateKeys) {
    const value = auth?.[key] ?? profile[key] ?? (isRecord(profile.env) ? profile.env[key] : undefined);
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function resolveCodexModelProviderName(configValue: Record<string, unknown>): string | null {
  const provider = configValue.model_provider;
  if (typeof provider === "string" && provider.trim()) return provider.trim();
  return null;
}

function resolveCodexCustomProviderBaseUrl(
  configValue: Record<string, unknown>,
  providerName: string | null
): string | null {
  if (!providerName) return null;
  const providers = configValue.model_providers;
  if (!isRecord(providers)) return null;
  const providerConfig = providers[providerName];
  if (!isRecord(providerConfig)) return null;
  const baseUrl = providerConfig.base_url;
  if (typeof baseUrl === "string" && baseUrl.trim()) return baseUrl.trim();
  return null;
}

function resolveCodexInlineConfig(profile: Record<string, unknown>): Record<string, unknown> | null {
  if (typeof profile.config !== "undefined" && typeof profile.config !== "string") {
    return null;
  }

  const config: Record<string, unknown> = { ...profile };
  delete config.auth;
  delete config.config;

  return Object.keys(config).length > 0 ? config : null;
}

function stripJsonComments(value: string): string {
  return value.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

function parseSimpleToml(raw: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
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
        current = current[part] as Record<string, unknown>;
      }
      continue;
    }

    const kv = trimmed.match(/^([A-Za-z0-9_.-]+|"(?:\\.|[^"])+")\s*=\s*(.+?)\s*(?:#.*)?$/);
    if (!kv) continue;
    current[unquoteTomlKey(kv[1])] = parseTomlScalar(kv[2].trim());
  }

  return root;
}

function splitTomlPath(value: string): string[] {
  const parts: string[] = [];
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

function unquoteTomlKey(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function parseTomlScalar(value: string): unknown {
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as string;
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

function flattenCodexConfig(
  value: Record<string, unknown>,
  prefix = ""
): [string, unknown][] {
  const entries: [string, unknown][] = [];
  for (const [key, nestedValue] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isRecord(nestedValue)) {
      entries.push(...flattenCodexConfig(nestedValue, path));
      continue;
    }
    entries.push([path, nestedValue]);
  }
  return entries;
}

function toCodexConfigValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null) {
    console.error(chalk.red("Codex config values cannot be null."));
    process.exit(1);
  }
  return JSON.stringify(value);
}

function toTomlValue(value: unknown): string {
  if (isRecord(value)) {
    const segments: string[] = [];
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === "undefined") continue;
      segments.push(`${toTomlKey(k)} = ${toTomlValue(v)}`);
    }
    return `{ ${segments.join(", ")} }`;
  }
  if (Array.isArray(value)) {
    const entries = value
      .filter((item) => typeof item !== "undefined")
      .map((item) => toTomlValue(item));
    return `[${entries.join(", ")}]`;
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null) {
    console.error(chalk.red("Codex config values cannot be null."));
    process.exit(1);
  }
  return JSON.stringify(String(value));
}

function toTomlKey(key: string): string {
  return /^\w+$/.test(key) ? key : JSON.stringify(key);
}

function serializeTomlObject(value: Record<string, unknown>, prefix: string[], lines: string[]): void {
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

function hasDirectTomlValues(value: Record<string, unknown>): boolean {
  return Object.values(value).some((child) => typeof child !== "undefined" && !isRecord(child));
}

function convertCodexJsonToToml(value: Record<string, unknown>): string {
  const lines: string[] = [];
  serializeTomlObject(value, [], lines);
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
