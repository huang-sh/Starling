import assert from "node:assert/strict";
import test from "node:test";

import { createExtensionUiBridge } from "../lib/agent-host/extension-ui.js";
import {
  createInitialStarlingTuiState,
  parseStarlingKeys,
  reduceStarlingTui,
  renderStarlingFrame,
  StarlingInputDecoder,
} from "../lib/tui/index.js";
import { normalizeChatRecord, normalizeChatSnapshot } from "../lib/tui/events.js";

function dispatchRecord(state, record) {
  for (const event of normalizeChatRecord(record)) {
    state = reduceStarlingTui(state, { type: "chat.event", event });
  }
  return state;
}

test("terminal decoder handles modern, legacy, release, and split key sequences", () => {
  assert.deepEqual(
    parseStarlingKeys(
      "\u001bOH\u001b[3~\u001b[1;5D\u001b[99;5u\u001b[99;5:3u\u001b[27;3;13~"
      + "\u001b[57417u\u001b[57426u\u001b[57399u\u001b[1089::99;5u",
    ),
    [
      { type: "home" },
      { type: "delete" },
      { type: "left" },
      { type: "ctrl-c" },
      { type: "alt-enter" },
      { type: "left" },
      { type: "delete" },
      { type: "text", value: "0" },
      { type: "ctrl-c" },
    ],
  );

  const decoder = new StarlingInputDecoder();
  assert.deepEqual(decoder.push("\u001b[1;"), []);
  assert.deepEqual(decoder.push("5C"), [{ type: "right" }]);
});

test("composer and modal editor use grapheme-safe movable cursors", () => {
  let state = createInitialStarlingTuiState("/work/starling");
  state = reduceStarlingTui(state, { type: "composer.set", value: "a👩‍💻c\nxy" });
  state = reduceStarlingTui(state, { type: "composer.home" });
  state = reduceStarlingTui(state, { type: "composer.line", delta: -1 });
  state = reduceStarlingTui(state, { type: "composer.move", delta: 2 });
  state = reduceStarlingTui(state, { type: "composer.backspace" });
  assert.equal(state.composer, "ac\nxy");

  let combining = createInitialStarlingTuiState("/work/starling");
  combining = reduceStarlingTui(combining, { type: "composer.set", value: "\u0301" });
  combining = reduceStarlingTui(combining, { type: "composer.home" });
  combining = reduceStarlingTui(combining, { type: "composer.append", value: "e" });
  assert.equal(combining.composerCursor, "e\u0301".length);

  state = reduceStarlingTui(state, {
    type: "ui.open",
    prompt: {
      id: "editor-1",
      method: "editor",
      title: "Edit",
      message: "",
      options: [],
      selected: 0,
      value: "a👩‍💻c",
      cursor: "a👩‍💻".length,
    },
  });
  state = reduceStarlingTui(state, { type: "ui.backspace" });
  state = reduceStarlingTui(state, { type: "ui.append", value: "X" });
  assert.equal(state.uiPrompt.value, "aXc");

  let legacy = createInitialStarlingTuiState("/work/starling");
  legacy = reduceStarlingTui(legacy, {
    type: "ui.open",
    prompt: {
      id: "legacy-editor",
      method: "editor",
      title: "Edit",
      message: "",
      options: [],
      selected: 0,
      value: "👍🏽x",
    },
  });
  legacy = reduceStarlingTui(legacy, { type: "ui.backspace" });
  assert.equal(legacy.uiPrompt.value, "👍🏽", "older prompt objects edit from the end");
});

test("editor keeps exactly one cursor at wrap and newline boundaries", () => {
  let exact = createInitialStarlingTuiState("/work/starling");
  exact = reduceStarlingTui(exact, { type: "composer.set", value: "abcdefghijklm" });
  const exactFrame = renderStarlingFrame(exact, { width: 20, height: 20, color: false });
  assert.match(exactFrame, /╰─ › abcdefghijklm▏╯/);

  let multiline = createInitialStarlingTuiState("/work/starling");
  multiline = reduceStarlingTui(multiline, { type: "composer.set", value: "a\n" });
  multiline = reduceStarlingTui(multiline, { type: "composer.move", delta: -1 });
  const multilineFrame = renderStarlingFrame(multiline, { width: 40, height: 20, color: false });
  assert.equal(multilineFrame.match(/▏/g)?.length ?? 0, 1);
  assert.match(multilineFrame, /a▏/);

  let tall = createInitialStarlingTuiState("/work/starling");
  tall = reduceStarlingTui(tall, { type: "composer.set", value: "0\n1\n2\n3\n4\n5\n6" });
  tall = reduceStarlingTui(tall, { type: "composer.move", delta: -100 });
  const tallFrame = renderStarlingFrame(tall, { width: 40, height: 20, color: false });
  assert.equal(tallFrame.match(/▏/g)?.length ?? 0, 1);
  assert.match(tallFrame, /▏0/);

  let modal = createInitialStarlingTuiState("/work/starling");
  modal = reduceStarlingTui(modal, {
    type: "ui.open",
    prompt: {
      id: "cursor-editor",
      method: "editor",
      title: "Edit",
      message: "",
      options: [],
      selected: 0,
      value: "a👩‍💻c",
      cursor: 1,
    },
  });
  const modalFrame = renderStarlingFrame(modal, { width: 40, height: 20, color: false });
  assert.match(modalFrame, /a▏👩‍💻c/);
});

