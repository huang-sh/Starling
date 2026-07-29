import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AgentHostLaunchOptions,
  AgentSdkAdapter,
  AgentSdkCommand,
  AgentSdkSession,
  ExtensionUiBindings,
  JsonObject,
  errorMessage,
  isJsonObject,
} from "./types.js";
import {
  ProviderFetch,
  ZhipuModelRuntime,
  registerZhipuCodingPlanProvider,
} from "./zhipu-provider.js";

const PI_SDK_PACKAGE = "@earendil-works/pi-coding-agent";

interface ModelRuntimeLike extends ZhipuModelRuntime {
  getAvailable(): Promise<unknown[]>;
  getModel?(provider: string, modelId: string): unknown;
  getProviders?(): readonly AuthProviderLike[];
  getProvider?(providerId: string): AuthProviderLike | undefined;
  getProviderAuthStatus?(providerId: string): AuthStatusLike;
  isUsingOAuth?(providerId: string): boolean;
  listCredentials?(): Promise<readonly CredentialInfoLike[]>;
  login?(
    providerId: string,
    authType: AuthProviderType,
    interaction: AuthInteractionLike,
  ): Promise<unknown>;
  logout?(providerId: string): Promise<void>;
}

type AuthProviderType = "oauth" | "api_key";

interface AuthProviderLike {
  id: string;
  name: string;
  auth?: {
    oauth?: { name?: string };
    apiKey?: { name?: string; login?: unknown };
  };
}

interface AuthStatusLike {
  configured?: boolean;
  source?: string;
  label?: string;
}

interface CredentialInfoLike {
  providerId: string;
  type: AuthProviderType;
}

type AuthPromptLike = {
  signal?: AbortSignal;
  type: "text" | "secret" | "manual_code";
  message: string;
  placeholder?: string;
} | {
  signal?: AbortSignal;
  type: "select";
  message: string;
  options: readonly { id: string; label: string; description?: string }[];
};

type AuthEventLike =
  | { type: "info"; message: string; links?: readonly { url: string; label?: string }[] }
  | { type: "auth_url"; url: string; instructions?: string }
  | {
    type: "device_code";
    userCode: string;
    verificationUri: string;
    intervalSeconds?: number;
    expiresInSeconds?: number;
  }
  | { type: "progress"; message: string };

interface AuthInteractionLike {
  signal?: AbortSignal;
  prompt(prompt: AuthPromptLike): Promise<string>;
  notify(event: AuthEventLike): void;
}

interface AuthUiLike {
  select?(
    title: string,
    options: string[],
    dialogOptions?: { signal?: AbortSignal },
  ): Promise<string | undefined>;
  input?(
    title: string,
    placeholder?: string,
    dialogOptions?: {
      signal?: AbortSignal;
      message?: string;
      secret?: boolean;
    },
  ): Promise<string | undefined>;
  notify?(message: string, type?: "info" | "warning" | "error"): void;
  setStatus?(key: string, text?: string): void;
}

interface SettingsManagerLike {
  /** Pi's file storage is not part of the typed SDK, but is exposed at runtime. */
  storage?: SettingsStorageLike;
  getDefaultProvider?(): string | undefined;
  getDefaultModel?(): string | undefined;
  getDefaultThinkingLevel?(): string | undefined;
  getSessionDir?(): string | undefined;
  setDefaultModelAndProvider?(provider: string, modelId: string): void;
  setDefaultThinkingLevel?(level: string): void;
  flush?(): Promise<void>;
}

interface SettingsStorageLike {
  withLock(
    scope: "global" | "project",
    update: (current: string | undefined) => string | undefined,
  ): void;
}

interface ResourceLoaderLike {
  reload(): Promise<void>;
  getExtensions?(): {
    extensions?: Array<{
      path?: string;
      resolvedPath?: string;
      sourceInfo?: { source?: string };
    }>;
    errors?: Array<{ path?: string; error?: string }>;
  };
}

interface CommandSourceLike {
  description?: string;
  sourceInfo: unknown;
}

interface RegisteredCommandLike extends CommandSourceLike {
  invocationName: string;
}

interface PromptTemplateLike extends CommandSourceLike {
  name: string;
}

interface SkillLike extends CommandSourceLike {
  name: string;
}

interface ManagedExtensionUiLike {
  confirm?(
    title: string,
    message: string,
    options?: { timeout?: number },
  ): Promise<boolean>;
  notify?(message: string, type?: "info" | "warning" | "error"): void;
}

interface ManagedExtensionContextLike {
  ui?: ManagedExtensionUiLike;
}

interface ManagedExtensionApiLike {
  on(
    event: string,
    handler: (event: unknown, context: ManagedExtensionContextLike) => unknown,
  ): void;
}

