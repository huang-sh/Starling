import { Command } from "commander";
import chalk from "chalk";
import { randomUUID } from "crypto";
import { chmodSync, existsSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "fs";
import { createInterface } from "node:readline/promises";
import { spawn } from "child_process";
import { basename, extname, isAbsolute, join, resolve } from "path";
import {
  addBookmark,
  addSpace,
  findBookmark,
  listSpaces,
  listBookmarks,
  updateBookmark,
} from "../lib/store.js";
import { generateBookmarkId, generateSpaceId } from "../lib/id.js";
import { findSessionById, findSessions, streamSessions } from "../lib/discovery.js";
import {
  DEFAULT_STARLING_HOME,
  DEFAULT_CLAUDE_SETTINGS_DIR,
  DEFAULT_CODEX_SETTINGS_DIR,
  DEFAULT_CODEX_HOME,
  CLAUDE_SESSIONS_DIR,
  CODEX_SESSIONS_DIR,
} from "../constants.js";
import { parseJsonlHead, extractClaudeSessionMeta, extractCodexSessionMeta } from "../lib/session.js";
import { atomicWriteJSON, ensureDir } from "../utils/fs.js";
import { resolveCodexConfigPath } from "../lib/codexProvider.js";
import { startCodexChatProxy } from "../lib/codexChatProxy.js";
import {
  snapshotCodexDefaultConfig,
  restoreCodexDefaultConfig,
} from "../lib/codexDefaultGuard.js";
import { upsertSessionInIndex } from "../lib/sessionIndex.js";
import { shortSessionId } from "../lib/sessionDisplay.js";
import { catalogPath, resolveCatalogReference } from "../lib/catalogResolver.js";
import type { SessionMeta, Space } from "../types.js";

type AgentProvider = "claude" | "codex";

interface RunOptions {
  config?: string;
  catalog?: string;
  title?: string;
  tags?: string;
  cwd?: string;
}

interface RunResult {
  exitCode: number;
}

interface RunAgentOptions {
  preserveSignals?: boolean;
  env?: NodeJS.ProcessEnv;
}

const RUN_SESSION_SCAN_LIMIT = 500;
const RUN_SESSION_CATALOG_SCAN_LIMIT = 2000;
const RUN_SESSION_DETECT_ATTEMPTS = 8;
const RUN_SESSION_DETECT_INTERVAL_MS = 300;
const RUN_SESSION_DETECT_FULL_SCAN_THRESHOLD_MS = 200;
const RUN_SESSION_EXIT_SETTLE_MS = 200;
const RUN_FAST_FAILURE_SKIP_SCAN_MS = 2000;

export function registerRunCommand(program: Command): void {
  const run = new Command("run")
    .description("Launch claude/codex with auto catalog assignment for the created session")
    .argument("<agent>", "agent binary: claude | codex | agent")
    .argument("[agent-args...]", "arguments passed verbatim to the agent CLI")
    .option("-c, --catalog <catalog>", "add created session to catalog")
    .option("--config <config>", "Starling settings profile under ~/.starling/settings/{claude|codex}")
    .option("--title <title>", "pin title for created session")
    .option("--tags <tags>", "pin tags for created session, comma-separated")
    .option("--cwd <path>", "working directory for agent launch")
    .allowUnknownOption()
    .passThroughOptions()
    .addHelpText(
      "after",
      "\nStarling options must be placed before <agent>. Everything after <agent> is passed to claude/codex."
    )
    .action(async (agentRaw: string, agentArgs: string[], opts: RunOptions, command: Command) => {
      const provider = normalizeAgent(agentRaw);
      if (!provider) {
        console.error(chalk.red(`Unknown agent: ${agentRaw}`));
        console.error(chalk.gray("Allowed values: claude, codex, agent"));
        process.exit(1);
      }

      const rawArgs = (command as { rawArgs?: string[] }).rawArgs;
      const requestedConfig = opts.config;
      const resolvedConfig =
        provider === "codex" ? resolveCodexConfigPath(requestedConfig) : resolveConfigFilePath(provider, opts.config);
      if (provider === "codex" && requestedConfig && !resolvedConfig) {
        const expectedPath = join(DEFAULT_CODEX_SETTINGS_DIR, requestedConfig);
        console.error(chalk.red(`Config file not found: ${requestedConfig}`));
        console.error(chalk.gray(`Expected path: ${expectedPath}`));
        process.exit(1);
      }
      const normalizedCwd = opts.cwd ? resolve(opts.cwd) : process.cwd();
      const catalog = await resolveCatalog(opts.catalog);
      const codexDefaultSnapshot = provider === "codex" ? snapshotCodexDefaultConfig() : null;
      let codexConfig = provider === "codex"
        ? await createCodexRunConfig(resolvedConfig)
        : null;
      if (provider === "codex" && catalog) {
        codexConfig = ensureCodexRunHookConfig(codexConfig);
      }
      const hookRun =
        provider === "claude" && catalog ? createClaudeRunHookSettings(resolvedConfig) : null;
      const effectiveConfig = hookRun?.settingsPath ?? resolvedConfig;
      const args = resolveAgentArgs(provider, rawArgs, agentArgs, effectiveConfig, codexConfig);
      const cwd = opts.cwd;
      const binary = provider === "claude" ? "claude" : "codex";
      const startedAt = new Date().toISOString();
      const runStartedAtMs = Date.now();
      const beforeRun = hookRun ? new Map<string, number>() : await snapshotSessions(provider);
      const beforeRunProjectFiles =
        provider === "claude" && !hookRun ? snapshotProjectSessions(normalizedCwd) : new Map<string, number>();
      const cleanupRunState = async () => {
        cleanupClaudeRunHookSettings(hookRun);
        await cleanupCodexRunConfig(codexConfig);
        restoreCodexDefaultConfig(codexDefaultSnapshot);
      };

      let catalogPinned = false;
      let agentClosed = false;
      let hintedSessionId: string | undefined;
      let pinAttempt: Promise<void> | null = null;
      const startAutoPinWatcher = async () => {
        if (!catalog || catalogPinned) return;
        if (pinAttempt) return;

        pinAttempt = (async () => {
          const startedTime = Date.parse(startedAt);
          let attemptsAfterClose = 0;
          for (let i = 0; ; i++) {
            const sessionId = hintedSessionId ?? readRunHookSessionId(hookRun?.eventsPath ?? codexConfig?.eventsPath);
            if (!sessionId) {
              if (provider === "codex") {
                const candidate = await findSingleCodexSessionForRunningAgent(startedTime, beforeRun, normalizedCwd);
                if (candidate) {
                  hintedSessionId = candidate.session_id;
                  await pinSessionToCatalog(candidate, opts, catalog);
                  catalogPinned = true;
                  return;
                }
              }
              if (agentClosed) return;
              await sleep(250);
              continue;
            }

            hintedSessionId = sessionId;
            const candidate: SessionMeta | null = hookRun && provider === "claude"
              ? await findClaudeSessionInProjectById(sessionId, normalizedCwd)
              : await findKnownSessionForRun(sessionId, provider, normalizedCwd, i);
            if (candidate && candidate.provider === provider && wasSessionTouchedAfterRun(candidate, startedTime, beforeRun)) {
              await pinSessionToCatalog(candidate, opts, catalog);
              catalogPinned = true;
              return;
            }
            if (agentClosed) {
              attemptsAfterClose++;
              if (attemptsAfterClose >= 20) break;
            }
            await sleep(250);
          }

          const fallback = provider === "claude"
            ? await detectSessionInCurrentClaudeProject(
              Date.parse(startedAt),
              beforeRun,
              normalizedCwd,
              beforeRunProjectFiles
            )
            : await findSingleCodexSessionForRunningAgent(
              Date.parse(startedAt),
              beforeRun,
              normalizedCwd
            );
          if (fallback && fallback.provider === provider && (!hintedSessionId || fallback.session_id === hintedSessionId)) {
            await pinSessionToCatalog(fallback, opts, catalog);
            catalogPinned = true;
          }
        })().finally(() => {
          pinAttempt = null;
        });

        pinAttempt.catch((error) => {
          if (process.env.NODE_ENV !== "test") {
            const sessionLabel = hintedSessionId ? ` ${hintedSessionId}` : "";
            console.error(chalk.yellow(`Failed to auto-pin session${sessionLabel} to catalog ${catalog?.name}: ${String(error)}`));
          }
        });
      };

      if (hookRun || (provider === "codex" && catalog)) {
        void startAutoPinWatcher();
      }

      let runResult: RunResult;
      try {
        runResult = await runAgent(binary, args, cwd, {
          preserveSignals: true,
          env: buildAgentEnv(provider, codexConfig?.env),
        });
      } catch (error) {
        await cleanupRunState();
        throw error;
      }
      agentClosed = true;
      syncCodexProfileProjectTrustFromRunConfig(resolvedConfig, codexConfig);
      const exitCode = runResult.exitCode;
      if (exitCode !== 0) {
        await sleep(RUN_SESSION_EXIT_SETTLE_MS);
      }
      const knownSessionId =
        hintedSessionId ?? readRunHookSessionId(hookRun?.eventsPath ?? codexConfig?.eventsPath) ?? undefined;
      if (exitCode !== 0 && Date.now() - runStartedAtMs < RUN_FAST_FAILURE_SKIP_SCAN_MS && !knownSessionId) {
        await cleanupRunState();
        process.exit(exitCode);
      }
      if (hookRun && !knownSessionId) {
        await cleanupRunState();
        if (exitCode !== 0) {
          process.exit(exitCode);
        }
        console.log(chalk.yellow("No Claude session id was reported by SessionStart hook."));
        return;
      }

      const newSessionMeta = hookRun && knownSessionId
        ? await resolveHookReportedClaudeSession(knownSessionId, normalizedCwd)
        : await detectSessionStartedAfterRun(
          provider,
          startedAt,
          beforeRun,
          normalizedCwd,
          beforeRunProjectFiles,
          knownSessionId
        );

      if (!newSessionMeta) {
        if (exitCode !== 0) {
          await cleanupRunState();
          process.exit(exitCode);
        }
        console.log(chalk.yellow("No new session found, or session metadata is not ready yet."));
        await cleanupRunState();
        return;
      }

      if (catalog && !catalogPinned) {
        if (knownSessionId && newSessionMeta.session_id === knownSessionId) {
          await pinSessionToCatalog(newSessionMeta, opts, catalog);
          catalogPinned = true;
        } else {
          const candidates = await collectRunSessionCandidates(
            provider,
            Date.parse(startedAt),
            beforeRun,
            normalizedCwd,
            beforeRunProjectFiles
          );

          const sameProjectCandidates = candidates.filter((session) =>
            normalizeProjectPath(session.project_path) === normalizedCwd
          );
          const targetCandidates = sameProjectCandidates.length > 0 ? sameProjectCandidates : candidates;

          if (targetCandidates.length === 0) {
            console.log(chalk.yellow("Could not find a stable candidate session for catalog assignment."));
          } else if (targetCandidates.length === 1) {
            await pinSessionToCatalog(targetCandidates[0]!, opts, catalog);
            catalogPinned = true;
          } else {
            const header = `Found ${targetCandidates.length} possible sessions created after run, can't choose automatically.`;
            console.log(chalk.yellow(header));
            targetCandidates.slice(0, 5).forEach((session, index) => {
              const shortId = shortSessionId(session.session_id);
              const date = session.modified_at.slice(0, 16).replace("T", " ");
              const project = session.project_path
                ? session.project_path.length > 36
                  ? `…${session.project_path.slice(-35)}`
                  : session.project_path
                : "-";
              console.log(`  ${index + 1}. ${chalk.cyan(shortId)}  ${date}  ${project}`);
            });
            console.log(chalk.gray(`Use: starling pin <session_id> --to ${catalog.id} to assign manually.`));
          }
        }
      }

      console.log(chalk.green(`Session started: ${newSessionMeta.session_id}`));
      updateSessionIndexInBackground(newSessionMeta);

      if (pinAttempt) {
        await pinAttempt;
      }

      if (exitCode !== 0) {
        await cleanupRunState();
        process.exit(exitCode);
      }

      await cleanupRunState();
    });

  program.addCommand(run);
}

function updateSessionIndexInBackground(session: SessionMeta): void {
  setImmediate(() => {
    try {
      upsertSessionInIndex(session);
    } catch {
      // Background index maintenance must not affect the run result.
    }
  });
}

const CONFIG_FILE_EXTENSIONS = [".json", ".jsonc", ".toml", ".yaml", ".yml", ".js", ".ts"];
const SESSION_ID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

interface ClaudeRunHook {
  settingsPath: string;
  eventsPath: string;
}

interface CodexRunConfig {
  args: string[];
  cleanupPaths: string[];
  cleanupTasks?: Array<() => Promise<void>>;
  env?: NodeJS.ProcessEnv;
  eventsPath?: string;
}

function buildAgentEnv(provider: AgentProvider, overrides?: NodeJS.ProcessEnv): NodeJS.ProcessEnv | undefined {
  if (provider !== "codex" && !overrides) return undefined;

  const env: NodeJS.ProcessEnv = { ...process.env, ...(overrides ?? {}) };
  if (provider === "codex") {
    for (const key of Object.keys(env)) {
      if (key.startsWith("CODEX_") && key !== "CODEX_HOME") {
        delete env[key];
      }
    }
  }
  return env;
}

function parseSessionIdFromText(text: string): string | null {
  const resumeMatch = text.match(new RegExp(`--resume\\s+(${SESSION_ID_PATTERN.source})`, "i"));
  if (resumeMatch?.[1]) return resumeMatch[1];
  const sessionMatch = text.match(new RegExp(`session\\s+id\\s*[:=]\\s*(${SESSION_ID_PATTERN.source})`, "i"));
  if (sessionMatch?.[1]) return sessionMatch[1];
  const genericMatch = SESSION_ID_PATTERN.exec(text)?.[0];
  if (genericMatch) return genericMatch;
  return null;
}

function createClaudeRunHookSettings(configPath: string | null): ClaudeRunHook | null {
  const runId = randomUUID();
  const baseDir = join(DEFAULT_STARLING_HOME, "run-hooks");
  const eventsPath = join(baseDir, `${runId}.jsonl`);
  const settingsPath = join(baseDir, `${runId}.settings.json`);
  ensureDir(eventsPath);

  const settings = readClaudeSettingsObject(configPath);
  if (!settings) return null;

  const hooks = isRecord(settings.hooks) ? { ...settings.hooks } : {};
  const sessionStart = Array.isArray(hooks.SessionStart) ? [...hooks.SessionStart] : [];
  sessionStart.push({
    hooks: [
      {
        type: "command",
        command: `bash -c 'cat >> "$1"; printf "\\n" >> "$1"' _ ${shellQuote(eventsPath)}`,
      },
    ],
  });
  hooks.SessionStart = sessionStart;

  atomicWriteJSON(settingsPath, { ...settings, hooks });
  return { settingsPath, eventsPath };
}

function cleanupClaudeRunHookSettings(hookRun: ClaudeRunHook | null): void {
  if (!hookRun) return;
  for (const path of [hookRun.settingsPath, hookRun.eventsPath]) {
    try {
      unlinkSync(path);
    } catch {
      // best-effort cleanup
    }
  }
}

async function createCodexRunConfig(configPath: string | null): Promise<CodexRunConfig | null> {
  if (!configPath) {
    return null;
  }

  const ext = extname(configPath).toLowerCase();
  if (ext === ".toml") {
    const profileName = `starling-run-${randomUUID()}`;
    const profilePath = join(DEFAULT_CODEX_HOME, `${profileName}.config.toml`);
    ensureDir(profilePath);
    writeFileSync(profilePath, readFileSync(configPath, "utf-8"), "utf-8");
    chmodSync(profilePath, 0o600);
    return { args: ["--profile", profileName], cleanupPaths: [profilePath] };
  }

  if (ext === ".json" || ext === ".jsonc") {
    const profile = readCodexJsonProfileForRun(configPath, ext === ".jsonc");
    return createCodexRunConfigFromProfile(profile);
  }

  console.error(chalk.red(`Unsupported Codex config file type: ${configPath}`));
  console.error(chalk.gray("Use .json, .jsonc, or .toml under ~/.starling/settings/codex."));
  process.exit(1);
}

function ensureCodexRunHookConfig(config: CodexRunConfig | null): CodexRunConfig {
  const runId = randomUUID();
  const baseDir = join(DEFAULT_STARLING_HOME, "run-hooks");
  const eventsPath = join(baseDir, `${runId}.codex.jsonl`);
  ensureDir(eventsPath);

  const hookText = codexSessionStartHookToml(eventsPath);
  if (config?.cleanupPaths[0] && config.args.includes("--profile")) {
    const profilePath = config.cleanupPaths[0];
    const existing = readFileSync(profilePath, "utf-8");
    writeFileSync(profilePath, `${existing.trimEnd()}\n\n${hookText}`, "utf-8");
    return {
      ...config,
      args: addCodexHookTrustBypassArg(config.args),
      cleanupPaths: [...config.cleanupPaths, eventsPath],
      eventsPath,
    };
  }

  const profileName = `starling-run-${randomUUID()}`;
  const profilePath = join(DEFAULT_CODEX_HOME, `${profileName}.config.toml`);
  ensureDir(profilePath);
  writeFileSync(profilePath, hookText, "utf-8");
  chmodSync(profilePath, 0o600);

  return {
    args: ["--profile", profileName, ...addCodexHookTrustBypassArg(config?.args ?? [])],
    cleanupPaths: [profilePath, eventsPath, ...(config?.cleanupPaths ?? [])],
    cleanupTasks: config?.cleanupTasks,
    env: config?.env,
    eventsPath,
  };
}

function codexSessionStartHookToml(eventsPath: string): string {
  return [
    "[features]",
    "hooks = true",
    "",
    "[[hooks.SessionStart]]",
    'matcher = "startup"',
    "",
    "[[hooks.SessionStart.hooks]]",
    'type = "command"',
    `command = ${JSON.stringify(`bash -c 'cat >> "$1"; printf "\\n" >> "$1"' _ ${shellQuote(eventsPath)}`)}`,
    "timeout = 5",
  ].join("\n") + "\n";
}

function addCodexHookTrustBypassArg(args: string[]): string[] {
  return args.includes("--dangerously-bypass-hook-trust") ? args : ["--dangerously-bypass-hook-trust", ...args];
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

async function cleanupCodexRunConfig(config: CodexRunConfig | null): Promise<void> {
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

function syncCodexProfileProjectTrustFromRunConfig(
  sourceConfigPath: string | null,
  runConfig: CodexRunConfig | null
): void {
  if (!sourceConfigPath || !runConfig) return;
  const sourceExt = extname(sourceConfigPath).toLowerCase();
  if (sourceExt !== ".json" && sourceExt !== ".jsonc") return;

  const trustedProjects = new Set<string>();
  for (const path of runConfig.cleanupPaths) {
    if (!path.endsWith(".config.toml") || !existsSync(path)) continue;
    for (const projectPath of readTrustedProjectsFromCodexToml(path)) {
      trustedProjects.add(projectPath);
    }
  }
  if (trustedProjects.size === 0) return;

  try {
    const raw = readFileSync(sourceConfigPath, "utf-8");
    const parsed = JSON.parse(sourceExt === ".jsonc" ? stripJsonComments(raw) : raw) as unknown;
    if (!isRecord(parsed)) return;

    const config = isRecord(parsed.config) ? parsed.config : {};
    const projects = isRecord(config.projects) ? config.projects : {};
    let changed = false;

    for (const projectPath of trustedProjects) {
      const project = isRecord(projects[projectPath]) ? projects[projectPath] as Record<string, unknown> : {};
      if (project.trust_level === "trusted") continue;
      project.trust_level = "trusted";
      projects[projectPath] = project;
      changed = true;
    }

    if (!changed) return;
    config.projects = projects;
    parsed.config = config;
    atomicWriteJSON(sourceConfigPath, parsed);
  } catch (error) {
    console.error(chalk.yellow(`Could not sync Codex project trust to ${sourceConfigPath}: ${String(error)}`));
  }
}

function readTrustedProjectsFromCodexToml(filePath: string): string[] {
  const raw = readFileSync(filePath, "utf-8");
  const trusted: string[] = [];
  let currentProject: string | null = null;
  let currentTrusted = false;

  const flush = () => {
    if (currentProject && currentTrusted) trusted.push(currentProject);
  };

  for (const line of raw.split(/\r?\n/)) {
    const section = line.match(/^\s*\[projects\.(?:"([^"]+)"|'([^']+)'|([^\]]+))\]\s*$/);
    if (section) {
      flush();
      currentProject = section[1] ?? section[2] ?? section[3] ?? null;
      currentTrusted = false;
      continue;
    }

    if (!currentProject) continue;
    const trust = line.match(/^\s*trust_level\s*=\s*(?:"trusted"|'trusted')\s*(?:#.*)?$/);
    if (trust) currentTrusted = true;
  }

  flush();
  return trusted;
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

function convertCodexJsonToToml(value: Record<string, unknown>): string {
  const lines: string[] = [];
  serializeTomlObject(value, [], lines);
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

function readRunHookSessionId(eventsPath?: string): string | null {
  if (!eventsPath || !existsSync(eventsPath)) return null;
  let raw = "";
  try {
    raw = readFileSync(eventsPath, "utf-8");
  } catch {
    return null;
  }

  const lines = raw.trim().split(/\r?\n/).filter(Boolean).reverse();
  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as unknown;
      const sessionId = readSessionIdFromHookEntry(entry);
      if (sessionId) return sessionId;
    } catch {
      const sessionId = parseSessionIdFromText(line);
      if (sessionId) return sessionId;
    }
  }
  return null;
}

function readSessionIdFromHookEntry(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const direct = value.session_id ?? value.sessionId;
  if (typeof direct === "string" && SESSION_ID_PATTERN.test(direct)) return direct;

  for (const nested of Object.values(value)) {
    const found = readSessionIdFromHookEntry(nested);
    if (found) return found;
  }
  return null;
}

function readClaudeSettingsObject(configPath: string | null): Record<string, unknown> | null {
  if (!configPath) return {};
  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (isRecord(parsed)) return parsed;
  } catch {
    console.log(chalk.yellow("Could not add Claude SessionStart hook because settings is not parseable JSON."));
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function resolveConfigFilePath(provider: AgentProvider, configFile?: string): string | null {
  if (!configFile) return null;

  if (isAbsolute(configFile) || existsSync(configFile)) {
    if (!existsSync(configFile)) {
      console.error(chalk.red(`Config file not found: ${configFile}`));
      process.exit(1);
    }
    return configFile;
  }

  const baseDir = provider === "claude" ? DEFAULT_CLAUDE_SETTINGS_DIR : DEFAULT_CODEX_SETTINGS_DIR;
  const fileName = basename(configFile);
  const candidate = join(baseDir, fileName);
  if (existsSync(candidate)) return candidate;

  const candidatesTried = [candidate];
  if (!extname(fileName)) {
    for (const ext of CONFIG_FILE_EXTENSIONS) {
      const candidateWithExtension = `${candidate}${ext}`;
      candidatesTried.push(candidateWithExtension);
      if (existsSync(candidateWithExtension)) return candidateWithExtension;
    }
  }

  console.error(chalk.red(`Config file not found: ${configFile}`));
  console.error(chalk.gray(`Expected path: ${candidate}`));
  console.error(
    chalk.gray(`Tried: ${candidatesTried
      .map((path) => path.replace(`${DEFAULT_CLAUDE_SETTINGS_DIR}/`, "").replace(`${DEFAULT_CODEX_SETTINGS_DIR}/`, ""))
      .join(", ")}`)
  );
  process.exit(1);
}

async function resolveCatalog(catalog?: string): Promise<Space | null> {
  if (!catalog) return null;

  const existing = resolveCatalogReference(catalog);
  if (existing.kind === "found") return existing.space;
  if (existing.kind === "ambiguous") {
    console.error(chalk.red(`Ambiguous catalog reference: ${catalog}`));
    console.error(chalk.red("Use a catalog path like parent/child or the catalog id."));
    for (const match of existing.matches) {
      console.error(chalk.gray(`  ${catalogPath(match, listSpaces())} (${match.id})`));
    }
    process.exit(1);
  }

  if (!process.stdin.isTTY) {
    console.error(chalk.red(`Catalog not found: ${catalog}`));
    console.error(chalk.yellow(`Create it first: starling catalog create ${catalog}`));
    process.exit(1);
  }

  const input = await askCreateCatalog(catalog);
  if (!input) {
    console.error(chalk.yellow(`Catalog not found: ${catalog}`));
    process.exit(1);
  }

  const now = new Date().toISOString();
  const created = createCatalogPath(catalog, now);
  console.log(chalk.green(`Created catalog: ${created.id} "${catalogPath(created)}"`));
  return created;
}

async function askCreateCatalog(catalog: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`Catalog not found: ${chalk.yellow(catalog)}. Create it now? (y/N) `);
    const normalized = answer.trim().toLowerCase();
    return normalized === "y" || normalized === "yes";
  } catch (error) {
    if (isReadlineAbort(error)) {
      return false;
    }
    throw error;
  } finally {
    rl.close();
  }
}

function isReadlineAbort(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "ABORT_ERR"
  );
}

function createCatalogPath(pathRef: string, now: string): Space {
  const parts = pathRef.split("/").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) {
    console.error(chalk.red("Catalog name cannot be empty."));
    process.exit(1);
  }

  let parentId: string | null = null;
  let currentSpace: Space | undefined;
  for (const part of parts) {
    const existing = findSiblingCatalog(part, parentId);
    if (existing) {
      currentSpace = existing;
      parentId = existing.id;
      continue;
    }

    currentSpace = {
      id: generateSpaceId(listSpaces()),
      name: part,
      description: "",
      tags: [],
      parent_id: parentId,
      created_at: now,
      updated_at: now,
    };
    addSpace(currentSpace);
    parentId = currentSpace.id;
  }

  return currentSpace!;
}

function findSiblingCatalog(name: string, parentId: string | null): Space | undefined {
  return listSpaces().find((space) => space.name === name && space.parent_id === parentId);
}

function resolveAgentArgs(
  provider: AgentProvider,
  rawArgs: string[] | undefined,
  parsedArgs: string[],
  configPath: string | null,
  codexConfig: CodexRunConfig | null
): string[] {
  // Allow explicit passthrough with `--` so users can force everything after it to be sent
  // directly to claude/codex without commander consuming it as command options.
  const args = rawArgs ? parsePassthroughArgs(rawArgs, parsedArgs) : parsedArgs;
  if (provider === "codex") {
    return [...(codexConfig?.args ?? []), ...args];
  }
  if (!configPath) return args;

  // When --config is provided, inject it into the launched agent invocation
  // using each provider's corresponding configuration flag.
  return ["--settings", configPath, ...args];
}

function parsePassthroughArgs(rawArgs: string[] | undefined, parsedArgs: string[]): string[] {
  if (!rawArgs) return parsedArgs;
  const separatorIndex = rawArgs.lastIndexOf("--");
  if (separatorIndex === -1) return parsedArgs;
  return rawArgs.slice(separatorIndex + 1);
}

async function runAgent(
  binary: string,
  args: string[],
  cwd?: string,
  options?: RunAgentOptions
): Promise<RunResult> {
  return new Promise<RunResult>((resolvePromise, reject) => {
    const childEnv = options?.env;
    const child = spawn(binary, args, {
      stdio: "inherit",
      cwd,
      env: childEnv,
    });

    let terminalInterrupted = false;

    const onSigInt = () => {
      terminalInterrupted = true;
      child.kill("SIGINT");
    };

    if (options?.preserveSignals) {
      process.on("SIGINT", onSigInt);
    }

    child.on("error", (err) => {
      if (options?.preserveSignals) {
        process.off("SIGINT", onSigInt);
      }
      reject(err);
    });

    child.on("close", (code) => {
      if (options?.preserveSignals) {
        process.off("SIGINT", onSigInt);
      }
      if (terminalInterrupted) {
        return resolvePromise({ exitCode: 130 });
      }
      resolvePromise({ exitCode: code ?? 0 });
    });
  });
}

type SessionSnapshot = Map<string, number>;

async function snapshotSessions(provider: AgentProvider): Promise<SessionSnapshot> {
  const sessions = await findSessions(RUN_SESSION_SCAN_LIMIT, provider);
  const snapshot: SessionSnapshot = new Map();
  for (const session of sessions) {
    const modifiedAt = Date.parse(session.modified_at);
    snapshot.set(session.session_id, Number.isFinite(modifiedAt) ? modifiedAt : 0);
  }
  return snapshot;
}

function wasSessionTouchedAfterRun(
  session: SessionMeta,
  startedAt: number,
  beforeRun: SessionSnapshot
): boolean {
  const modifiedAt = Date.parse(session.modified_at);
  if (!Number.isFinite(modifiedAt) || modifiedAt < startedAt) return false;

  const previousModifiedAt = beforeRun.get(session.session_id);
  if (previousModifiedAt === undefined) return true;
  return modifiedAt > previousModifiedAt;
}

async function detectSessionStartedAfterRun(
  provider: AgentProvider,
  startedAt: string,
  beforeRun: SessionSnapshot,
  cwd?: string,
  beforeRunProjectFiles: Map<string, number> = new Map<string, number>(),
  knownSessionId?: string
): Promise<SessionMeta | null> {
  const startedTime = Date.parse(startedAt);
  const graceUntil = Date.now() + RUN_SESSION_DETECT_FULL_SCAN_THRESHOLD_MS;
  const normalizedCwd = cwd ? normalizeProjectPath(cwd) : "";

  if (knownSessionId) {
    const hintedSession = await tryResolveKnownSession(
      knownSessionId,
      provider,
      startedTime,
      beforeRun,
      normalizedCwd
    );
    if (hintedSession) {
      return hintedSession;
    }
  }

  for (let attempt = 0; attempt < RUN_SESSION_DETECT_ATTEMPTS; attempt++) {
    if (provider === "codex") {
      const codexMatches = await collectSessionCandidatesByModifiedTime(
        CODEX_SESSIONS_DIR,
        startedTime,
        beforeRun,
        "codex"
      );
      if (codexMatches.length > 0) {
        return pickBestMatch(codexMatches, startedTime, beforeRun, cwd);
      }
    }

    const recentSessions = await findSessions(RUN_SESSION_SCAN_LIMIT, provider);
    const recentMatches = recentSessions.filter((session) =>
      wasSessionTouchedAfterRun(session, startedTime, beforeRun)
    );

    if (recentMatches.length > 0) {
      return pickBestMatch(recentMatches, startedTime, beforeRun, cwd);
    }

    const fallbackLimit = RUN_SESSION_SCAN_LIMIT * Math.max(1, Math.min(attempt + 1, 4));
    const allMatches: SessionMeta[] = [];
    for await (const session of streamSessions(provider, fallbackLimit)) {
      if (!wasSessionTouchedAfterRun(session, startedTime, beforeRun)) {
        continue;
      }
      allMatches.push(session);
    }

    if (allMatches.length > 0) {
      return pickBestMatch(allMatches, startedTime, beforeRun, cwd);
    }

    if (provider === "claude" && normalizedCwd) {
      const projectMatch = await detectSessionInCurrentClaudeProject(
        startedTime,
        beforeRun,
        normalizedCwd,
        beforeRunProjectFiles
      );
      if (projectMatch) {
        return projectMatch;
      }
    }

    if (attempt + 1 < RUN_SESSION_DETECT_ATTEMPTS) {
      await sleep(RUN_SESSION_DETECT_INTERVAL_MS);
    }
  }

  // If we still did not find anything, do a full scan once to avoid index truncation
  // in environments with huge session counts.
  const fullScanMatches: SessionMeta[] = [];
  for await (const session of streamSessions(provider, Infinity)) {
    if (!wasSessionTouchedAfterRun(session, startedTime, beforeRun)) continue;
    fullScanMatches.push(session);
  }

  if (fullScanMatches.length > 0) {
    return pickBestMatch(fullScanMatches, startedTime, beforeRun, cwd);
  }

  if (provider === "claude" && normalizedCwd) {
    const projectMatch = await detectSessionInCurrentClaudeProject(
      startedTime,
      beforeRun,
      normalizedCwd,
      beforeRunProjectFiles
    );
    if (projectMatch) {
      return projectMatch;
    }
  }

  // Give the process a little extra time if the session file was written slightly
  // after the process termination due interactive signal timing.
  if (Date.now() < graceUntil) {
    await sleep(RUN_SESSION_DETECT_INTERVAL_MS);
    return detectSessionStartedAfterRun(
      provider,
      startedAt,
      beforeRun,
      cwd,
      beforeRunProjectFiles,
      knownSessionId
    );
  }

  return null;
}

function collectSessionFilesByModifiedTime(
  dir: string,
  sinceMs: number,
  accumulator: string[],
  limit: number = 3000
): void {
  if (accumulator.length >= limit) return;

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry === "subagents") continue;
    const full = join(dir, entry);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      collectSessionFilesByModifiedTime(full, sinceMs, accumulator, limit);
      continue;
    }
    if (!entry.endsWith(".jsonl")) continue;
    if (st.mtimeMs < sinceMs) continue;
    accumulator.push(full);
    if (accumulator.length >= limit) return;
  }
}

