export const SHORT_SESSION_ID_LENGTH = 13;

export function shortSessionId(sessionId: string): string {
  return sessionId.slice(0, SHORT_SESSION_ID_LENGTH);
}
