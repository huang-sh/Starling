#!/usr/bin/env node
// Unified entry point for the Starling CLI.

import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "fs";
import { createRequire } from "node:module";
import path from "path";
import readline from "node:readline";
import { fileURLToPath } from "url";
import { renderTopSnapshot, renderTopWatchFrame } from "../lib/render/top.js";
import { getRenderPlan, renderCommandResult } from "../lib/render/commands.js";
import {
  MINIMUM_BUNDLED_PI_NODE_VERSION,
  bundledPiEnvironment,
  bundledPiSdkEnvironment,
  nodeSupportsBundledPi,
  piCliPathFromRpcEntry,
  piRpcEntryExportTarget,
} from "../lib/pi-runtime.js";

// __dirname equivalent in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

const PLATFORM_PACKAGE_BY_TARGET = {
  "x86_64-unknown-linux-musl": "starling-linux-x64-musl",
  "aarch64-unknown-linux-musl": "starling-linux-arm64",
  "x86_64-unknown-linux-gnu": "starling-linux-x64",
  "aarch64-unknown-linux-gnu": "starling-linux-arm64",
  "x86_64-apple-darwin": "starling-darwin-x64",
  "aarch64-apple-darwin": "starling-darwin-arm64",
  "x86_64-pc-windows-msvc": "starling-win32-x64",
  "aarch64-pc-windows-msvc": "starling-win32-arm64",
};

const IS_WINDOWS = process.platform === "win32";
const BINARY_NAME = IS_WINDOWS ? "starling.exe" : "starling";

const { platform, arch } = process;