async function collectSessionCandidatesByModifiedTime(
  baseDir: string,
  startedTime: number,
  beforeRun: SessionSnapshot,
  provider: "claude" | "codex",
  limit = 500
): Promise<SessionMeta[]> {
  const filePaths: string[] = [];
  collectSessionFilesByModifiedTime(baseDir, startedTime, filePaths, limit * 4);

  const matches: SessionMeta[] = [];
  for (const filePath of filePaths) {
    try {
      const st = statSync(filePath);
      const modifiedAt = new Date(st.mtimeMs).toISOString();
      const entries = await parseJsonlHead(filePath);
      const extract = provider === "codex" ? extractCodexSessionMeta : extractClaudeSessionMeta;
      const meta = extract(entries, filePath, modifiedAt);
      if (!meta) continue;
      if (wasSessionTouchedAfterRun(meta, startedTime, beforeRun)) {
        matches.push(meta);
      }
    } catch {
      continue;
    }
  }

  return dedupeById(matches).sort((a, b) => b.modified_at.localeCompare(a.modified_at));
}

async function findSingleCodexSessionForRunningAgent(
  startedTime: number,
  beforeRun: SessionSnapshot,
  normalizedCwd: string
): Promise<SessionMeta | null> {
  const candidates = await collectSessionCandidatesByModifiedTime(
    CODEX_SESSIONS_DIR,
    startedTime,
    beforeRun,
    "codex"
  );
  const sameProjectCandidates = candidates.filter((session) =>
    normalizeProjectPath(session.project_path) === normalizedCwd
  );

  if (sameProjectCandidates.length !== 1) return null;
  return sameProjectCandidates[0]!;
}