test("request failure restores the draft and removes its optimistic row", () => {
  let state = createInitialStarlingTuiState("/work/starling");
  state = { ...state, ready: true, phase: "ready" };
  state = reduceStarlingTui(state, {
    type: "prompt.submitted",
    text: "  keep spacing  ",
    queued: false,
  });
  state = reduceStarlingTui(state, {
    type: "prompt.rejected",
    text: "  keep spacing  ",
    queued: false,
    message: "transport closed",
  });
  assert.equal(state.composer, "  keep spacing  ");
  assert.equal(state.timeline.some((entry) => entry.kind === "user" && entry.pending), false);
  assert.equal(state.busy, false);
});

test("queued request failure preserves the active turn and repairs queue depth", () => {
  let state = createInitialStarlingTuiState("/work/starling");
  state = { ...state, ready: true, phase: "working", busy: true, queueDepth: 2 };
  state = reduceStarlingTui(state, {
    type: "prompt.submitted",
    text: "follow up",
    queued: true,
  });
  state = reduceStarlingTui(state, {
    type: "prompt.rejected",
    text: "follow up",
    queued: true,
    message: "queue closed",
  });
  assert.equal(state.busy, true);
  assert.equal(state.queueDepth, 2);
  assert.equal(state.composer, "follow up");

  state = reduceStarlingTui(state, {
    type: "prompt.submitted",
    text: "another",
    queued: true,
  });
  state = { ...state, busy: false, phase: "ready" };
  state = reduceStarlingTui(state, {
    type: "prompt.rejected",
    text: "another",
    queued: true,
    message: "late queue failure",
  });
  assert.equal(state.busy, false, "a late rejection must not resurrect a completed turn");
});

test("session compaction and extension UI state survive normalization and rendering", () => {
  let state = createInitialStarlingTuiState("/work/starling");
  state = reduceStarlingTui(state, {
    type: "chat.event",
    event: {
      type: "session.snapshot",
      snapshot: normalizeChatSnapshot({
        model: { provider: "openai", id: "gpt-test" },
        isCompacting: true,
      }, []),
    },
  });
  assert.equal(state.compacting, true);

  state = dispatchRecord(state, {
    type: "extension_ui_request",
    method: "setStatus",
    statusKey: "lint",
    statusText: "Checking",
  });
  state = dispatchRecord(state, {
    type: "extension_ui_request",
    method: "setWidget",
    widgetKey: "tests",
    widgetLines: ["12 passed"],
    widgetPlacement: "belowEditor",
  });
  state = dispatchRecord(state, {
    type: "extension_ui_request",
    method: "setTitle",
    title: "Starling · work",
  });
  state = reduceStarlingTui(state, { type: "composer.set", value: "hello" });
  state = reduceStarlingTui(state, { type: "composer.move", delta: -3 });

  const frame = renderStarlingFrame(state, { width: 80, height: 30, color: false });
  assert.match(frame, /he▏llo/);
  assert.match(frame, /lint · Checking/);
  assert.match(frame, /tests · 12 passed/);
  assert.equal(state.terminalTitle, "Starling · work");

  state = { ...state, sessionName: "Old name" };
  state = dispatchRecord(state, { type: "session_info_changed", name: "" });
  state = dispatchRecord(state, {
    type: "extension_ui_request",
    method: "setStatus",
    statusKey: "lint",
  });
  state = dispatchRecord(state, {
    type: "extension_ui_request",
    method: "setWidget",
    widgetKey: "tests",
  });
  assert.equal(state.sessionName, undefined);
  assert.equal(state.statusItems.lint, undefined);
  assert.equal(state.widgets.tests, undefined);
});

test("pasteToEditor appends instead of replacing the tracked editor text", () => {
  const output = [];
  const bridge = createExtensionUiBridge((value) => output.push(value));
  bridge.context.setEditorText("hello");
  bridge.context.pasteToEditor(" world");
  assert.equal(bridge.context.getEditorText(), "hello world");
  assert.equal(output.at(-1).text, "hello world");
});
