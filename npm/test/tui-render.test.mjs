import assert from "node:assert/strict";
import test from "node:test";

import {
  createInitialStarlingTuiState,
  reduceStarlingTui,
  renderStarlingFrame,
  visibleWidth,
} from "../lib/tui/index.js";

function fixtureState() {
  let state = createInitialStarlingTuiState("/work/nebula");
  state = reduceStarlingTui(state, {
    type: "starling.started",
    value: { runId: "run-123456", cwd: "/work/nebula" },
  });
  state = reduceStarlingTui(state, {
    type: "session.hydrated",
    state: {
      model: { provider: "openai", id: "gpt-5.3" },
      thinkingLevel: "high",
      sessionId: "session-42",
      sessionName: "Refactor",
    },
    messages: [
      { role: "user", content: "Inspect the workspace." },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Checking the project structure." },
          { type: "text", text: "I found three modules." },
        ],
      },
    ],
  });
  state = reduceStarlingTui(state, {
    type: "rpc.event",
    value: { type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: { path: "src/main.ts" } },
  });
  return reduceStarlingTui(state, {
    type: "rpc.event",
    value: { type: "tool_execution_end", toolCallId: "t1", toolName: "read", result: "42 lines", isError: false },
  });
}

function snapshot(frame) {
  return frame.split("\n").map((line) => line.trimEnd()).join("\n");
}

test("narrow terminal uses the original single-column Starling timeline", () => {
  const frame = renderStarlingFrame(fixtureState(), { width: 64, height: 18, color: false });
  assert.equal(snapshot(frame), ` STARLING  nebula                                         READY
 /work/nebula  ·  session Refactor  ·  openai/gpt-5.3  ·  thinki
────────────────────────────────────────────────────────────────

  YOU
    Inspect the workspace.

  STARLING
    ◌ Checking the project structure.
    I found three modules.

  ✓ TOOL · read
      42 lines
────────────────────────────────────────────────────────────────
 MESSAGE
 › Ask Starling to work in this workspace…
 ● Ready
 Enter send · Alt+Enter newline · Esc stop · PgUp/PgDn scroll ·`);
  assert.equal(frame.split("\n").length, 18);
  assert.ok(frame.split("\n").every((line) => visibleWidth(line) === 64));
});

test("wide terminal adds an activity rail without changing the conversation", () => {
  const frame = renderStarlingFrame(fixtureState(), { width: 112, height: 20, color: false });
  assert.equal(snapshot(frame), ` STARLING  nebula                                                                                         READY
 /work/nebula  ·  session Refactor  ·  openai/gpt-5.3  ·  thinking high
────────────────────────────────────────────────────────────────────────────────────────────────────────────────
                                                                                 │ ACTIVITY
                                                                                 │ ◆ runtime
                                                                                 │   Starling agent host
  YOU                                                                            │   started
    Inspect the workspace.                                                       │ ◆ read
                                                                                 │   Running
  STARLING                                                                       │ ✓ read
    ◌ Checking the project structure.                                            │   Completed
    I found three modules.                                                       │
                                                                                 │
  ✓ TOOL · read                                                                  │
      42 lines                                                                   │
────────────────────────────────────────────────────────────────────────────────────────────────────────────────
 MESSAGE
 › Ask Starling to work in this workspace…
 ● Ready
 Enter send · Alt+Enter newline · Esc stop · PgUp/PgDn scroll · Ctrl+C exit`);
  assert.ok(frame.includes("│ ACTIVITY"));
  assert.equal(frame.split("\n").length, 20);
  assert.ok(frame.split("\n").every((line) => visibleWidth(line) === 112));
});