let targetTriple = null;
switch (platform) {
  case "linux":
  case "android":
    switch (arch) {
      case "x64":
        targetTriple = isLinuxMusl() ? "x86_64-unknown-linux-musl" : "x86_64-unknown-linux-gnu";
        break;
      case "arm64":
        targetTriple = "aarch64-unknown-linux-gnu";
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
  case "win32":
    switch (arch) {
      case "x64":
        targetTriple = "x86_64-pc-windows-msvc";
        break;
      case "arm64":
        targetTriple = "aarch64-pc-windows-msvc";
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

function compatibleTargetTriples(primary) {
  const triples = [primary];
  if (primary === "x86_64-unknown-linux-musl") {
    triples.push("x86_64-unknown-linux-gnu");
  } else if (primary === "aarch64-unknown-linux-musl") {
    triples.push("aarch64-unknown-linux-gnu");
  }
  return triples;
}

function isLinuxMusl() {
  if (platform !== "linux" && platform !== "android") {
    return false;
  }
  const report = typeof process.report?.getReport === "function"
    ? process.report.getReport()
    : null;
  const glibc = report?.header?.glibcVersionRuntime || report?.header?.glibcVersionCompiler;
  return !glibc;
}

function findStarlingExecutable() {
  // 1. Dev/local package fallback. In `npm link` development, a globally
  // installed optional dependency may still exist next to the symlinked root
  // package; prefer the local staged binary so changes from scripts/build.sh
  // are picked up immediately.
  const devTargetTriples = compatibleTargetTriples(targetTriple);
  const devCandidates = [
    ...devTargetTriples.map((triple) =>
      path.join(__dirname, "..", "vendor", triple, "bin", BINARY_NAME),
    ),
    // direct cargo target dir (in-tree development)
    path.join(__dirname, "..", "..", "rust", "target", "release", BINARY_NAME),
    path.join(__dirname, "..", "..", "rust", "target", "debug", BINARY_NAME),
  ];
  for (const candidate of devCandidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  // 2. Installed platform package (production install)
  try {
    const packageJsonPath = require.resolve(`${platformPackage}/package.json`);
    const vendorRoot = path.join(path.dirname(packageJsonPath), "vendor");
    for (const triple of compatibleTargetTriples(targetTriple)) {
      const candidate = path.join(
        vendorRoot,
        triple,
        "bin",
        BINARY_NAME,
      );
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  } catch {
    // platform package not installed; fall through to dev path
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

const cliArgs = process.argv.slice(2);
// Bare `starling` launches Pi's interactive TUI through the managed native
// launcher (`starling run pi`), so run recording, session locks, and
// `starling top` visibility keep working. The interface is Pi's own TUI,
// branded "Starling" via the installed package's `piConfig.name`.
if (cliArgs.length === 0) {
  cliArgs.push("run", "pi");
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

const usesPiSdkHost = cliArgs[0] === "chat";
if (cliArgs[0] !== "chat") configureBundledPi(env);
if (usesPiSdkHost) configurePiSdkHost(env);

// Pi is branded "starling" (piConfig.name), so it reads STARLING_* override
// variables. Mirror any PI_* overrides so both surfaces agree on the location
// of the agent/session directories.
for (const [piVar, starlingVar] of [
  ["PI_CODING_AGENT_DIR", "STARLING_CODING_AGENT_DIR"],
  ["PI_CODING_AGENT_SESSION_DIR", "STARLING_CODING_AGENT_SESSION_DIR"],
]) {
  if (env[piVar]?.trim() && !env[starlingVar]?.trim()) {
    env[starlingVar] = env[piVar];
  }
}

if (usesPiSdkHost && !hasConfiguredPiSdkHost(env)) {
  const versionHint = nodeSupportsBundledPi(process.versions.node)
    ? "Reinstall starling-ai so its SDK Host files are present."
    : `Upgrade Node.js from ${process.versions.node} to ${MINIMUM_BUNDLED_PI_NODE_VERSION} or newer.`;
  console.error(`Starling Chat requires its Pi SDK Host. ${versionHint}`);
  process.exit(1);
}

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
  if (["record", "clear", "hook"].includes(args[1])) {
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
  if (!binaryPath) {
    throw new Error("Starling native executable is unavailable for this command.");
  }
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

function configureBundledPi(childEnv) {
  if (childEnv.STARLING_PI_BIN?.trim() || childEnv.STARLING_BUNDLED_PI_BIN?.trim()) {
    return;
  }

  const bundledPi = findBundledPiExecutable();

  if (!bundledPi) return;
  if (!nodeSupportsBundledPi(process.versions.node)) {
    // Keep Starling usable on older Node releases. Rust will continue through
    // its resolver to a configured or PATH Pi instead of selecting this one.
    return;
  }
  Object.assign(childEnv, bundledPiEnvironment(process.execPath, bundledPi));
}

function configurePiSdkHost(childEnv) {
  const hostEntry = path.join(__dirname, "..", "lib", "agent-host", "main.js");
  if (!existsSync(hostEntry) || !nodeSupportsBundledPi(process.versions.node)) return;
  const defaults = bundledPiSdkEnvironment(process.execPath, hostEntry);
  if (!childEnv.STARLING_PI_SDK_HOST?.trim()) {
    childEnv.STARLING_PI_SDK_HOST = defaults.STARLING_PI_SDK_HOST;
  }
  if (!childEnv.STARLING_PI_SDK_NODE?.trim()) {
    childEnv.STARLING_PI_SDK_NODE = defaults.STARLING_PI_SDK_NODE;
  }
}

function hasConfiguredPiSdkHost(childEnv) {
  return Boolean(
    childEnv.STARLING_PI_SDK_HOST?.trim()
      && childEnv.STARLING_PI_SDK_NODE?.trim(),
  );
}

function findBundledPiExecutable() {
  const specifier = "@earendil-works/pi-coding-agent/rpc-entry";
  try {
    // Prefer normal package-export resolution. Pi 0.82 exposes an import-only
    // condition, so createRequire may need the compatibility path below.
    const rpcEntry = require.resolve(specifier);
    const candidate = piCliPathFromRpcEntry(rpcEntry);
    return existsSync(candidate) ? candidate : null;
  } catch {
    // Fall through.
  }

  const packageName = "@earendil-works/pi-coding-agent";
  for (const moduleRoot of require.resolve.paths(packageName) || []) {
    const packageRoot = path.join(moduleRoot, "@earendil-works", "pi-coding-agent");
    const packageJsonPath = path.join(packageRoot, "package.json");
    try {
      const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
      const exportTarget = piRpcEntryExportTarget(packageJson);
      if (!exportTarget || !exportTarget.startsWith("./")) continue;
      const rpcEntry = path.resolve(packageRoot, exportTarget);
      const candidate = piCliPathFromRpcEntry(rpcEntry);
      if (existsSync(rpcEntry) && existsSync(candidate)) return candidate;
    } catch {
      // Try the next Node module root.
    }
  }
  return null;
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
