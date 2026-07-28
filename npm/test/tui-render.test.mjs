import assert from "node:assert/strict";
import test from "node:test";

import {
  createInitialStarlingTuiState,
  reduceStarlingTui,
  renderStarlingFrame,
  visibleWidth,
} from "../lib/tui/index.js";
import {
  normalizeChatRecord,
  normalizeChatSnapshot,
} from "../lib/tui/events.js";

function dispatchRecord(state, record) {
  for (const event of normalizeChatRecord(record)) {
    state = reduceStarlingTui(state, { type: "chat.event", event });
  }
  return state;
}

function sessionState(messages = []) {
  let state = createInitialStarlingTuiState("/work/nebula");
  state = dispatchRecord(state, {
    type: "starling_started",
    runId: "run-123456",
    cwd: "/work/nebula",
  });
  return reduceStarlingTui(state, {
    type: "chat.event",
    event: {
      type: "session.snapshot",
      snapshot: normalizeChatSnapshot({
        model: { provider: "openai", id: "gpt-5.3" },
        thinkingLevel: "high",
        sessionId: "session-42",
        sessionName: "Refactor",
      }, messages),
    },
  });
}

function fixtureState() {
  let state = sessionState([
    { role: "user", content: "Inspect the workspace." },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Checking the project structure." },
        { type: "text", text: "I found three modules." },
      ],
    },
  ]);
  state = dispatchRecord(state, {
    type: "tool_execution_start",
    toolCallId: "t1",
    toolName: "read",
    args: { path: "src/main.ts" },
  });
  return dispatchRecord(state, {
    type: "tool_execution_end",
    toolCallId: "t1",
    toolName: "read",
    result: "42 lines",
    isError: false,
  });
}

function renderedLines(frame) {
  return frame.split("\n").map((line) => line.trimEnd());
}

function assertFits(lines, width) {
  for (const line of lines) {
    assert.ok(
      visibleWidth(line) <= width,
      `line is ${visibleWidth(line)} columns wide in a ${width}-column viewport: ${JSON.stringify(line)}`,
    );
  }
}

function longestBlankRun(lines) {
  let longest = 0;
  let current = 0;
  for (const line of lines) {
    if (line.length === 0) {
      current += 1;
      longest = Math.max(longest, current);
    } else {
      current = 0;
    }
  }
  return longest;
}

function countLiteral(value, needle) {
  return value.split(needle).length - 1;
}

