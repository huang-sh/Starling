import assert from "node:assert/strict";
import test from "node:test";

import {
  createExtensionUiPrompt,
  createInitialStarlingTuiState,
  reduceStarlingTui,
} from "../lib/tui/index.js";
import {
  MAX_TOOL_TEXT_BYTES,
  normalizeChatRecord,
  normalizeChatSnapshot,
} from "../lib/tui/events.js";
import { MAX_JSONL_LINE_BYTES, StrictJsonlDecoder } from "../lib/tui/protocol.js";

function dispatchRecords(state, records) {
  for (const record of records) {
    for (const event of normalizeChatRecord(record)) {
      state = reduceStarlingTui(state, { type: "chat.event", event });
    }
  }
  return state;
}

test("TUI reducer hydrates a normalized session and consumes semantic chat events", () => {
  const initial = createInitialStarlingTuiState("/work/starling");
  const snapshot = normalizeChatSnapshot({
    model: { provider: "anthropic", id: "claude-test" },
    thinkingLevel: "high",
    sessionId: "session-1",
    isStreaming: false,
  }, [{ role: "user", content: "Hello" }]);
  const hydrated = reduceStarlingTui(initial, {
    type: "chat.event",
    event: { type: "session.snapshot", snapshot },
  });

  assert.equal(initial.timeline.length, 0, "the reducer must not mutate its input");
  assert.equal(hydrated.ready, true);
  assert.equal(hydrated.model, "anthropic/claude-test");
  assert.equal(hydrated.timeline[0].text, "Hello");

  const streamed = dispatchRecords(hydrated, [
    { type: "message_start", message: { role: "assistant", content: [] } },
    { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "Plan" } },
    { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Done" } },
    { type: "agent_settled" },
  ]);

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
  assert.deepEqual(state.activity, []);
  state = dispatchRecords(state, [
    { type: "message_start", message: { role: "user", content: "Run tests" } },
  ]);
  assert.equal(state.timeline.length, 1);
  assert.equal(state.timeline[0].pending, false);
});

test("successful lifecycle events stay out of permanent activity", () => {
  let state = createInitialStarlingTuiState("/work/starling");
  state = dispatchRecords(state, [
    { type: "starling_started", cwd: "/work/starling", runId: "run-1" },
    { type: "agent_start" },
    {
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "read",
      args: { path: "src/main.ts" },
    },
    {
      type: "tool_execution_update",
      toolCallId: "tool-1",
      partialResult: "partial output",
    },
    {
      type: "tool_execution_end",
      toolCallId: "tool-1",
      toolName: "read",
      result: "42 lines",
      isError: false,
    },
    { type: "agent_settled" },
    { type: "starling_exited", success: true, exitCode: 0 },
  ]);

  assert.deepEqual(state.activity, []);
  assert.equal(state.timeline.length, 1);
  assert.deepEqual(state.timeline[0], {
    id: state.timeline[0].id,
    kind: "tool",
    text: "42 lines",
    toolCallId: "tool-1",
    toolName: "read",
    toolState: "done",
  });
  assert.equal(state.status, "Session closed");
});

test("failures, retries, compaction, diagnostics, and explicit activity remain visible", () => {
  let state = createInitialStarlingTuiState("/work/starling");
  state = dispatchRecords(state, [
    { type: "auto_retry_start", attempt: 2, errorMessage: "rate limited" },
    { type: "compaction_start" },
    { type: "notice", level: "warning", message: "check configuration" },
    { type: "bash_execution_update", delta: "running command" },
    { type: "starling_exited", success: false, exitCode: 1 },
  ]);

  assert.deepEqual(state.activity.map(({ label, tone }) => ({ label, tone })), [
    { label: "retry", tone: "active" },
    { label: "context", tone: "active" },
    { label: "log", tone: "neutral" },
    { label: "shell", tone: "active" },
    { label: "runtime", tone: "error" },
  ]);
});

