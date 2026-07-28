import { StringDecoder } from "node:string_decoder";
import type { Readable } from "node:stream";

/**
 * Attach an LF-only JSONL reader. Unicode line/paragraph separators remain
 * ordinary JSON string contents and UTF-8 chunks may split at any byte.
 */
export function attachStrictJsonlReader(
  input: Readable,
  onLine: (line: string) => void,
): () => void {
  const decoder = new StringDecoder("utf8");
  let buffered = "";

  const emit = (line: string): void => {
    onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
  };
  const onData = (chunk: string | Buffer): void => {
    buffered += typeof chunk === "string" ? chunk : decoder.write(chunk);
    while (true) {
      const newline = buffered.indexOf("\n");
      if (newline < 0) return;
      emit(buffered.slice(0, newline));
      buffered = buffered.slice(newline + 1);
    }
  };
  const onEnd = (): void => {
    buffered += decoder.end();
    if (buffered.length > 0) emit(buffered);
    buffered = "";
  };

  input.on("data", onData);
  input.on("end", onEnd);
  return () => {
    input.off("data", onData);
    input.off("end", onEnd);
  };
}

export function serializeJsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}
