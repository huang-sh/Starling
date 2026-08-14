import type {
  AgentHostLaunchOptions,
  AgentSdkAdapter,
  JsonObject,
} from "../agent-host/types.js";

/** A command accepted by an in-process Starling agent session. */
export type ChatSessionRequest = JsonObject & { type: string };

/**
 * The transport-neutral surface shared by the terminal UI and JSONL host.
 *
 * Startup begins when the session is created. Requests issued while the Pi SDK
 * is opening are queued, except extension UI responses, which are delivered
 * immediately so project-trust and permission prompts cannot deadlock startup.
 */
export interface ChatSession {
  request(request: ChatSessionRequest): Promise<unknown>;
  /** Pass one raw terminal chunk through Pi extension input listeners. */
  handleTerminalInput?(data: string): { consumed: boolean; data: string };
  /** Abort immediately by default; JSONL EOF may request an ordered drain. */
  close(options?: { drain?: boolean }): Promise<void>;
}

export interface CreateChatSessionOptions {
  launch: AgentHostLaunchOptions;
  /** Override the public Pi SDK adapter (primarily for contract tests). */
  adapter?: AgentSdkAdapter;
  environment?: NodeJS.ProcessEnv;
  /** Pi lifecycle events and extension UI requests are delivered in order. */
  onRecord(value: unknown): void;
  /** Called when an extension asks the embedding surface to close. */
  onShutdownRequested?(): void;
  diagnostic?(message: string): void;
}

export type ChatSessionFactory = (options: CreateChatSessionOptions) => ChatSession;
