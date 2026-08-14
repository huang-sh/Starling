import { StringDecoder } from "node:string_decoder";
export const MAX_JSONL_LINE_BYTES = 1024 * 1024;
/** Incremental LF-only decoder that discards over-limit lines and then recovers. */
export class StrictJsonlDecoder {
    onError;
    decoder = new StringDecoder("utf8");
    buffer = "";
    bufferedBytes = 0;
    dropping = false;
    constructor(onError = () => { }) {
        this.onError = onError;
    }
    push(chunk) {
        return this.consume(typeof chunk === "string" ? chunk : this.decoder.write(chunk));
    }
    end() {
        const lines = this.consume(this.decoder.end());
        if (!this.dropping && this.buffer)
            lines.push(stripCarriageReturn(this.buffer));
        this.resetLine();
        return lines;
    }
    consume(text) {
        const lines = [];
        let start = 0;
        while (true) {
            const newline = text.indexOf("\n", start);
            const end = newline < 0 ? text.length : newline;
            this.append(text.slice(start, end));
            if (newline < 0)
                return lines;
            if (!this.dropping)
                lines.push(stripCarriageReturn(this.buffer));
            this.resetLine();
            start = newline + 1;
        }
    }
    append(value) {
        if (this.dropping || !value)
            return;
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
    resetLine() {
        this.buffer = "";
        this.bufferedBytes = 0;
        this.dropping = false;
    }
}
/**
 * Attach an LF-only JSONL reader. Unicode line/paragraph separators remain
 * ordinary JSON string contents and UTF-8 chunks may split at any byte.
 */
export function attachStrictJsonlReader(input, onLine, onError = () => { }) {
    const decoder = new StrictJsonlDecoder(onError);
    const onData = (chunk) => {
        for (const line of decoder.push(chunk))
            onLine(line);
    };
    const onEnd = () => {
        for (const line of decoder.end())
            onLine(line);
    };
    input.on("data", onData);
    input.on("end", onEnd);
    return () => {
        input.off("data", onData);
        input.off("end", onEnd);
    };
}
export function serializeJsonLine(value) {
    return `${JSON.stringify(value)}\n`;
}
function stripCarriageReturn(line) {
    return line.endsWith("\r") ? line.slice(0, -1) : line;
}