type ManagedExtensionFactory = (api: ManagedExtensionApiLike) => void;

interface InlineExtensionLike {
  name: string;
  factory: ManagedExtensionFactory;
  hidden?: boolean;
}

interface SessionManagerLike {
  getCwd(): string;
  getTree?(): unknown[];
  getLeafId?(): string | null;
}

interface ProjectTrustStoreLike {
  get(cwd: string): boolean | null;
  set(cwd: string, decision: boolean | null): void;
}

interface SdkSessionLike {
  model?: unknown;
  thinkingLevel?: unknown;
  isStreaming?: boolean;
  isCompacting?: boolean;
  steeringMode?: unknown;
  followUpMode?: unknown;
  sessionFile?: string;
  sessionId?: string;
  sessionName?: string;
  autoCompactionEnabled?: boolean;
  pendingMessageCount?: number;
  messages?: unknown[];
  promptTemplates?: readonly PromptTemplateLike[];
  resourceLoader?: {
    getSkills?(): { skills?: readonly SkillLike[] };
  };
  modelRuntime?: ModelRuntimeLike;
  extensionRunner?: {
    emit(event: unknown): Promise<unknown>;
    getRegisteredCommands?(): readonly RegisteredCommandLike[];
  };
  bindExtensions(bindings: JsonObject): Promise<void>;
  subscribe(listener: (event: unknown) => void): () => void;
  prompt(message: string, options?: JsonObject): Promise<void>;
  abort(): Promise<void>;
  setModel(model: unknown): Promise<void>;
  setThinkingLevel(level: unknown): void;
  compact(customInstructions?: string): Promise<unknown>;
  abortCompaction(): void;
  setSessionName?(name: string): void;
  getSessionStats?(): unknown;
  waitForIdle?(): Promise<void>;
  navigateTree?(targetId: string, options?: JsonObject): Promise<JsonObject>;
  abortBranchSummary?(): void;
  reload?(): Promise<void>;
  dispose(): void;
}

interface PiSdkModule {
  ModelRuntime: {
    create(options?: JsonObject): Promise<ModelRuntimeLike>;
  };
  SessionManager: {
    create(cwd: string, sessionDir?: string, options?: { id?: string }): SessionManagerLike;
    open(sessionPath: string, sessionDir?: string, cwdOverride?: string): SessionManagerLike;
  };
  SettingsManager: {
    create(
      cwd: string,
      agentDir?: string,
      options?: { projectTrusted?: boolean },
    ): SettingsManagerLike;
  };
  ProjectTrustStore: new (agentDir: string) => ProjectTrustStoreLike;
  hasTrustRequiringProjectResources(cwd: string): boolean;
  DefaultResourceLoader: new (options: JsonObject) => ResourceLoaderLike;
  createAgentSession(options: JsonObject): Promise<{ session: SdkSessionLike }>;
  getAgentDir?: () => string;
}

export type PiSdkLoader = () => Promise<unknown>;

/** Load Pi's public SDK export. This never resolves or executes Pi's CLI/TUI. */
export async function loadPiSdk(): Promise<unknown> {
  return import(PI_SDK_PACKAGE);
}

