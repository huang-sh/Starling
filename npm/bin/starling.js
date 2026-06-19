#!/usr/bin/env node
// Unified entry point for the Starling CLI.

import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "fs";
import { createRequire } from "node:module";
import path from "path";
import readline from "node:readline";
import { fileURLToPath } from "url";
import { renderTopSnapshot, renderTopWatchFrame } from "../lib/render/top.js";
import { getRenderPlan, renderCommandResult } from "../lib/render/commands.js";

// __dirname equivalent in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

const PLATFORM_PACKAGE_BY_TARGET = {
  "x86_64-unknown-linux-musl": "starling-linux-x64",
  "aarch64-unknown-linux-musl": "starling-linux-arm64",
  "x86_64-unknown-linux-gnu": "starling-linux-x64",
  "aarch64-unknown-linux-gnu": "starling-linux-arm64",
  "x86_64-apple-darwin": "starling-darwin-x64",
  "aarch64-apple-darwin": "starling-darwin-arm64",
};

const { platform, arch } = process;

let targetTriple = null;
switch (platform) {
  case "linux":
  case "android":
    switch (arch) {
      case "x64":
        targetTriple = "x86_64-unknown-linux-musl";
        break;
      case "arm64":
        targetTriple = "aarch64-unknown-linux-musl";
        break;
      default:
        break;
    }
    break;
  case "darwin":
    switch (arch) {
      case "x64":
        targetTriple = "x86_64-apple-darwin";
        break;
      case "arm64":
        targetTriple = "aarch64-apple-darwin";
        break;
      default:
        break;
    }
    break;
  default:
    break;
}

if (!targetTriple) {
  console.error(`Unsupported platform: ${platform} (${arch})`);
  process.exit(1);
}

const platformPackage = PLATFORM_PACKAGE_BY_TARGET[targetTriple];

