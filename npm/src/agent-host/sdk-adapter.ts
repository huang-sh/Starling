import os from "node:os";
import path from "node:path";
import {
  AgentHostLaunchOptions,
  AgentSdkAdapter,
  AgentSdkSession,
  ExtensionUiBindings,
  JsonObject,
  errorMessage,
  isJsonObject,
} from "./types.js";

const PI_SDK_PACKAGE = "@earendil-works/pi-coding-agent";

interface ModelRuntimeLike {
  getAvailable(): Promise<unknown[]>;
  getModel?(provider: string, modelId: string): unknown;
}

interface SettingsManagerLike {
  getDefaultProvider?(): string | undefined;
  getSessionDir?(): string | undefined;
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

interface SessionManagerLike {
  getCwd(): string;
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
  modelRuntime?: ModelRuntimeLike;
  extensionRunner?: {
    emit(event: unknown): Promise<unknown>;
  };
  bindExtensions(bindings: JsonObject): Promise<void>;
  subscribe(listener: (event: unknown) => void): () => void;
  prompt(message: string, options?: JsonObject): Promise<void>;
  abort(): Promise<void>;
  setModel(model: unknown): Promise<void>;
  setThinkingLevel(level: unknown): void;
  compact(customInstructions?: string): Promise<unknown>;
  setSessionName?(name: string): void;
  waitForIdle?(): Promise<void>;
  navigateTree?(targetId: string, options?: JsonObject): Promise<{ cancelled: boolean }>;
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
      const resourceLoader = new sdk.DefaultResourceLoader({
        cwd: effectiveCwd,
        agentDir,
        settingsManager,
        additionalExtensionPaths: options.extensions,
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
        thinkingLevel: options.thinking,
      });
      let unsubscribe = () => {};
      const adaptedSession = new PiSdkSessionAdapter(
        session,
        modelRuntime,
        () => unsubscribe(),
      );

      try {
        if (options.name) session.setSessionName?.(options.name);

        await session.bindExtensions({
          uiContext: bindings.uiContext,
          mode: "rpc",
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
  private readonly modelRuntime: ModelRuntimeLike;
  private readonly unsubscribe: () => void;
  private shutdownPromise: Promise<void> | undefined;

  constructor(
    session: SdkSessionLike,
    modelRuntime: ModelRuntimeLike,
    unsubscribe: () => void,
  ) {
    this.session = session;
    this.modelRuntime = modelRuntime;
    this.unsubscribe = unsubscribe;
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

  prompt(
    message: string,
    streamingBehavior: "steer" | "followUp" | undefined,
    accepted: () => void,
    rejected: (error: unknown) => void,
  ): void {
    let preflightAccepted = false;
    void this.session.prompt(message, {
      streamingBehavior,
      source: "rpc",
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

  setThinkingLevel(level: string): void {
    this.session.setThinkingLevel(level);
  }

  getAvailableModels(): Promise<unknown[]> {
    return this.modelRuntime.getAvailable();
  }

  compact(customInstructions?: string): Promise<unknown> {
    return this.session.compact(customInstructions);
  }

  shutdown(): Promise<void> {
    this.shutdownPromise ??= this.shutdownOnce();
    return this.shutdownPromise;
  }

  private async shutdownOnce(): Promise<void> {
    const errors: unknown[] = [];
    try {
      await this.session.abort();
    } catch (error) {
      errors.push(error);
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
