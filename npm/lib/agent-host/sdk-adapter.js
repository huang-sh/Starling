import os from "node:os";
import path from "node:path";
import { errorMessage, isJsonObject, } from "./types.js";
const PI_SDK_PACKAGE = "@earendil-works/pi-coding-agent";
/** Load Pi's public SDK export. This never resolves or executes Pi's CLI/TUI. */
export async function loadPiSdk() {
    return import(PI_SDK_PACKAGE);
}
export function createPiSdkAdapter(loadSdk = loadPiSdk, environment = process.env) {
    return {
        async open(options, bindings) {
            const sdk = requirePiSdk(await loadSdk());
            const agentDir = sdk.getAgentDir?.() ?? path.join(os.homedir(), ".pi", "agent");
            let sessionManager;
            let effectiveCwd;
            if (options.sessionPath) {
                // Deliberately omit cwdOverride: a resumed transcript owns its project cwd.
                sessionManager = sdk.SessionManager.open(options.sessionPath);
                effectiveCwd = sessionManager.getCwd();
            }
            else {
                effectiveCwd = options.cwd;
            }
            const projectTrusted = await resolveProjectTrusted(sdk, agentDir, effectiveCwd, bindings, environment);
            const settingsManager = sdk.SettingsManager.create(effectiveCwd, agentDir, { projectTrusted });
            if (!options.sessionPath) {
                const sessionDir = configuredSessionDir(environment, settingsManager);
                sessionManager = sdk.SessionManager.create(effectiveCwd, sessionDir, options.sessionId ? { id: options.sessionId } : undefined);
            }
            if (!sessionManager)
                throw new Error("Pi SDK did not create a session manager");
            const modelRuntime = await sdk.ModelRuntime.create({
                authPath: path.join(agentDir, "auth.json"),
                modelsPath: path.join(agentDir, "models.json"),
            });
            const inlineExtensions = options.starlingManaged
                ? [{
                        name: "starling-managed",
                        factory: createStarlingManagedExtension(),
                        hidden: true,
                    }]
                : [];
            const resourceLoader = new sdk.DefaultResourceLoader({
                cwd: effectiveCwd,
                agentDir,
                settingsManager,
                additionalExtensionPaths: options.extensions,
                extensionFactories: inlineExtensions,
                noExtensions: options.noExtensions,
            });
            await resourceLoader.reload();
            validateExplicitExtensions(resourceLoader, options.extensions, effectiveCwd);
            const model = await resolveRequestedModel(modelRuntime, settingsManager, options.provider, options.model);
            const { session } = await sdk.createAgentSession({
                cwd: effectiveCwd,
                agentDir,
                sessionManager,
                modelRuntime,
                settingsManager,
                resourceLoader,
                model,
                thinkingLevel: validateThinkingLevel(options.thinking),
            });
            let unsubscribe = () => { };
            const adaptedSession = new PiSdkSessionAdapter(session, modelRuntime, () => unsubscribe(), options.surface === "tui" ? "interactive" : "rpc");
            try {
                if (options.name)
                    session.setSessionName?.(options.name);
                await session.bindExtensions({
                    uiContext: bindings.uiContext,
                    mode: options.surface ?? "rpc",
                    commandContextActions: {
                        waitForIdle: () => session.waitForIdle?.() ?? Promise.resolve(),
                        newSession: async () => ({ cancelled: true }),
                        fork: async () => ({ cancelled: true }),
                        navigateTree: async (targetId, navigateOptions) => session.navigateTree?.(targetId, navigateOptions) ?? { cancelled: true },
                        switchSession: async () => ({ cancelled: true }),
                        reload: async () => {
                            await session.reload?.();
                        },
                    },
                    abortHandler: () => {
                        void session.abort();
                    },
                    shutdownHandler: bindings.requestShutdown,
                    onError: bindings.emitExtensionError,
                });
                unsubscribe = session.subscribe(bindings.emitEvent);
                for (const loadError of resourceLoader.getExtensions?.().errors ?? []) {
                    bindings.emitExtensionError({
                        extensionPath: loadError.path ?? "unknown",
                        event: "load",
                        error: loadError.error ?? "Extension failed to load",
                    });
                }
                return adaptedSession;
            }
            catch (error) {
                try {
                    await adaptedSession.shutdown();
                }
                catch (cleanupError) {
                    throw new Error(`${errorMessage(error)}; Pi SDK cleanup failed: ${errorMessage(cleanupError)}`, { cause: error });
                }
                throw error;
            }
        },
    };
}
class PiSdkSessionAdapter {
    session;
    modelRuntime;
    unsubscribe;
    promptSource;
    activeCompaction;
    shutdownPromise;
    constructor(session, modelRuntime, unsubscribe, promptSource) {
        this.session = session;
        this.modelRuntime = modelRuntime;
        this.unsubscribe = unsubscribe;
        this.promptSource = promptSource;
    }
    getState() {
        const messages = this.getMessages();
        return {
            model: this.session.model,
            thinkingLevel: this.session.thinkingLevel ?? "off",
            isStreaming: this.session.isStreaming === true,
            isCompacting: this.session.isCompacting === true,
            steeringMode: this.session.steeringMode ?? "all",
            followUpMode: this.session.followUpMode ?? "all",
            sessionFile: this.session.sessionFile,
            sessionId: this.session.sessionId ?? "",
            sessionName: this.session.sessionName,
            autoCompactionEnabled: this.session.autoCompactionEnabled === true,
            messageCount: messages.length,
            pendingMessageCount: this.session.pendingMessageCount ?? 0,
        };
    }
    getMessages() {
        return Array.isArray(this.session.messages) ? this.session.messages : [];
    }
    getCommands() {
        const commands = [];
        for (const command of this.session.extensionRunner?.getRegisteredCommands?.() ?? []) {
            commands.push({
                name: command.invocationName,
                description: command.description,
                source: "extension",
                sourceInfo: command.sourceInfo,
            });
        }
        for (const template of this.session.promptTemplates ?? []) {
            commands.push({
                name: template.name,
                description: template.description,
                source: "prompt",
                sourceInfo: template.sourceInfo,
            });
        }
        for (const skill of this.session.resourceLoader?.getSkills?.().skills ?? []) {
            commands.push({
                name: `skill:${skill.name}`,
                description: skill.description,
                source: "skill",
                sourceInfo: skill.sourceInfo,
            });
        }
        return commands;
    }
    getSessionStats() {
        const getSessionStats = this.session.getSessionStats;
        if (!getSessionStats)
            throw new Error("Pi SDK session does not support getSessionStats");
        return getSessionStats.call(this.session);
    }
    prompt(message, streamingBehavior, accepted, rejected) {
        let preflightAccepted = false;
        void this.session.prompt(message, {
            streamingBehavior,
            source: this.promptSource,
            preflightResult: (success) => {
                if (!success || preflightAccepted)
                    return;
                preflightAccepted = true;
                accepted();
            },
        }).catch((error) => {
            if (!preflightAccepted)
                rejected(error);
        });
    }
    async abort() {
        await this.session.abort();
    }
    async setModel(provider, modelId) {
        const models = await this.modelRuntime.getAvailable();
        const model = models.find((candidate) => modelMatches(candidate, provider, modelId));
        if (!model)
            throw new Error(`Model not found: ${provider}/${modelId}`);
        await this.session.setModel(model);
        return model;
    }
    setThinkingLevel(level) {
        this.session.setThinkingLevel(level);
    }
    getAvailableModels() {
        return this.modelRuntime.getAvailable();
    }
    compact(customInstructions) {
        const activeCompaction = this.session.compact(customInstructions);
        this.activeCompaction = activeCompaction;
        void activeCompaction.then(() => this.clearActiveCompaction(activeCompaction), () => this.clearActiveCompaction(activeCompaction));
        return activeCompaction;
    }
    abortCompaction() {
        this.session.abortCompaction();
    }
    setSessionName(name) {
        const setSessionName = this.session.setSessionName;
        if (!setSessionName)
            throw new Error("Pi SDK session does not support setSessionName");
        setSessionName.call(this.session, name);
    }
    async reload() {
        const reload = this.session.reload;
        if (!reload)
            throw new Error("Pi SDK session does not support reload");
        await reload.call(this.session);
    }
    shutdown() {
        this.shutdownPromise ??= this.shutdownOnce();
        return this.shutdownPromise;
    }
    async shutdownOnce() {
        const errors = [];
        const activeCompaction = this.activeCompaction;
        try {
            this.session.abortCompaction();
        }
        catch (error) {
            errors.push(error);
        }
        try {
            await this.session.abort();
        }
        catch (error) {
            errors.push(error);
        }
        // Pi creates the compaction AbortController only after compact()'s initial
        // await abort(). Cancel again after that await has had a chance to resume.
        try {
            this.session.abortCompaction();
        }
        catch (error) {
            errors.push(error);
        }
        if (activeCompaction) {
            try {
                await activeCompaction;
            }
            catch (error) {
                if (!isCompactionCancellation(error))
                    errors.push(error);
            }
        }
        try {
            await this.session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
        }
        catch (error) {
            errors.push(error);
        }
        try {
            this.unsubscribe();
        }
        catch (error) {
            errors.push(error);
        }
        try {
            this.session.dispose();
        }
        catch (error) {
            errors.push(error);
        }
        if (errors.length > 0) {
            throw new Error(`Pi SDK shutdown failed: ${errors.map(errorMessage).join("; ")}`);
        }
    }
    clearActiveCompaction(compaction) {
        if (this.activeCompaction === compaction)
            this.activeCompaction = undefined;
    }
}
function isCompactionCancellation(error) {
    return error instanceof Error
        && (error.name === "AbortError" || error.message === "Compaction cancelled");
}
const STARLING_AUTO_ALLOWED_TOOLS = new Set(["read", "grep", "find", "ls"]);
const STARLING_PERMISSION_TIMEOUT_MS = 30_000;
const STARLING_TOOL_INPUT_LIMIT = 4_000;
/** Starling guards installed through Pi's official inline extension factory. */
function createStarlingManagedExtension() {
    return (api) => {
        const blockSessionChange = (_event, context) => {
            context.ui?.notify?.("Starling has locked this transcript. Exit the workspace before opening or forking another session.", "warning");
            return { cancel: true };
        };
        api.on("session_before_switch", blockSessionChange);
        api.on("session_before_fork", blockSessionChange);
        api.on("tool_call", async (event, context) => {
            const record = isJsonObject(event) ? event : {};
            const toolName = typeof record.toolName === "string"
                ? record.toolName.trim().toLowerCase()
                : "";
            if (STARLING_AUTO_ALLOWED_TOOLS.has(toolName))
                return undefined;
            let approved = false;
            try {
                approved = await context.ui?.confirm?.(`Allow Pi tool: ${toolName || "unknown"}?`, printableToolInput(record.input), { timeout: STARLING_PERMISSION_TIMEOUT_MS }) === true;
            }
            catch {
                approved = false;
            }
            if (approved)
                return undefined;
            return {
                block: true,
                reason: `Starling denied Pi tool '${toolName || "unknown"}' because approval was not granted.`,
            };
        });
    };
}
function printableToolInput(value) {
    let text;
    try {
        text = JSON.stringify(value ?? {}, null, 2);
    }
    catch {
        text = "<unserializable tool input>";
    }
    if (text.length <= STARLING_TOOL_INPUT_LIMIT)
        return text;
    return `${text.slice(0, STARLING_TOOL_INPUT_LIMIT)}\n… <tool input truncated by Starling>`;
}
async function resolveRequestedModel(modelRuntime, settingsManager, provider, modelId) {
    if (!provider && !modelId)
        return undefined;
    const effectiveProvider = provider ?? settingsManager.getDefaultProvider?.();
    if (effectiveProvider && modelId) {
        const direct = modelRuntime.getModel?.(effectiveProvider, modelId);
        if (direct)
            return direct;
    }
    const available = await modelRuntime.getAvailable();
    const match = available.find((candidate) => {
        if (!isJsonObject(candidate))
            return false;
        if (provider && candidate.provider !== provider)
            return false;
        if (modelId && candidate.id !== modelId)
            return false;
        return true;
    });
    if (match)
        return match;
    const requested = [provider, modelId].filter(Boolean).join("/");
    throw new Error(`Model not found: ${requested}`);
}
function modelMatches(candidate, provider, modelId) {
    return isJsonObject(candidate) && candidate.provider === provider && candidate.id === modelId;
}
function requirePiSdk(value) {
    if (!isJsonObject(value))
        throw new Error("Pi SDK module did not export an object");
    const required = [
        "ModelRuntime",
        "SessionManager",
        "SettingsManager",
        "ProjectTrustStore",
        "hasTrustRequiringProjectResources",
        "DefaultResourceLoader",
        "createAgentSession",
    ];
    const missing = required.filter((name) => value[name] === undefined);
    if (missing.length > 0) {
        throw new Error(`Pi SDK is missing required exports: ${missing.join(", ")}`);
    }
    return value;
}
async function resolveProjectTrusted(sdk, agentDir, cwd, bindings, environment) {
    if (!sdk.hasTrustRequiringProjectResources(cwd))
        return true;
    const policy = projectTrustPolicy(environment.STARLING_PROJECT_TRUST);
    if (policy === "always")
        return true;
    if (policy === "never")
        return false;
    const trustStore = new sdk.ProjectTrustStore(agentDir);
    const saved = trustStore.get(cwd);
    if (saved !== null)
        return saved;
    const confirm = bindings.uiContext.confirm;
    if (typeof confirm !== "function")
        return false;
    const decision = await confirm("Trust project folder?", `${cwd}\n\nThis allows Pi to load project settings and resources and execute project extensions.`, { timeout: 30_000 });
    const trusted = decision === true;
    const explicit = bindings.wasLastUiConfirmationExplicit?.()
        ?? typeof decision === "boolean";
    if (explicit)
        trustStore.set(cwd, trusted);
    return trusted;
}
const VALID_THINKING_LEVELS = new Set([
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
]);
function validateThinkingLevel(level) {
    if (level === undefined || VALID_THINKING_LEVELS.has(level))
        return level;
    throw new Error(`Invalid thinking level "${level}". Valid values: ${[...VALID_THINKING_LEVELS].join(", ")}`);
}
function projectTrustPolicy(value) {
    const normalized = value?.trim().toLowerCase() || "ask";
    if (normalized === "always" || normalized === "never" || normalized === "ask") {
        return normalized;
    }
    throw new Error(`STARLING_PROJECT_TRUST must be always, never, or ask; received: ${value}`);
}
function configuredSessionDir(environment, settingsManager) {
    const fromEnvironment = environment.PI_CODING_AGENT_SESSION_DIR?.trim();
    if (fromEnvironment)
        return expandTilde(fromEnvironment);
    return settingsManager.getSessionDir?.();
}
function expandTilde(value) {
    if (value === "~")
        return os.homedir();
    if (value.startsWith("~/") || value.startsWith("~\\")) {
        return path.join(os.homedir(), value.slice(2));
    }
    return value;
}
function validateExplicitExtensions(resourceLoader, explicitPaths, cwd) {
    if (explicitPaths.length === 0)
        return;
    const result = resourceLoader.getExtensions?.();
    const extensions = result?.extensions ?? [];
    const errors = result?.errors ?? [];
    for (const explicitPath of explicitPaths) {
        const loaded = extensions.some((extension) => [extension.path, extension.resolvedPath, extension.sourceInfo?.source]
            .some((candidate) => candidate !== undefined && sameResolvedPath(candidate, explicitPath, cwd)));
        if (loaded)
            continue;
        const loadError = errors.find((error) => typeof error.path === "string" && sameResolvedPath(error.path, explicitPath, cwd));
        const detail = loadError?.error ?? "Pi did not report the extension as loaded";
        throw new Error(`Explicit extension failed to load: ${explicitPath}: ${detail}`);
    }
}
function sameResolvedPath(candidate, expected, cwd) {
    return path.resolve(cwd, candidate) === path.resolve(cwd, expected);
}
