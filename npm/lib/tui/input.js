const ESC = "\u001b";
const BRACKETED_PASTE_START = `${ESC}[200~`;
const BRACKETED_PASTE_END = `${ESC}[201~`;
const MAX_BRACKETED_PASTE_LENGTH = 1024 * 1024;
const ALT_MODIFIER = 2;
const CTRL_MODIFIER = 4;
const LOCK_MODIFIERS = 64 | 128;
const TERMINAL_SEQUENCES = [
    [`${ESC}[[5~`, { type: "page-up" }],
    [`${ESC}[[6~`, { type: "page-down" }],
    [`${ESC}[5~`, { type: "page-up" }],
    [`${ESC}[6~`, { type: "page-down" }],
    [`${ESC}[3~`, { type: "delete" }],
    [`${ESC}[1~`, { type: "home" }],
    [`${ESC}[4~`, { type: "end" }],
    [`${ESC}[7~`, { type: "home" }],
    [`${ESC}[8~`, { type: "end" }],
    [`${ESC}[H`, { type: "home" }],
    [`${ESC}[F`, { type: "end" }],
    [`${ESC}OH`, { type: "home" }],
    [`${ESC}OF`, { type: "end" }],
    [`${ESC}[A`, { type: "up" }],
    [`${ESC}[B`, { type: "down" }],
    [`${ESC}[C`, { type: "right" }],
    [`${ESC}[D`, { type: "left" }],
    [`${ESC}OA`, { type: "up" }],
    [`${ESC}OB`, { type: "down" }],
    [`${ESC}OC`, { type: "right" }],
    [`${ESC}OD`, { type: "left" }],
    [`${ESC}\r`, { type: "alt-enter" }],
    [`${ESC}\n`, { type: "alt-enter" }],
];
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
        return !this.inPaste && this.buffer.startsWith(ESC);
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
                if (sequence.key)
                    keys.push(sequence.key);
                this.buffer = this.buffer.slice(sequence.length);
                continue;
            }
            if (this.buffer.startsWith(ESC)) {
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
    const key = keyFromCodePoint(codePoint, 0);
    if (key)
        keys.push(key);
    else if (codePoint >= 0x20 && !(codePoint >= 0x7f && codePoint <= 0x9f)) {
        keys.push({ type: "text", value });
    }
}
function keyFromCodePoint(codePoint, modifiers) {
    const lower = codePoint >= 0x41 && codePoint <= 0x5a ? codePoint + 0x20 : codePoint;
    if ((modifiers & CTRL_MODIFIER) !== 0) {
        if (lower === 0x63)
            return { type: "ctrl-c" };
        if (lower === 0x64)
            return { type: "ctrl-d" };
        if (lower === 0x73)
            return { type: "ctrl-s" };
        if (lower === 0x75)
            return { type: "ctrl-u" };
    }
    switch (codePoint) {
        case 0x03:
            return { type: "ctrl-c" };
        case 0x04:
            return { type: "ctrl-d" };
        case 0x13:
            return { type: "ctrl-s" };
        case 0x15:
            return { type: "ctrl-u" };
        case 0x08:
        case 0x7f:
            return { type: "backspace" };
        case 0x09:
            return { type: "tab" };
        case 0x0a:
        case 0x0d:
            return (modifiers & ALT_MODIFIER) !== 0 ? { type: "alt-enter" } : { type: "enter" };
        case 0x1b:
            return { type: "escape" };
        default:
            return undefined;
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
    // WezTerm can concatenate a raw Escape press and its Kitty release sequence.
    // Consume the press alone so the second ESC remains a valid sequence prefix.
    if (value.startsWith(`${ESC}${ESC}`)
        && ["[", "]", "O", "P", "_", "^"].includes(value[2] ?? "")) {
        return { key: { type: "escape" }, length: 1 };
    }
    for (const [sequence, key] of TERMINAL_SEQUENCES) {
        if (value.startsWith(sequence))
            return { key, length: sequence.length };
    }
    const length = completeCsiSequenceLength(value);
    if (length === null)
        return null;
    const sequence = value.slice(0, length);
    const key = parseCsiKey(sequence);
    return key === undefined && !isRecognizedCsiSequence(sequence) ? null : { key, length };
}
function completeCsiSequenceLength(value) {
    if (!value.startsWith(`${ESC}[`) || value.length < 3)
        return null;
    for (let index = 2; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        if (code >= 0x40 && code <= 0x7e)
            return index + 1;
    }
    return null;
}
function parseCsiKey(sequence) {
    const kitty = sequence.match(/^\u001b\[(\d+)(?::(\d*))?(?::(\d+))?(?:;(\d+))?(?::([123]))?u$/);
    if (kitty) {
        if (kitty[5] === "3")
            return undefined;
        const codePoint = Number.parseInt(kitty[1] ?? "", 10);
        const baseLayoutKey = kitty[3] ? Number.parseInt(kitty[3], 10) : undefined;
        const modifiers = Number.parseInt(kitty[4] ?? "1", 10) - 1;
        const primary = keyFromKittyCodePoint(codePoint, modifiers);
        if (primary)
            return primary;
        return baseLayoutKey !== undefined && canUseKittyBaseLayout(codePoint)
            ? keyFromKittyCodePoint(baseLayoutKey, modifiers)
            : undefined;
    }
    const modifyOtherKeys = sequence.match(/^\u001b\[27;(\d+);(\d+)~$/);
    if (modifyOtherKeys) {
        return keyFromCodePoint(Number.parseInt(modifyOtherKeys[2] ?? "", 10), Number.parseInt(modifyOtherKeys[1] ?? "1", 10) - 1);
    }
    const navigation = sequence.match(/^\u001b\[(?:1;)?(\d+)?(?::([123]))?([ABCDHF])$/);
    if (navigation) {
        if (navigation[2] === "3")
            return undefined;
        return navigationKey(navigation[3] ?? "");
    }
    const functional = sequence.match(/^\u001b\[(\d+)(?:;(\d+))?(?::([123]))?~$/);
    if (functional) {
        if (functional[3] === "3")
            return undefined;
        switch (Number.parseInt(functional[1] ?? "", 10)) {
            case 1:
            case 7:
                return { type: "home" };
            case 3:
                return { type: "delete" };
            case 4:
            case 8:
                return { type: "end" };
            case 5:
                return { type: "page-up" };
            case 6:
                return { type: "page-down" };
            default:
                return undefined;
        }
    }
    return undefined;
}
function keyFromKittyCodePoint(codePoint, modifiers) {
    const equivalent = kittyFunctionalEquivalent(codePoint);
    if (equivalent === undefined || typeof equivalent !== "number")
        return equivalent;
    const key = keyFromCodePoint(equivalent, modifiers);
    if (key)
        return key;
    const effectiveModifiers = modifiers & ~(1 | LOCK_MODIFIERS);
    if (effectiveModifiers !== 0 || equivalent < 0x20 || equivalent > 0x10ffff)
        return undefined;
    if (equivalent >= 0x7f && equivalent <= 0x9f)
        return undefined;
    return { type: "text", value: String.fromCodePoint(equivalent) };
}
function kittyFunctionalEquivalent(codePoint) {
    if (codePoint >= 57399 && codePoint <= 57408)
        return 0x30 + codePoint - 57399;
    switch (codePoint) {
        case 57409:
            return 0x2e;
        case 57410:
            return 0x2f;
        case 57411:
            return 0x2a;
        case 57412:
            return 0x2d;
        case 57413:
            return 0x2b;
        case 57414:
            return 0x0d;
        case 57415:
            return 0x3d;
        case 57416:
            return 0x2c;
        case 57417:
            return { type: "left" };
        case 57418:
            return { type: "right" };
        case 57419:
            return { type: "up" };
        case 57420:
            return { type: "down" };
        case 57421:
            return { type: "page-up" };
        case 57422:
            return { type: "page-down" };
        case 57423:
            return { type: "home" };
        case 57424:
            return { type: "end" };
        case 57425:
            return undefined;
        case 57426:
            return { type: "delete" };
        default:
            return codePoint >= 57344 && codePoint <= 63743 ? undefined : codePoint;
    }
}
function canUseKittyBaseLayout(codePoint) {
    const equivalent = kittyFunctionalEquivalent(codePoint);
    if (typeof equivalent !== "number")
        return false;
    if (equivalent < 0 || equivalent > 0x10ffff)
        return true;
    const lower = equivalent >= 0x41 && equivalent <= 0x5a ? equivalent + 0x20 : equivalent;
    const latinLetter = lower >= 0x61 && lower <= 0x7a;
    const knownSymbol = "`-=[]\\;',./!@#$%^&*()_+|~{}:<>?".includes(String.fromCodePoint(equivalent));
    return !latinLetter && !knownSymbol;
}
function navigationKey(finalByte) {
    switch (finalByte) {
        case "A":
            return { type: "up" };
        case "B":
            return { type: "down" };
        case "C":
            return { type: "right" };
        case "D":
            return { type: "left" };
        case "H":
            return { type: "home" };
        case "F":
            return { type: "end" };
        default:
            return undefined;
    }
}
function isRecognizedCsiSequence(sequence) {
    return /^\u001b\[(?:\d|[;:])*[~uABCDHF]$/.test(sequence);
}
/**
 * Return the byte length of an unsupported complete terminal sequence, zero
 * for a lone Esc key, or null while a sequence may still receive more bytes.
 */
function unknownEscapeSequenceLength(value, flush) {
    if (value === ESC)
        return flush ? 0 : null;
    if (!flush && TERMINAL_SEQUENCES.some(([sequence]) => sequence.startsWith(value)))
        return null;
    if (!flush && `${ESC}${ESC}`.startsWith(value))
        return null;
    const introducer = value[1];
    if (introducer === ESC)
        return 1;
    if (introducer === "[") {
        const length = completeCsiSequenceLength(value);
        return length ?? (flush ? value.length : null);
    }
    if (introducer === "O")
        return value.length >= 3 ? 3 : flush ? value.length : null;
    if (introducer === "]") {
        const bell = value.indexOf("\u0007", 2);
        const stringTerminator = value.indexOf(`${ESC}\\`, 2);
        const end = minimumPositive(bell < 0 ? -1 : bell + 1, stringTerminator < 0 ? -1 : stringTerminator + 2);
        return end >= 0 ? end : flush ? value.length : null;
    }
    if (introducer === "P" || introducer === "^" || introducer === "_") {
        const stringTerminator = value.indexOf(`${ESC}\\`, 2);
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
