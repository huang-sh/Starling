import { createExtensionUiBridge } from "../agent-host/extension-ui.js";
import { createPiSdkAdapter, loadPiSdk } from "../agent-host/sdk-adapter.js";
import { errorMessage, isJsonObject, } from "../agent-host/types.js";
/**
 * Open Pi through its public SDK and expose a small in-process request surface.
 *
 * One official Pi SDK session is created in the host process. Consumers use
 * this port directly, while JSONL is only a Starling transport adapter; Pi's
 * CLI and built-in TUI are never launched on this path.
 */
export function createChatSession(options) {
    return new PiChatSession(options);
}
class PiChatSession {
    diagnostic;
    ui;
    opening;
    session;
    commandTail = Promise.resolve();
    closePromise;
    closeRequested = false;
    drainRequested = false;
    closed = false;
    resolveImmediateClose = () => { };
    immediateClose = new Promise((resolve) => {
        this.resolveImmediateClose = resolve;
    });
    constructor(options) {
        this.diagnostic = options.diagnostic ?? (() => { });
        this.ui = createExtensionUiBridge((value) => this.emit(options.onRecord, value));
        // Defer adapter code by one microtask so createChatSession() returns before
        // an adapter can synchronously emit a startup UI request. The UI response
        // still bypasses the command queue below and can unblock adapter.open().
        const adapter = options.adapter
            ?? createPiSdkAdapter(loadPiSdk, options.environment ?? process.env);
        this.opening = Promise.resolve().then(() => adapter.open(options.launch, {
            uiContext: this.ui.context,
            wasLastUiConfirmationExplicit: () => this.ui.wasLastConfirmationExplicit(),
            emitEvent: (event) => this.emit(options.onRecord, event),
            emitExtensionError: (error) => this.emit(options.onRecord, normalizeExtensionError(error)),
            requestShutdown: () => {
                let reportCloseFailure = options.onShutdownRequested === undefined;
                try {
                    options.onShutdownRequested?.();
                }
                catch (error) {
                    reportCloseFailure = true;
                    this.diagnostic(`Starling shutdown listener failed: ${errorMessage(error)}`);
                }
                void this.close().catch((error) => {
                    // When an embedding surface accepted the callback it awaits this
                    // same close promise and owns the user-facing error. Keep this catch
                    // only to prevent an unhandled rejection for standalone/no-op use.
                    if (reportCloseFailure) {
                        this.diagnostic(`Failed to close Pi SDK session: ${errorMessage(error)}`);
                    }
                });
            },
        })).then((session) => {
            this.session = session;
            return session;
        });
        // A consumer observes startup failure through its first ordinary request.
        // Attach a handler immediately as well so a session created only to be
        // closed cannot produce an unhandled rejection.
        void this.opening.catch(() => { });
    }
    request(request) {
        if (this.closeRequested || this.closed) {
            return Promise.reject(new Error("Pi SDK session is closed"));
        }
        if (!isJsonObject(request) || typeof request.type !== "string") {
            return Promise.reject(new Error("Command must be a JSON object with a string type"));
        }
        // Trust and permission dialogs may be emitted while adapter.open() is
        // awaiting their answer. Never put those answers behind the open barrier.
        if (request.type === "extension_ui_response") {
            if (!this.ui.handleResponse(request)) {
                return Promise.reject(new Error("Invalid extension UI response"));
            }
            return Promise.resolve(undefined);
        }
        // Cancellation is a control plane, not ordinary queued work. In
        // particular abort_compaction must be able to interrupt compact itself.
        if (request.type === "abort"
            || request.type === "abort_compaction"
            || request.type === "abort_authentication"
            || request.type === "abort_tree_navigation") {
            return this.opening.then((session) => dispatchRequest(session, request));
        }
        const result = this.commandTail.then(async () => {
            const session = await this.opening;
            if (this.closeRequested && !this.drainRequested) {
                throw new Error("Pi SDK session is closed");
            }
            return await dispatchRequest(session, request);
        });
        this.commandTail = result.then(() => undefined, () => undefined);
        return result;
    }
    close(options = {}) {
        if (!this.closePromise) {
            this.drainRequested = options.drain === true;
            this.closePromise = this.closeOnce(this.drainRequested);
        }
        else if (options.drain !== true && this.drainRequested && !this.closed) {
            // EOF starts an ordered drain, but a later signal must be able to abort
            // a stuck model/tool/compaction request instead of waiting forever.
            this.drainRequested = false;
            this.resolveImmediateClose();
        }
        return this.closePromise;
    }
    async closeOnce(drain) {
        this.closeRequested = true;
        // Fail closed and release any SDK call currently awaiting UI input.
        this.ui.cancelAll();
        try {
            if (drain)
                await Promise.race([this.commandTail, this.immediateClose]);
            const session = this.session ?? await this.opening;
            await session.shutdown();
        }
        finally {
            this.closed = true;
            this.session = undefined;
        }
    }
    emit(output, value) {
        if (this.closed)
            return;
        try {
            output(value);
        }
        catch (error) {
            this.diagnostic(`Starling chat event listener failed: ${errorMessage(error)}`);
        }
    }
}
async function dispatchRequest(session, request) {
    switch (request.type) {
        case "get_state":
            return session.getState();
        case "get_messages":
            return { messages: session.getMessages() };
        case "get_commands":
            assertOnlyFields(request, "get_commands", ["type", "id"]);
            return { commands: session.getCommands() };
        case "get_session_stats":
            assertOnlyFields(request, "get_session_stats", ["type", "id"]);
            return session.getSessionStats();
        case "prompt": {
            if (typeof request.message !== "string") {
                throw new Error("prompt.message must be a string");
            }
            const behavior = streamingBehavior(request.streamingBehavior);
            await new Promise((resolve, reject) => {
                let responded = false;
                session.prompt(request.message, behavior, () => {
                    if (responded)
                        return;
                    responded = true;
                    resolve();
                }, (error) => {
                    if (responded)
                        return;
                    responded = true;
                    reject(error);
                });
            });
            return undefined;
        }
        case "abort":
            await session.abort();
            return undefined;
        case "abort_compaction":
            assertOnlyFields(request, "abort_compaction", ["type", "id"]);
            session.abortCompaction();
            return undefined;
        case "set_model":
            if (typeof request.provider !== "string" || typeof request.modelId !== "string") {
                throw new Error("set_model requires provider and modelId strings");
            }
            return await session.setModel(request.provider, request.modelId);
        case "get_model_config":
            assertOnlyFields(request, "get_model_config", ["type", "id"]);
            return await session.getModelConfig();
        case "configure_model":
            if (typeof request.provider !== "string"
                || typeof request.modelId !== "string"
                || typeof request.role !== "string") {
                throw new Error("configure_model requires provider, modelId, and role strings");
            }
            if (request.thinkingLevel !== undefined && typeof request.thinkingLevel !== "string") {
                throw new Error("configure_model.thinkingLevel must be a string");
            }
            return await session.configureModel(request.provider, request.modelId, request.role, request.thinkingLevel ?? "inherit");
        case "get_auth_providers":
            assertOnlyFields(request, "get_auth_providers", ["type", "id", "mode"]);
            if (request.mode !== "login" && request.mode !== "logout") {
                throw new Error("get_auth_providers.mode must be login or logout");
            }
            return await session.getAuthProviders(request.mode);
        case "login_provider":
            assertOnlyFields(request, "login_provider", ["type", "id", "provider", "authType"]);
            if (typeof request.provider !== "string"
                || (request.authType !== "oauth" && request.authType !== "api_key")) {
                throw new Error("login_provider requires provider and oauth or api_key authType");
            }
            return await session.loginProvider(request.provider, request.authType);
        case "logout_provider":
            assertOnlyFields(request, "logout_provider", ["type", "id", "provider"]);
            if (typeof request.provider !== "string") {
                throw new Error("logout_provider.provider must be a string");
            }
            return await session.logoutProvider(request.provider);
        case "abort_authentication":
            assertOnlyFields(request, "abort_authentication", ["type", "id"]);
            session.abortAuthentication();
            return undefined;
        case "get_tree":
            assertOnlyFields(request, "get_tree", ["type", "id"]);
            return session.getTree();
        case "navigate_tree":
            assertOnlyFields(request, "navigate_tree", [
                "type",
                "id",
                "targetId",
                "summarize",
                "customInstructions",
            ]);
            if (typeof request.targetId !== "string" || !request.targetId.trim()) {
                throw new Error("navigate_tree.targetId must be a non-empty string");
            }
            if (request.summarize !== undefined && typeof request.summarize !== "boolean") {
                throw new Error("navigate_tree.summarize must be a boolean");
            }
            if (request.customInstructions !== undefined
                && typeof request.customInstructions !== "string") {
                throw new Error("navigate_tree.customInstructions must be a string");
            }
            return await session.navigateTree(request.targetId.trim(), {
                summarize: request.summarize === true,
                ...(typeof request.customInstructions === "string" && request.customInstructions.trim()
                    ? { customInstructions: request.customInstructions.trim() }
                    : {}),
            });
        case "abort_tree_navigation":
            assertOnlyFields(request, "abort_tree_navigation", ["type", "id"]);
            session.abortTreeNavigation();
            return undefined;
        case "set_thinking_level":
            if (typeof request.level !== "string") {
                throw new Error("set_thinking_level.level must be a string");
            }
            session.setThinkingLevel(request.level);
            return undefined;
        case "get_available_models":
            return { models: await session.getAvailableModels() };
        case "compact":
            if (request.customInstructions !== undefined
                && typeof request.customInstructions !== "string") {
                throw new Error("compact.customInstructions must be a string");
            }
            return await session.compact(request.customInstructions);
        case "set_session_name": {
            assertOnlyFields(request, "set_session_name", ["type", "id", "name"]);
            if (typeof request.name !== "string") {
                throw new Error("set_session_name.name must be a string");
            }
            const name = request.name.trim();
            if (!name)
                throw new Error("Session name cannot be empty");
            session.setSessionName(name);
            return undefined;
        }
        case "reload":
            assertOnlyFields(request, "reload", ["type", "id"]);
            await session.reload();
            return undefined;
        default:
            throw new Error(`Unknown command: ${request.type}`);
    }
}
function assertOnlyFields(request, command, allowed) {
    if (request.id !== undefined && typeof request.id !== "string") {
        throw new Error(`${command}.id must be a string`);
    }
    const allowedFields = new Set(allowed);
    const unexpected = Object.keys(request).filter((field) => !allowedFields.has(field));
    if (unexpected.length > 0) {
        throw new Error(`${command} does not accept field${unexpected.length === 1 ? "" : "s"}: ${unexpected.join(", ")}`);
    }
}
function streamingBehavior(value) {
    if (value === undefined)
        return undefined;
    if (value === "steer" || value === "followUp")
        return value;
    throw new Error("prompt.streamingBehavior must be steer or followUp");
}
function normalizeExtensionError(error) {
    if (isJsonObject(error)) {
        return {
            type: "extension_error",
            extensionPath: typeof error.extensionPath === "string" ? error.extensionPath : "unknown",
            event: typeof error.event === "string" ? error.event : "unknown",
            error: typeof error.error === "string" ? error.error : errorMessage(error.error),
        };
    }
    return {
        type: "extension_error",
        extensionPath: "unknown",
        event: "unknown",
        error: errorMessage(error),
    };
}