export function createPiSdkAdapter(
  loadSdk: PiSdkLoader = loadPiSdk,
  environment: NodeJS.ProcessEnv = process.env,
  fetchImpl: ProviderFetch = (input, init) => fetch(input, init),
): AgentSdkAdapter {
  return {
    async open(
      options: AgentHostLaunchOptions,
      bindings: ExtensionUiBindings,
    ): Promise<AgentSdkSession> {
      const sdk = requirePiSdk(await loadSdk());
      const agentDir = sdk.getAgentDir?.() ?? path.join(os.homedir(), ".pi", "agent");
      let sessionManager: SessionManagerLike | undefined;
      let effectiveCwd: string;

      if (options.sessionPath) {
        // Deliberately omit cwdOverride: a resumed transcript owns its project cwd.
        sessionManager = sdk.SessionManager.open(options.sessionPath);
        effectiveCwd = sessionManager.getCwd();
      } else {
        effectiveCwd = options.cwd;
      }

      const projectTrusted = await resolveProjectTrusted(
        sdk,
        agentDir,
        effectiveCwd,
        bindings,
        environment,
      );
      const settingsManager = sdk.SettingsManager.create(
        effectiveCwd,
        agentDir,
        { projectTrusted },
      );

      if (!options.sessionPath) {
        const sessionDir = configuredSessionDir(environment, settingsManager);
        sessionManager = sdk.SessionManager.create(
          effectiveCwd,
          sessionDir,
          options.sessionId ? { id: options.sessionId } : undefined,
        );
      }
      if (!sessionManager) throw new Error("Pi SDK did not create a session manager");

      const modelRuntime = await sdk.ModelRuntime.create({
        authPath: path.join(agentDir, "auth.json"),
        modelsPath: path.join(agentDir, "models.json"),
      });
      await registerZhipuCodingPlanProvider(modelRuntime, environment, fetchImpl);
      const inlineExtensions: InlineExtensionLike[] = options.starlingManaged
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
      const model = await resolveRequestedModel(
        modelRuntime,
        settingsManager,
        options.provider,
        options.model,
      );
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
      let unsubscribe = () => {};
      const adaptedSession = new PiSdkSessionAdapter(
        session,
        sessionManager,
        modelRuntime,
        settingsManager,
        path.join(agentDir, "settings.json"),
        bindings.uiContext as AuthUiLike,
        () => unsubscribe(),
        options.surface === "tui" ? "interactive" : "rpc",
      );

      try {
        if (options.name) session.setSessionName?.(options.name);

        await session.bindExtensions({
          uiContext: bindings.uiContext,
          mode: options.surface ?? "rpc",
          commandContextActions: {
            waitForIdle: () => session.waitForIdle?.() ?? Promise.resolve(),
            newSession: async () => ({ cancelled: true }),
            fork: async () => ({ cancelled: true }),
            navigateTree: async (targetId: string, navigateOptions?: JsonObject) =>
              session.navigateTree?.(targetId, navigateOptions) ?? { cancelled: true },
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
      } catch (error) {
        try {
          await adaptedSession.shutdown();
        } catch (cleanupError) {
          throw new Error(
            `${errorMessage(error)}; Pi SDK cleanup failed: ${errorMessage(cleanupError)}`,
            { cause: error },
          );
        }
        throw error;
      }
    },
  };
}

class PiSdkSessionAdapter implements AgentSdkSession {
  private readonly session: SdkSessionLike;
  private readonly sessionManager: SessionManagerLike;
  private readonly modelRuntime: ModelRuntimeLike;
  private readonly settingsManager: SettingsManagerLike;
  private readonly settingsPath: string;
  private readonly authUi: AuthUiLike;
  private readonly unsubscribe: () => void;
  private readonly promptSource: "interactive" | "rpc";
  private activeCompaction: Promise<unknown> | undefined;
  private activeTreeNavigation: Promise<JsonObject> | undefined;
  private activeAuthentication: AbortController | undefined;
  private shutdownPromise: Promise<void> | undefined;

  constructor(
    session: SdkSessionLike,
    sessionManager: SessionManagerLike,
    modelRuntime: ModelRuntimeLike,
    settingsManager: SettingsManagerLike,
    settingsPath: string,
    authUi: AuthUiLike,
    unsubscribe: () => void,
    promptSource: "interactive" | "rpc",
  ) {
    this.session = session;
    this.sessionManager = sessionManager;
    this.modelRuntime = modelRuntime;
    this.settingsManager = settingsManager;
    this.settingsPath = settingsPath;
    this.authUi = authUi;
    this.unsubscribe = unsubscribe;
    this.promptSource = promptSource;
  }

  getState(): JsonObject {
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

  getMessages(): unknown[] {
    return Array.isArray(this.session.messages) ? this.session.messages : [];
  }

  getCommands(): AgentSdkCommand[] {
    const commands: AgentSdkCommand[] = [];

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

  getSessionStats(): unknown {
    const getSessionStats = this.session.getSessionStats;
    if (!getSessionStats) throw new Error("Pi SDK session does not support getSessionStats");
    return getSessionStats.call(this.session);
  }

  prompt(
    message: string,
    streamingBehavior: "steer" | "followUp" | undefined,
    accepted: () => void,
    rejected: (error: unknown) => void,
  ): void {
    let preflightAccepted = false;
    void this.session.prompt(message, {
      streamingBehavior,
      source: this.promptSource,
      preflightResult: (success: boolean) => {
        if (!success || preflightAccepted) return;
        preflightAccepted = true;
        accepted();
      },
    }).catch((error) => {
      if (!preflightAccepted) rejected(error);
    });
  }

  async abort(): Promise<void> {
    await this.session.abort();
  }

  async setModel(provider: string, modelId: string): Promise<unknown> {
    const models = await this.modelRuntime.getAvailable();
    const model = models.find((candidate) => modelMatches(candidate, provider, modelId));
    if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);
    await this.session.setModel(model);
    return model;
  }

  async getModelConfig(): Promise<JsonObject> {
    await this.settingsManager.flush?.();
    const settings = await readPiSettings(this.settingsPath, this.settingsManager.storage);
    const defaultThinkingLevel = this.settingsManager.getDefaultThinkingLevel?.()
      ?? stringSetting(settings.defaultThinkingLevel);
    return {
      defaultProvider: this.settingsManager.getDefaultProvider?.()
        ?? stringSetting(settings.defaultProvider),
      defaultModel: this.settingsManager.getDefaultModel?.()
        ?? stringSetting(settings.defaultModel),
      ...(defaultThinkingLevel ? { defaultThinkingLevel } : {}),
      modelRoles: modelRolesFromSettings(settings),
    };
  }

  async configureModel(
    provider: string,
    modelId: string,
    role: string,
    thinkingLevel: string,
  ): Promise<unknown> {
    if (!CONFIGURABLE_MODEL_ROLES.has(role)) {
      throw new Error(`Unsupported model role: ${role}`);
    }
    const models = await this.modelRuntime.getAvailable();
    const model = models.find((candidate) => modelMatches(candidate, provider, modelId));
    if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);
    const thinking = validateConfiguredThinkingLevel(thinkingLevel);
    if (thinking !== "inherit" && !supportedThinkingLevels(model).includes(thinking)) {
      throw new Error(`${provider}/${modelId} does not support thinking level: ${thinking}`);
    }

    await this.settingsManager.flush?.();
    if (role === "default") {
      const setDefault = this.settingsManager.setDefaultModelAndProvider;
      if (!setDefault) throw new Error("Pi SDK settings do not support a default model");
      await this.session.setModel(model);
      setDefault.call(this.settingsManager, provider, modelId);
      if (thinking !== "inherit") {
        this.session.setThinkingLevel(thinking);
        this.settingsManager.setDefaultThinkingLevel?.(thinking);
      }
      await this.settingsManager.flush?.();
    }
    const baseSelector = `${provider}/${modelId}`;
    const selector = thinking === "inherit" ? baseSelector : `${baseSelector}:${thinking}`;
    await writePiModelRole(
      this.settingsPath,
      role,
      selector,
      this.settingsManager.storage,
    );
    return { provider, id: modelId, role, thinkingLevel: thinking, selector };
  }

  async getAuthProviders(mode: "login" | "logout"): Promise<JsonObject> {
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
            return authProviderRecord(
              provider ?? { id: credential.providerId, name: credential.providerId },
              credential.type,
              { configured: true, source: "stored credential" },
              true,
              true,
            );
          })
          .sort(compareAuthProviderRecords),
      };
    }

    const options: JsonObject[] = [];
    for (const provider of providers) {
      const status = this.modelRuntime.getProviderAuthStatus?.(provider.id) ?? {};
      const configuredType: AuthProviderType = this.modelRuntime.isUsingOAuth?.(provider.id)
        ? "oauth"
        : "api_key";
      if (provider.auth?.oauth) {
        options.push(authProviderRecord(
          provider,
          "oauth",
          status,
          stored.get(provider.id) === "oauth",
          status.configured === true && configuredType === "oauth",
        ));
      }
      if (provider.auth?.apiKey) {
        options.push(authProviderRecord(
          provider,
          "api_key",
          status,
          stored.get(provider.id) === "api_key",
          status.configured === true && configuredType === "api_key",
          typeof provider.auth.apiKey.login === "function",
        ));
      }
    }
    return { providers: options.sort(compareAuthProviderRecords) };
  }

  async loginProvider(providerId: string, authType: AuthProviderType): Promise<unknown> {
    if (this.activeAuthentication) throw new Error("Provider login is already in progress");
    const login = this.modelRuntime.login;
    const provider = this.modelRuntime.getProvider?.(providerId)
      ?? this.modelRuntime.getProviders?.().find((candidate) => candidate.id === providerId);
    if (!login || !provider) throw new Error(`Unknown authentication provider: ${providerId}`);
    const method = authType === "oauth" ? provider.auth?.oauth : provider.auth?.apiKey;
    if (!method) throw new Error(`${provider.name} does not support ${authTypeLabel(authType)} login`);
    if (authType === "api_key" && typeof provider.auth?.apiKey?.login !== "function") {
      throw new Error(`${provider.name} authentication is configured outside Pi`);
    }

    const controller = new AbortController();
    this.activeAuthentication = controller;
    this.authUi.setStatus?.("auth", `Logging in to ${provider.name}…`);
    try {
      await login.call(
        this.modelRuntime,
        provider.id,
        authType,
        createAuthInteraction(this.authUi, provider.name, controller.signal),
      );
      return { provider: provider.id, name: provider.name, authType };
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) throw new Error("Login cancelled");
      throw error;
    } finally {
      this.authUi.setStatus?.("auth", undefined);
      if (this.activeAuthentication === controller) this.activeAuthentication = undefined;
    }
  }

  async logoutProvider(providerId: string): Promise<unknown> {
    const logout = this.modelRuntime.logout;
    const listCredentials = this.modelRuntime.listCredentials;
    if (!logout || !listCredentials) {
      throw new Error("Pi SDK runtime does not support provider logout");
    }
    const credential = (await listCredentials.call(this.modelRuntime))
      .find((candidate) => candidate.providerId === providerId);
    if (!credential) throw new Error(`No stored credentials for provider: ${providerId}`);
    await logout.call(this.modelRuntime, providerId);
    const provider = this.modelRuntime.getProvider?.(providerId);
    return {
      provider: providerId,
      name: provider?.name ?? providerId,
      authType: credential.type,
    };
  }

  abortAuthentication(): void {
    this.activeAuthentication?.abort();
  }

  getTree(): JsonObject {
    const getTree = this.sessionManager.getTree;
    const getLeafId = this.sessionManager.getLeafId;
    if (!getTree || !getLeafId) throw new Error("Pi SDK session does not support tree navigation");
    return {
      tree: getTree.call(this.sessionManager),
      leafId: getLeafId.call(this.sessionManager),
    };
  }

  async navigateTree(targetId: string, options: JsonObject = {}): Promise<JsonObject> {
    const navigateTree = this.session.navigateTree;
    if (!navigateTree) throw new Error("Pi SDK session does not support tree navigation");
    const activeTreeNavigation = navigateTree.call(this.session, targetId, options);
    this.activeTreeNavigation = activeTreeNavigation;
    void activeTreeNavigation.then(
      () => this.clearActiveTreeNavigation(activeTreeNavigation),
      () => this.clearActiveTreeNavigation(activeTreeNavigation),
    );
    return await activeTreeNavigation;
  }

  abortTreeNavigation(): void {
    this.session.abortBranchSummary?.();
  }

  setThinkingLevel(level: string): void {
    this.session.setThinkingLevel(level);
  }

  getAvailableModels(): Promise<unknown[]> {
    return this.modelRuntime.getAvailable();
  }

  compact(customInstructions?: string): Promise<unknown> {
    const activeCompaction = this.session.compact(customInstructions);
    this.activeCompaction = activeCompaction;
    void activeCompaction.then(
      () => this.clearActiveCompaction(activeCompaction),
      () => this.clearActiveCompaction(activeCompaction),
    );
    return activeCompaction;
  }

  abortCompaction(): void {
    this.session.abortCompaction();
  }

  setSessionName(name: string): void {
    const setSessionName = this.session.setSessionName;
    if (!setSessionName) throw new Error("Pi SDK session does not support setSessionName");
    setSessionName.call(this.session, name);
  }

  async reload(): Promise<void> {
    const reload = this.session.reload;
    if (!reload) throw new Error("Pi SDK session does not support reload");
    await reload.call(this.session);
  }

  shutdown(): Promise<void> {
    this.shutdownPromise ??= this.shutdownOnce();
    return this.shutdownPromise;
  }

  private async shutdownOnce(): Promise<void> {
    const errors: unknown[] = [];
    const activeCompaction = this.activeCompaction;
    const activeTreeNavigation = this.activeTreeNavigation;
    this.abortAuthentication();
    try {
      this.session.abortBranchSummary?.();
    } catch (error) {
      errors.push(error);
    }
    try {
      this.session.abortCompaction();
    } catch (error) {
      errors.push(error);
    }
    try {
      await this.session.abort();
    } catch (error) {
      errors.push(error);
    }
    // Pi creates the compaction AbortController only after compact()'s initial
    // await abort(). Cancel again after that await has had a chance to resume.
    try {
      this.session.abortCompaction();
    } catch (error) {
      errors.push(error);
    }
    if (activeCompaction) {
      try {
        await activeCompaction;
      } catch (error) {
        if (!isCompactionCancellation(error)) errors.push(error);
      }
    }
    if (activeTreeNavigation) {
      try {
        await activeTreeNavigation;
      } catch (error) {
        if (!isTreeNavigationCancellation(error)) errors.push(error);
      }
    }
    try {
      await this.session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
    } catch (error) {
      errors.push(error);
    }
    try {
      this.unsubscribe();
    } catch (error) {
      errors.push(error);
    }
    try {
      this.session.dispose();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) {
      throw new Error(`Pi SDK shutdown failed: ${errors.map(errorMessage).join("; ")}`);
    }
  }

  private clearActiveCompaction(compaction: Promise<unknown>): void {
    if (this.activeCompaction === compaction) this.activeCompaction = undefined;
  }

  private clearActiveTreeNavigation(navigation: Promise<JsonObject>): void {
    if (this.activeTreeNavigation === navigation) this.activeTreeNavigation = undefined;
  }
}

