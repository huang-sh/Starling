import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { parseStarlingKeys, type StarlingKey } from "./input.js";
import {
  forceTerminateManagedProcessTree,
  stopManagedProcessTree,
} from "./process.js";
import { StarlingRpcClient } from "./protocol.js";
import { renderStarlingFrame, visibleWidth } from "./render.js";
import {
  createExtensionUiPrompt,
  createInitialStarlingTuiState,
  isRecord,
  reduceStarlingTui,
  type ExtensionUiPrompt,
  type StarlingTuiAction,
  type StarlingTuiState,
} from "./state.js";

export {
  parseStarlingKeys,
  renderStarlingFrame,
  createExtensionUiPrompt,
  createInitialStarlingTuiState,
  reduceStarlingTui,
  visibleWidth,
};
export {
  buildWindowsTaskkillCommand,
  forceTerminateManagedProcessTree,
  stopManagedProcessTree,
  waitForManagedProcessExit,
} from "./process.js";
export { rpcTimeoutForCommand } from "./protocol.js";
export type { StarlingKey } from "./input.js";
export type { StarlingTuiViewport } from "./render.js";
export type {
  ActivityEntry,
  ExtensionUiPrompt,
  StarlingTuiAction,
  StarlingTuiState,
  TimelineEntry,
} from "./state.js";

export interface RunStarlingTuiOptions {
  /** Native Starling executable. The caller owns package/platform resolution. */
  executable: string;
  env?: NodeJS.ProcessEnv;
  cwd: string;
}

export type StarlingTuiErrorCode = "NOT_TTY" | "INVALID_CWD" | "SPAWN_FAILED";

export class StarlingTuiError extends Error {
  constructor(public readonly code: StarlingTuiErrorCode, message: string) {
    super(message);
    this.name = "StarlingTuiError";
  }
}

interface QueuedUiRequest {
  raw: Record<string, unknown>;
  prompt: ExtensionUiPrompt;
  timer?: NodeJS.Timeout;
}

const ENTER_SCREEN = "\u001b[?1049h\u001b[2J\u001b[H\u001b[?25l";
const LEAVE_SCREEN = "\u001b[?25h\u001b[0m\u001b[?1049l";

/**
 * Run Starling's original terminal interface against the existing v1 chat
 * protocol. The terminal and child process are always restored in `finally`.
 */
