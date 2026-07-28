import assert from "node:assert/strict";
import test from "node:test";

import {
  createExtensionUiPrompt,
  createInitialStarlingTuiState,
  reduceStarlingTui,
} from "../lib/tui/index.js";
import { StrictJsonlDecoder } from "../lib/tui/protocol.js";

test("TUI reducer hydrates a Pi session and consumes streamed agent events", () => {
  const initial = createInitialStarlingTuiState("/work/starling");
  const hydrated = reduceStarlingTui(initial, {
    type: "session.hydrated",
    state: {
      model: { provider: "anthropic", id: "claude-test" },
      thinkingLevel: "high",
      sessionId: "session-1",
      isStreaming: false,
    },
    messages: [{ role: "user", content: "Hello" }],
  });

  assert.equal(initial.timeline.length, 0, "the reducer must not mutate its input");
  assert.equal(hydrated.ready, true);
  assert.equal(hydrated.model, "anthropic/claude-test");
  assert.equal(hydrated.timeline[0].text, "Hello");

  let streamed = reduceStarlingTui(hydrated, {
    type: "rpc.event",
    value: { type: "message_start", message: { role: "assistant", content: [] } },
  });
  streamed = reduceStarlingTui(streamed, {
    type: "rpc.event",
    value: { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "Plan" } },
  });
  streamed = reduceStarlingTui(streamed, {
    type: "rpc.event",
    value: { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Done" } },
  });
  streamed = reduceStarlingTui(streamed, {
    type: "rpc.event",
    value: { type: "agent_settled" },
  });

  assert.deepEqual(streamed.timeline.at(-1), {
    id: streamed.timeline.at(-1).id,
    kind: "assistant",
    text: "Done",
    thinking: "Plan",
    pending: true,
  });
  assert.equal(streamed.busy, false);
  assert.equal(streamed.status, "Ready");
});

test("optimistic user message is reconciled instead of duplicated", () => {
  let state = createInitialStarlingTuiState("/work/starling");
  state = reduceStarlingTui(state, { type: "prompt.submitted", text: "Run tests", queued: false });
  state = reduceStarlingTui(state, {
    type: "rpc.event",
    value: { type: "message_start", message: { role: "user", content: "Run tests" } },
  });
  assert.equal(state.timeline.length, 1);
  assert.equal(state.timeline[0].pending, false);
});

test("confirmation prompts default to deny", () => {
  assert.deepEqual(createExtensionUiPrompt({
    type: "extension_ui_request",
    id: "permission-1",
    method: "confirm",
    title: "Allow shell?",
    message: "npm test",
  }), {
    id: "permission-1",
    method: "confirm",
    title: "Allow shell?",
    message: "npm test",
    options: ["No", "Yes"],
    selected: 0,
    value: "",
  });
});

test("strict JSONL decoder preserves Unicode line separators and UTF-8 chunks", () => {
  const decoder = new StrictJsonlDecoder();
  const encoded = Buffer.from('{"text":"一 二"}\n{"ok":true}\r\n', "utf8");
  const lines = [
    ...decoder.push(encoded.subarray(0, 12)),
    ...decoder.push(encoded.subarray(12)),
    ...decoder.end(),
  ];
  assert.deepEqual(lines, ['{"text":"一 二"}', '{"ok":true}']);
});
