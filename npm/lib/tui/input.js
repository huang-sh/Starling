/** Parse terminal input without depending on readline or a third-party TUI. */
export function parseStarlingKeys(input) {
    const keys = [];
    for (let index = 0; index < input.length;) {
        const rest = input.slice(index);
        const sequence = terminalSequence(rest);
        if (sequence) {
            keys.push(sequence.key);
            index += sequence.length;
            continue;
        }
        const codePoint = input.codePointAt(index);
        if (codePoint === undefined)
            break;
        const value = String.fromCodePoint(codePoint);
        index += value.length;
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
                if (codePoint >= 0x20 && codePoint !== 0x7f)
                    keys.push({ type: "text", value });
        }
    }
    return keys;
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
