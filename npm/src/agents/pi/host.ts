import type { Readable } from "node:stream";
import { createChatSession } from "../../chat/session.js";
import type { ChatSession } from "../../chat/types.js";
import { attachStrictJsonlReader } from "./jsonl.js";
import { createPiSdkAdapter } from "./sdk-adapter.js";
import {
  AgentHostLaunchOptions,
  AgentSdkAdapter,
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
  private readonly onShutdownRequested: () => void;
  private chat: ChatSession | undefined;
  private shutdownPromise: Promise<void> | undefined;
  private openStarted = false;
  private closeRequested = false;
  private closed = false;

  constructor(
    adapter: AgentSdkAdapter,
    output: (value: unknown) => void,
    diagnostic: (message: string) => void,
    onShutdownRequested: () => void = () => {},
  ) {
    this.adapter = adapter;
    this.output = output;
    this.diagnostic = diagnostic;
    this.onShutdownRequested = onShutdownRequested;
  }

  async open(options: AgentHostLaunchOptions): Promise<void> {
    if (this.openStarted) throw new Error("Pi SDK host session is already open or opening");
    if (this.closeRequested) return;
    this.openStarted = true;
    const chat = createChatSession({
      launch: options,
      adapter: this.adapter,
      onRecord: (value) => this.write(value),
      diagnostic: this.diagnostic,
      onShutdownRequested: this.onShutdownRequested,
    });
    this.chat = chat;

    // The first request is the readiness barrier. It also propagates adapter
    // startup failures while startup UI responses continue to bypass it.
    await chat.request({ type: "get_state" });
  }

  async handleLine(line: string): Promise<void> {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      this.write(failure(undefined, "parse", `Failed to parse command: ${errorMessage(error)}`));
      return;
    }

    if (!isJsonObject(value) || typeof value.type !== "string") {
      this.write(failure(undefined, "unknown", "Command must be a JSON object with a string type"));
      return;
    }
    const chat = this.chat;
    if (!chat || this.closed || this.closeRequested) {
      this.write(failure(requestId(value), value.type, "Pi SDK host session is not available"));
      return;
    }
    const id = requestId(value);
    const command = value.type;
    try {
      const data = await chat.request(value as JsonObject & { type: string });
      // UI responses are acknowledgements to an SDK-owned request and never
      // create protocol response records of their own.
      if (command !== "extension_ui_response") this.write(success(id, command, data));
    } catch (error) {
      this.write(failure(id, command, errorMessage(error)));
    }
  }

  shutdown(): Promise<void> {
    return this.requestShutdown(false);
  }

  drainAndShutdown(): Promise<void> {
    return this.requestShutdown(true);
  }

  private requestShutdown(drain: boolean): Promise<void> {
    if (!this.shutdownPromise) {
      this.shutdownPromise = this.shutdownOnce(drain);
    } else if (!drain && this.chat) {
      // Upgrade an EOF drain when a termination signal arrives later.
      void this.chat.close().catch(() => {});
    }
    return this.shutdownPromise;
  }

  private async shutdownOnce(drain: boolean): Promise<void> {
    this.closeRequested = true;
    try {
      await this.chat?.close({ drain });
    } finally {
      this.closed = true;
      this.chat = undefined;
    }
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

  return new Promise<number>((resolve) => {
    let finishing = false;
    let draining = false;
    let primaryFailure: unknown;
    let finish: (code: number, drain?: boolean, failure?: unknown) => void = () => {};
    const runtime = new AgentHostRuntime(
      options.adapter ?? createPiSdkAdapter(),
      options.output,
      options.diagnostic,
      () => finish(0),
    );
    // createChatSession() installs the in-process request port synchronously;
    // its SDK adapter starts on a microtask. Do this before putting stdin into
    // flowing mode so already-buffered commands enter ChatSession's queue.
    const opening = runtime.open(launchOptions);
    const detach = attachStrictJsonlReader(options.input, (line) => {
      void runtime.handleLine(line);
    }, (error) => options.diagnostic(error.message));
    finish = (code: number, drain = false, failure?: unknown): void => {
      if (finishing) {
        if (!drain && draining) {
          draining = false;
          void runtime.shutdown();
        }
        return;
      }
      finishing = true;
      draining = drain;
      primaryFailure = failure;
      detach();
      options.input.off("end", onEnd);
      options.input.off("error", onError);
      const closing = drain ? runtime.drainAndShutdown() : runtime.shutdown();
      void closing.then(
        () => {
          options.shutdownSignal?.removeEventListener("abort", onAbort);
          resolve(code);
        },
        (error) => {
          options.shutdownSignal?.removeEventListener("abort", onAbort);
          // SDK initialization can reject both open() and the close path with
          // the same Error object. Suppress only that duplicate; a distinct
          // teardown failure must remain visible even after another error.
          if (error !== primaryFailure) {
            options.diagnostic(`Failed to finish Pi SDK host: ${errorMessage(error)}`);
          }
          resolve(1);
        },
      );
    };
    const onEnd = (): void => finish(0, true);
    const onError = (error: Error): void => {
      options.diagnostic(`Pi SDK host input failed: ${error.message}`);
      finish(1, false, error);
    };
    const onAbort = (): void => finish(0);

    options.input.once("end", onEnd);
    options.input.once("error", onError);
    options.shutdownSignal?.addEventListener("abort", onAbort, { once: true });

    if (options.shutdownSignal?.aborted) {
      finish(0);
      return;
    }

    void opening.catch((error) => {
      if (finishing) return;
      options.diagnostic(`Failed to initialize Pi SDK: ${errorMessage(error)}`);
      finish(1, false, error);
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