async function collectRunSessionCandidates(
  provider: AgentProvider,
  startedAtMs: number,
  beforeRun: SessionSnapshot,
  cwd?: string,
  beforeRunProjectFiles: Map<string, number> = new Map<string, number>()
): Promise<SessionMeta[]> {
  const normalizedCwd = cwd ? normalizeProjectPath(cwd) : "";
  const matches: SessionMeta[] = [];
  for await (const session of streamSessions(provider, RUN_SESSION_CATALOG_SCAN_LIMIT)) {
    if (!wasSessionTouchedAfterRun(session, startedAtMs, beforeRun)) continue;
    if (normalizedCwd && normalizeProjectPath(session.project_path) !== normalizedCwd) continue;
    matches.push(session);
  }

  if (provider === "claude" && normalizedCwd) {
    const currentProjectFiles = snapshotProjectSessions(normalizedCwd);
    for (const [filePath, fileModifiedAt] of currentProjectFiles) {
      const beforeModifiedAt = beforeRunProjectFiles.get(filePath);
      if (beforeModifiedAt !== undefined && fileModifiedAt <= beforeModifiedAt) continue;
      if (!Number.isFinite(fileModifiedAt) || fileModifiedAt < startedAtMs) continue;

      const modifiedAt = new Date(fileModifiedAt).toISOString();
      let parsed: SessionMeta | null = null;
      try {
        const parsedEntries = await parseJsonlHead(filePath);
        const parsedMeta = extractClaudeSessionMeta(parsedEntries, filePath, modifiedAt);
        parsed = parsedMeta ?? null;
      } catch {
        parsed = null;
      }

      matches.push({
        session_id: parsed?.session_id || basename(filePath, ".jsonl"),
        provider: "claude",
        model: parsed?.model || "",
        project_path: parsed?.project_path || normalizedCwd,
        first_prompt: parsed?.first_prompt || "",
        file_path: filePath,
        created_at: parsed?.created_at || modifiedAt,
        modified_at: modifiedAt,
        ...(parsed?.token_usage ? { token_usage: parsed.token_usage } : {}),
      });
    }
  }

  return dedupeById(matches).sort((a, b) => b.modified_at.localeCompare(a.modified_at));
}

