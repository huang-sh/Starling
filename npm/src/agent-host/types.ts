import path from "node:path";

export type JsonObject = Record<string, unknown>;

export interface AgentHostLaunchOptions {
  cwd: string;
  sessionPath?: string;
  sessionId?: string;
  name?: string;
  provider?: string;
  model?: string;
  thinking?: string;
  extensions: string[];
  noExtensions: boolean;
  /** Pi extension/input surface. JSONL defaults to rpc; bare Starling uses tui. */
  surface?: "rpc" | "tui";
  /** Install Starling's inline permission and session-identity guards. */
  starlingManaged?: boolean;
}

export interface ExtensionUiResponse extends JsonObject {
  type: "extension_ui_response";
  id: string;
  value?: string;
  confirmed?: boolean;
  cancelled?: true;
}

export interface ExtensionUiBindings {
  uiContext: JsonObject;
  wasLastUiConfirmationExplicit?(): boolean;
  emitEvent(event: unknown): void;
  emitExtensionError(error: unknown): void;
  requestShutdown(): void;
}

/** A Pi command that can be invoked through the shared prompt surface. */
export interface AgentSdkCommand {
  name: string;
  description?: string;
  source: "extension" | "prompt" | "skill";
  sourceInfo: unknown;
}

export interface AgentSdkSession {
  getState(): JsonObject;
  getMessages(): unknown[];
  getCommands(): AgentSdkCommand[];
  getSessionStats(): unknown;
  prompt(
    message: string,
    streamingBehavior: "steer" | "followUp" | undefined,
    accepted: () => void,
    rejected: (error: unknown) => void,
  ): void;
  abort(): Promise<void>;
  setModel(provider: string, modelId: string): Promise<unknown>;
  getModelConfig(): Promise<JsonObject>;
  configureModel(provider: string, modelId: string, role: string, thinkingLevel: string): Promise<unknown>;
  getAuthProviders(mode: "login" | "logout"): Promise<JsonObject>;
  loginProvider(provider: string, authType: "oauth" | "api_key"): Promise<unknown>;
  logoutProvider(provider: string): Promise<unknown>;
  abortAuthentication(): void;
  getTree(): JsonObject;
  navigateTree(targetId: string, options?: JsonObject): Promise<JsonObject>;
  abortTreeNavigation(): void;
  setThinkingLevel(level: string): void;
  getAvailableModels(): Promise<unknown[]>;
  compact(customInstructions?: string): Promise<unknown>;
  abortCompaction(): void;
  setSessionName(name: string): void;
  reload(): Promise<void>;
  shutdown(): Promise<void>;
}

export interface AgentSdkAdapter {
  open(
    options: AgentHostLaunchOptions,
    bindings: ExtensionUiBindings,
  ): Promise<AgentSdkSession>;
}

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
export function parseAgentHostArgs(
  argv: readonly string[],
  processCwd = process.cwd(),
): AgentHostLaunchOptions {
  const values = new Map<string, string[]>();
  let noExtensions = false;

  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    if (raw === "--no-extensions") {
      noExtensions = true;
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

  const last = (option: string): string | undefined => values.get(option)?.at(-1);
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
    extensions: (values.get("--extension") ?? []).map((extension) =>
      path.resolve(cwd, extension)
    ),
    noExtensions,
  };
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
