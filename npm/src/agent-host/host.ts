import type { Readable } from "node:stream";
import { createExtensionUiBridge } from "./extension-ui.js";
import { attachStrictJsonlReader } from "./jsonl.js";
import { createPiSdkAdapter } from "./sdk-adapter.js";
import {
  AgentHostLaunchOptions,
  AgentSdkAdapter,
  AgentSdkSession,
  JsonObject,
  errorMessage,
  isJsonObject,
  parseAgentHostArgs,
} from "./types.js";

export interface RunAgentHostOptions {
  argv: readonly string[];
  input: Readable;
  output(value: unknown): void;
  diagnostic(message: string): void;
  adapter?: AgentSdkAdapter;
  processCwd?: string;
  shutdownSignal?: AbortSignal;
}

export class AgentHostRuntime {
  private readonly adapter: AgentSdkAdapter;
  private readonly output: (value: unknown) => void;
  private readonly diagnostic: (message: string) => void;
  private readonly ui;
  private session: AgentSdkSession | undefined;
  private openingPromise: Promise<AgentSdkSession> | undefined;
  private sessionShutdownPromise: Promise<void> | undefined;
  private shutdownPromise: Promise<void> | undefined;
  private commandTail: Promise<void> = Promise.resolve();
  private readonly queuedCommands: JsonObject[] = [];
  private openStarted = false;
  private closeRequested = false;
  private closed = false;

  constructor(
    adapter: AgentSdkAdapter,
    output: (value: unknown) => void,
    diagnostic: (message: string) => void,
  ) {
    this.adapter = adapter;
    this.output = output;
    this.diagnostic = diagnostic;
    this.ui = createExtensionUiBridge((value) => this.write(value));
  }

  async open(options: AgentHostLaunchOptions): Promise<void> {
    if (this.openStarted) throw new Error("Pi SDK host session is already open or opening");
    if (this.closeRequested) return;
    this.openStarted = true;

    // Assign the opening promise before entering adapter code. A synchronous
    // shutdown request from adapter.open can therefore still wait for and
    // dispose the eventual session.
    const opening = Promise.resolve().then(() => this.adapter.open(options, {
      uiContext: this.ui.context,
      wasLastUiConfirmationExplicit: () => this.ui.wasLastConfirmationExplicit(),
      emitEvent: (event) => this.write(event),
      emitExtensionError: (error) => this.write(normalizeExtensionError(error)),
      requestShutdown: () => {
        void this.shutdown();
      },
    }));
    this.openingPromise = opening;

    try {
      const session = await opening;
      if (this.closeRequested) {
        await this.shutdownSession(session);
        return;
      }

      this.session = session;
      const queued = this.queuedCommands.splice(0);
      for (const command of queued) void this.enqueueCommand(command);
    } finally {
      if (this.openingPromise === opening) this.openingPromise = undefined;
    }
  }

  async handleLine(line: string): Promise<void> {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      this.write(failure(undefined, "parse", `Failed to parse command: ${errorMessage(error)}`));
      return;
    }

    if (this.ui.handleResponse(value)) return;
    if (!isJsonObject(value) || typeof value.type !== "string") {
      this.write(failure(undefined, "unknown", "Command must be a JSON object with a string type"));
      return;
    }
    if (!this.session && !this.closeRequested) {
      this.queuedCommands.push(value);
      return;
    }
    if (!this.session || this.closed || this.closeRequested) {
      this.write(failure(requestId(value), value.type, "Pi SDK host session is not available"));
      return;
    }