export async function runStarlingTui(options: RunStarlingTuiOptions): Promise<number> {
  const stdin = process.stdin;
  const stdout = process.stdout;
  if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== "function") {
    throw new StarlingTuiError(
      "NOT_TTY",
      "Starling's interactive workspace requires a TTY. Use `starling chat --cwd <path> pi` for JSONL automation.",
    );
  }

  const cwd = resolve(options.cwd || process.cwd());
  if (!existsSync(cwd) || !safeIsDirectory(cwd)) {
    throw new StarlingTuiError("INVALID_CWD", `Starling workspace does not exist or is not a directory: ${cwd}`);
  }
  if (!options.executable.trim()) {
    throw new StarlingTuiError("SPAWN_FAILED", "Starling native executable path is empty.");
  }

  let state = createInitialStarlingTuiState(cwd);
  let child: ChildProcessWithoutNullStreams | undefined;
  let client: StarlingRpcClient | undefined;
  let renderTimer: NodeJS.Timeout | undefined;
  let shutdownPromise: Promise<unknown> | undefined;
  let closing = false;
  let abortArmed = false;
  let activeUi: QueuedUiRequest | undefined;
  const uiQueue: QueuedUiRequest[] = [];
  const wasRaw = stdin.isRaw;
  const wasPaused = stdin.isPaused();
  const previousEncoding = (stdin as NodeJS.ReadStream & { readableEncoding?: BufferEncoding | null }).readableEncoding;
  let receivedLifecycleExit = false;
  let requestedSignal: NodeJS.Signals | undefined;

  let resolveCompletion: (value: number) => void = () => {};
  const completion = new Promise<number>((resolvePromise) => {
    resolveCompletion = resolvePromise;
  });

  const render = (): void => {
    renderTimer = undefined;
    const width = stdout.columns || 80;
    const height = stdout.rows || 24;
    stdout.write(`\u001b[H${renderStarlingFrame(state, { width, height, color: true })}`);
  };
  const scheduleRender = (immediate = false): void => {
    if (renderTimer) return;
    if (immediate) {
      render();
      return;
    }
    renderTimer = setTimeout(render, 16);
  };
  const dispatch = (action: StarlingTuiAction): void => {
    state = reduceStarlingTui(state, action);
    if (!state.busy) abortArmed = false;
    scheduleRender();
  };

  const sendUiResponse = (request: QueuedUiRequest, response: Record<string, unknown>): void => {
    if (request.timer) clearTimeout(request.timer);
    client?.send({ type: "extension_ui_response", id: request.prompt.id, ...response });
  };
  const activateNextUi = (): void => {
    if (activeUi || uiQueue.length === 0) return;
    activeUi = uiQueue.shift();
    if (activeUi) dispatch({ type: "ui.open", prompt: activeUi.prompt });
  };
  const finishActiveUi = (response: Record<string, unknown>): void => {
    if (!activeUi) return;
    const completed = activeUi;
    activeUi = undefined;
    sendUiResponse(completed, response);
    dispatch({ type: "ui.close" });
    activateNextUi();
  };
  const cancelUiById = (id: string): void => {
    if (activeUi?.prompt.id === id) {
      finishActiveUi({ cancelled: true });
      return;
    }
    const index = uiQueue.findIndex((entry) => entry.prompt.id === id);
    if (index >= 0) {
      const [removed] = uiQueue.splice(index, 1);
      sendUiResponse(removed, { cancelled: true });
    }
  };
  const cancelAllUi = (): void => {
    if (activeUi) {
      sendUiResponse(activeUi, { cancelled: true });
      activeUi = undefined;
    }
    for (const request of uiQueue.splice(0)) sendUiResponse(request, { cancelled: true });
    dispatch({ type: "ui.close" });
  };

  const handleUiRequest = (value: Record<string, unknown>): void => {
    const method = typeof value.method === "string" ? value.method : "";
    if (method === "notify") {
      dispatch({
        type: "diagnostic",
        level: value.notifyType === "error" ? "error" : "info",
        message: String(value.message ?? "Notification"),
      });
      return;
    }
    const prompt = createExtensionUiPrompt(value);
    if (!prompt) {
      if (typeof value.id === "string") {
        client?.send({ type: "extension_ui_response", id: value.id, cancelled: true });
      }
      return;
    }
    const request: QueuedUiRequest = { raw: value, prompt };
    const timeout = typeof value.timeout === "number" && value.timeout > 0
      ? Math.min(value.timeout, 10 * 60_000)
      : undefined;
    if (timeout) request.timer = setTimeout(() => cancelUiById(prompt.id), timeout);
    uiQueue.push(request);
    activateNextUi();
  };

  const handleRecord = (value: Record<string, unknown>): void => {
    if (value.type === "starling_started") {
      dispatch({ type: "starling.started", value });
      return;
    }
    if (value.type === "starling_exited") {
      receivedLifecycleExit = true;
      dispatch({ type: "starling.exited", value });
      return;
    }
    if (value.type === "extension_ui_request") {
      handleUiRequest(value);
      return;
    }
    dispatch({ type: "rpc.event", value });
  };

  const requestExit = (signal?: NodeJS.Signals): void => {
    if (signal) requestedSignal = signal;
    if (closing) {
      if (child) {
        void forceTerminateManagedProcessTree(child).catch((error: unknown) => {
          dispatch({ type: "diagnostic", level: "error", message: asError(error).message });
          resolveCompletion(1);
        });
      }
      return;
    }
    closing = true;
    cancelAllUi();
    if (state.busy) client?.send({ type: "abort" });
    if (child) {
      shutdownPromise ??= stopManagedProcessTree(child);
      void shutdownPromise.catch((error: unknown) => {
        dispatch({ type: "diagnostic", level: "error", message: asError(error).message });
        resolveCompletion(1);
      });
    }
  };

  const submitComposer = (): void => {
    if (!client || !state.ready || closing) return;
    const text = state.composer.trim();
    if (!text) return;
    const queued = state.busy;
    dispatch({ type: "prompt.submitted", text, queued });
    const body: Record<string, unknown> = { message: text };
    if (queued) body.streamingBehavior = "followUp";
    void client.request("prompt", body).catch((error: unknown) => {
      dispatch({ type: "prompt.rejected", message: asError(error).message });
    });
  };

  const abortTurn = (): void => {
    if (!client || !state.busy) return;
    client.send({ type: "abort" });
    dispatch({ type: "diagnostic", level: "info", message: "Abort requested" });
    abortArmed = true;
  };

  const handleModalKey = (key: StarlingKey): void => {
    const prompt = state.uiPrompt;
    if (!prompt) return;
    if (key.type === "escape" || key.type === "ctrl-c") {
      finishActiveUi({ cancelled: true });
      return;
    }
    if (prompt.method === "confirm") {
      if (key.type === "text" && (key.value.toLowerCase() === "y" || key.value.toLowerCase() === "n")) {
        finishActiveUi({ confirmed: key.value.toLowerCase() === "y" });
        return;
      }
      if (key.type === "left" || key.type === "up") dispatch({ type: "ui.select", delta: -1 });
      if (key.type === "right" || key.type === "down" || key.type === "tab") dispatch({ type: "ui.select", delta: 1 });
      if (key.type === "enter") finishActiveUi({ confirmed: prompt.selected === 1 });
      return;
    }
    if (prompt.method === "select") {
      if (key.type === "up" || key.type === "left") dispatch({ type: "ui.select", delta: -1 });
      if (key.type === "down" || key.type === "right" || key.type === "tab") dispatch({ type: "ui.select", delta: 1 });
      if (key.type === "enter") {
        const value = prompt.options[prompt.selected];
        finishActiveUi(value === undefined ? { cancelled: true } : { value });
      }
      return;
    }
    if (key.type === "text") dispatch({ type: "ui.append", value: key.value });
    if (key.type === "backspace") dispatch({ type: "ui.backspace" });
    if (key.type === "ctrl-u") dispatch({ type: "ui.value", value: "" });
    if (key.type === "alt-enter" || (prompt.method === "editor" && key.type === "enter")) {
      dispatch({ type: "ui.append", value: "\n" });
    } else if ((prompt.method === "input" && key.type === "enter") || key.type === "ctrl-s") {
      finishActiveUi({ value: prompt.value });
    }
  };

  const handleKey = (key: StarlingKey): void => {
    if (state.uiPrompt) {
      handleModalKey(key);
      return;
    }
    if (key.type === "ctrl-c") {
      if (state.busy && !abortArmed) abortTurn();
      else requestExit();
      return;
    }
    if (key.type === "ctrl-d" && !state.busy && !state.composer) {
      requestExit();
      return;
    }
    if (key.type === "escape") {
      abortTurn();
      return;
    }
    if (key.type === "enter") submitComposer();
    if (key.type === "alt-enter") dispatch({ type: "composer.append", value: "\n" });
    if (key.type === "backspace") dispatch({ type: "composer.backspace" });
    if (key.type === "ctrl-u") dispatch({ type: "composer.set", value: "" });
    if (key.type === "text") dispatch({ type: "composer.append", value: key.value });
    if (key.type === "page-up") dispatch({ type: "scroll", delta: Math.max(3, Math.floor((stdout.rows || 24) / 2)) });
    if (key.type === "page-down") dispatch({ type: "scroll", delta: -Math.max(3, Math.floor((stdout.rows || 24) / 2)) });
    if (key.type === "up" && !state.composer) dispatch({ type: "scroll", delta: 1 });
    if (key.type === "down" && !state.composer) dispatch({ type: "scroll", delta: -1 });
  };

  const onInput = (chunk: string | Buffer): void => {
    for (const key of parseStarlingKeys(chunk.toString())) handleKey(key);
  };
  const onResize = (): void => scheduleRender(true);
  const onSigint = (): void => requestExit("SIGINT");
  const onSigterm = (): void => requestExit("SIGTERM");
  const onSighup = (): void => requestExit("SIGHUP");

  try {
    stdout.write(ENTER_SCREEN);
    stdin.setEncoding("utf8");
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onInput);
    stdout.on("resize", onResize);
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
    process.once("SIGHUP", onSighup);
    scheduleRender(true);

    child = spawn(options.executable, ["chat", "--cwd", cwd, "pi"], {
      cwd,
      env: options.env ?? process.env,
      stdio: "pipe",
      // POSIX process groups let escalation kill both the Rust supervisor and
      // its Node SDK Host. Windows uses taskkill /T instead.
      detached: process.platform !== "win32",
      windowsHide: true,
      shell: false,
    });
    client = new StarlingRpcClient(child, {
      onRecord: handleRecord,
      onProtocolError: (error) => dispatch({ type: "diagnostic", level: "error", message: error.message }),
    });
    child.stderr.on("data", (chunk: string | Buffer) => {
      const message = chunk.toString("utf8").trim();
      if (message) dispatch({ type: "diagnostic", level: "info", message });
    });
    child.once("close", (code, signal) => {
      cancelAllUi();
      if (!receivedLifecycleExit) {
        dispatch({
          type: "starling.exited",
          value: { success: code === 0, exitCode: code, signal },
        });
      }
      resolveCompletion(code ?? signalExitCode(signal));
    });

    if (closing) {
      shutdownPromise ??= stopManagedProcessTree(child);
    }

    await waitForSpawn(child);
    const [stateResponse, messagesResponse] = await Promise.all([
      // SDK startup can pause for the project-trust confirmation delivered
      // over this same stream. Do not let the ordinary query deadline close
      // the UI while the user is still making that decision.
      client.request("get_state", {}, { timeoutMs: null }),
      client.request("get_messages", {}, { timeoutMs: null }),
    ]);
    const sessionState = isRecord(stateResponse.data) ? stateResponse.data : {};
    const messagesData = isRecord(messagesResponse.data) ? messagesResponse.data : {};
    dispatch({
      type: "session.hydrated",
      state: sessionState,
      messages: Array.isArray(messagesData.messages) ? messagesData.messages : [],
    });

    const result = await completion;
    if (requestedSignal) return signalExitCode(requestedSignal);
    return result;
  } catch (error) {
    requestExit();
    if (error instanceof StarlingTuiError) throw error;
    throw new StarlingTuiError("SPAWN_FAILED", asError(error).message);
  } finally {
    cancelAllUi();
    if (renderTimer) clearTimeout(renderTimer);
    let cleanupError: Error | undefined;
    try {
      if (child && child.exitCode === null && child.signalCode === null) {
        shutdownPromise ??= stopManagedProcessTree(child);
      }
      await shutdownPromise;
    } catch (error) {
      cleanupError = asError(error);
    } finally {
      client?.close();
      stdin.off("data", onInput);
      stdout.off("resize", onResize);
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      process.off("SIGHUP", onSighup);
      stdin.setRawMode(wasRaw === true);
      if (wasPaused) stdin.pause();
      if (previousEncoding) stdin.setEncoding(previousEncoding);
      else (stdin as unknown as { setEncoding(value: null): void }).setEncoding(null);
      stdout.write(LEAVE_SCREEN);
    }
    if (cleanupError) throw cleanupError;
  }
}

function waitForSpawn(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const onSpawn = (): void => {
      child.off("error", onError);
      resolvePromise();
    };
    const onError = (error: Error): void => {
      child.off("spawn", onSpawn);
      reject(error);
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}

function signalExitCode(signal: NodeJS.Signals | null): number {
  if (!signal) return 1;
  const numbers: Partial<Record<NodeJS.Signals, number>> = {
    SIGHUP: 1,
    SIGINT: 2,
    SIGTERM: 15,
  };
  return 128 + (numbers[signal] ?? 1);
}

function safeIsDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