function assertNoDashboardChrome(frame) {
  assert.doesNotMatch(frame, /^\s*✦\s*STARLING\s*\//m);
  assert.doesNotMatch(frame, /^\s*(?:YOU|STARLING)(?:\s|$)/m);
  assert.doesNotMatch(frame, /\bMESSAGE\b/);
  assert.doesNotMatch(frame, /^─{20,}\s*$/m);
  assert.doesNotMatch(frame, /│\s*(?:ACTIVITY|NOW|SESSION)\b/);
}

test("empty workspace keeps the same compact flow in short and tall terminals", () => {
  const state = sessionState();
  const short = renderedLines(renderStarlingFrame(state, {
    width: 80,
    height: 24,
    color: false,
  }));
  const tall = renderedLines(renderStarlingFrame(state, {
    width: 80,
    height: 60,
    color: false,
  }));

  assert.deepEqual(tall, short, "terminal height must not move the editor away from the transcript");
  assert.ok(short.length < 24, "an empty workspace should use intrinsic content height");
  assert.ok(longestBlankRun(short) <= 1, "sections may have one spacer, not a dashboard-sized void");
  assertFits(short, 80);
  assertNoDashboardChrome(short.join("\n"));
});

test("single-line composer ends the flow as a two-row OMP editor", () => {
  const lines = renderedLines(renderStarlingFrame(sessionState(), {
    width: 80,
    height: 24,
    color: false,
  }));
  const composer = lines.slice(-2);

  assert.equal(composer.length, 2);
  assert.match(composer[0], /^╭─/);
  assert.match(composer[0], /nebula/);
  assert.match(composer[0], /openai\/gpt-5\.3/);
  assert.match(composer[0], /high/);
  assert.match(composer[0], /╮$/);
  assert.match(composer[1], /^╰─/);
  assert.match(composer[1], /›/);
  assert.match(composer[1], /▏/);
  assert.match(composer[1], /╯$/);
  assertNoDashboardChrome(lines.join("\n"));
});

test("conversation content and tool state each render once without lifecycle noise", () => {
  const frame = renderStarlingFrame(fixtureState(), {
    width: 96,
    height: 32,
    color: false,
  });
  const lines = renderedLines(frame);

  for (const content of [
    "Inspect the workspace.",
    "Checking the project structure.",
    "I found three modules.",
    "42 lines",
  ]) {
    assert.equal(countLiteral(frame, content), 1, `${JSON.stringify(content)} should render exactly once`);
  }
  assert.equal(frame.match(/\bread\b/g)?.length ?? 0, 1, "one tool call must have one visual block");
  assert.doesNotMatch(
    frame,
    /Starling agent host started|Reasoning started|Agent settled|Prompt accepted|\bRunning\b|\bCompleted\b/,
  );
  assertNoDashboardChrome(frame);
  assertFits(lines, 96);
});

test("wide terminal keeps the compact single flow instead of adding a dashboard rail", () => {
  for (const width of [72, 120]) {
    const frame = renderStarlingFrame(fixtureState(), { width, height: 32, color: false });
    const lines = renderedLines(frame);

    for (const content of ["Inspect the workspace.", "I found three modules.", "42 lines"]) {
      assert.equal(countLiteral(frame, content), 1);
    }
    assertNoDashboardChrome(frame);
    assertFits(lines, width);
  }
});

test("multiline composer adds middle rows and keeps the final line in the bottom border", () => {
  let state = sessionState();
  state = reduceStarlingTui(state, {
    type: "composer.set",
    value: "first line\nsecond line",
  });
  const lines = renderedLines(renderStarlingFrame(state, {
    width: 64,
    height: 24,
    color: false,
  }));
  const composer = lines.slice(-3);

  assert.equal(composer.length, 3);
  assert.match(composer[0], /^╭─.*openai\/gpt-5\.3.*╮$/);
  assert.match(composer[1], /^│.*first line.*│$/);
  assert.match(composer[2], /^╰─.*second line.*▏.*╯$/);
  assert.match(composer.join("\n"), /›/);
  assertNoDashboardChrome(lines.join("\n"));
  assertFits(lines, 64);
});

test("interactive requests render as a compact fail-closed action box", () => {
  let state = fixtureState();
  state = dispatchRecord(state, {
    type: "extension_ui_request",
    id: "permission-1",
    method: "confirm",
    title: "Allow shell?",
    message: "npm test",
  });
  const frame = renderStarlingFrame(state, { width: 72, height: 32, color: false, tick: 2 });
  const lines = renderedLines(frame);

  assert.match(frame, /╭─ PERMISSION REQUIRED/);
  assert.ok(lines.some((line) => line.startsWith("│ npm test") && line.endsWith("│")));
  assert.ok(lines.some((line) => line.includes("[No]") && line.endsWith("│")));
  assert.match(frame, /Esc deny/);
  assert.ok(lines.length < 32, "an inline request must not expand to the full terminal height");
  assertNoDashboardChrome(frame);
  assertFits(lines, 72);
});

test("slash commands render inline above the editor with bounded selection", () => {
  let state = sessionState();
  state = reduceStarlingTui(state, {
    type: "slash.loaded",
    commands: Array.from({ length: 10 }, (_, index) => ({
      name: `extension-${index}`,
      description: `Extension command ${index}`,
      source: "extension",
    })),
  });
  state = reduceStarlingTui(state, { type: "composer.set", value: "/" });
  state = reduceStarlingTui(state, { type: "slash.select", delta: 9 });
  const frame = renderStarlingFrame(state, { width: 80, height: 18, color: false });
  const lines = renderedLines(frame);

  assert.match(frame, /\/extension-1/);
  assert.match(frame, /\[extension\]/);
  assert.match(frame, /↑\/↓ select · Tab\/Enter complete · Esc close/);
  assert.equal(frame.match(/^\s*[› ] \/[^\s]+/gm)?.length, 8, "menu shows at most eight rows");
  assert.equal(lines.at(-1).startsWith("╰─"), true, "composer remains the final row");
  assert.ok(lines.length <= 18);
  assertFits(lines, 80);
});

test("renderer sanitizes terminal controls and preserves Unicode cell width", () => {
  let state = createInitialStarlingTuiState("/work/星鸟");
  state = reduceStarlingTui(state, {
    type: "chat.event",
    event: {
      type: "message.started",
      message: {
        kind: "assistant",
        text: "safe\u001b[2J内容\t😀\u001b]0;owned\u0007\u001bPpayload\u001b\\",
        pending: true,
      },
    },
  });
  const frame = renderStarlingFrame(state, { width: 48, height: 14, color: false });
  const lines = renderedLines(frame);

  assert.doesNotMatch(frame, /\u001b\[2J/);
  assert.doesNotMatch(frame, /owned|payload|\u0007|\u001b/);
  assert.match(frame, /safe内容  😀/);
  assertFits(lines, 48);
});

test("renderer never exceeds a tiny physical viewport", () => {
  const frame = renderStarlingFrame(fixtureState(), {
    width: 8,
    height: 4,
    color: false,
  });
  const lines = renderedLines(frame);

  assert.ok(lines.length <= 4);
  assertFits(lines, 8);
});

test("cell width follows grapheme clusters for joined and modified emoji", () => {
  assert.equal(visibleWidth("👩‍💻"), 2);
  assert.equal(visibleWidth("👍🏽"), 2);
  assert.equal(visibleWidth("🇨🇳"), 2);
  assert.equal(visibleWidth("e\u0301"), 1);
});

test("unterminated and C1 terminal controls are removed with their payload", () => {
  let state = createInitialStarlingTuiState("/work/safe");
  state = reduceStarlingTui(state, {
    type: "chat.event",
    event: {
      type: "message.started",
      message: {
        kind: "assistant",
        text: "visible\u001b]52;c;secret\u009d0;also-secret\u009cend",
        pending: true,
      },
    },
  });
  const frame = renderStarlingFrame(state, { width: 48, height: 14, color: false });

  assert.match(frame, /visible/);
  assert.doesNotMatch(frame, /secret|also-secret|\u001b|\u009d|\u009c/);
  assertFits(renderedLines(frame), 48);
});
