import { spawn } from "child_process";
import { existsSync } from "fs";
import { basename, isAbsolute, join } from "path";
import {
  DEFAULT_CLAUDE_SETTINGS_DIR,
} from "../constants.js";
import { resolveCodexConfigPath } from "../lib/codexProvider.js";
import {
  createCodexRunConfig,
  cleanupCodexRunConfig,
  type CodexRunConfig,
} from "../lib/codexRunConfig.js";
import type {
  AgentCaptureResult,
  AgentSpec,
  Provider,
} from "./types.js";

const CAPTURE_STDOUT_MAX_BYTES = 2 * 1024 * 1024;
const CAPTURE_STDERR_MAX_BYTES = 64 * 1024;
const CAPTURE_SIGKILL_GRACE_MS = 5000;

/**
 * Parse a `provider:profile` spec string.
 * `claude:` → {provider:"claude", profile:""} (agent default config).
 * `claude:ds` → {provider:"claude", profile:"ds"}.
 * Throws on missing colon or unknown provider.
 */
export function parseAgentSpec(spec: string): AgentSpec {
  const trimmed = spec.trim();
  if (!trimmed) {
    throw new Error("Empty agent spec. Use the form `provider:profile`, e.g. `claude:ds`.");
  }
  const colonIndex = trimmed.indexOf(":");
  // A bare provider name (e.g. "claude", "codex") with no colon = default config.
  const provider = colonIndex === -1 ? trimmed : trimmed.slice(0, colonIndex);
  const profile = colonIndex === -1 ? "" : trimmed.slice(colonIndex + 1);
  if (provider !== "claude" && provider !== "codex") {
    throw new Error(
      `Invalid agent spec "${spec}": unknown provider "${provider}". Allowed: claude, codex.`
    );
  }
  return { provider, profile, raw: spec };
}

/** A human-readable label for an agent spec, used in reports and progress output. */
export function specLabel(spec: AgentSpec): string {
  return spec.profile ? `${spec.provider}:${spec.profile}` : `${spec.provider}:default`;
}

/**
 * Resolve a Claude Starling profile name to a settings file path, or null if it
 * does not exist. Mirrors run.ts resolveConfigFilePath but returns null instead
 * of calling process.exit, so callers can collect multiple errors.
 */
