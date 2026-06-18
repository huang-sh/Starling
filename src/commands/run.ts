import { Command } from "commander";
import chalk from "chalk";
import { randomUUID } from "crypto";
import { chmodSync, existsSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "fs";
import { createInterface } from "node:readline/promises";
import { spawn } from "child_process";
import type { ChildProcess } from "child_process";
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
import { createCodexRunConfig, cleanupCodexRunConfig, type CodexRunConfig } from "../lib/codexRunConfig.js";
import {
  snapshotCodexDefaultConfig,
  restoreCodexDefaultConfig,
} from "../lib/codexDefaultGuard.js";
import { upsertSessionInIndex } from "../lib/sessionIndex.js";
import { createRun, finalizeRun } from "../lib/runs.js";
import { shortSessionId } from "../lib/sessionDisplay.js";
import { catalogPath, resolveCatalogReference } from "../lib/catalogResolver.js";
import { hasKnownConfigExtension } from "../lib/configPaths.js";
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
  onSpawn?: (child: ChildProcess) => void;
}

const RUN_SESSION_SCAN_LIMIT = 500;
const RUN_SESSION_CATALOG_SCAN_LIMIT = 2000;
const RUN_SESSION_DETECT_ATTEMPTS = 8;
const RUN_SESSION_DETECT_INTERVAL_MS = 300;
const RUN_SESSION_DETECT_FULL_SCAN_THRESHOLD_MS = 200;
const RUN_SESSION_EXIT_SETTLE_MS = 200;
const RUN_FAST_FAILURE_SKIP_SCAN_MS = 2000;
const RUN_PIN_ATTEMPT_DRAIN_TIMEOUT_MS = 1500;

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
      let currentRunId: string | undefined;
      const cleanupRunState = async (finalize?: { exitCode: number; sessionId?: string }) => {
        syncClaudeProfileSettingsFromRunSettings(resolvedConfig, hookRun?.settingsPath ?? null);
        cleanupClaudeRunHookSettings(hookRun);
        await cleanupCodexRunConfig(codexConfig);
        restoreCodexDefaultConfig(codexDefaultSnapshot);
        if (currentRunId && finalize) {
          try {
            finalizeRun(currentRunId, {
              status: finalize.exitCode === 0 ? "completed" : "errored",
              exit_code: finalize.exitCode,
              session_id: finalize.sessionId,
            });
          } catch {
            // Run-status persistence must never affect the run result.
          }
        }
      };

      let catalogPinned = false;
      let agentClosed = false;
      let stopAutoPinWatcher = false;
      let hintedSessionId: string | undefined;
      let pinAttempt: Promise<void> | null = null;
      const startAutoPinWatcher = async () => {
        if (!catalog || catalogPinned) return;
        if (pinAttempt) return;

        pinAttempt = (async () => {
          const startedTime = Date.parse(startedAt);
          let attemptsAfterClose = 0;
          for (let i = 0; !stopAutoPinWatcher; i++) {
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
              if (agentClosed || stopAutoPinWatcher) return;
              await sleep(250);
              continue;
            }

            hintedSessionId = sessionId;
            const candidate: SessionMeta | null = hookRun && provider === "claude"
              ? await findClaudeSessionInProjectById(sessionId, normalizedCwd)
              : await findKnownSessionForRun(sessionId, provider, normalizedCwd, i);
            if (isRunSessionCandidate(candidate, provider, startedTime, beforeRun, sessionId)) {
              await pinSessionToCatalog(candidate, opts, catalog);
              catalogPinned = true;
              return;
            }
            if (agentClosed || stopAutoPinWatcher) {
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
      const handleSpawn = (child: ChildProcess) => {
        currentRunId = randomUUID();
        try {
          createRun({
            run_id: currentRunId,
            provider,
            project_path: normalizedCwd,
            catalog_id: catalog?.id,
            pid: child.pid,
            status: "running",
            started_at: startedAt,
            source: "starling-run",
          });
        } catch {
          // Run-status persistence must never affect the run result.
        }
      };
      try {
        runResult = await runAgent(binary, args, cwd, {
          preserveSignals: true,
          env: buildAgentEnv(provider, codexConfig?.env),
          onSpawn: handleSpawn,
        });
      } catch (error) {
        await cleanupRunState({ exitCode: 1 });
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
        await cleanupRunState({ exitCode, sessionId: knownSessionId });
        process.exit(exitCode);
      }
      if (hookRun && !knownSessionId) {
        await cleanupRunState({ exitCode, sessionId: knownSessionId });
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
          await cleanupRunState({ exitCode, sessionId: knownSessionId });
          process.exit(exitCode);
        }
        console.log(chalk.yellow("No new session found, or session metadata is not ready yet."));
        await cleanupRunState({ exitCode, sessionId: knownSessionId });
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
        stopAutoPinWatcher = true;
        await drainPinAttempt(pinAttempt);
      }

      if (exitCode !== 0) {
        await cleanupRunState({ exitCode, sessionId: newSessionMeta.session_id });
        process.exit(exitCode);
      }

      await cleanupRunState({ exitCode, sessionId: newSessionMeta.session_id });
    });

  program.addCommand(run);
}