test("normalizer consumes official Pi thinking, compaction, and retry events", () => {
  let state = createInitialStarlingTuiState("/work/starling");
  state = dispatchRecords(state, [
    { type: "thinking_level_changed", level: "xhigh" },
    { type: "compaction_start", reason: "threshold" },
    { type: "compaction_end", errorMessage: "context failed" },
    { type: "auto_retry_start", attempt: 2, errorMessage: "rate limited" },
  ]);

  assert.equal(state.thinking, "xhigh");
  assert.equal(state.status, "Retrying (2)…");
  assert.ok(state.activity.some((entry) => entry.label === "context" && entry.tone === "error"));
  assert.ok(state.activity.some((entry) => entry.label === "retry" && entry.detail === "rate limited"));
});

test("Pi extension presentation controls update Starling-owned UI state", () => {
  let state = createInitialStarlingTuiState("/work/starling");
  state = dispatchRecords(state, [
    { type: "extension_ui_request", id: "working", method: "setWorkingMessage", message: "Indexing" },
    { type: "extension_ui_request", id: "visible", method: "setWorkingVisible", visible: false },
    { type: "extension_ui_request", id: "indicator", method: "setWorkingIndicator", options: { frames: ["A", "B"] } },
    { type: "extension_ui_request", id: "thinking", method: "setHiddenThinkingLabel", label: "Reasoning folded" },
    { type: "extension_ui_request", id: "tools", method: "setToolsExpanded", expanded: true },
    { type: "agent_start" },
  ]);

  assert.equal(state.status, "Indexing");
  assert.equal(state.workingVisible, false);
  assert.deepEqual(state.workingIndicatorFrames, ["A", "B"]);
  assert.equal(state.hiddenThinkingLabel, "Reasoning folded");
  assert.equal(state.toolsExpanded, true);
});

test("Pi assistant errors and aborts remain visible after live message completion", () => {
  let state = createInitialStarlingTuiState("/work/starling");
  state = dispatchRecords(state, [
    { type: "message_start", message: { role: "assistant", content: [] } },
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "Authentication failed",
      },
    },
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        stopReason: "aborted",
      },
    },
  ]);

  assert.equal(state.timeline[0].pending, false, "the failed assistant placeholder must settle");
  assert.ok(state.activity.some((entry) =>
    entry.label === "error"
    && entry.tone === "error"
    && entry.detail === "Authentication failed"));
  assert.ok(state.activity.some((entry) =>
    entry.label === "log"
    && entry.tone === "neutral"
    && entry.detail === "Request aborted"));
});

test("Pi assistant errors and aborts survive transcript history normalization", () => {
  const snapshot = normalizeChatSnapshot({}, [
    {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "Provider unavailable",
    },
    {
      role: "assistant",
      content: [],
      stopReason: "aborted",
    },
  ]);

  assert.deepEqual(snapshot.transcript, [
    { kind: "error", text: "Provider unavailable" },
    { kind: "system", text: "Request aborted" },
  ]);
});

test("normalizer ignores non-Pi compatibility field names", () => {
  assert.deepEqual(normalizeChatRecord({
    type: "message_update",
    event: { type: "text_delta", delta: "legacy" },
  }), []);
  assert.deepEqual(normalizeChatRecord({
    type: "thinking_level_changed",
    thinkingLevel: "xhigh",
  }), []);
  assert.deepEqual(normalizeChatRecord({ type: "auto_compaction_start" }), []);
  assert.deepEqual(normalizeChatRecord({ type: "auto_compaction_end" }), []);
});

test("tool output is capped by UTF-8 bytes", () => {
  const [event] = normalizeChatRecord({
    type: "tool_execution_end",
    toolCallId: "large-tool",
    toolName: "read",
    result: "界".repeat(MAX_TOOL_TEXT_BYTES),
  });

  assert.equal(event.type, "tool.completed");
  assert.ok(Buffer.byteLength(event.output, "utf8") <= MAX_TOOL_TEXT_BYTES);
  assert.match(event.output, /tool output truncated by Starling/);
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
    secret: false,
    cursor: 0,
  });
});

