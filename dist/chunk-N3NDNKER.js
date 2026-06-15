#!/usr/bin/env node

// src/lib/sessionDisplay.ts
var SHORT_SESSION_ID_LENGTH = 13;
function shortSessionId(sessionId) {
  return sessionId.slice(0, SHORT_SESSION_ID_LENGTH);
}

export {
  shortSessionId
};