function isCompactionCancellation(error: unknown): boolean {
  return error instanceof Error
    && (error.name === "AbortError" || error.message === "Compaction cancelled");
}

function isTreeNavigationCancellation(error: unknown): boolean {
  return error instanceof Error
    && (error.name === "AbortError" || /branch summarization cancelled/i.test(error.message));
}

function authProviderRecord(
  provider: AuthProviderLike,
  authType: AuthProviderType,
  status: AuthStatusLike,
  stored: boolean,
  configured: boolean,
  interactive = true,
): JsonObject {
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

function compareAuthProviderRecords(left: JsonObject, right: JsonObject): number {
  return String(left.name).localeCompare(String(right.name))
    || String(left.id).localeCompare(String(right.id))
    || String(left.authType).localeCompare(String(right.authType));
}

function authTypeLabel(authType: AuthProviderType): string {
  return authType === "oauth" ? "subscription" : "API key";
}

function createAuthInteraction(
  ui: AuthUiLike,
  providerName: string,
  signal: AbortSignal,
): AuthInteractionLike {
  const notices: string[] = [];
  return {
    signal,
    async prompt(prompt): Promise<string> {
      const promptSignal = prompt.signal
        ? AbortSignal.any([signal, prompt.signal])
        : signal;
      if (prompt.type === "select") {
        if (!ui.select) throw new Error("Starling authentication UI cannot show a selection prompt");
        const labels = prompt.options.map((option) =>
          option.description ? `${option.label} — ${option.description}` : option.label
        );
        const selected = await ui.select(prompt.message, labels, { signal: promptSignal });
        const index = selected === undefined ? -1 : labels.indexOf(selected);
        const value = prompt.options[index]?.id;
        if (!value) throw new Error("Login cancelled");
        return value;
      }
      if (!ui.input) throw new Error("Starling authentication UI cannot request input");
      const value = await ui.input(
        `Login to ${providerName}`,
        prompt.placeholder,
        {
          signal: promptSignal,
          message: [...notices, prompt.message].join("\n\n"),
          secret: prompt.type === "secret",
        },
      );
      if (value === undefined) throw new Error("Login cancelled");
      return value;
    },
    notify(event): void {
      const message = authEventMessage(event);
      // Surface every auth event on the live status line so it stays visible
      // while the auth picker holds the screen (device codes / auth URLs are
      // otherwise trapped in the hidden timeline and the login cannot finish).
      ui.setStatus?.("auth", message);
      if (event.type === "progress") return;
      notices.push(message);
      if (notices.length > 4) notices.shift();
      ui.notify?.(message, "info");
    },
  };
}

function authEventMessage(event: AuthEventLike): string {
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

function isAbortError(error: unknown): boolean {
  return error instanceof Error
    && (error.name === "AbortError" || /cancelled|canceled|aborted/i.test(error.message));
}

const STARLING_PERMISSION_TIMEOUT_MS = 30_000;

// Pi-style risk-based permission gate: only intercept genuinely destructive
// operations, auto-allow everything else. Mirrors pi's official
// examples/extensions/permission-gate.ts and protected-paths.ts — NOT a
// blanket "confirm every tool" allowlist.
// ponytail: whole-command regex scan — catches nested invocations like
// `bash -c "rm -rf x"`, but false-positives on `echo rm -rf`. Mirrors pi's
// official permission-gate heuristic; over-prompting is the safe side.
const STARLING_DANGEROUS_BASH_PATTERNS = [
  /\brm\b\s+(-[a-z]*r|--recursive)/i, // rm -r / rm -rf / rm --recursive
  /\brm\b\s+(-[a-z]*f|--force)\b/i, // rm -f / rm -rf
  /\bsudo\b/i,
  /\b(chmod|chown)\b[^|\n]*\b777\b/i,
  /\bgit\b\s+push\b.*--force(?!-)/i, // --force but not --force-with-lease
  /\bdd\b[^|\n]*\bof=/i,
  /\bmkfs\b/i,
  /\b(shutdown|reboot|halt|poweroff)\b/i,
];

const STARLING_PROTECTED_WRITE_PATHS = [".env", ".git/", "node_modules/"];

function isDangerousBash(command: unknown): boolean {
  return typeof command === "string"
    && STARLING_DANGEROUS_BASH_PATTERNS.some((p) => p.test(command));
}

function isProtectedWritePath(target: unknown): boolean {
  return typeof target === "string"
    && STARLING_PROTECTED_WRITE_PATHS.some((p) => target.includes(p));
}

/** Starling guards installed through Pi's official inline extension factory. */
function createStarlingManagedExtension(): ManagedExtensionFactory {
  return (api) => {
    const blockSessionChange = (_event: unknown, context: ManagedExtensionContextLike) => {
      context.ui?.notify?.(
        "Starling has locked this transcript. Exit the workspace before opening or forking another session.",
        "warning",
      );
      return { cancel: true };
    };
    api.on("session_before_switch", blockSessionChange);
    api.on("session_before_fork", blockSessionChange);
    api.on("tool_call", async (event: unknown, context: ManagedExtensionContextLike) => {
      const record = isJsonObject(event) ? event : {};
      const toolName = typeof record.toolName === "string"
        ? record.toolName.trim().toLowerCase()
        : "";
      const input = isJsonObject(record.input) ? record.input : {};

      // bash: confirm only destructive commands (pi permission-gate.ts style)
      if (toolName === "bash" && isDangerousBash(input.command)) {
        const command = String(input.command ?? "");
        let approved = false;
        try {
          approved = await context.ui?.confirm?.(
            `⚠️ Dangerous command:\n\n  ${command}\n\nAllow?`,
            command,
            { timeout: STARLING_PERMISSION_TIMEOUT_MS },
          ) === true;
        } catch {
          approved = false;
        }
        if (approved) return undefined;
        return {
          block: true,
          reason: `Starling blocked destructive bash: ${command}`,
        };
      }

      // write/edit: block protected paths outright (pi protected-paths.ts style)
      if ((toolName === "write" || toolName === "edit") && isProtectedWritePath(input.path)) {
        const target = String(input.path ?? "");
        context.ui?.notify?.(`Blocked write to protected path: ${target}`, "warning");
        return { block: true, reason: `Path "${target}" is protected by Starling` };
      }

      return undefined;
    });
  };
}

async function resolveRequestedModel(
  modelRuntime: ModelRuntimeLike,
  settingsManager: SettingsManagerLike,
  provider: string | undefined,
  modelId: string | undefined,
): Promise<unknown> {
  if (!provider && !modelId) return undefined;

  const effectiveProvider = provider ?? settingsManager.getDefaultProvider?.();
  if (effectiveProvider && modelId) {
    const direct = modelRuntime.getModel?.(effectiveProvider, modelId);
    if (direct) return direct;
  }

  const available = await modelRuntime.getAvailable();
  const match = available.find((candidate) => {
    if (!isJsonObject(candidate)) return false;
    if (provider && candidate.provider !== provider) return false;
    if (modelId && candidate.id !== modelId) return false;
    return true;
  });
  if (match) return match;

  const requested = [provider, modelId].filter(Boolean).join("/");
  throw new Error(`Model not found: ${requested}`);
}

function modelMatches(candidate: unknown, provider: string, modelId: string): boolean {
  return isJsonObject(candidate) && candidate.provider === provider && candidate.id === modelId;
}

const CONFIGURABLE_MODEL_ROLES = new Set([
  "default",
  "smol",
  "slow",
  "vision",
  "plan",
  "designer",
  "commit",
  "tiny",
  "task",
  "advisor",
]);

async function readPiSettings(
  settingsPath: string,
  storage?: SettingsStorageLike,
): Promise<JsonObject> {
  if (storage) {
    let contents: string | undefined;
    storage.withLock("global", (current) => {
      contents = current;
      return undefined;
    });
    return parsePiSettings(contents);
  }
  let contents: string;
  try {
    contents = await fs.readFile(settingsPath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return {};
    throw error;
  }
  return parsePiSettings(contents);
}

function parsePiSettings(contents: string | undefined): JsonObject {
  if (!contents) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new Error(`Pi settings are not valid JSON: ${errorMessage(error)}`);
  }
  if (!isJsonObject(parsed)) throw new Error("Pi settings must contain a JSON object");
  return parsed;
}

function modelRolesFromSettings(settings: JsonObject): JsonObject {
  if (!isJsonObject(settings.modelRoles)) return {};
  const roles: JsonObject = {};
  for (const [role, selector] of Object.entries(settings.modelRoles)) {
    if (typeof selector === "string" && selector.trim()) roles[role] = selector.trim();
  }
  return roles;
}

async function writePiModelRole(
  settingsPath: string,
  role: string,
  selector: string,
  storage?: SettingsStorageLike,
): Promise<void> {
  if (storage) {
    storage.withLock("global", (current) => {
      const settings = parsePiSettings(current);
      const roles = modelRolesFromSettings(settings);
      roles[role] = selector;
      return JSON.stringify({ ...settings, modelRoles: roles }, null, 2);
    });
    return;
  }
  const settings = await readPiSettings(settingsPath);
  const roles = modelRolesFromSettings(settings);
  roles[role] = selector;
  const next = { ...settings, modelRoles: roles };
  const directory = path.dirname(settingsPath);
  const temporary = path.join(directory, `.settings.${process.pid}.${randomUUID()}.tmp`);
  await fs.mkdir(directory, { recursive: true });
  try {
    await fs.writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, settingsPath);
  } finally {
    await fs.unlink(temporary).catch((error) => {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    });
  }
}

function stringSetting(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function requirePiSdk(value: unknown): PiSdkModule {
  if (!isJsonObject(value)) throw new Error("Pi SDK module did not export an object");
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
  return value as unknown as PiSdkModule;
}

type ProjectTrustPolicy = "always" | "never" | "ask";

async function resolveProjectTrusted(
  sdk: PiSdkModule,
  agentDir: string,
  cwd: string,
  bindings: ExtensionUiBindings,
  environment: NodeJS.ProcessEnv,
): Promise<boolean> {
  if (!sdk.hasTrustRequiringProjectResources(cwd)) return true;

  const policy = projectTrustPolicy(environment.STARLING_PROJECT_TRUST);
  if (policy === "always") return true;
  if (policy === "never") return false;

  const trustStore = new sdk.ProjectTrustStore(agentDir);
  const saved = trustStore.get(cwd);
  if (saved !== null) return saved;

  const confirm = bindings.uiContext.confirm;
  if (typeof confirm !== "function") return false;
  const decision = await confirm(
    "Trust project folder?",
    `${cwd}\n\nThis allows Pi to load project settings and resources and execute project extensions.`,
    { timeout: 30_000 },
  );
  const trusted = decision === true;
  const explicit = bindings.wasLastUiConfirmationExplicit?.()
    ?? typeof decision === "boolean";
  if (explicit) trustStore.set(cwd, trusted);
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

const VALID_CONFIGURED_THINKING_LEVELS = new Set(["inherit", ...VALID_THINKING_LEVELS]);

function validateConfiguredThinkingLevel(level: string): string {
  if (VALID_CONFIGURED_THINKING_LEVELS.has(level)) return level;
  throw new Error(
    `Invalid configured thinking level "${level}". Valid values: ${[...VALID_CONFIGURED_THINKING_LEVELS].join(", ")}`,
  );
}

function supportedThinkingLevels(model: unknown): string[] {
  if (!isJsonObject(model) || typeof model.reasoning !== "boolean") {
    return [...VALID_THINKING_LEVELS];
  }
  if (!model.reasoning) return ["off"];
  const map = isJsonObject(model.thinkingLevelMap) ? model.thinkingLevelMap : {};
  return [...VALID_THINKING_LEVELS].filter((level) => {
    if (map[level] === null) return false;
    if (level === "xhigh" || level === "max") return map[level] !== undefined;
    return true;
  });
}

function validateThinkingLevel(level: string | undefined): string | undefined {
  if (level === undefined || VALID_THINKING_LEVELS.has(level)) return level;
  throw new Error(
    `Invalid thinking level "${level}". Valid values: ${[...VALID_THINKING_LEVELS].join(", ")}`,
  );
}


function projectTrustPolicy(value: string | undefined): ProjectTrustPolicy {
  const normalized = value?.trim().toLowerCase() || "ask";
  if (normalized === "always" || normalized === "never" || normalized === "ask") {
    return normalized;
  }
  throw new Error(
    `STARLING_PROJECT_TRUST must be always, never, or ask; received: ${value}`,
  );
}

function configuredSessionDir(
  environment: NodeJS.ProcessEnv,
  settingsManager: SettingsManagerLike,
): string | undefined {
  const fromEnvironment = environment.PI_CODING_AGENT_SESSION_DIR?.trim();
  if (fromEnvironment) return expandTilde(fromEnvironment);
  return settingsManager.getSessionDir?.();
}

function expandTilde(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function validateExplicitExtensions(
  resourceLoader: ResourceLoaderLike,
  explicitPaths: readonly string[],
  cwd: string,
): void {
  if (explicitPaths.length === 0) return;

  const result = resourceLoader.getExtensions?.();
  const extensions = result?.extensions ?? [];
  const errors = result?.errors ?? [];

  for (const explicitPath of explicitPaths) {
    const loaded = extensions.some((extension) =>
      [extension.path, extension.resolvedPath, extension.sourceInfo?.source]
        .some((candidate) => candidate !== undefined && sameResolvedPath(candidate, explicitPath, cwd))
    );
    if (loaded) continue;

    const loadError = errors.find((error) =>
      typeof error.path === "string" && sameResolvedPath(error.path, explicitPath, cwd)
    );
    const detail = loadError?.error ?? "Pi did not report the extension as loaded";
    throw new Error(`Explicit extension failed to load: ${explicitPath}: ${detail}`);
  }
}

function sameResolvedPath(candidate: string, expected: string, cwd: string): boolean {
  return path.resolve(cwd, candidate) === path.resolve(cwd, expected);
}