test("slash menu follows composer edits, selection, dismissal, and command lifecycle", () => {
  let state = createInitialStarlingTuiState("/work/starling");
  state = reduceStarlingTui(state, {
    type: "slash.loaded",
    commands: [
      { name: "review", description: "Review changes", source: "prompt" },
      { name: "skill:check", description: "Check project", source: "skill" },
    ],
  });
  state = reduceStarlingTui(state, { type: "composer.append", value: "/" });
  assert.equal(state.slashMenuOpen, true);
  assert.equal(state.slashSelected, 0);

  state = reduceStarlingTui(state, { type: "slash.select", delta: -1 });
  assert.equal(state.slashSelected, state.slashCommands.length - 1, "selection must wrap");
  state = reduceStarlingTui(state, { type: "composer.append", value: "rev" });
  assert.equal(state.slashSelected, 0, "editing resets selection to the first match");
  assert.equal(state.slashMenuOpen, true);

  state = reduceStarlingTui(state, { type: "slash.dismiss" });
  assert.equal(state.slashMenuOpen, false);
  assert.equal(state.composer, "/rev");
  state = reduceStarlingTui(state, { type: "composer.append", value: "iew " });
  assert.equal(state.slashMenuOpen, false, "argument entry keeps the menu closed");

  state = reduceStarlingTui(state, { type: "command.submitted", name: "review" });
  assert.equal(state.composer, "");
  assert.equal(state.busy, false, "slash submission must not fake an agent turn");
  assert.equal(state.timeline.length, 0, "dynamic commands own their transcript rows");
  state = reduceStarlingTui(state, { type: "command.completed", message: "Review complete" });
  assert.deepEqual(state.timeline.at(-1), {
    id: state.timeline.at(-1).id,
    kind: "system",
    text: "Review complete",
  });

  state = reduceStarlingTui(state, {
    type: "chat.event",
    event: { type: "composer.replaced", value: "/skill:" },
  });
  assert.equal(state.slashMenuOpen, true, "extension editor replacement must refresh slash state");
  assert.equal(state.slashSelected, 0);
});

test("compaction is independently interruptible and cancellation is not reported as success", () => {
  let state = createInitialStarlingTuiState("/work/starling");
  state = dispatchRecords(state, [{ type: "compaction_start", reason: "manual" }]);
  assert.equal(state.compacting, true);
  assert.equal(state.phase, "working");
  assert.equal(state.status, "Compacting context…");

  state = dispatchRecords(state, [{
    type: "compaction_end",
    reason: "manual",
    aborted: true,
    willRetry: false,
  }]);
  assert.equal(state.compacting, false);
  assert.equal(state.phase, "ready");
  assert.equal(state.status, "Compaction cancelled");
  assert.deepEqual(state.activity.map(({ label, detail, tone }) => ({ label, detail, tone })), [
    { label: "context", detail: "Compacting", tone: "active" },
    { label: "context", detail: "Compaction cancelled", tone: "neutral" },
  ]);
});

test("session tree navigation keeps tree, summary, and custom-prompt stages explicit", () => {
  let state = createInitialStarlingTuiState("/work/starling");
  const entries = [
    {
      id: "root",
      parentId: null,
      type: "message",
      text: "user: start",
      prefix: "",
      onActivePath: true,
      current: false,
    },
    {
      id: "leaf",
      parentId: "root",
      type: "message",
      text: "assistant: done",
      prefix: "└─ ",
      onActivePath: true,
      current: true,
    },
  ];
  state = reduceStarlingTui(state, { type: "tree.open", entries, leafId: "leaf" });
  assert.equal(state.treePicker.selected, 1, "the current Pi leaf starts selected");

  state = reduceStarlingTui(state, { type: "tree.select", delta: -1 });
  assert.equal(state.treePicker.selected, 0);
  state = reduceStarlingTui(state, { type: "tree.summary.open", targetId: "root" });
  assert.equal(state.treePicker.stage, "summary");
  state = reduceStarlingTui(state, { type: "tree.summary.select", delta: 2 });
  assert.equal(state.treePicker.summarySelected, 2);
  state = reduceStarlingTui(state, { type: "tree.custom.open" });
  state = reduceStarlingTui(state, { type: "tree.custom.append", value: "Keep decisions" });
  assert.equal(state.treePicker.customPrompt, "Keep decisions");
  state = reduceStarlingTui(state, { type: "tree.working" });
  state = reduceStarlingTui(state, { type: "tree.failed", message: "cancelled" });
  assert.equal(state.treePicker.working, false);
  assert.equal(state.treePicker.error, "cancelled");
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

  const errors = [];
  const bounded = new StrictJsonlDecoder((error) => errors.push(error.message));
  assert.deepEqual(
    bounded.push(`${"x".repeat(MAX_JSONL_LINE_BYTES + 1)}\n{"recovered":true}\n`),
    ['{"recovered":true}'],
  );
  assert.deepEqual(errors, [`JSONL line exceeds ${MAX_JSONL_LINE_BYTES} bytes`]);
});

