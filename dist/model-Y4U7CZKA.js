#!/usr/bin/env node
import {
  getCodexProviderProfile,
  migrateCodexJsonProfilesToToml,
  saveCodexProviderProfile
} from "./chunk-PWS26QTV.js";
import {
  DEFAULT_CLAUDE_SETTINGS_DIR,
  DEFAULT_CODEX_HOME,
  DEFAULT_CODEX_SETTINGS_DIR,
  atomicWriteJSON
} from "./chunk-RWHPIOVN.js";

// src/commands/model.ts
import { Command } from "commander";
import chalk from "chalk";
import Table from "cli-table3";
import { existsSync, readFileSync, readdirSync, unlinkSync } from "fs";
import { basename, extname, join } from "path";
import { homedir } from "os";
var SUPPORTED_EXTENSIONS = /* @__PURE__ */ new Set([".json", ".jsonc", ".toml"]);
function registerModelCommand(program) {
  const model = new Command("model").description("Inspect model configurations");
  model.command("list").alias("ls").description("List current and Starling-managed model configurations").option("-a, --agent <agent>", "filter by agent: claude | codex | all", "all").option("--json", "output JSON").action((opts) => {
    const agent = normalizeAgent(opts.agent);
    if (!agent) {
      console.error(chalk.red(`Unknown agent: ${opts.agent}`));
      process.exit(1);
    }
    const rows = collectModelConfigs(agent);
    if (opts.json) {
      console.log(JSON.stringify(rows, null, 2));
      return;
    }
    printModelTable(rows);
  });
  model.command("add <name>").description("Add a Starling model profile").requiredOption("-a, --agent <agent>", "agent: claude | codex").requiredOption("--model <model>", "model name").option("--base-url <url>", "provider base URL").option("--api-key <key>", "API key/token").option("--provider <provider>", "provider name", "custom").option("--reasoning <effort>", "Codex reasoning effort").option("--wire-api <api>", "Codex wire_api: responses | chat", "responses").option("--force", "overwrite existing profile").option("--json", "output JSON").action((name, opts) => {
    const agent = normalizeAgent(opts.agent);
    if (!agent || agent === "all") {
      console.error(chalk.red(`Unknown agent: ${opts.agent}`));
      console.error(chalk.gray("Allowed values: claude, codex"));
      process.exit(1);
    }
    const result = addModelProfile(name, agent, opts);
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(chalk.green(`Added ${agent} model profile: ${result.name}`));
    console.log(chalk.gray(`  Source: ${result.source}`));
  });
  model.command("delete <name>").aliases(["del", "rm"]).description("Delete a Starling model profile").requiredOption("-a, --agent <agent>", "agent: claude | codex").option("--json", "output JSON").action((name, opts) => {
    const agent = normalizeAgent(opts.agent);
    if (!agent || agent === "all") {
      console.error(chalk.red(`Unknown agent: ${opts.agent}`));
      console.error(chalk.gray("Allowed values: claude, codex"));
      process.exit(1);
    }
    const result = deleteModelProfile(name, agent);
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(chalk.green(`Deleted ${agent} model profile: ${result.name}`));
    for (const source of result.sources) {
      console.log(chalk.gray(`  Removed: ${source}`));
    }
  });
  program.addCommand(model);
}
function addModelProfile(name, agent, opts) {
  const profileName = normalizeProfileName(name);
  if (agent === "codex") {
    const existing = getCodexProviderProfile(profileName);
    if (existing && !opts.force) {
      console.error(chalk.red(`Model profile already exists: ${profileName}`));
      console.error(chalk.gray(`  Source: ${existing.filePath}`));
      console.error(chalk.gray("Use --force to overwrite it."));
      process.exit(1);
    }
  }
  const source = join(DEFAULT_CLAUDE_SETTINGS_DIR, `${profileName}.json`);
  if (existsSync(source) && !opts.force) {
    console.error(chalk.red(`Model profile already exists: ${profileName}`));
    console.error(chalk.gray(`  Source: ${source}`));
    console.error(chalk.gray("Use --force to overwrite it."));
    process.exit(1);
  }
  const model = opts.model.trim();
  if (!model) {
    console.error(chalk.red("Model name cannot be empty."));
    process.exit(1);
  }
  if (agent === "codex") {
    const saved = saveCodexProviderProfile(profileName, {
      apiKey: opts.apiKey?.trim() || "",
      baseUrl: opts.baseUrl?.trim() || "",
      model,
      modelProvider: opts.provider?.trim() || "custom",
      wireApi: opts.wireApi?.trim() || "responses",
      config: {
        model_reasoning_effort: opts.reasoning?.trim() || "",
        disable_response_storage: true
      }
    });
    return { agent, name: profileName, source: saved.filePath, model };
  }
  const payload = buildClaudeProfile(opts, model);
  atomicWriteJSON(source, payload);
  return { agent, name: profileName, source, model };
}
function deleteModelProfile(name, agent) {
  const profileName = normalizeProfileName(name);
  const sources = findModelProfileSources(profileName, agent);
  if (sources.length === 0) {
    const dir = agent === "claude" ? DEFAULT_CLAUDE_SETTINGS_DIR : DEFAULT_CODEX_SETTINGS_DIR;
    const extensions = agent === "claude" ? ".json or .jsonc" : ".toml, .json, or .jsonc";
    console.error(chalk.red(`Model profile not found: ${profileName}`));
    console.error(chalk.gray(`  Agent: ${agent}`));
    console.error(chalk.gray(`  Expected under: ${dir}`));
    console.error(chalk.gray(`  Supported files: ${profileName}${extensions}`));
    process.exit(1);
  }
  for (const source of sources) {
    unlinkSync(source);
  }
  return { agent, name: profileName, sources };
}
function findModelProfileSources(profileName, agent) {
  const dir = agent === "claude" ? DEFAULT_CLAUDE_SETTINGS_DIR : DEFAULT_CODEX_SETTINGS_DIR;
  const extensions = agent === "claude" ? [".json", ".jsonc"] : [".toml", ".json", ".jsonc"];
  return extensions.map((extension) => join(dir, `${profileName}${extension}`)).filter((source) => existsSync(source));
}
function buildClaudeProfile(opts, model) {
  const env = {
    ANTHROPIC_AUTH_TOKEN: opts.apiKey?.trim() || "",
    ANTHROPIC_BASE_URL: opts.baseUrl?.trim() || "",
    API_TIMEOUT_MS: "3000000",
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    ANTHROPIC_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model
  };
  return {
    env,
    enableAllProjectMcpServers: true,
    permissions: {
      allow: [
        "Edit:*",
        "Write:*",
        "MultiEdit:*",
        "NotebookEdit:*",
        "Bash:*"
      ],
      defaultMode: "plan"
    }
  };
}
function normalizeProfileName(name) {
  const normalized = basename(name).replace(/\.(jsonc?|toml)$/i, "").trim();
  if (!normalized || normalized === "." || normalized === "..") {
    console.error(chalk.red(`Invalid model profile name: ${name}`));
    process.exit(1);
  }
  if (!/^[A-Za-z0-9._-]+$/.test(normalized)) {
    console.error(chalk.red("Model profile name may only contain letters, numbers, dot, dash, and underscore."));
    process.exit(1);
  }
  return normalized;
}
function normalizeAgent(value) {
  const normalized = (value || "all").trim().toLowerCase();
  if (normalized === "all") return "all";
  if (normalized === "claude") return "claude";
  if (normalized === "codex" || normalized === "code") return "codex";
  return null;
}
function collectModelConfigs(agent) {
  const rows = [];
  if (agent === "all" || agent === "claude") {
    rows.push(...collectClaudeConfigs());
  }
  if (agent === "all" || agent === "codex") {
    rows.push(...collectCodexConfigs());
  }
  return rows;
}
function collectClaudeConfigs() {
  const currentPath = join(homedir(), ".claude", "settings.json");
  return [
    summarizeClaudeJson(currentPath, "current", "current"),
    ...listProfileFiles(DEFAULT_CLAUDE_SETTINGS_DIR).map(
      (filePath) => summarizeClaudeProfile(filePath, basename(filePath, extname(filePath)))
    )
  ];
}
function collectCodexConfigs() {
  migrateCodexJsonProfilesToToml();
  const currentPath = join(DEFAULT_CODEX_HOME, "config.toml");
  return [
    summarizeCodexToml(currentPath, "current", "current", readCodexAuthState()),
    ...listProfileFiles(DEFAULT_CODEX_SETTINGS_DIR).map(
      (filePath) => summarizeCodexProfile(filePath, basename(filePath, extname(filePath)))
    )
  ];
}
function listProfileFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => join(dir, entry.name)).filter((filePath) => SUPPORTED_EXTENSIONS.has(extname(filePath).toLowerCase())).sort((a, b) => a.localeCompare(b));
}
function summarizeClaudeProfile(filePath, name) {
  const extension = extname(filePath).toLowerCase();
  if (extension !== ".json" && extension !== ".jsonc") {
    return {
      agent: "claude",
      scope: "profile",
      name,
      source: filePath,
      exists: true,
      error: `Unsupported Claude profile format: ${extension}`
    };
  }
  return summarizeClaudeJson(filePath, name, "profile");
}
function summarizeClaudeJson(filePath, name, scope) {
  const base = {
    agent: "claude",
    scope,
    name,
    source: filePath,
    exists: existsSync(filePath)
  };
  if (!base.exists) return base;
  try {
    const parsed = parseJsonFile(filePath);
    const env = isRecord(parsed.env) ? parsed.env : parsed;
    const model = stringValue(env.ANTHROPIC_MODEL) || stringValue(env.CLAUDE_MODEL) || stringValue(env.ANTHROPIC_DEFAULT_SONNET_MODEL) || stringValue(parsed.model);
    const provider = inferProviderName(stringValue(env.ANTHROPIC_BASE_URL) || stringValue(env.CLAUDE_BASE_URL));
    return {
      ...base,
      model,
      provider,
      baseUrl: stringValue(env.ANTHROPIC_BASE_URL) || stringValue(env.CLAUDE_BASE_URL),
      reasoning: stringValue(env.ANTHROPIC_REASONING_EFFORT) || stringValue(parsed.reasoning),
      auth: describeAuth(env, ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "CLAUDE_API_KEY"])
    };
  } catch (error) {
    return { ...base, error: formatError(error) };
  }
}
function summarizeCodexProfile(filePath, name) {
  const extension = extname(filePath).toLowerCase();
  if (extension === ".toml") {
    return summarizeCodexToml(filePath, name, "profile", readCodexTomlAuthState(filePath));
  }
  if (extension !== ".json" && extension !== ".jsonc") {
    return {
      agent: "codex",
      scope: "profile",
      name,
      source: filePath,
      exists: true,
      error: `Unsupported Codex profile format: ${extension}`
    };
  }
  const base = {
    agent: "codex",
    scope: "profile",
    name,
    source: filePath,
    exists: true
  };
  try {
    const parsed = parseJsonFile(filePath);
    const config = isRecord(parsed.config) ? parsed.config : parsed;
    const auth = isRecord(parsed.auth) ? describeAuth(parsed.auth, ["OPENAI_API_KEY", "api_key", "apiKey"]) : "none";
    return summarizeCodexConfigObject(base, config, auth);
  } catch (error) {
    return { ...base, error: formatError(error) };
  }
}
function summarizeCodexToml(filePath, name, scope, auth) {
  const base = {
    agent: "codex",
    scope,
    name,
    source: filePath,
    exists: existsSync(filePath),
    auth
  };
  if (!base.exists) return base;
  try {
    const raw = readFileSync(filePath, "utf-8");
    const provider = parseTomlValue(raw, "model_provider");
    const providerSection = provider ? parseTomlSection(raw, `model_providers.${provider}`) : {};
    return {
      ...base,
      model: parseTomlValue(raw, "model"),
      provider: stringValue(providerSection.name) || provider,
      baseUrl: stringValue(providerSection.base_url),
      reasoning: parseTomlValue(raw, "model_reasoning_effort"),
      wireApi: stringValue(providerSection.wire_api)
    };
  } catch (error) {
    return { ...base, error: formatError(error) };
  }
}
function summarizeCodexConfigObject(base, config, auth) {
  const providerKey = stringValue(config.model_provider);
  const providers = isRecord(config.model_providers) ? config.model_providers : {};
  const providerConfig = providerKey && isRecord(providers[providerKey]) ? providers[providerKey] : {};
  const providerRecord = isRecord(providerConfig) ? providerConfig : {};
  return {
    ...base,
    model: stringValue(config.model),
    provider: stringValue(providerRecord.name) || providerKey,
    baseUrl: stringValue(providerRecord.base_url),
    reasoning: stringValue(config.model_reasoning_effort),
    wireApi: stringValue(providerRecord.wire_api),
    auth
  };
}
function readCodexAuthState() {
  const authPath = join(DEFAULT_CODEX_HOME, "auth.json");
  if (!existsSync(authPath)) return "none";
  try {
    const parsed = parseJsonFile(authPath);
    if (hasAnySecret(parsed, ["OPENAI_API_KEY", "api_key", "apiKey", "access_token", "refresh_token"])) {
      return "stored";
    }
    return Object.keys(parsed).length > 0 ? "stored" : "none";
  } catch {
    return "unreadable";
  }
}
function readCodexTomlAuthState(filePath) {
  if (!existsSync(filePath)) return "none";
  try {
    const raw = readFileSync(filePath, "utf-8");
    return /^\s*(experimental_bearer_token|OPENAI_API_KEY)\s*=\s*["'][^"']+["']/m.test(raw) ? "configured" : "none";
  } catch {
    return "unreadable";
  }
}
function printModelTable(rows) {
  if (rows.length === 0) {
    console.log(chalk.yellow("No model configurations found."));
    return;
  }
  const claudeRows = rows.filter((row) => row.agent === "claude");
  const codexRows = rows.filter((row) => row.agent === "codex");
  if (claudeRows.length > 0) {
    console.log(chalk.bold("Claude"));
    console.log(formatModelTable(claudeRows));
  }
  if (codexRows.length > 0) {
    if (claudeRows.length > 0) console.log("");
    console.log(chalk.bold("Codex"));
    console.log(formatModelTable(codexRows));
  }
}
function formatModelTable(rows) {
  const table = new Table({
    head: [
      chalk.green("Name"),
      chalk.green("Model"),
      chalk.green("Auth"),
      chalk.green("Source")
    ],
    colWidths: [12, 28, 12, 76],
    wordWrap: true,
    style: { head: [] }
  });
  for (const row of rows) {
    const source = row.exists ? row.source : chalk.gray(`${row.source} (missing)`);
    const model = row.error ? chalk.red("error") : row.model || "-";
    const auth = row.error ? truncate(row.error, 10) : row.auth || "-";
    table.push([
      row.scope === "current" && row.name === "current" ? "default" : row.name,
      model,
      auth,
      source
    ]);
  }
  return table.toString();
}
function parseJsonFile(filePath) {
  const raw = readFileSync(filePath, "utf-8");
  const parsed = JSON.parse(stripJsonComments(raw));
  if (!isRecord(parsed)) {
    throw new Error("JSON root is not an object");
  }
  return parsed;
}
function stripJsonComments(raw) {
  return raw.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}
