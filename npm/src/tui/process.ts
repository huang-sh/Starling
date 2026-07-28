import { spawn } from "node:child_process";

export interface ManagedProcess {
  pid?: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  stdin: { writable: boolean; end(): void };
  once(event: "close", listener: () => void): unknown;
  off(event: "close", listener: () => void): unknown;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export interface StopProcessTreeOptions {
  platform?: NodeJS.Platform;
  gracefulTimeoutMs?: number;
  terminateTimeoutMs?: number;
  killTimeoutMs?: number;
  killUnixProcessGroup?: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
  runWindowsTaskkill?: (pid: number) => Promise<void>;
}

export type StopProcessTreeResult = "already-exited" | "graceful" | "forced";

const DEFAULT_GRACEFUL_TIMEOUT_MS = 2_000;
const DEFAULT_TERMINATE_TIMEOUT_MS = 750;
const DEFAULT_KILL_TIMEOUT_MS = 750;

/**
 * Close stdin first so the Rust supervisor can abort and reap its SDK Host.
 * If it does not exit, escalate against the complete process tree.
 */
export async function stopManagedProcessTree(
  child: ManagedProcess,
  options: StopProcessTreeOptions = {},
): Promise<StopProcessTreeResult> {
  if (hasExited(child)) {
    sweepExitedUnixProcessGroup(child, options);
    return "already-exited";
  }
  if (child.stdin.writable) child.stdin.end();
  if (await waitForManagedProcessExit(child, options.gracefulTimeoutMs ?? DEFAULT_GRACEFUL_TIMEOUT_MS)) {
    // The Rust supervisor normally reaps its SDK Host before exiting. Sweep
    // the detached group as a final guard against a supervisor crash that
    // closed our pipes while leaving the Host behind.
    sweepExitedUnixProcessGroup(child, options);
    return "graceful";
  }

  await forceTerminateManagedProcessTree(child, options, false);
  if (!hasExited(child)) {
    throw new Error(`Could not terminate Starling process tree${child.pid ? ` ${child.pid}` : ""}.`);
  }
  return "forced";
}

/** Force the entire tree now; used for escalation and a repeated exit request. */
export async function forceTerminateManagedProcessTree(
  child: ManagedProcess,
  options: StopProcessTreeOptions = {},
  killImmediately = true,
): Promise<void> {
  if (hasExited(child)) return;
  const platform = options.platform ?? process.platform;
  const terminateTimeoutMs = options.terminateTimeoutMs ?? DEFAULT_TERMINATE_TIMEOUT_MS;
  const killTimeoutMs = options.killTimeoutMs ?? DEFAULT_KILL_TIMEOUT_MS;
  const pid = validPid(child.pid) ? child.pid : undefined;

  if (platform === "win32") {
    if (pid) {
      try {
        await (options.runWindowsTaskkill ?? runWindowsTaskkill)(pid);
      } catch {
        safeKillChild(child, "SIGKILL");
      }
    } else {
      safeKillChild(child, "SIGKILL");
    }
    await waitForManagedProcessExit(child, killTimeoutMs);
    if (!hasExited(child)) safeKillChild(child, "SIGKILL");
    await waitForManagedProcessExit(child, killTimeoutMs);
    return;
  }

  const killGroup = options.killUnixProcessGroup ?? killUnixProcessGroup;
  if (!killImmediately) {
    if (pid) {
      try {
        killGroup(pid, "SIGTERM");
      } catch {
        safeKillChild(child, "SIGTERM");
      }
    } else {
      safeKillChild(child, "SIGTERM");
    }
    // Even when the group leader exits on TERM, continue to SIGKILL below so
    // a stubborn SDK Host left in the detached group cannot survive.
    await waitForManagedProcessExit(child, terminateTimeoutMs);
  }

  if (pid) {
    try {
      killGroup(pid, "SIGKILL");
    } catch {
      if (!hasExited(child)) safeKillChild(child, "SIGKILL");
    }
  } else {
    safeKillChild(child, "SIGKILL");
  }
  await waitForManagedProcessExit(child, killTimeoutMs);
  if (!hasExited(child)) {
    safeKillChild(child, "SIGKILL");
    await waitForManagedProcessExit(child, killTimeoutMs);
  }
}

export function buildWindowsTaskkillCommand(pid: number): { file: string; args: string[] } {
  if (!validPid(pid)) throw new Error(`Invalid Starling process PID: ${pid}`);
  return { file: "taskkill.exe", args: ["/PID", String(pid), "/T", "/F"] };
}

export function waitForManagedProcessExit(child: ManagedProcess, timeoutMs: number): Promise<boolean> {
  if (hasExited(child)) return Promise.resolve(true);
  return new Promise((resolvePromise) => {
    let settled = false;
    const finish = (exited: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("close", onClose);
      resolvePromise(exited);
    };
    const onClose = (): void => finish(true);
    const timer = setTimeout(() => finish(hasExited(child)), Math.max(0, timeoutMs));
    child.once("close", onClose);
  });
}

function runWindowsTaskkill(pid: number): Promise<void> {
  const command = buildWindowsTaskkillCommand(pid);
  const taskkill = spawn(command.file, command.args, {
    windowsHide: true,
    shell: false,
    stdio: "ignore",
  });
  return new Promise((resolvePromise, reject) => {
    const onError = (error: Error): void => {
      taskkill.off("close", onClose);
      reject(error);
    };
    const onClose = (code: number | null): void => {
      taskkill.off("error", onError);
      if (code === 0) resolvePromise();
      else reject(new Error(`taskkill.exe failed with exit code ${code ?? "unknown"}.`));
    };
    taskkill.once("error", onError);
    taskkill.once("close", onClose);
  });
}

function killUnixProcessGroup(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH") throw error;
  }
}

function sweepExitedUnixProcessGroup(
  child: ManagedProcess,
  options: StopProcessTreeOptions,
): void {
  if ((options.platform ?? process.platform) === "win32" || !validPid(child.pid)) return;
  try {
    (options.killUnixProcessGroup ?? killUnixProcessGroup)(child.pid, "SIGKILL");
  } catch {
    // The group normally disappears with the supervisor. A failed best-effort
    // sweep must not turn an otherwise clean shutdown into an error.
  }
}

function safeKillChild(child: ManagedProcess, signal: NodeJS.Signals): void {
  if (hasExited(child)) return;
  try {
    child.kill(signal);
  } catch {
    // A concurrent exit is indistinguishable from a failed kill here. The
    // bounded wait and final state check decide whether cleanup succeeded.
  }
}

function hasExited(child: ManagedProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function validPid(pid: number | undefined): pid is number {
  return Number.isSafeInteger(pid) && (pid ?? 0) > 0;
}