async function resolveHookReportedClaudeSession(
  sessionId: string,
  normalizedCwd: string
): Promise<SessionMeta> {
  for (let i = 0; i < 20; i++) {
    const direct = await findClaudeSessionInProjectById(sessionId, normalizedCwd);
    if (direct) return direct;
    await sleep(250);
  }

  const now = new Date().toISOString();
  return {
    session_id: sessionId,
    provider: "claude",
    model: "",
    project_path: normalizedCwd,
    first_prompt: "",
    file_path: join(encodeClaudeProjectDirectory(normalizedCwd), `${sessionId}.jsonl`),
    created_at: now,
    modified_at: now,
  };
}

async function findKnownSessionForRun(
  sessionId: string,
  provider: AgentProvider,
  normalizedCwd: string,
  attempt: number
): Promise<SessionMeta | null> {
  if (provider === "claude" && normalizedCwd) {
    const direct = await findClaudeSessionInProjectById(sessionId, normalizedCwd);
    if (direct) return direct;
  }

  // Global lookup is expensive with large histories, so keep it as a sparse fallback
  // for resumed sessions or providers whose storage path cannot be precomputed.
  if (attempt % 8 !== 0) return null;
  return findSessionById(sessionId);
}

async function findClaudeSessionInProjectById(
  sessionId: string,
  normalizedCwd: string
): Promise<SessionMeta | null> {
  const filePath = join(encodeClaudeProjectDirectory(normalizedCwd), `${sessionId}.jsonl`);
  let fileModifiedAt: number;
  try {
    const st = statSync(filePath);
    if (!st.isFile()) return null;
    fileModifiedAt = st.mtimeMs;
  } catch {
    return null;
  }

  const modifiedAt = new Date(fileModifiedAt).toISOString();
  try {
    const parsedEntries = await parseJsonlHead(filePath);
    const parsedMeta = extractClaudeSessionMeta(parsedEntries, filePath, modifiedAt);
    if (parsedMeta) {
      return parsedMeta;
    }
  } catch {
    // Fall through to a minimal candidate; the session file itself proves the id.
  }

  return {
    session_id: sessionId,
    provider: "claude",
    model: "",
    project_path: normalizedCwd,
    first_prompt: "",
    file_path: filePath,
    created_at: modifiedAt,
    modified_at: modifiedAt,
  };
}

