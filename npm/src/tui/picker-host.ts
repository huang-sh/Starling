import type { ChatSession, ChatSessionRequest } from "../chat/types.js";
import type { StarlingTuiAction, StarlingTuiState } from "./state.js";

export interface SessionMetadata {
  model?: string;
  thinking?: string;
  sessionName?: string;
  sessionId?: string;
  sessionFile?: string;
}

/**
 * Side-effect handle injected into picker key handlers so they can live outside
 * the runStarlingTui closure. `state`, `session`, and `closing` are snapshots
 * captured at call time; the callbacks are stable refs bound to the live loop.
 */
export interface PickerHost {
  readonly state: StarlingTuiState;
  readonly session: ChatSession | undefined;
  readonly closing: boolean;
  dispatch(action: StarlingTuiAction): void;
  sendSessionRequest(request: ChatSessionRequest): void;
  refreshSessionMetadata(): Promise<SessionMetadata | undefined>;
}

export function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