function resolveClaudeConfigPath(profile: string): string | null {
  if (!profile) return null;
  if (isAbsolute(profile) || existsSync(profile)) {
    return existsSync(profile) ? profile : null;
  }
  const base = join(DEFAULT_CLAUDE_SETTINGS_DIR, basename(profile));
  if (existsSync(base)) return base;
  if (!base.endsWith(".json") && !base.endsWith(".jsonc")) {
    for (const ext of [".json", ".jsonc"]) {
      const candidate = `${base}${ext}`;
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** Build the env for a spawned agent (strips stray CODEX_ vars, merges profile env). */
function buildAgentEnv(provider: Provider, overrides?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
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

/** Resolved invocation for a non-interactive agent call, plus optional cleanup. */
export interface ResolvedAgentInvocation {
  binary: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cleanup: () => Promise<void>;
}

/**
 * Resolve the binary + args for a non-interactive (`claude -p` / `codex exec`)
 * invocation honoring a Starling profile. For codex this reuses createCodexRunConfig
 * so chat-proxy / env / temp-profile logic stays consistent with `starling run`.
 */
export async function resolveAgentInvocation(
  spec: AgentSpec,
  prompt: string
): Promise<ResolvedAgentInvocation> {
  if (spec.provider === "claude") {
    const settingsPath = resolveClaudeConfigPath(spec.profile);
    if (spec.profile && !settingsPath) {
      throw new Error(
        `Claude profile not found: ${spec.profile}\nExpected under: ${DEFAULT_CLAUDE_SETTINGS_DIR}`
      );
    }
    const args = settingsPath
      ? ["--settings", settingsPath, "-p", prompt]
      : ["-p", prompt];
    return {
      binary: "claude",
      args,
      env: buildAgentEnv("claude"),
      cleanup: async () => {},
    };
  }

  const configPath = resolveCodexConfigPath(spec.profile || undefined);
  if (spec.profile && !configPath) {
    throw new Error(
      `Codex profile not found: ${spec.profile}\nExpected under ~/.starling/settings/codex`
    );
  }
  const codexConfig: CodexRunConfig | null = configPath
    ? await createCodexRunConfig(configPath)
    : null;
  // codex global opts (--profile/--config) come BEFORE the `exec` subcommand.
  // --skip-git-repo-check: diagnose runs codex non-interactively with no project
  // context, so it must not require a trusted/git working directory.
  const args = [...(codexConfig?.args ?? []), "exec", "--skip-git-repo-check", prompt];
  return {
    binary: "codex",
    args,
    env: buildAgentEnv("codex", codexConfig?.env),
    cleanup: async () => {
      await cleanupCodexRunConfig(codexConfig);
    },
  };
}

/**
 * Run an agent non-interactively, capturing stdout. Enforces a timeout and a
 * stdout size cap. stderr is collected (capped) for diagnostics. Always cleans
 * up the resolved invocation (codex temp files), even on timeout or spawn error.
 */
export async function runAgentCapture(
  spec: AgentSpec,
  prompt: string,
  timeoutMs: number
): Promise<AgentCaptureResult> {
  let invocation: ResolvedAgentInvocation;
  try {
    invocation = await resolveAgentInvocation(spec, prompt);
  } catch (err) {
    return {
      stdout: "",
      exitCode: 127,
      durationMs: 0,
      timedOut: false,
      spawnError: err instanceof Error ? err.message : String(err),
    };
  }

  const startedAt = Date.now();
  return new Promise<AgentCaptureResult>((resolve) => {
    const child = spawn(invocation.binary, invocation.args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: invocation.env,
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let settled = false;
    let timedOut = false;
    let sigkillTimer: NodeJS.Timeout | undefined;

    const settle = (result: AgentCaptureResult) => {
      if (settled) return;
      settled = true;
      void Promise.resolve(invocation.cleanup().catch(() => {})).finally(() => {
        resolve(result);
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
      sigkillTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }, CAPTURE_SIGKILL_GRACE_MS);
    }, Math.max(0, timeoutMs));

    const clearTimers = () => {
      clearTimeout(timer);
      if (sigkillTimer) clearTimeout(sigkillTimer);
    };

    const buildStdout = () => {
      const text = Buffer.concat(stdoutChunks).toString("utf-8");
      return truncated ? `${text}\n[stdout truncated]` : text;
    };

    child.on("error", (err) => {
      clearTimers();
      settle({
        stdout: "",
        exitCode: 127,
        durationMs: Date.now() - startedAt,
        timedOut: false,
        spawnError: `${invocation.binary}: ${err.message}`,
      });
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      if (truncated) return;
      if (stdoutBytes + chunk.length > CAPTURE_STDOUT_MAX_BYTES) {
        const remaining = CAPTURE_STDOUT_MAX_BYTES - stdoutBytes;
        if (remaining > 0) stdoutChunks.push(chunk.subarray(0, remaining));
        truncated = true;
        return;
      }
      stdoutChunks.push(chunk);
      stdoutBytes += chunk.length;
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderrBytes + chunk.length > CAPTURE_STDERR_MAX_BYTES) {
        const remaining = CAPTURE_STDERR_MAX_BYTES - stderrBytes;
        if (remaining > 0) stderrChunks.push(chunk.subarray(0, remaining));
        return;
      }
      stderrChunks.push(chunk);
      stderrBytes += chunk.length;
    });

    const onExit = (code: number | null) => {
      clearTimers();
      const stderr = Buffer.concat(stderrChunks).toString("utf-8");
      settle({
        stdout: buildStdout(),
        exitCode: code ?? 0,
        durationMs: Date.now() - startedAt,
        timedOut,
        stderr: stderr || undefined,
      });
    };

    child.on("exit", onExit);
    child.on("close", onExit);
  });
}