test("input history recalls submitted prompts and slash commands via Up/Down", () => {
  let state = createInitialStarlingTuiState("/work/starling");
  state = reduceStarlingTui(state, { type: "composer.set", value: "hello world" });
  state = reduceStarlingTui(state, { type: "history.push", text: "hello world" });
  state = reduceStarlingTui(state, { type: "composer.set", value: "/login" });
  state = reduceStarlingTui(state, { type: "history.push", text: "/login" });
  assert.deepEqual(state.inputHistory, ["hello world", "/login"]);
  assert.equal(state.historyIndex, 2);
  // submitComposer clears the composer after pushing history.
  state = reduceStarlingTui(state, { type: "composer.set", value: "" });

  state = reduceStarlingTui(state, { type: "history.prev" });
  assert.equal(state.composer, "/login");
  state = reduceStarlingTui(state, { type: "history.prev" });
  assert.equal(state.composer, "hello world");
  const oldest = reduceStarlingTui(state, { type: "history.prev" });
  assert.equal(oldest.composer, "hello world");

  state = reduceStarlingTui(state, { type: "history.next" });
  assert.equal(state.composer, "/login");
  state = reduceStarlingTui(state, { type: "history.next" });
  assert.equal(state.composer, "");
  assert.equal(state.historyIndex, state.inputHistory.length);
  const newest = reduceStarlingTui(state, { type: "history.next" });
  assert.equal(newest.composer, "");
});

test("history preserves an unsent draft and collapses consecutive duplicates", () => {
  let state = createInitialStarlingTuiState("/work/starling");
  state = reduceStarlingTui(state, { type: "history.push", text: "first" });
  state = reduceStarlingTui(state, { type: "composer.set", value: "a draft in progress" });
  state = reduceStarlingTui(state, { type: "history.prev" });
  assert.equal(state.composer, "first");
  state = reduceStarlingTui(state, { type: "history.next" });
  assert.equal(state.composer, "a draft in progress", "unsent draft is restored");

  state = reduceStarlingTui(state, { type: "history.push", text: "first" });
  state = reduceStarlingTui(state, { type: "history.push", text: "first" });
  assert.deepEqual(state.inputHistory, ["first"]);
});

test("session snapshot seeds history from prior user turns", () => {
  let state = createInitialStarlingTuiState("/work/starling");
  state = dispatchRecords(state, [{ type: "starling_started", runId: "r", cwd: "/work/starling" }]);
  const snapshot = normalizeChatSnapshot(
    { model: { provider: "p", id: "m" }, thinkingLevel: "high" },
    [
      { role: "user", content: "earlier question" },
      { role: "assistant", content: "an answer" },
      { role: "user", content: "follow up" },
      { role: "user", content: "follow up" },
    ],
  );
  state = reduceStarlingTui(state, { type: "chat.event", event: { type: "session.snapshot", snapshot } });
  assert.deepEqual(state.inputHistory, ["earlier question", "follow up"]);
  assert.equal(state.historyIndex, state.inputHistory.length);
  state = reduceStarlingTui(state, { type: "history.prev" });
  assert.equal(state.composer, "follow up");
  state = reduceStarlingTui(state, { type: "history.prev" });
  assert.equal(state.composer, "earlier question");
});