async function drainPinAttempt(pinAttempt: Promise<void>): Promise<void> {
  await Promise.race([
    pinAttempt,
    sleep(RUN_PIN_ATTEMPT_DRAIN_TIMEOUT_MS),
  ]);
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
        command: hookAppendCommand(eventsPath),
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

const CLAUDE_SETTINGS_SYNC_KEYS = [
  "permissions",
  "projects",
  "trust",
  "trustedProjects",
  "enableAllProjectMcpServers",
  "enabledMcpjsonServers",
  "disabledMcpjsonServers",
];

export function syncClaudeProfileSettingsFromRunSettings(
  sourceConfigPath: string | null,
  runSettingsPath: string | null
): boolean {
  if (!sourceConfigPath || !runSettingsPath || !existsSync(runSettingsPath)) return false;

  const sourceExt = extname(sourceConfigPath).toLowerCase();
  if (sourceExt !== ".json" && sourceExt !== ".jsonc") return false;

  try {
    const sourceSettings = readSettingsJsonObject(sourceConfigPath, sourceExt === ".jsonc");
    const runSettings = readSettingsJsonObject(runSettingsPath, false);
    if (!sourceSettings || !runSettings) return false;

    let changed = false;
    for (const key of CLAUDE_SETTINGS_SYNC_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(runSettings, key)) continue;
      if (jsonStable(sourceSettings[key]) === jsonStable(runSettings[key])) continue;
      sourceSettings[key] = cloneJsonValue(runSettings[key]);
      changed = true;
    }

    if (!changed) return false;
    atomicWriteJSON(sourceConfigPath, sourceSettings);
    return true;
  } catch (error) {
    console.error(chalk.yellow(`Could not sync Claude settings to ${sourceConfigPath}: ${String(error)}`));
    return false;
  }
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
    `command = ${JSON.stringify(hookAppendCommand(eventsPath))}`,
    "timeout = 5",
  ].join("\n") + "\n";
}

function addCodexHookTrustBypassArg(args: string[]): string[] {
  return args.includes("--dangerously-bypass-hook-trust") ? args : ["--dangerously-bypass-hook-trust", ...args];
}

