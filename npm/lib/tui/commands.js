export const STARLING_SLASH_COMMANDS = [
    {
        name: "help",
        description: "Show available slash commands and keyboard shortcuts",
        source: "starling",
        allowArgs: false,
    },
    {
        name: "settings",
        description: "Open Pi settings",
        source: "starling",
        allowArgs: false,
    },
    {
        name: "new",
        description: "Start a new Pi session in this workspace",
        source: "starling",
        allowArgs: false,
    },
    {
        name: "resume",
        description: "Resume a saved Pi session",
        source: "starling",
        argumentHint: "[session.jsonl]",
        allowArgs: true,
    },
    {
        name: "fork",
        description: "Fork from an earlier user message",
        source: "starling",
        allowArgs: false,
    },
    {
        name: "clone",
        description: "Clone the current session branch",
        source: "starling",
        allowArgs: false,
    },
    {
        name: "import",
        description: "Import and resume a Pi JSONL session",
        source: "starling",
        argumentHint: "<session.jsonl>",
        allowArgs: true,
    },
    {
        name: "export",
        description: "Export this session to HTML or JSONL",
        source: "starling",
        argumentHint: "[output.html|output.jsonl]",
        allowArgs: true,
    },
    {
        name: "copy",
        description: "Copy the last agent message",
        source: "starling",
        allowArgs: false,
    },
    {
        name: "scoped-models",
        description: "Choose models used by model cycling",
        source: "starling",
        allowArgs: false,
    },
    {
        name: "model",
        description: "List models or switch the active model",
        source: "starling",
        argumentHint: "[provider/model]",
        allowArgs: true,
    },
    {
        name: "tree",
        description: "Navigate the current Pi session tree",
        source: "starling",
        allowArgs: false,
    },
    {
        name: "login",
        description: "Configure provider authentication",
        source: "starling",
        argumentHint: "[provider]",
        allowArgs: true,
    },
    {
        name: "logout",
        description: "Remove stored provider authentication",
        source: "starling",
        argumentHint: "[provider]",
        allowArgs: true,
    },
    {
        name: "thinking",
        description: "Show or set the thinking level",
        source: "starling",
        argumentHint: "[level]",
        allowArgs: true,
    },
    {
        name: "compact",
        description: "Compact the current conversation context",
        source: "starling",
        argumentHint: "[instructions]",
        allowArgs: true,
    },
    {
        name: "name",
        description: "Show or set the current session name",
        source: "starling",
        argumentHint: "[session name]",
        allowArgs: true,
    },
    {
        name: "session",
        description: "Show current session statistics",
        source: "starling",
        allowArgs: false,
    },
    {
        name: "share",
        description: "Share this session as a secret GitHub gist",
        source: "starling",
        allowArgs: false,
    },
    {
        name: "changelog",
        description: "Show the bundled Pi changelog",
        source: "starling",
        allowArgs: false,
    },
    {
        name: "hotkeys",
        description: "Show Starling keyboard shortcuts",
        source: "starling",
        allowArgs: false,
    },
    {
        name: "trust",
        description: "Save the project trust decision for future sessions",
        source: "starling",
        allowArgs: false,
    },
    {
        name: "reload",
        description: "Reload Pi extensions, prompts, skills, and commands",
        source: "starling",
        allowArgs: false,
    },
    {
        name: "quit",
        description: "Close the Starling workspace",
        source: "starling",
        allowArgs: false,
    },
];
const VALID_SOURCES = new Set([
    "starling",
    "extension",
    "prompt",
    "skill",
]);
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
/** Merge Pi-discovered commands behind Starling's actually implemented builtins. */
export function mergeSlashCommands(dynamic) {
    const merged = STARLING_SLASH_COMMANDS.map((command) => ({ ...command }));
    const names = new Set(merged.map((command) => command.name));
    for (const value of dynamic) {
        const command = normalizeDynamicCommand(value);
        if (!command || names.has(command.name))
            continue;
        names.add(command.name);
        merged.push(command);
    }
    return merged;
}
/** Parse the `{ commands }` envelope returned by ChatSession.get_commands. */
export function slashCommandsFromResponse(value) {
    if (!isRecord(value) || !Array.isArray(value.commands))
        return mergeSlashCommands([]);
    return mergeSlashCommands(value.commands);
}
/** The menu is active only while editing the command-name token. */
export function slashQuery(composer) {
    const match = /^\/([^/\s]*)$/.exec(composer);
    return match?.[1] ?? null;
}
export function filterSlashCommands(composer, commands) {
    const rawQuery = slashQuery(composer);
    if (rawQuery === null)
        return [];
    const query = rawQuery.toLocaleLowerCase();
    if (!query)
        return [...commands];
    const prefix = [];
    const contains = [];
    for (const command of commands) {
        const name = command.name.toLocaleLowerCase();
        const description = command.description.toLocaleLowerCase();
        if (name.startsWith(query))
            prefix.push(command);
        else if (name.includes(query) || description.includes(query))
            contains.push(command);
    }
    return [...prefix, ...contains];
}
export function completeSlashCommand(command) {
    return `/${command.name}${command.allowArgs ? " " : ""}`;
}
/** Convert one slash invocation into a local action or transport request. */
export function planSlashCommand(text, catalog, busy) {
    const invocation = parseSlashInvocation(text);
    if (!invocation) {
        return { kind: "error", message: "Slash commands must start with / followed by a command name" };
    }
    const command = catalog.find((candidate) => candidate.name === invocation.name);
    if (!command) {
        return {
            kind: "error",
            message: `Unknown command: /${invocation.name}. Type / to see available commands.`,
        };
    }
    if (!command.allowArgs && invocation.args) {
        return { kind: "error", message: `/${command.name} does not accept arguments` };
    }
    if (command.source !== "starling") {
        const request = { type: "prompt", message: text.trim() };
        if (busy)
            request.streamingBehavior = "followUp";
        return { kind: "dynamic", command, request };
    }
    if (busy && ["settings", "new", "resume", "fork", "clone", "import", "scoped-models", "share", "compact", "tree", "trust", "login", "logout", "reload"].includes(command.name)) {
        return {
            kind: "error",
            message: `/${command.name} is unavailable while Pi is working; interrupt or wait for the turn to finish`,
        };
    }
    switch (command.name) {
        case "help":
            return { kind: "local", command, action: "help" };
        case "settings":
            return { kind: "request", command, request: { type: "configure_settings" } };
        case "new":
            return {
                kind: "request",
                command,
                request: { type: "new_session" },
                successMessage: "New session started",
                refreshTranscript: true,
                refreshCommands: true,
            };
        case "resume":
            return {
                kind: "request",
                command,
                request: {
                    type: "resume_session",
                    ...(invocation.args ? { sessionPath: invocation.args } : {}),
                },
                successMessage: "Session resumed",
                refreshTranscript: true,
                refreshCommands: true,
            };
        case "fork":
            return {
                kind: "request",
                command,
                request: { type: "fork_session" },
                successMessage: "Forked to new session",
                refreshTranscript: true,
                refreshCommands: true,
            };
        case "clone":
            return {
                kind: "request",
                command,
                request: { type: "clone_session" },
                successMessage: "Cloned to new session",
                refreshTranscript: true,
                refreshCommands: true,
            };
        case "import": {
            const inputPath = pathArgument(invocation.args);
            if (!inputPath) {
                return { kind: "error", message: "Usage: /import <path.jsonl>" };
            }
            return {
                kind: "request",
                command,
                request: { type: "import_session", inputPath },
                successMessage: "Session imported",
                refreshTranscript: true,
                refreshCommands: true,
            };
        }
        case "export": {
            const outputPath = pathArgument(invocation.args);
            return {
                kind: "request",
                command,
                request: {
                    type: "export_session",
                    ...(outputPath ? { outputPath } : {}),
                },
                successMessage: "Session exported",
            };
        }
        case "copy":
            return {
                kind: "request",
                command,
                request: { type: "copy_last_message" },
                successMessage: "Copied last agent message to clipboard",
            };
        case "scoped-models":
            return { kind: "request", command, request: { type: "configure_scoped_models" } };
        case "model": {
            if (!invocation.args)
                return { kind: "local", command, action: "models" };
            const separator = invocation.args.indexOf("/");
            if (separator <= 0 || separator === invocation.args.length - 1) {
                return { kind: "error", message: "Usage: /model <provider/model>" };
            }
            return {
                kind: "request",
                command,
                request: {
                    type: "set_model",
                    provider: invocation.args.slice(0, separator),
                    modelId: invocation.args.slice(separator + 1),
                },
                successMessage: `Model changed to ${invocation.args}`,
                refreshMetadata: true,
            };
        }
        case "tree":
            return { kind: "local", command, action: "tree" };
        case "login":
            return {
                kind: "local",
                command,
                action: "login",
                ...(invocation.args ? { argument: invocation.args } : {}),
            };
        case "logout":
            return {
                kind: "local",
                command,
                action: "logout",
                ...(invocation.args ? { argument: invocation.args } : {}),
            };
        case "thinking":
            if (!invocation.args)
                return { kind: "local", command, action: "thinking" };
            if (!THINKING_LEVELS.includes(invocation.args)) {
                return {
                    kind: "error",
                    message: `Invalid thinking level. Choose: ${THINKING_LEVELS.join(", ")}`,
                };
            }
            return {
                kind: "request",
                command,
                request: { type: "set_thinking_level", level: invocation.args },
                successMessage: `Thinking level changed to ${invocation.args}`,
                refreshMetadata: true,
            };
        case "compact":
            return {
                kind: "request",
                command,
                request: {
                    type: "compact",
                    ...(invocation.args ? { customInstructions: invocation.args } : {}),
                },
                successMessage: "Context compaction complete",
            };
        case "name":
            if (!invocation.args)
                return { kind: "local", command, action: "name" };
            return {
                kind: "request",
                command,
                request: { type: "set_session_name", name: invocation.args },
                successMessage: `Session named ${invocation.args}`,
                refreshMetadata: true,
            };
        case "session":
            return {
                kind: "request",
                command,
                request: { type: "get_session_stats" },
            };
        case "share":
            return { kind: "request", command, request: { type: "share_session" } };
        case "changelog":
            return { kind: "request", command, request: { type: "get_changelog" } };
        case "hotkeys":
            return { kind: "local", command, action: "hotkeys" };
        case "trust":
            return { kind: "request", command, request: { type: "configure_project_trust" } };
        case "reload":
            return {
                kind: "request",
                command,
                request: { type: "reload" },
                successMessage: "Pi resources reloaded",
                refreshMetadata: true,
                refreshCommands: true,
            };
        case "quit":
            return { kind: "local", command, action: "quit" };
        default:
            return { kind: "error", message: `Unsupported Starling command: /${command.name}` };
    }
}
export function formatSlashHelp(commands) {
    const width = commands.reduce((maximum, command) => Math.max(maximum, commandDisplayName(command).length), 0);
    const rows = commands.map((command) => {
        const name = commandDisplayName(command).padEnd(width);
        const source = command.source === "starling" ? "" : ` [${command.source}]`;
        return `  ${name}  ${command.description}${source}`;
    });
    return [
        "Available slash commands",
        ...rows,
        "",
        "Keyboard: ↑/↓ select · Tab complete · Enter run · Esc close · Alt+Enter newline",
    ].join("\n");
}
export function formatThinkingLevels(current) {
    return [
        `Thinking level: ${current || "default"}`,
        `Choose with /thinking <level>: ${THINKING_LEVELS.join(", ")}`,
    ].join("\n");
}
export function formatHotkeys() {
    return [
        "Keyboard shortcuts",
        "  Enter              send",
        "  Shift/Alt+Enter    newline",
        "  Esc                interrupt",
        "  Ctrl+C             interrupt, then exit",
        "  Ctrl+D             exit with an empty editor",
        "  Shift+Tab          cycle thinking level",
        "  Ctrl+P/Shift+Ctrl+P cycle models",
        "  Ctrl+L             choose a model",
        "  Ctrl+O             toggle tool output",
        "  Ctrl+T             toggle thinking blocks",
        "  Ctrl+X             copy the last agent message",
        "  Alt+Up             restore queued messages",
        "  Ctrl+Z             suspend to background",
        "  Up/Down            move or recall input history",
        "  PageUp/Down        scroll transcript",
        "  Tab                complete slash commands",
    ].join("\n");
}
export function formatAvailableModels(value, current) {
    const models = isRecord(value) && Array.isArray(value.models) ? value.models : [];
    const names = models.map(modelName).filter((name) => Boolean(name));
    const unique = [...new Set(names)];
    const visible = unique.slice(0, 80);
    const suffix = unique.length > visible.length
        ? [`  … ${unique.length - visible.length} more models`]
        : [];
    return [
        `Current model: ${current || "default model"}`,
        "Switch with /model <provider/model>",
        ...(visible.length > 0 ? visible.map((name) => `  ${name}`) : ["  No configured models found"]),
        ...suffix,
    ].join("\n");
}
export function formatSessionStats(value) {
    if (!isRecord(value))
        return "Session statistics are unavailable";
    const tokens = isRecord(value.tokens) ? value.tokens : {};
    const context = isRecord(value.contextUsage) ? value.contextUsage : undefined;
    const rows = [
        `Session ${text(value.sessionId) || "unknown"}`,
        text(value.sessionFile) ? `File: ${text(value.sessionFile)}` : undefined,
        `Messages: ${number(value.totalMessages)} (${number(value.userMessages)} user, ${number(value.assistantMessages)} assistant)`,
        `Tools: ${number(value.toolCalls)} calls, ${number(value.toolResults)} results`,
        `Tokens: ${number(tokens.total)} total (${number(tokens.input)} input, ${number(tokens.output)} output, ${number(tokens.cacheRead)} cache read, ${number(tokens.cacheWrite)} cache write)`,
        `Cost: $${currency(value.cost)}`,
        context ? formatContextUsage(context) : undefined,
    ];
    return rows.filter((row) => row !== undefined).join("\n");
}
function parseSlashInvocation(text) {
    const match = /^\/([^/\s]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
    if (!match)
        return null;
    return { name: match[1], args: (match[2] ?? "").trim() };
}
function pathArgument(args) {
    if (!args)
        return undefined;
    const quote = args[0];
    if (quote === "\"" || quote === "'") {
        const end = args.indexOf(quote, 1);
        return end < 0 ? undefined : args.slice(1, end);
    }
    return args.split(/\s/, 1)[0] || undefined;
}
/** Whether text is shaped like a slash command (`/name` + optional args).
 *  A leading `/` alone does not qualify: `/data20T/dev/foo` is a file path,
 *  not a command, so it must be sent as an ordinary prompt. */
export function isSlashInvocation(text) {
    return parseSlashInvocation(text) !== null;
}
function normalizeDynamicCommand(value) {
    if (!isRecord(value))
        return null;
    const name = text(value.name);
    const rawSource = text(value.source);
    if (!name || !isCommandName(name) || !VALID_SOURCES.has(rawSource)) {
        return null;
    }
    const source = rawSource;
    if (source === "starling")
        return null;
    const description = text(value.description) || defaultDescription(source);
    const argumentHint = text(value.argumentHint) || undefined;
    return {
        name,
        description,
        source,
        argumentHint,
        allowArgs: true,
    };
}
function isCommandName(value) {
    return !/[\s/\u0000-\u001f\u007f]/.test(value);
}
function defaultDescription(source) {
    if (source === "extension")
        return "Run Pi extension command";
    if (source === "prompt")
        return "Use Pi prompt template";
    if (source === "skill")
        return "Use Pi skill";
    return "Run Starling command";
}
function commandDisplayName(command) {
    return `/${command.name}${command.argumentHint ? ` ${command.argumentHint}` : ""}`;
}
function modelName(value) {
    if (!isRecord(value))
        return undefined;
    const provider = text(value.provider);
    const id = text(value.id) || text(value.modelId);
    return provider && id ? `${provider}/${id}` : undefined;
}
function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function text(value) {
    return typeof value === "string" ? value.trim() : "";
}
function number(value) {
    return typeof value === "number" && Number.isFinite(value)
        ? Math.max(0, value).toLocaleString("en-US")
        : "0";
}
function currency(value) {
    return typeof value === "number" && Number.isFinite(value) ? value.toFixed(4) : "0.0000";
}
function formatContextUsage(context) {
    const window = number(context.contextWindow);
    if (typeof context.tokens !== "number" || !Number.isFinite(context.tokens)) {
        return `Context: unknown / ${window} tokens`;
    }
    const percent = typeof context.percent === "number" && Number.isFinite(context.percent)
        ? ` (${number(context.percent)}%)`
        : "";
    return `Context: ${number(context.tokens)} / ${window} tokens${percent}`;
}