function parseTomlValue(raw, key) {
  const pattern = new RegExp(`^\\s*${escapeRegex(key)}\\s*=\\s*(.+?)\\s*(?:#.*)?$`, "m");
  const match = raw.match(pattern);
  if (!match) return "";
  return unquoteTomlValue(match[1].trim());
}
function parseTomlSection(raw, section) {
  const result = {};
  const lines = raw.split(/\r?\n/);
  let inSection = false;
  for (const line of lines) {
    const sectionMatch = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (sectionMatch) {
      inSection = sectionMatch[1] === section;
      continue;
    }
    if (!inSection) continue;
    const kv = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=\s*(.+?)\s*(?:#.*)?$/);
    if (kv) result[kv[1]] = unquoteTomlValue(kv[2].trim());
  }
  return result;
}
function unquoteTomlValue(value) {
  if (value.startsWith('"') && value.endsWith('"') || value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return value;
}
function describeAuth(source, keys) {
  return hasAnySecret(source, keys) ? "configured" : "none";
}
function hasAnySecret(source, keys) {
  return keys.some((key) => typeof source[key] === "string" && source[key].trim().length > 0);
}
function inferProviderName(baseUrl) {
  if (!baseUrl) return "";
  try {
    const host = new URL(baseUrl).hostname.replace(/^api\./, "");
    return host.split(".")[0] || "";
  } catch {
    return "";
  }
}
function truncate(value, max) {
  return value.length > max ? `${value.slice(0, max - 1)}\u2026` : value;
}
function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}
function stringValue(value) {
  return typeof value === "string" ? value : "";
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
export {
  deleteModelProfile,
  registerModelCommand
};