function syncCodexProfileProjectTrustFromRunConfig(
  sourceConfigPath: string | null,
  runConfig: CodexRunConfig | null
): void {
  if (!sourceConfigPath || !runConfig) return;
  const sourceExt = extname(sourceConfigPath).toLowerCase();
  if (sourceExt !== ".json" && sourceExt !== ".jsonc" && sourceExt !== ".toml") return;

  const trustedProjects = new Set<string>();
  for (const path of runConfig.cleanupPaths) {
    if (!path.endsWith(".config.toml") || !existsSync(path)) continue;
    for (const projectPath of readTrustedProjectsFromCodexToml(path)) {
      trustedProjects.add(projectPath);
    }
  }
  if (trustedProjects.size === 0) return;

  if (sourceExt === ".toml") {
    syncCodexTomlProjectTrust(sourceConfigPath, trustedProjects);
    return;
  }

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

function syncCodexTomlProjectTrust(sourceConfigPath: string, trustedProjects: Set<string>): void {
  try {
    let raw = readFileSync(sourceConfigPath, "utf-8");
    let changed = false;

    for (const projectPath of trustedProjects) {
      const updated = upsertCodexTomlProjectTrust(raw, projectPath);
      if (updated !== raw) {
        raw = updated;
        changed = true;
      }
    }

    if (changed) writeFileSync(sourceConfigPath, raw.endsWith("\n") ? raw : `${raw}\n`, "utf-8");
  } catch (error) {
    console.error(chalk.yellow(`Could not sync Codex project trust to ${sourceConfigPath}: ${String(error)}`));
  }
}

function upsertCodexTomlProjectTrust(raw: string, projectPath: string): string {
  const header = `[projects.${JSON.stringify(projectPath)}]`;
  const lines = raw.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => line.trim() === header);

  if (headerIndex < 0) {
    return `${raw.trimEnd()}\n\n${header}\ntrust_level = "trusted"\n`;
  }

  let endIndex = lines.length;
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    if (/^\s*\[/.test(lines[index])) {
      endIndex = index;
      break;
    }
  }

  let hasTrust = false;
  const nextLines = [...lines];
  for (let index = endIndex - 1; index > headerIndex; index -= 1) {
    if (!/^\s*trust_level\s*=\s*["']trusted["']\s*(?:#.*)?$/.test(nextLines[index])) continue;
    if (hasTrust) {
      nextLines.splice(index, 1);
      endIndex -= 1;
      continue;
    }
    hasTrust = true;
  }

  if (!hasTrust) {
    nextLines.splice(endIndex, 0, "trust_level = \"trusted\"");
  }

  return nextLines.join("\n").replace(/\n{3,}/g, "\n\n");
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

function stripJsonComments(value: string): string {
  return value.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
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
    const parsed = readSettingsJsonObject(configPath, extname(configPath).toLowerCase() === ".jsonc");
    if (parsed) return parsed;
  } catch {
    console.log(chalk.yellow("Could not add Claude SessionStart hook because settings is not parseable JSON."));
  }
  return null;
}

function readSettingsJsonObject(filePath: string, allowComments: boolean): Record<string, unknown> | null {
  const raw = readFileSync(filePath, "utf-8");
  const parsed = JSON.parse(allowComments ? stripJsonComments(raw) : raw) as unknown;
  return isRecord(parsed) ? parsed : null;
}

function jsonStable(value: unknown): string {
  return JSON.stringify(value);
}

function cloneJsonValue(value: unknown): unknown {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function hookAppendCommand(eventsPath: string): string {
  const script = "const fs=require('fs');const d=[];process.stdin.on('data',c=>d.push(c));process.stdin.on('end',()=>{fs.appendFileSync(process.argv[1],Buffer.concat(d).toString()+'\\n')})";
  return `node -e ${JSON.stringify(script)} ${eventsPath}`;
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
  if (!hasKnownConfigExtension(fileName, CONFIG_FILE_EXTENSIONS)) {
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
    if (options?.onSpawn) {
      try {
        options.onSpawn(child);
      } catch {
        // Never let the spawn callback break the run.
      }
    }

    let terminalInterrupted = false;
    let settled = false;

    const onSigInt = () => {
      terminalInterrupted = true;
      child.kill("SIGINT");
    };

    const cleanupListeners = () => {
      if (options?.preserveSignals) {
        process.off("SIGINT", onSigInt);
      }
    };

    const settle = (exitCode: number) => {
      if (settled) return;
      settled = true;
      cleanupListeners();
      resolvePromise({ exitCode });
    };

    if (options?.preserveSignals) {
      process.on("SIGINT", onSigInt);
    }

    child.on("error", (err) => {
      cleanupListeners();
      reject(err);
    });

    child.on("exit", (code) => {
      if (terminalInterrupted) {
        settle(130);
        return;
      }
      settle(code ?? 0);
    });

    child.on("close", (code) => {
      if (terminalInterrupted) {
        settle(130);
        return;
      }
      settle(code ?? 0);
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

function isRunSessionCandidate(
  session: SessionMeta | null,
  provider: AgentProvider,
  startedAt: number,
  beforeRun: SessionSnapshot,
  reportedSessionId?: string
): session is SessionMeta {
  if (!session || session.provider !== provider) return false;
  if (reportedSessionId && session.session_id === reportedSessionId) return true;
  return wasSessionTouchedAfterRun(session, startedAt, beforeRun);
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
  const title = opts.title || session.custom_title || session.first_prompt.slice(0, 60) || session.session_id.slice(0, 16);
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
