import { createExtensionUiBridge } from "../agent-host/extension-ui.js";
import { createPiSdkAdapter, loadPiSdk } from "../agent-host/sdk-adapter.js";
import {
  type AgentSdkSession,
  type JsonObject,
  errorMessage,
  isJsonObject,
} from "../agent-host/types.js";
import type {
  ChatSession,
  ChatSessionRequest,
  CreateChatSessionOptions,
} from "./types.js";

/**
 * Open Pi through its public SDK and expose a small in-process request surface.
 *
 * One official Pi SDK session is created in the host process. Consumers use
 * this port directly, while JSONL is only a Starling transport adapter; Pi's
 * CLI and built-in TUI are never launched on this path.
 */
export function createChatSession(options: CreateChatSessionOptions): ChatSession {
  return new PiChatSession(options);
}

class PiChatSession implements ChatSession {
  private readonly diagnostic: (message: string) => void;
  private readonly ui;
  private readonly opening: Promise<AgentSdkSession>;
  private session: AgentSdkSession | undefined;
  private commandTail: Promise<void> = Promise.resolve();
  private closePromise: Promise<void> | undefined;
  private closeRequested = false;
  private drainRequested = false;
  private closed = false;
  private resolveImmediateClose: () => void = () => {};
  private readonly immediateClose = new Promise<void>((resolve) => {
    this.resolveImmediateClose = resolve;
  });

  constructor(options: CreateChatSessionOptions) {
    this.diagnostic = options.diagnostic ?? (() => {});
    this.ui = createExtensionUiBridge((value) => this.emit(options.onRecord, value));

    // Defer adapter code by one microtask so createChatSession() returns before
    // an adapter can synchronously emit a startup UI request. The UI response
    // still bypasses the command queue below and can unblock adapter.open().
    const adapter = options.adapter
      ?? createPiSdkAdapter(loadPiSdk, options.environment ?? process.env);
    this.opening = Promise.resolve().then(() => adapter.open(options.launch, {
      uiContext: this.ui.context,
      wasLastUiConfirmationExplicit: () => this.ui.wasLastConfirmationExplicit(),
      emitEvent: (event) => this.emit(options.onRecord, event),
      emitExtensionError: (error) => this.emit(options.onRecord, normalizeExtensionError(error)),
      requestShutdown: () => {
        let reportCloseFailure = options.onShutdownRequested === undefined;
        try {
          options.onShutdownRequested?.();
        } catch (error) {
          reportCloseFailure = true;
          this.diagnostic(`Starling shutdown listener failed: ${errorMessage(error)}`);
        }
        void this.close().catch((error) => {
          // When an embedding surface accepted the callback it awaits this
          // same close promise and owns the user-facing error. Keep this catch
          // only to prevent an unhandled rejection for standalone/no-op use.
          if (reportCloseFailure) {
            this.diagnostic(`Failed to close Pi SDK session: ${errorMessage(error)}`);
          }
        });
      },
    })).then((session) => {
      this.session = session;
      return session;
    });

    // A consumer observes startup failure through its first ordinary request.
    // Attach a handler immediately as well so a session created only to be
    // closed cannot produce an unhandled rejection.
    void this.opening.catch(() => {});
  }