async function tryResolveKnownSession(
  sessionId: string,
  provider: AgentProvider,
  startedTime: number,
  beforeRun: SessionSnapshot,
  cwd?: string
): Promise<SessionMeta | null> {
  if (provider === "claude" && cwd) {
    const direct = await findClaudeSessionInProjectById(sessionId, normalizeProjectPath(cwd));
    if (direct && wasSessionTouchedAfterRun(direct, startedTime, beforeRun)) {
      return direct;
    }
  }

  const candidate = await findSessionById(sessionId);
  if (!candidate || candidate.provider !== provider) {
    return null;
  }

  if (wasSessionTouchedAfterRun(candidate, startedTime, beforeRun)) {
    return candidate;
  }

  if (!beforeRun.has(sessionId) && candidate.modified_at && Date.parse(candidate.modified_at) >= startedTime) {
    return candidate;
  }

  if (!cwd) return null;
  const normalizedCwd = normalizeProjectPath(cwd);
  if (!candidate.project_path) return null;
  return normalizeProjectPath(candidate.project_path) === normalizedCwd ? candidate : null;
}

function encodeClaudeProjectDirectory(cwd: string): string {
  const normalized = resolve(cwd);
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  return join(CLAUDE_SESSIONS_DIR, `-${parts.join("-")}`);
}

