import path from "node:path";
const VALUE_OPTIONS = new Set([
    "--cwd",
    "--session",
    "--session-id",
    "--name",
    "--provider",
    "--model",
    "--thinking",
    "--extension",
    "--mode",
]);
/** Parse the Pi-compatible arguments produced by Starling's Rust launcher. */
export function parseAgentHostArgs(argv, processCwd = process.cwd()) {
    const values = new Map();
    let noExtensions = false;
    let starlingManaged = false;
    for (let index = 0; index < argv.length; index += 1) {
        const raw = argv[index];
        if (raw === "--no-extensions") {
            noExtensions = true;
            continue;
        }
        if (raw === "--starling-managed") {
            starlingManaged = true;
            continue;
        }
        const equals = raw.indexOf("=");
        const option = equals < 0 ? raw : raw.slice(0, equals);
        if (!VALUE_OPTIONS.has(option)) {
            throw new Error(`Unknown Pi SDK host option: ${raw}`);
        }
        const value = equals < 0 ? argv[++index] : raw.slice(equals + 1);
        if (value === undefined || value.length === 0) {
            throw new Error(`${option} requires a value`);
        }
        const existing = values.get(option) ?? [];
        existing.push(value);
        values.set(option, existing);
    }
    const last = (option) => values.get(option)?.at(-1);
    const mode = last("--mode");
    if (mode !== undefined && mode !== "rpc") {
        throw new Error(`Pi SDK host only supports --mode rpc, received: ${mode}`);
    }
    const cwd = path.resolve(processCwd, last("--cwd") ?? ".");
    const sessionPathValue = last("--session");
    const sessionPath = sessionPathValue === undefined
        ? undefined
        : path.normalize(sessionPathValue);
    if (sessionPath !== undefined && !path.isAbsolute(sessionPath)) {
        throw new Error("--session must be an absolute Pi transcript path");
    }
    const sessionId = clean(last("--session-id"));
    if (sessionPath !== undefined && sessionId !== undefined) {
        throw new Error("--session and --session-id cannot be used together");
    }
    return {
        cwd,
        sessionPath,
        sessionId,
        name: clean(last("--name")),
        provider: clean(last("--provider")),
        model: clean(last("--model")),
        thinking: clean(last("--thinking")),
        extensions: (values.get("--extension") ?? []).map((extension) => path.resolve(cwd, extension)),
        noExtensions,
        ...(starlingManaged ? { starlingManaged: true } : {}),
    };
}
function clean(value) {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
}
export function isJsonObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
