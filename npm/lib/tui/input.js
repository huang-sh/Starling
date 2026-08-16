const BRACKETED_PASTE_START = "\u001b[200~";
const BRACKETED_PASTE_END = "\u001b[201~";
const MAX_BRACKETED_PASTE_LENGTH = 1024 * 1024;
/**
 * Stateful terminal-input decoder. Escape sequences and UTF-8 text can arrive
 * in arbitrary stream chunks, while bracketed paste must be delivered as one
 * editor operation so embedded newlines are never mistaken for submit keys.
 */
export class StarlingInputDecoder {
    buffer = "";
    paste = "";
    inPaste = false;
    push(input) {
        this.buffer += input;
        return this.decode(false);
    }
    /** True while an ambiguous ESC-prefixed sequence is awaiting more bytes. */
    get hasPendingEscape() {
        return !this.inPaste && this.buffer.startsWith("\u001b");
    }
    /** Resolve a lone Esc key and discard incomplete control sequences safely. */
    flushPendingEscape() {
        return this.inPaste ? [] : this.decode(true);
    }
    end() {
        const keys = this.decode(true);
        if (this.inPaste) {
            this.appendPaste(this.buffer);
            this.buffer = "";
            this.inPaste = false;
            if (this.paste)
                keys.push({ type: "paste", value: normalizePaste(this.paste) });
            this.paste = "";
        }
        return keys;
    }
    decode(flush) {
        const keys = [];
        // On stream end an unterminated bracketed paste may already have been
        // moved entirely into `paste`, leaving `buffer` empty. Still flush it as
        // one paste operation instead of silently dropping the user's text.
        while (this.buffer.length > 0 || (flush && this.inPaste)) {
            if (this.inPaste) {
                const end = this.buffer.indexOf(BRACKETED_PASTE_END);
                if (end < 0) {
                    if (!flush) {
                        const retained = terminalSequenceSuffix(this.buffer, BRACKETED_PASTE_END);
                        this.appendPaste(this.buffer.slice(0, this.buffer.length - retained));
                        this.buffer = this.buffer.slice(this.buffer.length - retained);
                        break;
                    }
                    this.appendPaste(this.buffer);
                    this.buffer = "";
                    this.inPaste = false;
                    if (this.paste)
                        keys.push({ type: "paste", value: normalizePaste(this.paste) });
                    this.paste = "";
                    break;
                }
                this.appendPaste(this.buffer.slice(0, end));
                this.buffer = this.buffer.slice(end + BRACKETED_PASTE_END.length);
                this.inPaste = false;
                keys.push({ type: "paste", value: normalizePaste(this.paste) });
                this.paste = "";
                continue;
            }
            if (this.buffer.startsWith(BRACKETED_PASTE_START)) {
                this.buffer = this.buffer.slice(BRACKETED_PASTE_START.length);
                this.inPaste = true;
                continue;
            }
            const sequence = terminalSequence(this.buffer);
            if (sequence) {
                keys.push(sequence.key);
                this.buffer = this.buffer.slice(sequence.length);
                continue;
            }
            if (this.buffer.startsWith("\u001b")) {
                const unknownLength = unknownEscapeSequenceLength(this.buffer, flush);
                if (unknownLength === null)
                    break;
                if (unknownLength > 0) {
                    this.buffer = this.buffer.slice(unknownLength);
                    continue;
                }
            }
            const codePoint = this.buffer.codePointAt(0);
            if (codePoint === undefined)
                break;
            const value = String.fromCodePoint(codePoint);
            this.buffer = this.buffer.slice(value.length);
            appendCodePoint(keys, codePoint, value);
        }
        return keys;
    }
    appendPaste(value) {
        const remaining = MAX_BRACKETED_PASTE_LENGTH - this.paste.length;
        if (remaining > 0)
            this.paste += value.slice(0, remaining);
    }
}
/** Parse terminal input without depending on readline or a third-party TUI. */
export function parseStarlingKeys(input) {
    const decoder = new StarlingInputDecoder();
    return [...decoder.push(input), ...decoder.end()];
}
function appendCodePoint(keys, codePoint, value) {
    switch (codePoint) {
        case 0x03:
            keys.push({ type: "ctrl-c" });
            break;
        case 0x04:
            keys.push({ type: "ctrl-d" });
            break;
        case 0x13:
            keys.push({ type: "ctrl-s" });
            break;
        case 0x15:
            keys.push({ type: "ctrl-u" });
            break;
        case 0x08:
        case 0x7f:
            keys.push({ type: "backspace" });
            break;
        case 0x09:
            keys.push({ type: "tab" });
            break;
        case 0x0a:
        case 0x0d:
            keys.push({ type: "enter" });
            break;
        case 0x1b:
            keys.push({ type: "escape" });
            break;
        default:
            if (codePoint >= 0x20 && !(codePoint >= 0x7f && codePoint <= 0x9f)) {
                keys.push({ type: "text", value });
            }
    }
}
function normalizePaste(value) {
    return value
        .replace(/\r\n?/g, "\n")
        .replace(/\t/g, "  ")
        .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, "")
        .normalize("NFC");
}
function terminalSequenceSuffix(value, sequence) {
    const maximum = Math.min(value.length, sequence.length - 1);
    for (let length = maximum; length > 0; length -= 1) {
        if (sequence.startsWith(value.slice(-length)))
            return length;
    }
    return 0;
}
function terminalSequence(value) {
    const sequences = [
        ["\u001b[5~", { type: "page-up" }],
        ["\u001b[6~", { type: "page-down" }],
        ["\u001b[A", { type: "up" }],
        ["\u001b[B", { type: "down" }],
        ["\u001b[C", { type: "right" }],
        ["\u001b[D", { type: "left" }],
        ["\u001b\r", { type: "alt-enter" }],
        ["\u001b\n", { type: "alt-enter" }],
    ];
    for (const [sequence, key] of sequences) {
        if (value.startsWith(sequence))
            return { key, length: sequence.length };
    }
    return null;
}
/**
 * Return the byte length of an unsupported complete terminal sequence, zero
 * for a lone Esc key, or null while a sequence may still receive more bytes.
 */
function unknownEscapeSequenceLength(value, flush) {
    if (value === "\u001b")
        return flush ? 0 : null;
    const introducer = value[1];
    if (introducer === "[") {
        for (let index = 2; index < value.length; index += 1) {
            const code = value.charCodeAt(index);
            if (code >= 0x40 && code <= 0x7e)
                return index + 1;
        }
        return flush ? value.length : null;
    }
    if (introducer === "O")
        return value.length >= 3 ? 3 : flush ? value.length : null;
    if (introducer === "]") {
        const bell = value.indexOf("\u0007", 2);
        const stringTerminator = value.indexOf("\u001b\\", 2);
        const end = minimumPositive(bell < 0 ? -1 : bell + 1, stringTerminator < 0 ? -1 : stringTerminator + 2);
        return end >= 0 ? end : flush ? value.length : null;
    }
    if (introducer === "P" || introducer === "^" || introducer === "_") {
        const stringTerminator = value.indexOf("\u001b\\", 2);
        return stringTerminator >= 0 ? stringTerminator + 2 : flush ? value.length : null;
    }
    return 2;
}
function minimumPositive(left, right) {
    if (left < 0)
        return right;
    if (right < 0)
        return left;
    return Math.min(left, right);
}