function snapshotProjectSessions(projectDir: string): Map<string, number> {
  const snapshot = new Map<string, number>();
  const absoluteProjectDir = encodeClaudeProjectDirectory(projectDir);
  const stack = [absoluteProjectDir];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;

    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry === "subagents") {
        continue;
      }
      const fullPath = join(current, entry);
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (entry.endsWith(".jsonl")) {
        snapshot.set(fullPath, stat.mtimeMs);
      }
    }
  }

  return snapshot;
}

async function detectSessionInCurrentClaudeProject(
  startedTime: number,
  beforeRun: SessionSnapshot,
  normalizedCwd: string,
  beforeRunProjectFiles: Map<string, number> = new Map<string, number>()
): Promise<SessionMeta | null> {
  const currentProjectFiles = snapshotProjectSessions(normalizedCwd);
  if (currentProjectFiles.size === 0) return null;

  const candidates: SessionMeta[] = [];
  for (const [filePath, fileModifiedAt] of currentProjectFiles) {
    if (fileModifiedAt < startedTime) continue;

    const beforeProjectModifiedAt = beforeRunProjectFiles.get(filePath);
    if (beforeProjectModifiedAt !== undefined && fileModifiedAt <= beforeProjectModifiedAt) continue;

    const modifiedAt = new Date(fileModifiedAt).toISOString();
    let parsed: SessionMeta | null = null;
    try {
      const parsedEntries = await parseJsonlHead(filePath);
      const parsedMeta = extractClaudeSessionMeta(parsedEntries, filePath, modifiedAt);
      parsed = parsedMeta ?? null;
    } catch {
      parsed = null;
    }

    const sessionId = parsed?.session_id || basename(filePath, ".jsonl");
    const candidate: SessionMeta = {
      session_id: sessionId,
      provider: "claude",
      model: parsed?.model || "",
      project_path: parsed?.project_path || normalizedCwd,
      first_prompt: parsed?.first_prompt || "",
      file_path: filePath,
      created_at: parsed?.created_at || modifiedAt,
      modified_at: modifiedAt,
      ...(parsed?.token_usage ? { token_usage: parsed.token_usage } : {}),
    };

    if (normalizeProjectPath(candidate.project_path) !== normalizedCwd) continue;
    if (!wasSessionTouchedAfterRun(candidate, startedTime, beforeRun)) continue;
    candidates.push(candidate);
  }

  if (candidates.length === 0) {
    const directCandidates: SessionMeta[] = [];
    for (const [filePath, beforeModifiedAt] of beforeRunProjectFiles) {
      const after = currentProjectFiles.get(filePath);
      if (after === undefined) continue;
      if (!Number.isFinite(after) || after < startedTime || after <= beforeModifiedAt) continue;
      const sessionId = basename(filePath, ".jsonl");
      directCandidates.push({
        session_id: sessionId,
        provider: "claude",
        model: "",
        project_path: normalizedCwd,
        first_prompt: "",
        file_path: filePath,
        created_at: new Date(after).toISOString(),
        modified_at: new Date(after).toISOString(),
      });
    }
    if (directCandidates.length > 0) {
      directCandidates.sort((a, b) => b.modified_at.localeCompare(a.modified_at));
      return directCandidates[0]!;
    }
  }

  if (candidates.length === 0) return null;
  const deduped = dedupeById(candidates);
  if (deduped.length === 1) return deduped[0]!;
  deduped.sort((a, b) => b.modified_at.localeCompare(a.modified_at));
  return deduped[0]!;
}

