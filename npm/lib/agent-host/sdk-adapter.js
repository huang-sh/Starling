import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { errorMessage, isJsonObject, } from "./types.js";
import { registerZhipuCodingPlanProvider } from "./zhipu-provider.js";
const PI_SDK_PACKAGE = "@earendil-works/pi-coding-agent";
/** Load Pi's public SDK export. This never resolves or executes Pi's CLI/TUI. */
export async function loadPiSdk() {
    return import(PI_SDK_PACKAGE);
}
export function createPiSdkAdapter(loadSdk = loadPiSdk, environment = process.env, fetchImpl = (input, init) => fetch(input, init)) {
    return {
        async open(options, bindings) {
            enforceIgnoreScriptsEnv(environment);
            const sdk = requirePiSdk(await loadSdk());
            const agentDir = sdk.getAgentDir?.() ?? path.join(os.homedir(), ".pi", "agent");
            let sessionManager;
            let effectiveCwd;
            let initialProjectTrusted;
            if (options.sessionPath) {
                // Deliberately omit cwdOverride: a resumed transcript owns its project cwd.
                sessionManager = sdk.SessionManager.open(options.sessionPath);
                effectiveCwd = sessionManager.getCwd();
            }
            else {
                effectiveCwd = options.cwd;
            }
            if (!options.sessionPath) {
                initialProjectTrusted = await resolveProjectTrusted(sdk, agentDir, effectiveCwd, bindings, environment);
                const startupSettings = sdk.SettingsManager.create(effectiveCwd, agentDir, { projectTrusted: initialProjectTrusted });
                const sessionDir = configuredSessionDir(environment, startupSettings);
                sessionManager = sdk.SessionManager.create(effectiveCwd, sessionDir, options.sessionId ? { id: options.sessionId } : undefined);
            }
            if (!sessionManager)
                throw new Error("Pi SDK did not create a session manager");
            const inlineExtensions = options.starlingManaged
                ? [{
                        name: "starling-managed",
                        factory: createStarlingManagedExtension(),
                        hidden: true,
                    }]
                : [];
            const createRuntime = async (runtimeOptions) => {
                const projectTrusted = initialProjectTrusted ?? await resolveProjectTrusted(sdk, agentDir, runtimeOptions.cwd, bindings, environment);
                initialProjectTrusted = undefined;
                const settingsManager = sdk.SettingsManager.create(runtimeOptions.cwd, agentDir, { projectTrusted });
                const modelRuntime = await sdk.ModelRuntime.create({
                    authPath: path.join(agentDir, "auth.json"),
                    modelsPath: path.join(agentDir, "models.json"),
                });
                await registerZhipuCodingPlanProvider(modelRuntime, environment, fetchImpl);
                const resourceLoader = new sdk.DefaultResourceLoader({
                    cwd: runtimeOptions.cwd,
                    agentDir,
                    settingsManager,
                    additionalExtensionPaths: options.extensions,
                    extensionFactories: inlineExtensions,
                    noExtensions: options.noExtensions,
                });
                await resourceLoader.reload();
                validateExplicitExtensions(resourceLoader, options.extensions, runtimeOptions.cwd);
                const model = await resolveRequestedModel(modelRuntime, settingsManager, options.provider, options.model);
                const created = await sdk.createAgentSession({
                    cwd: runtimeOptions.cwd,
                    agentDir,
                    sessionManager: runtimeOptions.sessionManager,
                    modelRuntime,
                    settingsManager,
                    resourceLoader,
                    model,
                    thinkingLevel: validateThinkingLevel(options.thinking),
                    sessionStartEvent: runtimeOptions.sessionStartEvent,
                });
                const services = {
                    cwd: runtimeOptions.cwd,
                    agentDir,
                    modelRuntime,
                    settingsManager,
                    resourceLoader,
                    diagnostics: [],
                };
                return { ...created, services, diagnostics: [] };
            };
            const runtime = await sdk.createAgentSessionRuntime(createRuntime, {
                cwd: sessionManager.getCwd(),
                agentDir,
                sessionManager,
            });
            const adaptedSession = new PiSdkSessionAdapter(runtime, sdk, bindings, bindings.uiContext, options.surface === "tui" ? "interactive" : "rpc", options.surface ?? "rpc", environment);
            runtime.setBeforeSessionInvalidate(() => adaptedSession.detach());
            runtime.setRebindSession(async () => adaptedSession.bind(true));
            try {
                if (options.name)
                    runtime.session.setSessionName?.(options.name);
                await adaptedSession.bind();
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
    environment;
    runtime;
    sdk;
    bindings;
    authUi;
    promptSource;
    extensionMode;
    unsubscribe = () => { };
    activeCompaction;
    activeTreeNavigation;
    activeAuthentication;
    bashSequence = 0;
    shutdownPromise;
    constructor(runtime, sdk, bindings, authUi, promptSource, extensionMode, environment) {
        this.environment = environment;
        this.runtime = runtime;
        this.sdk = sdk;
        this.bindings = bindings;
        this.authUi = authUi;
        this.promptSource = promptSource;
        this.extensionMode = extensionMode;
    }
    get session() {
        return this.runtime.session;
    }
    get sessionManager() {
        return this.session.sessionManager;
    }
    get modelRuntime() {
        return this.runtime.services.modelRuntime;
    }
    get settingsManager() {
        return this.runtime.services.settingsManager;
    }
    async bind(replaced = false) {
        const session = this.session;
        await session.bindExtensions({
            uiContext: this.bindings.uiContext,
            mode: this.extensionMode,
            commandContextActions: {
                waitForIdle: () => session.waitForIdle(),
                newSession: (options) => this.runtime.newSession(options),
                fork: async (entryId, options) => {
                    const result = await this.runtime.fork(entryId, options);
                    return { cancelled: result.cancelled };
                },
                navigateTree: async (targetId, options) => {
                    const result = await session.navigateTree(targetId, options);
                    return { cancelled: result.cancelled };
                },
                switchSession: (sessionPath, options) => this.runtime.switchSession(sessionPath, options),
                reload: () => session.reload(),
            },
            abortHandler: () => {
                void session.abort();
            },
            shutdownHandler: this.bindings.requestShutdown,
            onError: this.bindings.emitExtensionError,
        });
        this.detach();
        this.unsubscribe = session.subscribe(this.bindings.emitEvent);
        for (const loadError of this.runtime.services.resourceLoader.getExtensions().errors) {
            this.bindings.emitExtensionError({
                extensionPath: loadError.path ?? "unknown",
                event: "load",
                error: loadError.error ?? "Extension failed to load",
            });
        }
        if (replaced) {
            this.bindings.emitEvent({
                type: "starling_session_replaced",
                state: this.getState(),
                messages: this.getMessages(),
            });
        }
    }
    detach() {
        this.unsubscribe();
        this.unsubscribe = () => { };
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
            hideThinkingBlock: this.settingsManager.getHideThinkingBlock(),
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
    async getModelConfig() {
        await this.settingsManager.flush?.();
        const defaultThinkingLevel = this.settingsManager.getDefaultThinkingLevel?.();
        return {
            defaultProvider: this.settingsManager.getDefaultProvider?.(),
            defaultModel: this.settingsManager.getDefaultModel?.(),
            ...(defaultThinkingLevel ? { defaultThinkingLevel } : {}),
        };
    }
    async configureModel(provider, modelId, thinkingLevel) {
        const models = await this.modelRuntime.getAvailable();
        const model = models.find((candidate) => modelMatches(candidate, provider, modelId));
        if (!model)
            throw new Error(`Model not found: ${provider}/${modelId}`);
        const thinking = validateConfiguredThinkingLevel(thinkingLevel);
        if (thinking !== "inherit" && !supportedThinkingLevels(model).includes(thinking)) {
            throw new Error(`${provider}/${modelId} does not support thinking level: ${thinking}`);
        }
        await this.settingsManager.flush?.();
        const setDefault = this.settingsManager.setDefaultModelAndProvider;
        if (!setDefault)
            throw new Error("Pi SDK settings do not support a default model");
        await this.session.setModel(model);
        setDefault.call(this.settingsManager, provider, modelId);
        if (thinking !== "inherit") {
            this.session.setThinkingLevel(thinking);
            this.settingsManager.setDefaultThinkingLevel?.(thinking);
        }
        await this.settingsManager.flush?.();
        return { provider, id: modelId, thinkingLevel: thinking };
    }
    async getAuthProviders(mode) {
        const getProviders = this.modelRuntime.getProviders;
        const listCredentials = this.modelRuntime.listCredentials;
        if (!getProviders || !listCredentials) {
            throw new Error("Pi SDK runtime does not support provider authentication");
        }
        await this.modelRuntime.getAvailable();
        const providers = getProviders.call(this.modelRuntime);
        const credentials = await listCredentials.call(this.modelRuntime);
        const stored = new Map(credentials.map((credential) => [credential.providerId, credential.type]));
        if (mode === "logout") {
            return {
                providers: credentials
                    .map((credential) => {
                    const provider = providers.find((candidate) => candidate.id === credential.providerId);
                    return authProviderRecord(provider ?? { id: credential.providerId, name: credential.providerId }, credential.type, { configured: true, label: "stored credential" }, true, true);
                })
                    .sort(compareAuthProviderRecords),
            };
        }
        const options = [];
        for (const provider of providers) {
            const status = this.modelRuntime.getProviderAuthStatus?.(provider.id) ?? {};
            const configuredType = this.modelRuntime.isUsingOAuth?.(provider.id)
                ? "oauth"
                : "api_key";
            if (provider.auth?.oauth) {
                options.push(authProviderRecord(provider, "oauth", status, stored.get(provider.id) === "oauth", status.configured === true && configuredType === "oauth"));
            }
            if (provider.auth?.apiKey) {
                options.push(authProviderRecord(provider, "api_key", status, stored.get(provider.id) === "api_key", status.configured === true && configuredType === "api_key", typeof provider.auth.apiKey.login === "function"));
            }
        }
        return { providers: options.sort(compareAuthProviderRecords) };
    }
    async loginProvider(providerId, authType) {
        if (this.activeAuthentication)
            throw new Error("Provider login is already in progress");
        const login = this.modelRuntime.login;
        const provider = this.modelRuntime.getProvider?.(providerId)
            ?? this.modelRuntime.getProviders?.().find((candidate) => candidate.id === providerId);
        if (!login || !provider)
            throw new Error(`Unknown authentication provider: ${providerId}`);
        const method = authType === "oauth" ? provider.auth?.oauth : provider.auth?.apiKey;
        if (!method)
            throw new Error(`${provider.name} does not support ${authTypeLabel(authType)} login`);
        if (authType === "api_key" && typeof provider.auth?.apiKey?.login !== "function") {
            throw new Error(`${provider.name} authentication is configured outside Pi`);
        }
        const controller = new AbortController();
        this.activeAuthentication = controller;
        this.authUi.setStatus?.("auth", `Logging in to ${provider.name}…`);
        try {
            await login.call(this.modelRuntime, provider.id, authType, createAuthInteraction(this.authUi, provider.name, controller.signal));
            return { provider: provider.id, name: provider.name, authType };
        }
        catch (error) {
            if (controller.signal.aborted || isAbortError(error))
                throw new Error("Login cancelled");
            throw error;
        }
        finally {
            this.authUi.setStatus?.("auth", undefined);
            if (this.activeAuthentication === controller)
                this.activeAuthentication = undefined;
        }
    }
    async logoutProvider(providerId) {
        const logout = this.modelRuntime.logout;
        const listCredentials = this.modelRuntime.listCredentials;
        if (!logout || !listCredentials) {
            throw new Error("Pi SDK runtime does not support provider logout");
        }
        const credential = (await listCredentials.call(this.modelRuntime))
            .find((candidate) => candidate.providerId === providerId);
        if (!credential)
            throw new Error(`No stored credentials for provider: ${providerId}`);
        await logout.call(this.modelRuntime, providerId);
        const provider = this.modelRuntime.getProvider?.(providerId);
        return {
            provider: providerId,
            name: provider?.name ?? providerId,
            authType: credential.type,
        };
    }
    abortAuthentication() {
        this.activeAuthentication?.abort();
    }
    getTree() {
        const getTree = this.sessionManager.getTree;
        const getLeafId = this.sessionManager.getLeafId;
        if (!getTree || !getLeafId)
            throw new Error("Pi SDK session does not support tree navigation");
        return {
            tree: getTree.call(this.sessionManager),
            leafId: getLeafId.call(this.sessionManager),
        };
    }
    async navigateTree(targetId, options = {}) {
        const navigateTree = this.session.navigateTree;
        if (!navigateTree)
            throw new Error("Pi SDK session does not support tree navigation");
        const activeTreeNavigation = navigateTree.call(this.session, targetId, options);
        this.activeTreeNavigation = activeTreeNavigation;
        void activeTreeNavigation.then(() => this.clearActiveTreeNavigation(activeTreeNavigation), () => this.clearActiveTreeNavigation(activeTreeNavigation));
        return await activeTreeNavigation;
    }
    abortTreeNavigation() {
        this.session.abortBranchSummary?.();
    }
    setThinkingLevel(level) {
        this.session.setThinkingLevel(validateThinkingLevel(level));
    }
    getAvailableModels() {
        return this.modelRuntime.getAvailable().then((models) => [...models]);
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
    async newSession() {
        await this.session.waitForIdle();
        return await this.runtime.newSession();
    }
    async resumeSession(sessionPath) {
        await this.session.waitForIdle();
        let selectedPath = sessionPath;
        if (!selectedPath) {
            const current = this.sessionManager;
            const sessions = current.usesDefaultSessionDir()
                ? await this.sdk.SessionManager.listAll()
                : await this.sdk.SessionManager.listAll(current.getSessionDir());
            const choices = new Map(sessions.map((info) => [sessionChoice(info), info.path]));
            if (choices.size === 0)
                throw new Error("No saved Pi sessions found");
            const selected = await this.authUi.select?.("Resume session", [...choices.keys()]);
            if (!selected)
                return { cancelled: true };
            selectedPath = choices.get(selected);
            if (!selectedPath)
                return { cancelled: true };
        }
        return await this.runtime.switchSession(selectedPath);
    }
    async forkSession(entryId) {
        await this.session.waitForIdle();
        let selectedId = entryId;
        if (!selectedId) {
            const choices = new Map(this.session.getUserMessagesForForking().map((message) => [
                `${oneLine(message.text).slice(0, 100) || "Empty message"} · ${message.entryId.slice(0, 8)}`,
                message.entryId,
            ]));
            if (choices.size === 0)
                throw new Error("No user messages to fork from");
            const selected = await this.authUi.select?.("Fork from message", [...choices.keys()]);
            if (!selected)
                return { cancelled: true };
            selectedId = choices.get(selected);
            if (!selectedId)
                return { cancelled: true };
        }
        return await this.runtime.fork(selectedId);
    }
    async cloneSession() {
        await this.session.waitForIdle();
        const leafId = this.sessionManager.getLeafId();
        if (!leafId)
            throw new Error("Nothing to clone yet");
        return await this.runtime.fork(leafId, { position: "at" });
    }
    async importSession(inputPath) {
        await this.session.waitForIdle();
        const confirmed = await this.authUi.confirm?.("Import session", `Replace the current session with ${inputPath}?`);
        if (confirmed !== true)
            return { cancelled: true };
        return await this.runtime.importFromJsonl(inputPath);
    }
    async executeBash(command, excludeFromContext) {
        const id = `starling-bash-${++this.bashSequence}`;
        const eventResult = await this.session.extensionRunner.emitUserBash({
            type: "user_bash",
            command,
            excludeFromContext,
            cwd: this.sessionManager.getCwd(),
        });
        this.bindings.emitEvent({
            type: "starling_bash_started",
            id,
            command,
            excludeFromContext,
        });
        try {
            if (eventResult?.result) {
                this.session.recordBashResult(command, eventResult.result, { excludeFromContext });
                this.bindings.emitEvent({ type: "starling_bash_completed", id, result: eventResult.result });
                return eventResult.result;
            }
            let output = "";
            const result = await this.session.executeBash(command, (chunk) => {
                output += chunk;
                this.bindings.emitEvent({ type: "starling_bash_updated", id, output });
            }, { excludeFromContext, id, operations: eventResult?.operations });
            this.bindings.emitEvent({ type: "starling_bash_completed", id, result });
            return result;
        }
        catch (error) {
            this.bindings.emitEvent({
                type: "starling_bash_completed",
                id,
                result: { output: errorMessage(error), cancelled: false },
                failed: true,
            });
            throw error;
        }
    }
    abortBash() {
        this.session.abortBash();
    }
    async exportSession(outputPath) {
        if (outputPath?.endsWith(".jsonl")) {
            return { path: this.session.exportToJsonl(outputPath), format: "jsonl" };
        }
        return { path: await this.session.exportToHtml(outputPath), format: "html" };
    }
    async copyLastAssistantMessage() {
        const text = this.session.getLastAssistantText();
        if (!text)
            throw new Error("No agent messages to copy yet");
        await this.sdk.copyToClipboard(text);
        return { copied: true };
    }
    async configureSettings() {
        const settings = this.settingsManager;
        const choices = [
            booleanSetting("Auto-compact", () => this.session.autoCompactionEnabled, (value) => {
                this.session.setAutoCompactionEnabled(value);
            }),
            booleanSetting("Auto-retry", () => settings.getRetryEnabled(), (value) => {
                this.session.setAutoRetryEnabled(value);
            }),
            booleanSetting("Show images", () => settings.getShowImages(), (value) => {
                settings.setShowImages(value);
            }),
            choiceSetting("Image width", () => String(settings.getImageWidthCells()), ["60", "80", "120"], (value) => {
                settings.setImageWidthCells(Number(value));
            }),
            booleanSetting("Auto-resize images", () => settings.getImageAutoResize(), (value) => {
                settings.setImageAutoResize(value);
            }),
            booleanSetting("Block images", () => settings.getBlockImages(), (value) => {
                settings.setBlockImages(value);
            }),
            booleanSetting("Skill commands", () => settings.getEnableSkillCommands(), (value) => {
                settings.setEnableSkillCommands(value);
            }),
            choiceSetting("Steering mode", () => this.session.steeringMode, ["one-at-a-time", "all"], (value) => {
                this.session.setSteeringMode(value);
            }),
            choiceSetting("Follow-up mode", () => this.session.followUpMode, ["one-at-a-time", "all"], (value) => {
                this.session.setFollowUpMode(value);
            }),
            choiceSetting("Transport", () => settings.getTransport(), ["sse", "websocket", "websocket-cached", "auto"], (value) => {
                settings.setTransport(value);
            }),
            choiceSetting("HTTP idle timeout", () => String(settings.getHttpIdleTimeoutMs()), ["0", "30000", "60000", "300000", "600000"], (value) => {
                settings.setHttpIdleTimeoutMs(Number(value));
            }),
            choiceSetting("Thinking level", () => this.session.thinkingLevel, this.session.getAvailableThinkingLevels(), (value) => {
                this.session.setThinkingLevel(value);
            }),
            booleanSetting("Hide thinking", () => settings.getHideThinkingBlock(), (value) => {
                settings.setHideThinkingBlock(value);
            }),
            booleanSetting("Cache miss notices", () => settings.getShowCacheMissNotices(), (value) => {
                settings.setShowCacheMissNotices(value);
            }),
            booleanSetting("Collapse changelog", () => settings.getCollapseChangelog(), (value) => {
                settings.setCollapseChangelog(value);
            }),
            booleanSetting("Quiet startup", () => settings.getQuietStartup(), (value) => {
                settings.setQuietStartup(value);
            }),
            booleanSetting("Install telemetry", () => settings.getEnableInstallTelemetry(), (value) => {
                settings.setEnableInstallTelemetry(value);
            }),
            choiceSetting("Default project trust", () => settings.getDefaultProjectTrust(), ["ask", "always", "never"], (value) => {
                settings.setDefaultProjectTrust(value);
            }),
            choiceSetting("Double-escape action", () => settings.getDoubleEscapeAction(), ["tree", "fork", "none"], (value) => {
                settings.setDoubleEscapeAction(value);
            }),
            choiceSetting("Tree filter mode", () => settings.getTreeFilterMode(), ["default", "no-tools", "user-only", "labeled-only", "all"], (value) => {
                settings.setTreeFilterMode(value);
            }),
            booleanSetting("Show hardware cursor", () => settings.getShowHardwareCursor(), (value) => {
                settings.setShowHardwareCursor(value);
            }),
            choiceSetting("Editor padding", () => String(settings.getEditorPaddingX()), ["0", "1", "2", "3"], (value) => {
                settings.setEditorPaddingX(Number(value));
            }),
            choiceSetting("Output padding", () => String(settings.getOutputPad()), ["0", "1"], (value) => {
                settings.setOutputPad(value === "0" ? 0 : 1);
            }),
            choiceSetting("Autocomplete max items", () => String(settings.getAutocompleteMaxVisible()), ["3", "5", "7", "10", "15", "20"], (value) => {
                settings.setAutocompleteMaxVisible(Number(value));
            }),
            booleanSetting("Clear on shrink", () => settings.getClearOnShrink(), (value) => {
                settings.setClearOnShrink(value);
            }),
            booleanSetting("Terminal progress", () => settings.getShowTerminalProgress(), (value) => {
                settings.setShowTerminalProgress(value);
            }),
            booleanSetting("Anthropic extra-usage warning", () => settings.getWarnings().anthropicExtraUsage !== false, (value) => {
                settings.setWarnings({ ...settings.getWarnings(), anthropicExtraUsage: value });
            }),
        ];
        const select = this.authUi.select;
        if (!select)
            throw new Error("Starling cannot open the Pi settings menu");
        let changed = 0;
        while (true) {
            const labels = choices.map((choice) => `${choice.label} · ${choice.current()}`);
            const selected = await select("Pi settings", ["Done", ...labels]);
            if (!selected || selected === "Done") {
                await settings.flush();
                return {
                    cancelled: changed === 0,
                    message: changed === 0 ? "Settings unchanged" : `Updated ${changed} Pi setting${changed === 1 ? "" : "s"}`,
                };
            }
            const choice = choices[labels.indexOf(selected)];
            if (!choice)
                continue;
            const value = await select(choice.label, [...choice.values]);
            if (value === undefined)
                continue;
            choice.apply(value);
            changed += 1;
        }
    }
    async configureScopedModels() {
        await this.modelRuntime.refresh();
        const models = [...await this.modelRuntime.getAvailable()];
        if (models.length === 0)
            throw new Error("No configured models found");
        const allIds = models.map((model) => `${model.provider}/${model.id}`);
        let enabled;
        if (this.session.scopedModels.length > 0) {
            enabled = this.session.scopedModels.map(({ model }) => `${model.provider}/${model.id}`);
        }
        else {
            const patterns = this.settingsManager.getEnabledModels();
            enabled = patterns?.length
                ? (await this.sdk.resolveModelScopeWithDiagnostics(patterns, this.modelRuntime)).scopedModels
                    .map(({ model }) => `${model.provider}/${model.id}`)
                : null;
        }
        const select = this.authUi.select;
        if (!select)
            throw new Error("Starling cannot open the scoped-model menu");
        while (true) {
            const labels = models.map((model) => {
                const id = `${model.provider}/${model.id}`;
                return `${enabled === null || enabled.includes(id) ? "✓" : "○"} ${id}`;
            });
            const selected = await select("Models used by model cycling", [
                "Save and close",
                "Enable all",
                "Clear all",
                ...labels,
            ]);
            if (!selected)
                return { cancelled: true, message: "Scoped-model changes remain session-only" };
            if (selected === "Save and close") {
                const persisted = enabled === null || enabled.length === allIds.length ? undefined : enabled;
                this.settingsManager.setEnabledModels(persisted ? [...persisted] : undefined);
                await this.settingsManager.flush();
                return { cancelled: false, message: "Model-cycle selection saved to Pi settings" };
            }
            if (selected === "Enable all")
                enabled = null;
            else if (selected === "Clear all")
                enabled = [];
            else {
                const id = allIds[labels.indexOf(selected)];
                if (!id)
                    continue;
                if (enabled === null)
                    enabled = [id];
                else
                    enabled = enabled.includes(id)
                        ? enabled.filter((candidate) => candidate !== id)
                        : [...enabled, id];
            }
            const scoped = enabled && enabled.length > 0 && enabled.length < models.length
                ? enabled.flatMap((id) => {
                    const model = models.find((candidate) => `${candidate.provider}/${candidate.id}` === id);
                    return model ? [{ model }] : [];
                })
                : [];
            this.session.setScopedModels(scoped);
        }
    }
    async shareSession() {
        const directory = await mkdtemp(path.join(os.tmpdir(), "starling-share-"));
        const outputPath = path.join(directory, "session.html");
        try {
            await this.session.exportToHtml(outputPath);
            const result = await runGh(["gist", "create", "--public=false", outputPath]);
            if (result.code !== 0) {
                throw new Error(result.stderr.trim() || "GitHub CLI could not create the gist");
            }
            const gistUrl = safeHttpUrl(result.stdout.trim(), "GitHub CLI returned an invalid gist URL");
            const gistId = gistUrl.pathname.split("/").filter(Boolean).at(-1);
            if (!gistId || !/^[A-Za-z0-9]+$/.test(gistId)) {
                throw new Error("GitHub CLI returned an invalid gist ID");
            }
            const preview = safeHttpUrl(this.environment.PI_SHARE_VIEWER_URL ?? "https://pi.dev/session/", "PI_SHARE_VIEWER_URL must be an HTTP(S) URL");
            preview.hash = gistId;
            return {
                gistUrl: gistUrl.toString(),
                shareUrl: preview.toString(),
                message: `Share URL: ${preview.toString()}\nGist: ${gistUrl.toString()}`,
            };
        }
        finally {
            await rm(directory, { recursive: true, force: true });
        }
    }
    async getChangelog() {
        const bytes = await readFile(path.join(this.sdk.getPackageDir(), "CHANGELOG.md"));
        const limit = 64 * 1024;
        const truncated = bytes.length > limit;
        return {
            message: `${bytes.subarray(0, limit).toString("utf8")}${truncated ? "\n\n… changelog truncated by Starling" : ""}`,
            truncated,
        };
    }
    async configureProjectTrust() {
        const select = this.authUi.select;
        if (!select)
            throw new Error("Starling cannot open the project-trust menu");
        const cwd = this.sessionManager.getCwd();
        const trustStore = new this.sdk.ProjectTrustStore(this.runtime.services.agentDir);
        const saved = trustStore.get(cwd);
        const selected = await select(`Project trust · ${saved === null ? "not saved" : saved ? "trusted" : "untrusted"}`, ["Trust this folder", "Do not trust this folder", "Forget saved decision"]);
        if (!selected)
            return { cancelled: true, message: "Project trust unchanged" };
        const decision = selected === "Trust this folder"
            ? true
            : selected === "Do not trust this folder" ? false : null;
        trustStore.set(cwd, decision);
        return {
            cancelled: false,
            message: decision === null
                ? "Forgot the saved project trust decision. Restart Starling for this to take effect."
                : `Saved project as ${decision ? "trusted" : "untrusted"}. Restart Starling for this to take effect.`,
        };
    }
    async cycleModel(direction) {
        const result = await this.session.cycleModel(direction);
        return result
            ? {
                model: result.model,
                thinkingLevel: result.thinkingLevel,
                isScoped: result.isScoped,
            }
            : { unchanged: true };
    }
    async cycleThinkingLevel() {
        const thinkingLevel = this.session.cycleThinkingLevel();
        return thinkingLevel ? { thinkingLevel } : { unchanged: true };
    }
    clearQueue() {
        return this.session.clearQueue();
    }
    async setThinkingVisible(visible) {
        this.settingsManager.setHideThinkingBlock(!visible);
        await this.settingsManager.flush();
        return { visible };
    }
    shutdown() {
        this.shutdownPromise ??= this.shutdownOnce();
        return this.shutdownPromise;
    }
    async shutdownOnce() {
        const errors = [];
        const activeCompaction = this.activeCompaction;
        const activeTreeNavigation = this.activeTreeNavigation;
        this.abortAuthentication();
        try {
            this.session.abortBranchSummary?.();
        }
        catch (error) {
            errors.push(error);
        }
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
        if (activeTreeNavigation) {
            try {
                await activeTreeNavigation;
            }
            catch (error) {
                if (!isTreeNavigationCancellation(error))
                    errors.push(error);
            }
        }
        try {
            await this.runtime.dispose();
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
    clearActiveTreeNavigation(navigation) {
        if (this.activeTreeNavigation === navigation)
            this.activeTreeNavigation = undefined;
    }
}
function choiceSetting(label, current, values, apply) {
    return { label, current, values, apply };
}
function booleanSetting(label, current, apply) {
    return choiceSetting(label, () => String(current()), ["true", "false"], (value) => {
        apply(value === "true");
    });
}
function runGh(args) {
    return new Promise((resolve, reject) => {
        const child = spawn("gh", args, { stdio: ["ignore", "pipe", "pipe"] });
        let stdout = Buffer.alloc(0);
        let stderr = Buffer.alloc(0);
        let settled = false;
        const finish = (result) => {
            if (settled)
                return;
            settled = true;
            resolve(result);
        };
        child.stdout.on("data", (chunk) => {
            stdout = appendBytes(stdout, chunk, 64 * 1024);
        });
        child.stderr.on("data", (chunk) => {
            stderr = appendBytes(stderr, chunk, 64 * 1024);
        });
        child.once("error", (error) => {
            if (settled)
                return;
            settled = true;
            reject(new Error(error.code === "ENOENT"
                ? "GitHub CLI (gh) is not installed"
                : `GitHub CLI failed: ${error.message}`));
        });
        child.once("close", (code) => finish({
            code,
            stdout: stdout.toString("utf8"),
            stderr: stderr.toString("utf8"),
        }));
    });
}
function appendBytes(current, chunk, limit) {
    const remaining = limit - current.length;
    return remaining <= 0 ? current : Buffer.concat([current, chunk.subarray(0, remaining)]);
}
function safeHttpUrl(value, message) {
    let url;
    try {
        url = new URL(value);
    }
    catch {
        throw new Error(message);
    }
    if (url.protocol !== "https:" && url.protocol !== "http:")
        throw new Error(message);
    return url;
}
function isCompactionCancellation(error) {
    return error instanceof Error
        && (error.name === "AbortError" || error.message === "Compaction cancelled");
}
function isTreeNavigationCancellation(error) {
    return error instanceof Error
        && (error.name === "AbortError" || /branch summarization cancelled/i.test(error.message));
}
function sessionChoice(info) {
    const title = info.name?.trim() || info.firstMessage.trim() || "Untitled session";
    return `${title} · ${info.id.slice(0, 8)} · ${info.cwd || "unknown cwd"}`;
}
function oneLine(value) {
    return value.replace(/\s+/g, " ").trim();
}
function authProviderRecord(provider, authType, status, stored, configured, interactive = true) {
    const method = authType === "oauth" ? provider.auth?.oauth : provider.auth?.apiKey;
    return {
        id: provider.id,
        name: provider.name || provider.id,
        authType,
        methodName: method?.name ?? authTypeLabel(authType),
        configured,
        stored,
        interactive,
        ...(status.label || status.source ? { source: status.label ?? status.source } : {}),
    };
}
function compareAuthProviderRecords(left, right) {
    return String(left.name).localeCompare(String(right.name))
        || String(left.id).localeCompare(String(right.id))
        || String(left.authType).localeCompare(String(right.authType));
}
function authTypeLabel(authType) {
    return authType === "oauth" ? "subscription" : "API key";
}
function createAuthInteraction(ui, providerName, signal) {
    const notices = [];
    return {
        signal,
        async prompt(prompt) {
            const promptSignal = prompt.signal
                ? AbortSignal.any([signal, prompt.signal])
                : signal;
            if (prompt.type === "select") {
                if (!ui.select)
                    throw new Error("Starling authentication UI cannot show a selection prompt");
                const labels = prompt.options.map((option) => option.description ? `${option.label} — ${option.description}` : option.label);
                const selected = await ui.select(prompt.message, labels, { signal: promptSignal });
                const index = selected === undefined ? -1 : labels.indexOf(selected);
                const value = prompt.options[index]?.id;
                if (!value)
                    throw new Error("Login cancelled");
                return value;
            }
            if (!ui.input)
                throw new Error("Starling authentication UI cannot request input");
            const value = await ui.input(`Login to ${providerName}`, prompt.placeholder, {
                signal: promptSignal,
                message: [...notices, prompt.message].join("\n\n"),
                secret: prompt.type === "secret",
            });
            if (value === undefined)
                throw new Error("Login cancelled");
            return value;
        },
        notify(event) {
            const message = authEventMessage(event);
            // Surface every auth event on the live status line so it stays visible
            // while the auth picker holds the screen (device codes / auth URLs are
            // otherwise trapped in the hidden timeline and the login cannot finish).
            ui.setStatus?.("auth", message);
            if (event.type === "progress")
                return;
            notices.push(message);
            if (notices.length > 4)
                notices.shift();
            ui.notify?.(message, "info");
        },
    };
}
function authEventMessage(event) {
    switch (event.type) {
        case "auth_url":
            return [event.instructions, "Open this URL to continue:", event.url].filter(Boolean).join("\n");
        case "device_code":
            return [
                `Open ${event.verificationUri}`,
                `Device code: ${event.userCode}`,
                event.expiresInSeconds ? `Expires in ${event.expiresInSeconds} seconds` : undefined,
            ].filter(Boolean).join("\n");
        case "info":
            return [
                event.message,
                ...(event.links ?? []).map((link) => `${link.label ? `${link.label}: ` : ""}${link.url}`),
            ].join("\n");
        case "progress":
            return event.message;
    }
}
function isAbortError(error) {
    return error instanceof Error
        && (error.name === "AbortError" || /cancelled|canceled|aborted/i.test(error.message));
}
const STARLING_PERMISSION_TIMEOUT_MS = 30_000;
const STARLING_AUTO_ALLOWED_TOOLS = new Set(["read", "grep", "find", "ls"]);
const STARLING_TOOL_INPUT_LIMIT = 4_000;
/** Starling guards installed through Pi's official inline extension factory. */
function createStarlingManagedExtension() {
    return (api) => {
        const blockSessionChange = (_event, context) => {
            context.ui.notify("Starling has locked this transcript. Exit the workspace before opening or forking another session.", "warning");
            return { cancel: true };
        };
        api.on("session_before_switch", blockSessionChange);
        api.on("session_before_fork", blockSessionChange);
        api.on("tool_call", async (event, context) => {
            const toolName = event.toolName.trim().toLowerCase();
            if (STARLING_AUTO_ALLOWED_TOOLS.has(toolName))
                return undefined;
            let approved = false;
            try {
                approved = await context.ui.confirm(`Allow Pi tool: ${toolName || "unknown"}?`, printableToolInput(event.input), { timeout: STARLING_PERMISSION_TIMEOUT_MS }) === true;
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
    return candidate.provider === provider && candidate.id === modelId;
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
        "createAgentSessionRuntime",
        "copyToClipboard",
        "resolveModelScopeWithDiagnostics",
        "getPackageDir",
    ];
    const missing = required.filter((name) => value[name] === undefined);
    if (missing.length > 0) {
        throw new Error(`Pi SDK is missing required exports: ${missing.join(", ")}`);
    }
    return value;
}
function enforceIgnoreScriptsEnv(environment) {
    const names = [
        "NPM_CONFIG_IGNORE_SCRIPTS",
        "npm_config_ignore_scripts",
        "PNPM_CONFIG_IGNORE_SCRIPTS",
    ];
    for (const target of environment === process.env ? [environment] : [environment, process.env]) {
        for (const name of names) {
            const value = target[name]?.trim().toLowerCase();
            if (value !== "true" && value !== "1" && value !== "yes")
                target[name] = "true";
        }
    }
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
const VALID_CONFIGURED_THINKING_LEVELS = new Set([
    "inherit",
    ...VALID_THINKING_LEVELS,
]);
function validateConfiguredThinkingLevel(level) {
    if (VALID_CONFIGURED_THINKING_LEVELS.has(level)) {
        return level;
    }
    throw new Error(`Invalid configured thinking level "${level}". Valid values: ${[...VALID_CONFIGURED_THINKING_LEVELS].join(", ")}`);
}
function supportedThinkingLevels(model) {
    if (!model.reasoning)
        return ["off"];
    const map = isJsonObject(model.thinkingLevelMap) ? model.thinkingLevelMap : {};
    return [...VALID_THINKING_LEVELS].filter((level) => {
        if (map[level] === null)
            return false;
        if (level === "xhigh" || level === "max")
            return map[level] !== undefined;
        return true;
    });
}
function validateThinkingLevel(level) {
    if (level === undefined)
        return undefined;
    if (VALID_THINKING_LEVELS.has(level))
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
