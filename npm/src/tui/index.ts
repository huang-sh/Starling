import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { createChatSession } from "../chat/session.js";
import type {
  ChatSession,
  ChatSessionFactory,
  ChatSessionRequest,
} from "../chat/types.js";
import {
  createManagedRun,
  type ManagedRun,
  type ManagedRunFactory,
} from "../run-lifecycle.js";
import {
  normalizeChatRecord,
  normalizeChatSnapshot,
  type ChatInteractionRequest,
} from "./events.js";
import {
  authenticateProvider,
  authProvidersFromResponse,
  handleAuthPickerKey,
  type AuthPickerMode,
} from "./auth-picker.js";
import {
  completeSlashCommand,
  filterSlashCommands,
  formatSessionStats,
  formatSlashHelp,
  formatThinkingLevels,
  isSlashInvocation,
  planSlashCommand,
  type SlashCommandPlan,
} from "./commands.js";
import { StarlingInputDecoder, parseStarlingKeys, type StarlingKey } from "./input.js";
import {
  availableModelsFromResponse,
  handleModelPickerKey,
  modelRolesFromResponse,
} from "./model-picker.js";
import {
  handleTreePickerKey,
  treePickerFromResponse,
} from "./tree-picker.js";
import { renderStarlingFrame, renderStarlingParts, visibleWidth } from "./render.js";
import { shouldUseSynchronizedOutput, StarlingScreen } from "./screen.js";
import type { PickerHost } from "./picker-host.js";
import {
  createExtensionUiPrompt,
  createInitialStarlingTuiState,
  isRecord,
  reduceStarlingTui,
  type ExtensionUiPrompt,
  type StarlingTuiAction,
} from "./state.js";

export {
  completeSlashCommand,
  createExtensionUiPrompt,
  createInitialStarlingTuiState,
  filterSlashCommands,
  planSlashCommand,
  parseStarlingKeys,
  reduceStarlingTui,
  renderStarlingFrame,
  renderStarlingParts,
  shouldUseSynchronizedOutput,
  StarlingInputDecoder,
  StarlingScreen,
  visibleWidth,
};
export {
  availableModelsFromResponse,
  selectedModelPickerModel,
  visibleModelPickerModels,
} from "./model-picker.js";
export type { StarlingKey } from "./input.js";
export type { SlashCommandItem, SlashCommandPlan, SlashCommandSource } from "./commands.js";
export type { StarlingFrameMode, StarlingFrameParts, StarlingTuiViewport } from "./render.js";
export type {
  ActivityEntry,
  ExtensionUiPrompt,
  StarlingTuiAction,
  StarlingTuiState,
  TimelineEntry,
} from "./state.js";

export interface RunStarlingTuiOptions {
  env?: NodeJS.ProcessEnv;
  cwd: string;
  /** Override the in-process Pi SDK session factory (primarily for tests). */
  createSession?: ChatSessionFactory;
  /** Override Starling run persistence (primarily for tests). */
  createRun?: ManagedRunFactory;
}

export type StarlingTuiErrorCode = "NOT_TTY" | "INVALID_CWD" | "SESSION_FAILED";

export class StarlingTuiError extends Error {
  constructor(public readonly code: StarlingTuiErrorCode, message: string) {
    super(message);
    this.name = "StarlingTuiError";
  }
}

interface QueuedUiRequest {
  prompt: ExtensionUiPrompt;
  timer?: NodeJS.Timeout;
}

const ENTER_SCREEN = "\u001b[?25l\u001b[?2004h";
const LONE_ESCAPE_TIMEOUT_MS = 75;
const TERMINAL_FLUSH_TIMEOUT_MS = 250;

