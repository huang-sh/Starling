import { Command } from "commander";
import chalk from "chalk";
import Table from "cli-table3";
import { existsSync, readFileSync, readdirSync } from "fs";
import { basename, extname, join } from "path";
import {
  DEFAULT_CLAUDE_SETTINGS_DIR,
  DEFAULT_CODEX_HOME,
  DEFAULT_CODEX_SETTINGS_DIR,
} from "../constants.js";
import { homedir } from "os";
import { atomicWriteJSON } from "../utils/fs.js";

type ModelAgent = "claude" | "codex";
type ModelScope = "current" | "profile";

interface ModelConfigSummary {
  agent: ModelAgent;
  scope: ModelScope;
  name: string;
  source: string;
  exists: boolean;
  model?: string;
  provider?: string;
  baseUrl?: string;
  reasoning?: string;
  wireApi?: string;
  auth?: string;
  error?: string;
}

const SUPPORTED_EXTENSIONS = new Set([".json", ".jsonc", ".toml"]);

export function registerModelCommand(program: Command): void {
  const model = new Command("model").description("Inspect model configurations");

  model
    .command("list")
    .alias("ls")
    .description("List current and Starling-managed model configurations")
    .option("-a, --agent <agent>", "filter by agent: claude | codex | all", "all")
    .option("--json", "output JSON")
    .action((opts: { agent?: string; json?: boolean }) => {
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

  model
    .command("add <name>")
    .description("Add a Starling model profile")
    .requiredOption("-a, --agent <agent>", "agent: claude | codex")
    .requiredOption("--model <model>", "model name")
    .option("--base-url <url>", "provider base URL")
    .option("--api-key <key>", "API key/token")
    .option("--provider <provider>", "provider name", "custom")
    .option("--reasoning <effort>", "Codex reasoning effort")
    .option("--wire-api <api>", "Codex wire_api: responses | chat", "responses")
    .option("--force", "overwrite existing profile")
    .option("--json", "output JSON")
    .action((name: string, opts: {
      agent: string;
      model: string;
      baseUrl?: string;
      apiKey?: string;
      provider?: string;
      reasoning?: string;
      wireApi?: string;
      force?: boolean;
      json?: boolean;
    }) => {
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

  program.addCommand(model);
}

interface AddModelProfileResult {
  agent: ModelAgent;
  name: string;
  source: string;
  model: string;
}

interface AddModelProfileOptions {
  model: string;
  baseUrl?: string;
  apiKey?: string;
  provider?: string;
  reasoning?: string;
  wireApi?: string;
  force?: boolean;
}

function addModelProfile(name: string, agent: ModelAgent, opts: AddModelProfileOptions): AddModelProfileResult {
  const profileName = normalizeProfileName(name);
  const source = join(agent === "claude" ? DEFAULT_CLAUDE_SETTINGS_DIR : DEFAULT_CODEX_SETTINGS_DIR, `${profileName}.json`);
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

  const payload = agent === "claude" ? buildClaudeProfile(opts, model) : buildCodexProfile(opts, model);
  atomicWriteJSON(source, payload);
  return { agent, name: profileName, source, model };
}

function buildClaudeProfile(opts: AddModelProfileOptions, model: string): Record<string, unknown> {
  const env: Record<string, string> = {
    ANTHROPIC_AUTH_TOKEN: opts.apiKey?.trim() || "",
    ANTHROPIC_BASE_URL: opts.baseUrl?.trim() || "",
    API_TIMEOUT_MS: "3000000",
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    ANTHROPIC_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
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
        "Bash:*",
      ],
      defaultMode: "plan",
    },
  };
}

function buildCodexProfile(opts: AddModelProfileOptions, model: string): Record<string, unknown> {
  const provider = opts.provider?.trim() || "custom";
  const providerConfig: Record<string, unknown> = {
    name: provider,
    base_url: opts.baseUrl?.trim() || "",
    wire_api: opts.wireApi?.trim() || "responses",
    requires_openai_auth: true,
  };

  const config: Record<string, unknown> = {
    model_provider: provider,
    model,
    model_reasoning_effort: opts.reasoning?.trim() || "",
    disable_response_storage: true,
    model_providers: {
      [provider]: providerConfig,
    },
  };

  return {
    auth: {
      OPENAI_API_KEY: opts.apiKey?.trim() || "",
    },
    config,
  };
}

function normalizeProfileName(name: string): string {
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

function normalizeAgent(value?: string): ModelAgent | "all" | null {
  const normalized = (value || "all").trim().toLowerCase();
  if (normalized === "all") return "all";
  if (normalized === "claude") return "claude";
  if (normalized === "codex" || normalized === "code") return "codex";
  return null;
}

function collectModelConfigs(agent: ModelAgent | "all"): ModelConfigSummary[] {
  const rows: ModelConfigSummary[] = [];
  if (agent === "all" || agent === "claude") {
    rows.push(...collectClaudeConfigs());
  }
  if (agent === "all" || agent === "codex") {
    rows.push(...collectCodexConfigs());
  }
  return rows;
}

function collectClaudeConfigs(): ModelConfigSummary[] {
  const currentPath = join(homedir(), ".claude", "settings.json");
  return [
    summarizeClaudeJson(currentPath, "current", "current"),
    ...listProfileFiles(DEFAULT_CLAUDE_SETTINGS_DIR).map((filePath) =>
      summarizeClaudeProfile(filePath, basename(filePath, extname(filePath)))
    ),
  ];
}

function collectCodexConfigs(): ModelConfigSummary[] {
  const currentPath = join(DEFAULT_CODEX_HOME, "config.toml");
  return [
    summarizeCodexToml(currentPath, "current", "current", readCodexAuthState()),
    ...listProfileFiles(DEFAULT_CODEX_SETTINGS_DIR).map((filePath) =>
      summarizeCodexProfile(filePath, basename(filePath, extname(filePath)))
    ),
  ];
}

function listProfileFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(dir, entry.name))
    .filter((filePath) => SUPPORTED_EXTENSIONS.has(extname(filePath).toLowerCase()))
    .sort((a, b) => a.localeCompare(b));
}

function summarizeClaudeProfile(filePath: string, name: string): ModelConfigSummary {
  const extension = extname(filePath).toLowerCase();
  if (extension !== ".json" && extension !== ".jsonc") {
    return {
      agent: "claude",
      scope: "profile",
      name,
      source: filePath,
      exists: true,
      error: `Unsupported Claude profile format: ${extension}`,
    };
  }
  return summarizeClaudeJson(filePath, name, "profile");
}

function summarizeClaudeJson(filePath: string, name: string, scope: ModelScope): ModelConfigSummary {
  const base: ModelConfigSummary = {
    agent: "claude",
    scope,
    name,
    source: filePath,
    exists: existsSync(filePath),
  };
  if (!base.exists) return base;

  try {
    const parsed = parseJsonFile(filePath);
    const env = isRecord(parsed.env) ? parsed.env : parsed;
    const model =
      stringValue(env.ANTHROPIC_MODEL) ||
      stringValue(env.CLAUDE_MODEL) ||
      stringValue(env.ANTHROPIC_DEFAULT_SONNET_MODEL) ||
      stringValue(parsed.model);
    const provider = inferProviderName(stringValue(env.ANTHROPIC_BASE_URL) || stringValue(env.CLAUDE_BASE_URL));
    return {
      ...base,
      model,
      provider,
      baseUrl: stringValue(env.ANTHROPIC_BASE_URL) || stringValue(env.CLAUDE_BASE_URL),
      reasoning: stringValue(env.ANTHROPIC_REASONING_EFFORT) || stringValue(parsed.reasoning),
      auth: describeAuth(env, ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "CLAUDE_API_KEY"]),
    };
  } catch (error) {
    return { ...base, error: formatError(error) };
  }
}

