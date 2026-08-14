import type { ChildProcessWithoutNullStreams } from "node:child_process";
import {
  MAX_JSONL_LINE_BYTES,
  StrictJsonlDecoder,
} from "../agent-host/jsonl.js";
import { isRecord } from "./state.js";

export { MAX_JSONL_LINE_BYTES, StrictJsonlDecoder };

interface PendingRequest {
  command: string;
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
}

export interface StarlingRpcClientOptions {
  /** Timeout for bounded read-only requests. Mutating requests default to no timeout. */
  requestTimeoutMs?: number;
  onRecord: (value: Record<string, unknown>) => void;
  onProtocolError: (error: Error) => void;
}

export interface StarlingRpcRequestOptions {
  /** `null` disables the timeout. Omit to use the command-aware policy. */
  timeoutMs?: number | null;
}

const BOUNDED_QUERY_COMMANDS = new Set([
  "get_state",
  "get_messages",
  "get_available_models",
  "get_session_stats",
  "get_commands",
]);

/**
 * Mutating commands may have been accepted even if their reply is delayed.
 * Timing those commands out invites a caller to retry and duplicate work, so
 * only known read-only queries receive the default deadline.
 */
export function rpcTimeoutForCommand(command: string, boundedTimeoutMs: number): number | undefined {
  return BOUNDED_QUERY_COMMANDS.has(command) ? boundedTimeoutMs : undefined;
}

/** Owns request correlation and record framing for one `starling chat` child. */
export class StarlingRpcClient {
  private readonly decoder: StrictJsonlDecoder;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly timeoutMs: number;
  private sequence = 0;
  private closed = false;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly options: StarlingRpcClientOptions,
  ) {
    this.timeoutMs = options.requestTimeoutMs ?? 15_000;
    this.decoder = new StrictJsonlDecoder(options.onProtocolError);
    child.stdout.on("data", (chunk: string | Buffer) => {
      for (const line of this.decoder.push(chunk)) this.handleLine(line);
    });
    child.stdout.on("end", () => {
      for (const line of this.decoder.end()) this.handleLine(line);
    });
    child.once("close", (code, signal) => {
      this.close(new Error(`Starling agent host exited (${code ?? signal ?? "unknown"}).`));
    });
    child.once("error", (error) => this.close(error));
  }

  request(
    command: string,
    body: Record<string, unknown> = {},
    requestOptions: StarlingRpcRequestOptions = {},
  ): Promise<Record<string, unknown>> {
    if (this.closed || !this.child.stdin.writable) {
      return Promise.reject(new Error("Starling agent host is not running."));
    }
    const id = `starling-tui-${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const timeoutMs = requestOptions.timeoutMs === null
        ? undefined
        : requestOptions.timeoutMs ?? rpcTimeoutForCommand(command, this.timeoutMs);
      const timer = timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`${command} timed out after ${timeoutMs}ms.`));
        }, timeoutMs);
      this.pending.set(id, { command, resolve, reject, timer });
      try {
        this.write({ ...body, id, type: command });
      } catch (error) {
        if (timer) clearTimeout(timer);
        this.pending.delete(id);
        reject(asError(error));
      }
    });
  }

  send(value: Record<string, unknown>): void {
    if (!this.closed && this.child.stdin.writable) this.write(value);
  }

  endInput(): void {
    if (!this.closed && this.child.stdin.writable) this.child.stdin.end();
  }

  close(error = new Error("Starling agent host closed.")): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private write(value: Record<string, unknown>): void {
    this.child.stdin.write(`${JSON.stringify(value)}\n`, "utf8");
  }

  private handleLine(line: string): void {
    if (!line) return;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      this.options.onProtocolError(new Error(`Invalid Starling agent JSON: ${line.slice(0, 200)}`));
      return;
    }
    if (!isRecord(raw)) {
      this.options.onProtocolError(new Error("Starling agent emitted a non-object JSON record."));
      return;
    }

    if (raw.type === "response" && typeof raw.id === "string") {
      const pending = this.pending.get(raw.id);
      if (pending) {
        this.pending.delete(raw.id);
        if (pending.timer) clearTimeout(pending.timer);
        if (raw.success === false) {
          pending.reject(new Error(String(raw.error ?? `${pending.command} failed`)));
        } else if (typeof raw.command === "string" && raw.command !== pending.command) {
          pending.reject(new Error(`Expected ${pending.command} response, received ${raw.command}.`));
        } else {
          pending.resolve(raw);
        }
        return;
      }
    }
    this.options.onRecord(raw);
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