  request(request: ChatSessionRequest): Promise<unknown> {
    if (this.closeRequested || this.closed) {
      return Promise.reject(new Error("Pi SDK session is closed"));
    }
    if (!isJsonObject(request) || typeof request.type !== "string") {
      return Promise.reject(new Error("Command must be a JSON object with a string type"));
    }

    // Trust and permission dialogs may be emitted while adapter.open() is
    // awaiting their answer. Never put those answers behind the open barrier.
    if (request.type === "extension_ui_response") {
      if (!this.ui.handleResponse(request)) {
        return Promise.reject(new Error("Invalid extension UI response"));
      }
      return Promise.resolve(undefined);
    }

    // Cancellation is a control plane, not ordinary queued work. In
    // particular abort_compaction must be able to interrupt compact itself.
    if (request.type === "abort" || request.type === "abort_compaction") {
      return this.opening.then((session) => dispatchRequest(session, request));
    }

    const result = this.commandTail.then(async () => {
      const session = await this.opening;
      if (this.closeRequested && !this.drainRequested) {
        throw new Error("Pi SDK session is closed");
      }
      return await dispatchRequest(session, request);
    });
    this.commandTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  close(options: { drain?: boolean } = {}): Promise<void> {
    if (!this.closePromise) {
      this.drainRequested = options.drain === true;
      this.closePromise = this.closeOnce(this.drainRequested);
    } else if (options.drain !== true && this.drainRequested && !this.closed) {
      // EOF starts an ordered drain, but a later signal must be able to abort
      // a stuck model/tool/compaction request instead of waiting forever.
      this.drainRequested = false;
      this.resolveImmediateClose();
    }
    return this.closePromise;
  }

  private async closeOnce(drain: boolean): Promise<void> {
    this.closeRequested = true;
    // Fail closed and release any SDK call currently awaiting UI input.
    this.ui.cancelAll();

    try {
      if (drain) await Promise.race([this.commandTail, this.immediateClose]);
      const session = this.session ?? await this.opening;
      await session.shutdown();
    } finally {
      this.closed = true;
      this.session = undefined;
    }
  }

  private emit(output: (value: unknown) => void, value: unknown): void {
    if (this.closed) return;
    try {
      output(value);
    } catch (error) {
      this.diagnostic(`Starling chat event listener failed: ${errorMessage(error)}`);
    }
  }
}

async function dispatchRequest(
  session: AgentSdkSession,
  request: ChatSessionRequest,
): Promise<unknown> {
  switch (request.type) {
    case "get_state":
      return session.getState();
    case "get_messages":
      return { messages: session.getMessages() };
    case "get_commands":
      assertOnlyFields(request, "get_commands", ["type", "id"]);
      return { commands: session.getCommands() };
    case "get_session_stats":
      assertOnlyFields(request, "get_session_stats", ["type", "id"]);
      return session.getSessionStats();
    case "prompt": {
      if (typeof request.message !== "string") {
        throw new Error("prompt.message must be a string");
      }
      const behavior = streamingBehavior(request.streamingBehavior);
      await new Promise<void>((resolve, reject) => {
        let responded = false;
        session.prompt(
          request.message as string,
          behavior,
          () => {
            if (responded) return;
            responded = true;
            resolve();
          },
          (error) => {
            if (responded) return;
            responded = true;
            reject(error);
          },
        );
      });
      return undefined;
    }
    case "abort":
      await session.abort();
      return undefined;
    case "abort_compaction":
      assertOnlyFields(request, "abort_compaction", ["type", "id"]);
      session.abortCompaction();
      return undefined;
    case "set_model":
      if (typeof request.provider !== "string" || typeof request.modelId !== "string") {
        throw new Error("set_model requires provider and modelId strings");
      }
      return await session.setModel(request.provider, request.modelId);
    case "set_thinking_level":
      if (typeof request.level !== "string") {
        throw new Error("set_thinking_level.level must be a string");
      }
      session.setThinkingLevel(request.level);
      return undefined;
    case "get_available_models":
      return { models: await session.getAvailableModels() };
    case "compact":
      if (
        request.customInstructions !== undefined
        && typeof request.customInstructions !== "string"
      ) {
        throw new Error("compact.customInstructions must be a string");
      }
      return await session.compact(request.customInstructions as string | undefined);
    case "set_session_name": {
      assertOnlyFields(request, "set_session_name", ["type", "id", "name"]);
      if (typeof request.name !== "string") {
        throw new Error("set_session_name.name must be a string");
      }
      const name = request.name.trim();
      if (!name) throw new Error("Session name cannot be empty");
      session.setSessionName(name);
      return undefined;
    }
    case "reload":
      assertOnlyFields(request, "reload", ["type", "id"]);
      await session.reload();
      return undefined;
    default:
      throw new Error(`Unknown command: ${request.type}`);
  }
}

function assertOnlyFields(
  request: ChatSessionRequest,
  command: string,
  allowed: readonly string[],
): void {
  if (request.id !== undefined && typeof request.id !== "string") {
    throw new Error(`${command}.id must be a string`);
  }
  const allowedFields = new Set(allowed);
  const unexpected = Object.keys(request).filter((field) => !allowedFields.has(field));
  if (unexpected.length > 0) {
    throw new Error(
      `${command} does not accept field${unexpected.length === 1 ? "" : "s"}: ${unexpected.join(", ")}`,
    );
  }
}

function streamingBehavior(value: unknown): "steer" | "followUp" | undefined {
  if (value === undefined) return undefined;
  if (value === "steer" || value === "followUp") return value;
  throw new Error("prompt.streamingBehavior must be steer or followUp");
}

function normalizeExtensionError(error: unknown): JsonObject {
  if (isJsonObject(error)) {
    return {
      type: "extension_error",
      extensionPath: typeof error.extensionPath === "string" ? error.extensionPath : "unknown",
      event: typeof error.event === "string" ? error.event : "unknown",
      error: typeof error.error === "string" ? error.error : errorMessage(error.error),
    };
  }
  return {
    type: "extension_error",
    extensionPath: "unknown",
    event: "unknown",
    error: errorMessage(error),
  };
}