function summarizeCodexProfile(filePath: string, name: string): ModelConfigSummary {
  const extension = extname(filePath).toLowerCase();
  if (extension === ".toml") {
    return summarizeCodexToml(filePath, name, "profile", "profile");
  }
  if (extension !== ".json" && extension !== ".jsonc") {
    return {
      agent: "codex",
      scope: "profile",
      name,
      source: filePath,
      exists: true,
      error: `Unsupported Codex profile format: ${extension}`,
    };
  }

  const base: ModelConfigSummary = {
    agent: "codex",
    scope: "profile",
    name,
    source: filePath,
    exists: true,
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

function summarizeCodexToml(filePath: string, name: string, scope: ModelScope, auth: string): ModelConfigSummary {
  const base: ModelConfigSummary = {
    agent: "codex",
    scope,
    name,
    source: filePath,
    exists: existsSync(filePath),
    auth,
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
      wireApi: stringValue(providerSection.wire_api),
    };
  } catch (error) {
    return { ...base, error: formatError(error) };
  }
}

function summarizeCodexConfigObject(
  base: ModelConfigSummary,
  config: Record<string, unknown>,
  auth: string
): ModelConfigSummary {
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
    auth,
  };
}

function readCodexAuthState(): string {
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

function printModelTable(rows: ModelConfigSummary[]): void {
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

function formatModelTable(rows: ModelConfigSummary[]): string {
  const table = new Table({
    head: [
      chalk.green("Name"),
      chalk.green("Model"),
      chalk.green("Auth"),
      chalk.green("Source"),
    ],
    colWidths: [12, 28, 12, 76],
    wordWrap: true,
    style: { head: [] },
  });

  for (const row of rows) {
    const source = row.exists ? row.source : chalk.gray(`${row.source} (missing)`);
    const model = row.error ? chalk.red("error") : row.model || "-";
    const auth = row.error ? truncate(row.error, 10) : row.auth || "-";
    table.push([
      row.scope === "current" && row.name === "current" ? "default" : row.name,
      model,
      auth,
      source,
    ]);
  }

  return table.toString();
}

function parseJsonFile(filePath: string): Record<string, unknown> {
  const raw = readFileSync(filePath, "utf-8");
  const parsed = JSON.parse(stripJsonComments(raw)) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("JSON root is not an object");
  }
  return parsed;
}

function stripJsonComments(raw: string): string {
  return raw.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

function parseTomlValue(raw: string, key: string): string {
  const pattern = new RegExp(`^\\s*${escapeRegex(key)}\\s*=\\s*(.+?)\\s*(?:#.*)?$`, "m");
  const match = raw.match(pattern);
  if (!match) return "";
  return unquoteTomlValue(match[1].trim());
}

function parseTomlSection(raw: string, section: string): Record<string, string> {
  const result: Record<string, string> = {};
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

function unquoteTomlValue(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function describeAuth(source: Record<string, unknown>, keys: string[]): string {
  return hasAnySecret(source, keys) ? "configured" : "none";
}

function hasAnySecret(source: Record<string, unknown>, keys: string[]): boolean {
  return keys.some((key) => typeof source[key] === "string" && (source[key] as string).trim().length > 0);
}

function inferProviderName(baseUrl: string): string {
  if (!baseUrl) return "";
  try {
    const host = new URL(baseUrl).hostname.replace(/^api\./, "");
    return host.split(".")[0] || "";
  } catch {
    return "";
  }
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
