import { StringDecoder } from "node:string_decoder";
import type { Readable } from "node:stream";

export const MAX_JSONL_LINE_BYTES = 1024 * 1024;

/** Incremental LF-only decoder that discards over-limit lines and then recovers. */
export class StrictJsonlDecoder {
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";
  private bufferedBytes = 0;
  private dropping = false;

  constructor(private readonly onError: (error: Error) => void = () => {}) {}

  push(chunk: string | Buffer): string[] {
    return this.consume(typeof chunk === "string" ? chunk : this.decoder.write(chunk));
  }

  end(): string[] {
    const lines = this.consume(this.decoder.end());
    if (!this.dropping && this.buffer) lines.push(stripCarriageReturn(this.buffer));
    this.resetLine();
    return lines;
  }

  private consume(text: string): string[] {
    const lines: string[] = [];
    let start = 0;
    while (true) {
      const newline = text.indexOf("\n", start);
      const end = newline < 0 ? text.length : newline;
      this.append(text.slice(start, end));
      if (newline < 0) return lines;
      if (!this.dropping) lines.push(stripCarriageReturn(this.buffer));
      this.resetLine();
      start = newline + 1;
    }
  }

  private append(value: string): void {
    if (this.dropping || !value) return;
    const bytes = Buffer.byteLength(value, "utf8");
    if (this.bufferedBytes + bytes <= MAX_JSONL_LINE_BYTES) {
      this.buffer += value;
      this.bufferedBytes += bytes;
      return;
    }
    this.buffer = "";
    this.bufferedBytes = 0;
    this.dropping = true;
    this.onError(new Error(`JSONL line exceeds ${MAX_JSONL_LINE_BYTES} bytes`));
  }

  private resetLine(): void {
    this.buffer = "";
    this.bufferedBytes = 0;
    this.dropping = false;
  }
}

/**
 * Attach an LF-only JSONL reader. Unicode line/paragraph separators remain
 * ordinary JSON string contents and UTF-8 chunks may split at any byte.
 */
export function attachStrictJsonlReader(
  input: Readable,
  onLine: (line: string) => void,
  onError: (error: Error) => void = () => {},
): () => void {
  const decoder = new StrictJsonlDecoder(onError);
  const onData = (chunk: string | Buffer): void => {
    for (const line of decoder.push(chunk)) onLine(line);
  };
  const onEnd = (): void => {
    for (const line of decoder.end()) onLine(line);
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

function stripCarriageReturn(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}