    await this.enqueueCommand(value);
  }

  private enqueueCommand(value: JsonObject): Promise<void> {
    const handling = this.commandTail.then(() => this.dispatchCommand(value));
    this.commandTail = handling.catch((error) => {
      this.diagnostic(`Pi SDK host command failed: ${errorMessage(error)}`);
    });
    return handling;
  }

  private async dispatchCommand(value: JsonObject): Promise<void> {
    const session = this.session;
    if (!session || this.closed || this.closeRequested) return;
    const id = requestId(value);
    const command = value.type as string;
    try {
      switch (command) {
        case "get_state":
          this.write(success(id, command, session.getState()));
          return;
        case "get_messages":
          this.write(success(id, command, { messages: session.getMessages() }));
          return;
        case "prompt": {
          if (typeof value.message !== "string") throw new Error("prompt.message must be a string");
          const behavior = streamingBehavior(value.streamingBehavior);
          let responded = false;
          session.prompt(
            value.message,
            behavior,
            () => {
              if (responded) return;
              responded = true;
              this.write(success(id, "prompt"));
            },
            (error) => {
              if (responded) return;
              responded = true;
              this.write(failure(id, "prompt", errorMessage(error)));
            },
          );
          return;
        }
        case "abort":
          await session.abort();
          this.write(success(id, command));
          return;
        case "set_model": {
          if (typeof value.provider !== "string" || typeof value.modelId !== "string") {
            throw new Error("set_model requires provider and modelId strings");
          }
          const model = await session.setModel(value.provider, value.modelId);
          this.write(success(id, command, model));
          return;
        }
        case "set_thinking_level":
          if (typeof value.level !== "string") throw new Error("set_thinking_level.level must be a string");
          session.setThinkingLevel(value.level);
          this.write(success(id, command));
          return;
        case "get_available_models": {
          const models = await session.getAvailableModels();
          this.write(success(id, command, { models }));
          return;
        }
        case "compact": {
          if (value.customInstructions !== undefined && typeof value.customInstructions !== "string") {
            throw new Error("compact.customInstructions must be a string");
          }
          const result = await session.compact(value.customInstructions);
          this.write(success(id, command, result));
          return;
        }
        default:
          this.write(failure(id, command, `Unknown command: ${command}`));
      }
    } catch (error) {
      this.write(failure(id, command, errorMessage(error)));
    }
  }

  shutdown(): Promise<void> {
    this.shutdownPromise ??= this.shutdownOnce();
    return this.shutdownPromise;
  }

  async drainAndShutdown(): Promise<void> {
    try {
      const opening = this.openingPromise;
      if (opening) await opening;
      await this.commandTail;
    } finally {
      await this.shutdown();
    }
  }

  private async shutdownOnce(): Promise<void> {
    this.closeRequested = true;
    this.queuedCommands.splice(0);
    this.ui.cancelAll();
    try {
      const session = this.session ?? await this.openingPromise?.catch(() => undefined);
      if (session) await this.shutdownSession(session);
    } catch (error) {
      this.diagnostic(errorMessage(error));
    } finally {
      this.closed = true;
      this.session = undefined;
    }
  }

  private shutdownSession(session: AgentSdkSession): Promise<void> {
    this.sessionShutdownPromise ??= session.shutdown();
    return this.sessionShutdownPromise;
  }

  private write(value: unknown): void {
    if (!this.closed) this.output(value);
  }
}

/** Run one SDK-backed session until stdin ends or a termination signal arrives. */
export async function runAgentHost(options: RunAgentHostOptions): Promise<number> {
  let launchOptions: AgentHostLaunchOptions;
  try {
    launchOptions = parseAgentHostArgs(options.argv, options.processCwd);
  } catch (error) {
    options.diagnostic(errorMessage(error));
    return 2;
  }

  const runtime = new AgentHostRuntime(
    options.adapter ?? createPiSdkAdapter(),
    options.output,
    options.diagnostic,
  );
  return new Promise<number>((resolve) => {
    let finishing = false;
    const detach = attachStrictJsonlReader(options.input, (line) => {
      void runtime.handleLine(line);
    });
    const finish = (code: number, drain = false): void => {
      if (finishing) return;
      finishing = true;
      detach();
      options.input.off("end", onEnd);
      options.input.off("error", onError);
      options.shutdownSignal?.removeEventListener("abort", onAbort);
      const closing = drain ? runtime.drainAndShutdown() : runtime.shutdown();
      void closing.then(
        () => resolve(code),
        (error) => {
          options.diagnostic(`Failed to finish Pi SDK host: ${errorMessage(error)}`);
          resolve(1);
        },
      );
    };
    const onEnd = (): void => finish(0, true);
    const onError = (error: Error): void => {
      options.diagnostic(`Pi SDK host input failed: ${error.message}`);
      finish(1);
    };
    const onAbort = (): void => finish(0);

    options.input.once("end", onEnd);
    options.input.once("error", onError);
    options.shutdownSignal?.addEventListener("abort", onAbort, { once: true });

    if (options.shutdownSignal?.aborted) {
      finish(0);
      return;
    }

    const opening = runtime.open(launchOptions);
    void opening.catch((error) => {
      if (finishing) return;
      options.diagnostic(`Failed to initialize Pi SDK: ${errorMessage(error)}`);
      finish(1);
    });
    if (options.input.readableEnded) finish(0, true);
  });
}

function success(
  id: string | undefined,
  command: string,
  data?: unknown,
): JsonObject {
  const response: JsonObject = { id, type: "response", command, success: true };
  if (data !== undefined) response.data = data;
  return response;
}

function failure(
  id: string | undefined,
  command: string,
  error: string,
): JsonObject {
  return { id, type: "response", command, success: false, error };
}

function requestId(value: JsonObject): string | undefined {
  return typeof value.id === "string" ? value.id : undefined;
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
  return { type: "extension_error", extensionPath: "unknown", event: "unknown", error: errorMessage(error) };
}