function findStarlingExecutable() {
  // 1. Installed platform package (production install)
  try {
    const packageJsonPath = require.resolve(`${platformPackage}/package.json`);
    const vendorRoot = path.join(path.dirname(packageJsonPath), "vendor");
    const candidate = path.join(
      vendorRoot,
      targetTriple,
      "bin",
      "starling",
    );
    if (existsSync(candidate)) {
      return candidate;
    }
  } catch {
    // platform package not installed; fall through to dev path
  }

  // 2. Dev fallback — look for local cargo build output. scripts/build.sh
  // stages host builds under rustc's host triple, which is usually GNU on
  // Linux even though the published optional package uses the musl target.
  const devTargetTriples = [targetTriple];
  if (targetTriple === "x86_64-unknown-linux-musl") {
    devTargetTriples.push("x86_64-unknown-linux-gnu");
  } else if (targetTriple === "aarch64-unknown-linux-musl") {
    devTargetTriples.push("aarch64-unknown-linux-gnu");
  }
  const devCandidates = [
    ...devTargetTriples.map((triple) =>
      path.join(__dirname, "..", "vendor", triple, "bin", "starling"),
    ),
    // direct cargo target dir (in-tree development)
    path.join(__dirname, "..", "..", "rust", "target", "release", "starling"),
    path.join(__dirname, "..", "..", "rust", "target", "debug", "starling"),
  ];
  for (const candidate of devCandidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  const packageManager = detectPackageManager();
  const updateCommand =
    packageManager === "bun"
      ? "bun install -g starling-ai@latest"
      : "npm install -g starling-ai@latest";
  console.error(
    `Missing optional dependency ${platformPackage}. Reinstall Starling: ${updateCommand}`,
  );
  process.exit(1);
}

/**
 * Use heuristics to detect the package manager that was used to install Starling
 * in order to give the user a hint about how to update it.
 */
function detectPackageManager() {
  const userAgent = process.env.npm_config_user_agent || "";
  if (/\bbun\//.test(userAgent)) {
    return "bun";
  }

  const execPath = process.env.npm_execpath || "";
  if (execPath.includes("bun")) {
    return "bun";
  }

  if (
    __dirname.includes(".bun/install/global") ||
    __dirname.includes(".bun\\install\\global")
  ) {
    return "bun";
  }

  return userAgent ? "npm" : null;
}

const binaryPath = findStarlingExecutable();

// Use an asynchronous spawn so that Node is able to respond to signals
// (e.g. Ctrl-C / SIGINT) while the native binary is executing. This allows
// us to forward those signals to the child process and guarantees that when
// either the child terminates or the parent receives a fatal signal, both
// processes exit in a predictable manner.

const packageManagerEnvVar =
  detectPackageManager() === "bun"
    ? "STARLING_MANAGED_BY_BUN"
    : "STARLING_MANAGED_BY_NPM";
const env = {
  ...process.env,
  [packageManagerEnvVar]: "1",
  STARLING_MANAGED_PACKAGE_ROOT: realpathSync(path.join(__dirname, "..")),
};

const cliArgs = process.argv.slice(2);
if (shouldRenderTop(cliArgs)) {
  await runTopRenderer(cliArgs);
  process.exit(0);
}

const renderPlan = getRenderPlan(cliArgs);
if (renderPlan) {
  await runCommandRenderer(renderPlan);
  process.exit(0);
}

const child = spawnStarling(cliArgs, "inherit");

await mirrorChildExit(child);

function shouldRenderTop(args) {
  const command = args[0];
  if (command !== "top" && command !== "monitor") {
    return false;
  }
  return !args.some((arg) => arg === "--json" || arg === "-h" || arg === "--help" || arg === "help");
}

async function runTopRenderer(args) {
  const rustArgs = normalizeTopArgs(args);
  if (rustArgs.includes("--watch")) {
    await runTopWatchRenderer(rustArgs);
    return;
  }

  const result = await captureStarling(rustArgs);
  if (result.type === "signal") {
    process.kill(process.pid, result.signal);
    return;
  }
  if (result.exitCode !== 0) {
    process.exit(result.exitCode);
  }
  try {
    console.log(renderTopSnapshot(JSON.parse(result.stdout)));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

async function runCommandRenderer(plan) {
  const result = await captureStarling(plan.rustArgs);
  if (result.type === "signal") {
    process.kill(process.pid, result.signal);
    return;
  }
  if (result.exitCode !== 0) {
    process.exit(result.exitCode);
  }
  try {
    console.log(renderCommandResult(plan, JSON.parse(result.stdout)));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

function normalizeTopArgs(args) {
  const next = [...args];
  if (next[0] === "monitor") {
    next[0] = "top";
  }
  if (!next.includes("--json")) {
    next.push("--json");
  }
  return next;
}

async function runTopWatchRenderer(args) {
  const child = spawnStarling(args, ["ignore", "pipe", "inherit"]);
  const rl = readline.createInterface({ input: child.stdout });

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      process.stdout.write("\x1b[2J\x1b[H");
      process.stdout.write(renderTopWatchFrame(JSON.parse(trimmed)));
      process.stdout.write("\n");
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    }
  });

  await mirrorChildExit(child);
}

function captureStarling(args) {
  const child = spawnStarling(args, ["ignore", "pipe", "inherit"]);
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  return new Promise((resolve) => {
    child.on("exit", (code, signal) => {
      if (signal) {
        resolve({ type: "signal", signal });
      } else {
        resolve({ type: "code", exitCode: code ?? 1, stdout });
      }
    });
  });
}

function spawnStarling(args, stdio) {
  const child = spawn(binaryPath, args, {
    stdio,
    env,
  });

  child.on("error", (err) => {
    console.error(err);
    process.exit(1);
  });

  return child;
}

// Forward common termination signals to the child so that it shuts down
// gracefully.
function installSignalForwarding(child) {
  const forwardSignal = (signal) => {
    if (child.killed) {
      return;
    }
    try {
      child.kill(signal);
    } catch {
      /* ignore */
    }
  };

  ["SIGINT", "SIGTERM", "SIGHUP"].forEach((sig) => {
    process.once(sig, () => forwardSignal(sig));
  });
}

// When the child exits, mirror its termination reason in the parent so that
// shell scripts and other tooling observe the correct exit status.
function mirrorChildExit(child) {
  installSignalForwarding(child);
  return new Promise((resolve) => {
    child.on("exit", (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
      } else {
        process.exit(code ?? 1);
      }
      resolve();
    });
  });
}
