import { spawn } from "child_process";
import { basename, isAbsolute, join, resolve } from "path";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";

const CONFIG_FILE_EXTENSIONS = [".json", ".jsonc", ".toml", ".yaml", ".yml", ".js", ".ts"];

interface FastRunParseResult {
  handled: boolean;
  exitCode?: number;
}

interface FastRunOptions {
  config?: string;
  cwd?: string;
  agent?: string;
  agentArgs: string[];
  needsFullRun: boolean;
}

export async function tryFastRun(argv: string[]): Promise<FastRunParseResult> {
  if (argv[2] !== "run") return { handled: false };

  const parsed = parseFastRunArgs(argv.slice(3));
  if (!parsed || parsed.needsFullRun || parsed.agent !== "claude") {
    return { handled: false };
  }

  const configPath = resolveClaudeConfigPath(parsed.config);
  if (parsed.config && !configPath) {
    printConfigNotFound(parsed.config);
    return { handled: true, exitCode: 1 };
  }

  const args = configPath ? ["--settings", configPath, ...parsed.agentArgs] : parsed.agentArgs;
  const exitCode = await runAgentFast("claude", args, parsed.cwd ? resolve(parsed.cwd) : undefined);
  return { handled: true, exitCode };
}

function parseFastRunArgs(args: string[]): FastRunOptions | null {
  const parsed: FastRunOptions = {
    agentArgs: [],
    needsFullRun: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];

    if (arg === "--") {
      parsed.needsFullRun = true;
      return parsed;
    }

    if (arg === "-c" || arg === "--catalog" || arg === "--title" || arg === "--tags") {
      parsed.needsFullRun = true;
      return parsed;
    }

    if (arg === "--config") {
      const value = args[i + 1];
      if (!value) return null;
      parsed.config = value;
      i += 1;
      continue;
    }

    if (arg.startsWith("--config=")) {
      parsed.config = arg.slice("--config=".length);
      continue;
    }

    if (arg === "--cwd") {
      const value = args[i + 1];
      if (!value) return null;
      parsed.cwd = value;
      i += 1;
      continue;
    }

    if (arg.startsWith("--cwd=")) {
      parsed.cwd = arg.slice("--cwd=".length);
      continue;
    }

    if (arg === "claude" || arg === "codex" || arg === "agent") {
      parsed.agent = arg;
      parsed.agentArgs = args.slice(i + 1);
      return parsed;
    }

    if (arg.startsWith("-")) {
      parsed.needsFullRun = true;
      return parsed;
    }

    return null;
  }

  return parsed.agent ? parsed : null;
}

function resolveClaudeConfigPath(configFile?: string): string | null {
  if (!configFile) return null;

  if (isAbsolute(configFile) || existsSync(configFile)) {
    return existsSync(configFile) ? configFile : null;
  }

  const fileName = basename(configFile);
  const settingsDir = join(resolveStarlingHomeFast(), "settings", "claude");
  const candidate = join(settingsDir, fileName);
  if (existsSync(candidate)) return candidate;

  if (!hasKnownConfigExtensionFast(fileName)) {
    for (const ext of CONFIG_FILE_EXTENSIONS) {
      const candidateWithExtension = `${candidate}${ext}`;
      if (existsSync(candidateWithExtension)) return candidateWithExtension;
    }
  }

  return null;
}

function printConfigNotFound(configFile: string): void {
  const fileName = basename(configFile);
  const settingsDir = join(resolveStarlingHomeFast(), "settings", "claude");
  const candidate = join(settingsDir, fileName);
  const candidatesTried = [candidate];
  if (!hasKnownConfigExtensionFast(fileName)) {
    for (const ext of CONFIG_FILE_EXTENSIONS) {
      candidatesTried.push(`${candidate}${ext}`);
    }
  }

  console.error(`Config file not found: ${configFile}`);
  console.error(`Expected path: ${candidate}`);
  console.error(`Tried: ${candidatesTried.map((path) => path.replace(`${settingsDir}/`, "")).join(", ")}`);
}

function hasKnownConfigExtensionFast(fileName: string): boolean {
  return CONFIG_FILE_EXTENSIONS.some((extension) => fileName.toLowerCase().endsWith(extension));
}

function resolveStarlingHomeFast(): string {
  const envHome = process.env.STARLING_HOME?.trim();
  if (envHome) return expandHomePathFast(envHome);

  const configPath = process.env.STARLING_CLI_CONFIG?.trim() || join(homedir(), ".config", "starling", "config.json");
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf-8")) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const homePath = (parsed as { homePath?: unknown }).homePath;
      if (typeof homePath === "string" && homePath.trim()) {
        return expandHomePathFast(homePath.trim());
      }
    }
  } catch {
    // Missing or invalid config falls back to the default home.
  }

  return join(homedir(), ".starling");
}

function expandHomePathFast(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

function runAgentFast(binary: string, args: string[], cwd?: string): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(binary, args, {
      stdio: "inherit",
      cwd,
    });

    let terminalInterrupted = false;
    let settled = false;

    const onSigInt = () => {
      terminalInterrupted = true;
      child.kill("SIGINT");
    };

    const cleanup = () => {
      process.off("SIGINT", onSigInt);
    };

    const settle = (exitCode: number) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise(exitCode);
    };

    process.on("SIGINT", onSigInt);

    child.on("error", (error) => {
      cleanup();
      reject(error);
    });

    child.on("exit", (code) => {
      settle(terminalInterrupted ? 130 : code ?? 0);
    });

    child.on("close", (code) => {
      settle(terminalInterrupted ? 130 : code ?? 0);
    });
  });
}
