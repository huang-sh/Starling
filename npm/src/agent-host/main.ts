#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { runAgentHost } from "./host.js";
import { serializeJsonLine } from "./jsonl.js";

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const rawStdoutWrite = process.stdout.write.bind(process.stdout);
  redirectUnexpectedStdout();

  const shutdown = new AbortController();
  const handlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of supportedSignals()) {
    const handler = (): void => shutdown.abort();
    handlers.set(signal, handler);
    process.once(signal, handler);
  }

  try {
    return await runAgentHost({
      argv,
      input: process.stdin,
      output: (value) => {
        rawStdoutWrite(serializeJsonLine(value));
      },
      diagnostic: (message) => process.stderr.write(`${message}\n`),
      shutdownSignal: shutdown.signal,
    });
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  }
}

function supportedSignals(): NodeJS.Signals[] {
  return process.platform === "win32"
    ? ["SIGINT", "SIGTERM"]
    : ["SIGINT", "SIGTERM", "SIGHUP"];
}

/** Keep SDK/extension logging away from the machine-readable stdout stream. */
function redirectUnexpectedStdout(): void {
  process.stdout.write = ((chunk: unknown, ...args: unknown[]): boolean => {
    const callback = args.find((argument): argument is () => void => typeof argument === "function");
    const text = Buffer.isBuffer(chunk) || chunk instanceof Uint8Array
      ? Buffer.from(chunk).toString("utf8")
      : String(chunk);
    const written = process.stderr.write(text);
    callback?.();
    return written;
  }) as typeof process.stdout.write;
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (entry === import.meta.url) {
  void main().then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    },
  );
}