/**
 * Starling-owned TUI backed directly by one in-process Pi SDK ChatSession.
 * OMP informs only this frontend's visual hierarchy and differential terminal
 * painting; no external terminal UI or JSONL transport participates here.
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
    throw new StarlingTuiError(
      "INVALID_CWD",
      `Starling workspace does not exist or is not a directory: ${cwd}`,
    );
  }
  const environment = options.env ?? process.env;
  const inputDecoder = new StarlingInputDecoder();
  const screen = new StarlingScreen((value) => stdout.write(value), {
    synchronizedOutput: shouldUseSynchronizedOutput(environment),
  });
  const wasRaw = stdin.isRaw === true;
  const wasPaused = stdin.isPaused();
  const previousEncoding = stdin.readableEncoding;

  let state = createInitialStarlingTuiState(cwd);
  let session: ChatSession | undefined;
  let managedRun: ManagedRun | undefined;
  let renderTimer: NodeJS.Timeout | undefined;
  let animationTimer: NodeJS.Timeout | undefined;
  let escapeTimer: NodeJS.Timeout | undefined;
  let shutdownPromise: Promise<void> | undefined;
  let terminalEntered = false;
  let closing = false;
  let abortArmed = false;
  let activeUi: QueuedUiRequest | undefined;
  const uiQueue: QueuedUiRequest[] = [];
  let requestedSignal: NodeJS.Signals | undefined;
  let finalExitCode = 1;
  let startupFailed = false;
  let terminalFailed = false;
  let terminalFlushPromise: Promise<void> = Promise.resolve();
  let tick = 0;

  let completionSettled = false;
  let resolveCompletion: (value: number) => void = () => {};
  const completion = new Promise<number>((resolvePromise) => {
    resolveCompletion = resolvePromise;
  });

  function settleCompletion(code: number): void {
    if (completionSettled) return;
    completionSettled = true;
    resolveCompletion(code);
  }

  function ensureAnimation(): void {
    if (
      animationTimer
      || closing
      || (
        !state.busy
        && !state.compacting
        && !state.uiPrompt
        && !state.authPicker?.working
        && !state.treePicker?.working
        && !state.modelPicker?.switching
      )
    ) return;
    animationTimer = setTimeout(() => {
      animationTimer = undefined;
      scheduleRender(true);
    }, 80);
  }

  function render(force = false): void {
    renderTimer = undefined;
    if (!terminalEntered || closing) return;
    tick += 1;
    const parts = renderStarlingParts(state, {
      width: stdout.columns || 80,
      height: stdout.rows || 24,
      color: true,
      tick,
    });
    try {
      screen.paint(parts, { height: stdout.rows || 24, force });
    } catch (error) {
      recordTerminalFailure(error);
      requestExit();
      return;
    }
    ensureAnimation();
  }

  function scheduleRender(immediate = false, force = false): void {
    if (!terminalEntered || closing) return;
    if (immediate) {
      if (renderTimer) clearTimeout(renderTimer);
      render(force);
      return;
    }
    if (!renderTimer) renderTimer = setTimeout(() => render(force), 16);
  }

  function dispatch(action: StarlingTuiAction): void {
    state = reduceStarlingTui(state, action);
    if (!state.busy && !state.compacting) abortArmed = false;
    scheduleRender();
  }
  function pickerHost(): PickerHost {
    return { state, session, closing, dispatch, sendSessionRequest, refreshSessionMetadata };
  }

  function sendUiResponse(
    request: QueuedUiRequest,
    response: Record<string, unknown>,
  ): void {
    if (request.timer) clearTimeout(request.timer);
    sendSessionRequest({
      ...response,
      type: "extension_ui_response",
      id: request.prompt.id,
    });
  }

  function sendSessionRequest(request: ChatSessionRequest): void {
    if (!session) return;
    void session.request(request).catch((error: unknown) => {
      dispatch({ type: "diagnostic", level: "error", message: asError(error).message });
    });
  }

  function activateNextUi(): void {
    if (closing || activeUi || uiQueue.length === 0) return;
    activeUi = uiQueue.shift();
    if (activeUi) dispatch({ type: "ui.open", prompt: activeUi.prompt });
  }

  function finishActiveUi(response: Record<string, unknown>): void {
    if (!activeUi) return;
    const completed = activeUi;
    activeUi = undefined;
    sendUiResponse(completed, response);
    dispatch({ type: "ui.close" });
    activateNextUi();
  }

  function cancelUiById(id: string): void {
    if (activeUi?.prompt.id === id) {
      finishActiveUi({ cancelled: true });
      return;
    }
    const index = uiQueue.findIndex((entry) => entry.prompt.id === id);
    if (index < 0) return;
    const [removed] = uiQueue.splice(index, 1);
    if (removed) sendUiResponse(removed, { cancelled: true });
  }

  function dismissUiById(id: string): void {
    if (activeUi?.prompt.id === id) {
      if (activeUi.timer) clearTimeout(activeUi.timer);
      activeUi = undefined;
      dispatch({ type: "ui.close" });
      activateNextUi();
      return;
    }
    const index = uiQueue.findIndex((entry) => entry.prompt.id === id);
    if (index < 0) return;
    const [removed] = uiQueue.splice(index, 1);
    if (removed?.timer) clearTimeout(removed.timer);
  }

  function cancelAllUi(): void {
    if (activeUi) {
      sendUiResponse(activeUi, { cancelled: true });
      activeUi = undefined;
    }
    for (const request of uiQueue.splice(0)) {
      sendUiResponse(request, { cancelled: true });
    }
    dispatch({ type: "ui.close" });
  }

  function queueInteractiveUi(request: ChatInteractionRequest, timeout: unknown): void {
    const queued: QueuedUiRequest = {
      prompt: {
        id: request.id,
        method: request.method,
        title: request.title,
        message: request.message,
        options: request.options,
        selected: 0,
        value: request.initialValue,
        secret: request.secret,
      },
    };
    if (typeof timeout === "number" && timeout > 0) {
      queued.timer = setTimeout(
        () => cancelUiById(request.id),
        Math.min(timeout, 10 * 60_000),
      );
    }
    if (closing) {
      sendUiResponse(queued, { cancelled: true });
      return;
    }
    uiQueue.push(queued);
    activateNextUi();
  }

  function handleRecord(value: Record<string, unknown>): void {
    const timeout = value.type === "extension_ui_request" ? value.timeout : undefined;
    let handledInteractiveRequest = false;
    for (const event of normalizeChatRecord(value)) {
      if (event.type === "interaction.requested") {
        handledInteractiveRequest = true;
        queueInteractiveUi(event.request, timeout);
        continue;
      }
      if (event.type === "interaction.dismissed") {
        dismissUiById(event.id);
        continue;
      }
      dispatch({ type: "chat.event", event });
    }
    if (
      value.type === "extension_ui_request"
      && !handledInteractiveRequest
      && typeof value.id === "string"
      && !["notify", "setStatus", "setTitle", "set_editor_text"].includes(String(value.method))
    ) {
      sendSessionRequest({
        type: "extension_ui_response",
        id: value.id,
        cancelled: true,
      });
    }
  }

  function beginShutdown(): void {
    if (!session || shutdownPromise) return;
    shutdownPromise = session.close();
    void shutdownPromise.then(
      async () => {
        await terminalFlushPromise;
        finalExitCode = requestedSignal
          ? signalExitCode(requestedSignal)
          : startupFailed || terminalFailed ? 1 : 0;
        state = reduceStarlingTui(state, {
          type: "chat.event",
          event: { type: "runtime.exited", success: true, exitCode: 0 },
        });
        settleCompletion(finalExitCode);
      },
      async (error: unknown) => {
        await terminalFlushPromise;
        finalExitCode = requestedSignal ? signalExitCode(requestedSignal) : 1;
        state = reduceStarlingTui(state, {
          type: "diagnostic",
          level: "error",
          message: asError(error).message,
        });
        settleCompletion(finalExitCode);
      },
    );
  }

  function requestExit(signal?: NodeJS.Signals): void {
    if (signal) requestedSignal = signal;
    if (closing) return;
    closing = true;
    cancelAllUi();
    // Return terminal ownership before awaiting SDK teardown. Signal handlers
    // are removed here, so a second Ctrl-C can still terminate a stuck close.
    restoreTerminal();
    beginShutdown();
    if (!session) {
      void terminalFlushPromise.then(() => {
        finalExitCode = signal
          ? signalExitCode(signal)
          : startupFailed || terminalFailed ? 1 : 0;
        settleCompletion(finalExitCode);
      });
    }
  }

  async function loadSlashCommands(): Promise<void> {
    if (!session || closing) return;
    const response = await session.request({ type: "get_commands" });
    const commands = isRecord(response) && Array.isArray(response.commands)
      ? response.commands
      : [];
    dispatch({ type: "slash.loaded", commands });
  }

  async function refreshSessionMetadata(): Promise<ReturnType<typeof sessionMetadata>> {
    if (!session || closing) return {};
    const response = await session.request({ type: "get_state" });
    const metadata = sessionMetadata(response);
    dispatch({ type: "session.metadata", ...metadata });
    if (managedRun) {
      try {
        await managedRun.updateSession({
          sessionId: metadata.sessionId,
          sessionFile: metadata.sessionFile,
          model: metadata.model,
          title: metadata.sessionName,
        });
      } catch (error) {
        dispatch({
          type: "diagnostic",
          level: "info",
          message: `Session tracking unavailable: ${asError(error).message}`,
        });
      }
    }
    return metadata;
  }

  function submitComposer(): void {
    if (!session || !state.ready || closing) return;
    const text = state.composer.trim();
    if (!text) return;
    dispatch({ type: "history.push", text });
    if (isSlashInvocation(text)) {
      void executeSlashCommand(text);
      return;
    }

    const queued = state.busy || state.compacting;
    dispatch({ type: "prompt.submitted", text, queued });
    const request: ChatSessionRequest = { type: "prompt", message: text };
    if (queued) request.streamingBehavior = "followUp";
    void session.request(request).catch((error: unknown) => {
      dispatch({ type: "prompt.rejected", message: asError(error).message });
    });
  }

  async function executeSlashCommand(text: string): Promise<void> {
    if (!session || closing) return;
    const plan = planSlashCommand(text, state.slashCommands, state.busy || state.compacting);
    if (plan.kind === "error") {
      dispatch({ type: "command.submitted", name: commandName(text) });
      dispatch({ type: "command.failed", message: plan.message });
      return;
    }

    dispatch({ type: "command.submitted", name: plan.command.name });
    if (plan.kind === "local") {
      await executeLocalSlashCommand(plan);
      return;
    }

    try {
      const result = await session.request(plan.request);
      if (plan.kind === "request") {
        let refreshedMetadata: ReturnType<typeof sessionMetadata> | undefined;
        if (plan.refreshCommands) {
          try {
            await loadSlashCommands();
          } catch (error) {
            dispatch({
              type: "diagnostic",
              level: "error",
              message: `Commands could not be refreshed: ${asError(error).message}`,
            });
          }
        }
        if (plan.refreshMetadata) {
          try {
            refreshedMetadata = await refreshSessionMetadata();
          } catch (error) {
            dispatch({
              type: "diagnostic",
              level: "error",
              message: `Session metadata could not be refreshed: ${asError(error).message}`,
            });
          }
        }
        const message = requestCompletionMessage(plan, result, refreshedMetadata);
        dispatch({ type: "command.completed", message });
      } else {
        // Dynamic extension/template/skill commands own their transcript and
        // busy lifecycle. Do not create an optimistic user row here because
        // Pi may handle the command without starting an agent turn.
        dispatch({ type: "command.completed" });
      }
    } catch (error) {
      dispatch({ type: "command.failed", message: asError(error).message });
    }
  }

  async function executeLocalSlashCommand(
    plan: Extract<SlashCommandPlan, { kind: "local" }>,
  ): Promise<void> {
    if (!session || closing) return;
    try {
      switch (plan.action) {
        case "help":
          dispatch({ type: "command.completed", message: formatSlashHelp(state.slashCommands) });
          return;
        case "models": {
          const response = await session.request({ type: "get_available_models" });
          const config = await session.request({ type: "get_model_config" });
          const models = availableModelsFromResponse(response);
          if (models.length === 0) {
            dispatch({ type: "command.failed", message: "No configured models found" });
            return;
          }
          dispatch({
            type: "model.open",
            models,
            current: state.model,
            roles: modelRolesFromResponse(config),
          });
          dispatch({ type: "command.completed" });
          return;
        }
        case "tree": {
          const response = await session.request({ type: "get_tree" });
          const tree = treePickerFromResponse(response);
          if (tree.entries.length === 0) {
            dispatch({ type: "command.completed", message: "No entries in session" });
            return;
          }
          dispatch({ type: "tree.open", ...tree });
          dispatch({ type: "command.completed" });
          return;
        }
        case "login":
        case "logout":
          await openAuthPicker(plan.action, plan.argument);
          return;
        case "thinking":
          dispatch({
            type: "command.completed",
            message: formatThinkingLevels(state.thinking),
          });
          return;
        case "name":
          dispatch({
            type: "command.completed",
            message: state.sessionName
              ? `Session name: ${state.sessionName}`
              : "This session has no name. Set one with /name <session name>.",
          });
          return;
        case "quit":
          requestExit();
          return;
      }
    } catch (error) {
      dispatch({ type: "command.failed", message: asError(error).message });
    }
  }

  async function openAuthPicker(
    mode: AuthPickerMode,
    providerRef?: string,
  ): Promise<void> {
    if (!session || closing) return;
    const response = await session.request({ type: "get_auth_providers", mode });
    const available = authProvidersFromResponse(response);
    if (available.length === 0) {
      dispatch({
        type: "command.completed",
        message: mode === "logout"
          ? "No stored credentials to remove. Environment variables and models.json are unchanged."
          : "No Pi authentication providers are available.",
      });
      return;
    }

    let providers = available;
    if (providerRef) {
      const query = providerRef.trim().toLocaleLowerCase();
      const exact = available.filter((provider) =>
        provider.id.toLocaleLowerCase() === query
        || provider.name.toLocaleLowerCase() === query
      );
      providers = exact.length > 0
        ? exact
        : available.filter((provider) =>
          provider.id.toLocaleLowerCase().includes(query)
          || provider.name.toLocaleLowerCase().includes(query)
        );
      if (providers.length === 0) {
        dispatch({ type: "command.failed", message: `Unknown authentication provider: ${providerRef}` });
        return;
      }
    }

    dispatch({ type: "auth.open", mode, providers });
    dispatch({ type: "command.completed" });
    if (providerRef && providers.length === 1) {
      await authenticateProvider(pickerHost(), providers[0]!);
    }
  }

  function completeSelectedSlashCommand(): boolean {
    const matches = filterSlashCommands(state.composer, state.slashCommands);
    const selected = matches[state.slashSelected];
    if (!selected) return false;
    dispatch({ type: "composer.set", value: completeSlashCommand(selected) });
    dispatch({ type: "slash.dismiss" });
    return true;
  }

  function abortTurn(): void {
    if (!session || (!state.busy && !state.compacting)) return;
    if (state.compacting) {
      sendSessionRequest({ type: "abort_compaction" });
      dispatch({ type: "diagnostic", level: "info", message: "Compaction cancellation requested" });
    } else {
      sendSessionRequest({ type: "abort" });
      dispatch({ type: "diagnostic", level: "info", message: "Abort requested" });
    }
    abortArmed = true;
  }

  function handleModalKey(key: StarlingKey): void {
    const prompt = state.uiPrompt;
    if (!prompt) return;
    if (key.type === "escape" || key.type === "ctrl-c") {
      finishActiveUi({ cancelled: true });
      return;
    }
    if (prompt.method === "confirm") {
      if (key.type === "text" && ["y", "n"].includes(key.value.toLowerCase())) {
        finishActiveUi({ confirmed: key.value.toLowerCase() === "y" });
        return;
      }
      if (key.type === "left" || key.type === "up") {
        dispatch({ type: "ui.select", delta: -1 });
      }
      if (key.type === "right" || key.type === "down" || key.type === "tab") {
        dispatch({ type: "ui.select", delta: 1 });
      }
      if (key.type === "enter") finishActiveUi({ confirmed: prompt.selected === 1 });
      return;
    }
    if (prompt.method === "select") {
      if (key.type === "up" || key.type === "left") {
        dispatch({ type: "ui.select", delta: -1 });
      }
      if (key.type === "down" || key.type === "right" || key.type === "tab") {
        dispatch({ type: "ui.select", delta: 1 });
      }
      if (key.type === "enter") {
        const value = prompt.options[prompt.selected];
        finishActiveUi(value === undefined ? { cancelled: true } : { value });
      }
      return;
    }
    if (key.type === "left") {
      dispatch({ type: "ui.move", delta: -1 });
      return;
    }
    if (key.type === "right") {
      dispatch({ type: "ui.move", delta: 1 });
      return;
    }
    if (key.type === "home") {
      dispatch({ type: "ui.home" });
      return;
    }
    if (key.type === "end") {
      dispatch({ type: "ui.end" });
      return;
    }
    if (prompt.method === "editor" && (key.type === "up" || key.type === "down")) {
      dispatch({ type: "ui.line", delta: key.type === "up" ? -1 : 1 });
      return;
    }
    if (key.type === "delete") {
      dispatch({ type: "ui.delete" });
      return;
    }
    if (key.type === "text" || key.type === "paste") {
      dispatch({ type: "ui.append", value: key.value });
      return;
    }
    if (key.type === "backspace") {
      dispatch({ type: "ui.backspace" });
      return;
    }
    if (key.type === "ctrl-u") {
      dispatch({ type: "ui.value", value: "" });
      return;
    }
    if (key.type === "alt-enter" || (prompt.method === "editor" && key.type === "enter")) {
      dispatch({ type: "ui.append", value: "\n" });
    } else if ((prompt.method === "input" && key.type === "enter") || key.type === "ctrl-s") {
      finishActiveUi({ value: prompt.value });
    }
  }

  function handleKey(key: StarlingKey): void {
    if (state.uiPrompt) {
      handleModalKey(key);
      return;
    }
    if (state.authPicker) {
      handleAuthPickerKey(pickerHost(), key);
      return;
    }
    if (state.treePicker) {
      handleTreePickerKey(pickerHost(), key);
      return;
    }
    if (state.modelPicker) {
      handleModelPickerKey(pickerHost(), key);
      return;
    }
    if (state.slashMenuOpen) {
      if (key.type === "escape") {
        dispatch({ type: "slash.dismiss" });
        return;
      }
      if (key.type === "up") {
        dispatch({ type: "slash.select", delta: -1 });
        return;
      }
      if (key.type === "down") {
        dispatch({ type: "slash.select", delta: 1 });
        return;
      }
      if (key.type === "tab") {
        completeSelectedSlashCommand();
        return;
      }
      if (key.type === "enter") {
        const matches = filterSlashCommands(state.composer, state.slashCommands);
        const selected = matches[state.slashSelected];
        const exact = selected
          && state.composer.toLocaleLowerCase() === `/${selected.name}`.toLocaleLowerCase();
        if (exact) {
          dispatch({ type: "slash.dismiss" });
          submitComposer();
        } else if (!completeSelectedSlashCommand()) {
          submitComposer();
        }
        return;
      }
      if (key.type === "backspace") {
        dispatch({ type: "composer.backspace" });
        return;
      }
      if (key.type === "ctrl-u") {
        dispatch({ type: "composer.set", value: "" });
        return;
      }
      if (key.type === "text" || key.type === "paste") {
        dispatch({ type: "composer.append", value: key.value });
        return;
      }
    }
    if (key.type === "ctrl-c") {
      if ((state.busy || state.compacting) && !abortArmed) abortTurn();
      else requestExit();
      return;
    }
    if (key.type === "ctrl-d" && !state.busy && !state.compacting && !state.composer) {
      requestExit();
      return;
    }
    if (key.type === "escape") {
      abortTurn();
      return;
    }
    if (key.type === "left") {
      dispatch({ type: "composer.move", delta: -1 });
      return;
    }
    if (key.type === "right") {
      dispatch({ type: "composer.move", delta: 1 });
      return;
    }
    if (key.type === "home") {
      dispatch({ type: "composer.home" });
      return;
    }
    if (key.type === "end") {
      dispatch({ type: "composer.end" });
      return;
    }
    if (key.type === "delete") {
      dispatch({ type: "composer.delete" });
      return;
    }
    if (key.type === "up" || key.type === "down") {
      // readline-style: move the cursor within a multiline draft, but recall
      // history (Up = older, Down = newer) at the first/last line.
      const atTop = key.type === "up"
        && !state.composer.slice(0, state.composerCursor).includes("\n");
      const atBottom = key.type === "down"
        && !state.composer.slice(state.composerCursor).includes("\n");
      const atEdge = key.type === "up" ? atTop : atBottom;
      if (state.composer && !atEdge) {
        dispatch({ type: "composer.line", delta: key.type === "up" ? -1 : 1 });
      } else {
        dispatch({ type: key.type === "up" ? "history.prev" : "history.next" });
      }
      return;
    }
    if (key.type === "enter") {
      submitComposer();
      return;
    }
    if (key.type === "alt-enter") {
      dispatch({ type: "composer.append", value: "\n" });
      return;
    }
    if (key.type === "backspace") {
      dispatch({ type: "composer.backspace" });
      return;
    }
    if (key.type === "ctrl-u") {
      dispatch({ type: "composer.set", value: "" });
      return;
    }
    if (key.type === "text" || key.type === "paste") {
      dispatch({ type: "composer.append", value: key.value });
      return;
    }
    const page = Math.max(3, Math.floor((stdout.rows || 24) / 2));
    if (key.type === "page-up") dispatch({ type: "scroll", delta: page });
    if (key.type === "page-down") dispatch({ type: "scroll", delta: -page });
  }

  function deliverInput(chunk: string | Buffer): void {
    if (escapeTimer) {
      clearTimeout(escapeTimer);
      escapeTimer = undefined;
    }
    for (const key of inputDecoder.push(chunk.toString())) handleKey(key);
    if (inputDecoder.hasPendingEscape) {
      escapeTimer = setTimeout(() => {
        escapeTimer = undefined;
        for (const key of inputDecoder.flushPendingEscape()) handleKey(key);
      }, LONE_ESCAPE_TIMEOUT_MS);
    }
  }

  function onResize(): void {
    scheduleRender(true, true);
  }
  function onInputEnd(): void {
    requestExit();
  }
  function onSigint(): void {
    requestExit("SIGINT");
  }
  function onSigterm(): void {
    requestExit("SIGTERM");
  }
  function onSighup(): void {
    requestExit("SIGHUP");
  }
  function onTerminalError(error: Error): void {
    recordTerminalFailure(error);
    requestExit();
  }

  function recordTerminalFailure(_error: unknown): void {
    terminalFailed = true;
  }

  function enterTerminal(): void {
    // A dead remote terminal commonly reports EIO/EPIPE asynchronously through
    // the stream's `error` event, outside this async function's try/catch.
    stdin.on("error", onTerminalError);
    stdout.on("error", onTerminalError);
    stdout.write(ENTER_SCREEN);
    terminalEntered = true;
    stdin.setEncoding("utf8");
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", deliverInput);
    stdin.once("end", onInputEnd);
    stdout.on("resize", onResize);
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
    process.once("SIGHUP", onSighup);
  }

  function restoreTerminal(): void {
    if (!terminalEntered) return;
    // Mark ownership as returned first so a failed/dead TTY cannot cause a
    // second cleanup attempt or prevent SDK/run teardown from continuing.
    terminalEntered = false;
    try {
      stdin.off("data", deliverInput);
      stdin.off("end", onInputEnd);
      stdout.off("resize", onResize);
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      process.off("SIGHUP", onSighup);
    } catch {
      // Event-target cleanup is best effort when the terminal has disappeared.
    }
    try {
      stdin.setRawMode(wasRaw);
    } catch (error) {
      recordTerminalFailure(error);
      // Remote disconnects can invalidate the tty before SIGHUP is delivered.
    }
    try {
      if (wasPaused) stdin.pause();
    } catch (error) {
      recordTerminalFailure(error);
      // Best effort only.
    }
    try {
      if (previousEncoding) stdin.setEncoding(previousEncoding);
      else (stdin as unknown as { setEncoding(value: null): void }).setEncoding(null);
    } catch (error) {
      recordTerminalFailure(error);
      // Best effort only.
    }
    terminalFlushPromise = queueTerminalLeave(screen, recordTerminalFailure);
    try {
      screen.reset();
    } catch (error) {
      recordTerminalFailure(error);
      // Best effort only: a dead remote TTY can reject the final paint.
    }
  }

  try {
    enterTerminal();
    scheduleRender(true, true);
    if (closing) return await completion;

    try {
      managedRun = await (options.createRun ?? createManagedRun)({
        cwd,
        pid: process.pid,
        environment,
      });
    } catch (error) {
      dispatch({
        type: "diagnostic",
        level: "info",
        message: `Run tracking unavailable: ${asError(error).message}`,
      });
    }
    if (closing) return await completion;

    const createSession = options.createSession ?? createChatSession;
    session = createSession({
      launch: {
        cwd,
        extensions: [],
        // Pi's extension commands, prompt templates, and skills are part of
        // the SDK command surface. Project trust and Starling's managed gate
        // still control what project resources and tools may execute.
        noExtensions: false,
        surface: "tui",
        starlingManaged: true,
      },
      environment,
      onRecord: (value) => {
        if (isRecord(value)) handleRecord(value);
      },
      onShutdownRequested: requestExit,
      diagnostic: (message) => {
        dispatch({ type: "diagnostic", level: "info", message });
      },
    });
    dispatch({
      type: "chat.event",
      event: { type: "runtime.started", cwd, runId: managedRun?.runId },
    });
    if (closing) {
      beginShutdown();
      return await completion;
    }

    const commandsPromise = session.request({ type: "get_commands" }).catch((error) => {
      dispatch({
        type: "diagnostic",
        level: "error",
        message: `Slash commands could not be loaded: ${asError(error).message}`,
      });
      return { commands: [] };
    });
    const [stateResponse, messagesResponse, commandsResponse] = await Promise.all([
      session.request({ type: "get_state" }),
      session.request({ type: "get_messages" }),
      commandsPromise,
    ]);
    const sessionState = isRecord(stateResponse) ? stateResponse : {};
    const messagesData = isRecord(messagesResponse) ? messagesResponse : {};
    const snapshot = normalizeChatSnapshot(
      sessionState,
      Array.isArray(messagesData.messages) ? messagesData.messages : [],
    );
    dispatch({
      type: "chat.event",
      event: {
        type: "session.snapshot",
        snapshot,
      },
    });
    const slashCommands = isRecord(commandsResponse) && Array.isArray(commandsResponse.commands)
      ? commandsResponse.commands
      : [];
    dispatch({ type: "slash.loaded", commands: slashCommands });
    if (
      managedRun
      && (snapshot.sessionId || snapshot.sessionFile || snapshot.model || snapshot.sessionName)
    ) {
      try {
        await managedRun.updateSession({
          sessionId: snapshot.sessionId,
          sessionFile: snapshot.sessionFile,
          model: snapshot.model,
          title: snapshot.sessionName,
        });
      } catch (error) {
        dispatch({
          type: "diagnostic",
          level: "info",
          message: `Session tracking unavailable: ${asError(error).message}`,
        });
      }
    }

    const result = await completion;
    finalExitCode = requestedSignal ? signalExitCode(requestedSignal) : result;
    return finalExitCode;
  } catch (error) {
    if (closing) {
      finalExitCode = await completion;
      return finalExitCode;
    }
    startupFailed = true;
    finalExitCode = requestedSignal ? signalExitCode(requestedSignal) : 1;
    requestExit();
    if (error instanceof StarlingTuiError) throw error;
    throw new StarlingTuiError("SESSION_FAILED", asError(error).message);
  } finally {
    closing = true;
    cancelAllUi();
    if (renderTimer) clearTimeout(renderTimer);
    if (animationTimer) clearTimeout(animationTimer);
    if (escapeTimer) clearTimeout(escapeTimer);
    restoreTerminal();
    let cleanupError: Error | undefined;
    try {
      if (session) shutdownPromise ??= session.close();
      await shutdownPromise;
    } catch (error) {
      cleanupError = asError(error);
    }
    await terminalFlushPromise;
    stdin.off("error", onTerminalError);
    stdout.off("error", onTerminalError);
    if ((cleanupError || terminalFailed) && !requestedSignal) finalExitCode = 1;
    if (managedRun) {
      try {
        await managedRun.finish({ exitCode: finalExitCode });
      } catch (error) {
        process.stderr.write(`Starling could not finalize run tracking: ${asError(error).message}\n`);
      }
    }
    if (cleanupError) throw cleanupError;
  }
}

function queueTerminalLeave(
  _screen: StarlingScreen,
  onError: (error: unknown) => void,
): Promise<void> {
  return new Promise((resolvePromise) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolvePromise();
    };
    timer = setTimeout(settle, TERMINAL_FLUSH_TIMEOUT_MS);
    try {
      settle();
    } catch (error) {
      onError(error);
      settle();
    }
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

function safeIsDirectory(value: string): boolean {
  try {
    return statSync(value).isDirectory();
  } catch {
    return false;
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function requestCompletionMessage(
  plan: Extract<SlashCommandPlan, { kind: "request" }>,
  result: unknown,
  metadata: ReturnType<typeof sessionMetadata> | undefined,
): string | undefined {
  if (plan.command.name === "session") return formatSessionStats(result);
  if (plan.command.name === "thinking") {
    return metadata?.thinking
      ? `Thinking level changed to ${metadata.thinking}`
      : "Thinking level updated";
  }
  if (plan.command.name === "model") {
    return metadata?.model ? `Model changed to ${metadata.model}` : "Model updated";
  }
  if (plan.command.name === "name") {
    return metadata?.sessionName
      ? `Session named ${metadata.sessionName}`
      : "Session name updated";
  }
  return plan.successMessage;
}

function commandName(value: string): string {
  const match = /^\/([^\s/]*)/.exec(value.trim());
  return match?.[1] || "command";
}

function sessionMetadata(value: unknown): {
  model?: string;
  thinking?: string;
  sessionName?: string;
  sessionId?: string;
  sessionFile?: string;
} {
  if (!isRecord(value)) return {};
  const model = isRecord(value.model) ? value.model : {};
  const provider = optionalText(model.provider);
  const modelId = optionalText(model.id) || optionalText(model.modelId);
  return {
    model: [provider, modelId].filter(Boolean).join("/") || undefined,
    thinking: optionalText(value.thinkingLevel) || optionalText(value.thinking),
    sessionName: optionalText(value.sessionName),
    sessionId: optionalText(value.sessionId),
    sessionFile: optionalText(value.sessionFile),
  };
}

function optionalText(value: unknown): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  return text || undefined;
}