function pickBestMatch(
  sessions: SessionMeta[],
  startedTime: number,
  beforeRun: SessionSnapshot,
  cwd?: string
): SessionMeta {
  const matches = sessions.filter((session) =>
    wasSessionTouchedAfterRun(session, startedTime, beforeRun)
  );
  if (matches.length === 0) return matches[0]!;

  const deduped = dedupeById(matches);
  if (!cwd) {
    deduped.sort((a, b) => b.modified_at.localeCompare(a.modified_at));
    return deduped[0]!;
  }

  const cwdNormalized = resolve(cwd);
  const exact = deduped.filter((session) => normalizeProjectPath(session.project_path) === cwdNormalized);
  if (exact.length > 0) {
    exact.sort((a, b) => b.modified_at.localeCompare(a.modified_at));
    return exact[0]!;
  }

  deduped.sort((a, b) => b.modified_at.localeCompare(a.modified_at));
  return deduped[0]!;
}

function normalizeProjectPath(value?: string): string {
  if (!value) return "";
  try {
    return resolve(value);
  } catch {
    return value;
  }
}

function dedupeById(sessions: SessionMeta[]): SessionMeta[] {
  const latest = new Map<string, SessionMeta>();
  for (const session of sessions) {
    const current = latest.get(session.session_id);
    if (!current || session.modified_at > current.modified_at) {
      latest.set(session.session_id, session);
    }
  }
  return [...latest.values()];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function pinSessionToCatalog(session: SessionMeta, opts: RunOptions, space: Space): Promise<void> {
  const existing = findBookmark(session.session_id);
  if (existing) {
    if (!existing.space_ids.includes(space.id)) {
      existing.space_ids.push(space.id);
      updateBookmark(existing.id, { space_ids: existing.space_ids });
      console.log(chalk.green(`Added ${existing.id} to catalog "${space.name}" (${space.id})`));
    } else {
      console.log(chalk.yellow(`Session already in catalog "${space.name}".`));
    }
    return;
  }

  const now = new Date().toISOString();
  const bookmarkId = generateBookmarkId(listBookmarks());
  const title = opts.title || session.first_prompt.slice(0, 60) || session.session_id.slice(0, 16);
  const tagList = opts.tags ? opts.tags.split(",").map((tag) => tag.trim()).filter(Boolean) : [];

  addBookmark({
    id: bookmarkId,
    provider: session.provider,
    session_id: session.session_id,
    title,
    category: "",
    tags: tagList,
    project_path: session.project_path ?? "",
    first_prompt: session.first_prompt ?? "",
    notes: [],
    space_ids: [space.id],
    created_at: now,
    updated_at: now,
  });

  console.log(chalk.green(`Pinned: ${bookmarkId}`));
  console.log(`  Title:   ${title}`);
  console.log(`  Catalog: ${space.name} (${space.id})`);
}

function normalizeAgent(input: string): AgentProvider | null {
  if (input === "claude") return "claude";
  if (input === "codex" || input === "agent") return "codex";
  return null;
}
