import assert from "node:assert/strict";
import test from "node:test";

import {
  availableModelsFromResponse,
  createInitialStarlingTuiState,
  reduceStarlingTui,
  renderStarlingFrame,
  visibleWidth,
} from "../lib/tui/index.js";
import {
  normalizeChatRecord,
  normalizeChatSnapshot,
} from "../lib/tui/events.js";
import { treePickerFromResponse } from "../lib/tui/tree-picker.js";

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
  assert.match(composer[1], /^› /);
  assert.match(composer[1], /›/);
  assert.match(composer[1], /▏/);
  assert.doesNotMatch(composer[1], /[╰╯─]/);
  assertNoDashboardChrome(lines.join("\n"));
});

test("composer input keeps the terminal default style after the cyan prompt", () => {
  let state = sessionState();
  state = reduceStarlingTui(state, {
    type: "composer.set",
    value: "typed text",
  });
  const frame = renderStarlingFrame(state, {
    width: 80,
    height: 24,
    color: true,
  });

  assert.match(
    frame,
    /\u001b\[1;36m› \u001b\[0mtyped text\u001b\[1;36m▏/,
    "only the composer prompt and cursor should be cyan; typed text must not receive a color",
  );

  state = reduceStarlingTui(state, { type: "composer.move", delta: -1 });
  const movedCursorFrame = renderStarlingFrame(state, {
    width: 80,
    height: 24,
    color: true,
  });
  assert.match(
    movedCursorFrame,
    /\u001b\[0mtyped tex\u001b\[1;36m▏\u001b\[0mt\u001b\[1;36m /,
    "text on both sides of the cyan cursor must keep the terminal default style",
  );
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

test("multiline composer adds middle rows and keeps an unframed final prompt", () => {
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
  assert.match(composer[2], /^› .*second line.*▏$/);
  assert.doesNotMatch(composer[2], /[╰╯─]/);
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
  assert.ok(lines.some((line) => line.includes("› No") && line.endsWith("│")));
  assert.match(frame, /Esc deny/);
  assert.ok(lines.length < 32, "an inline request must not expand to the full terminal height");
  assertNoDashboardChrome(frame);
  assertFits(lines, 72);
});

test("authentication inputs are masked and provider choices render vertically", () => {
  let state = sessionState();
  state = dispatchRecord(state, {
    type: "extension_ui_request",
    id: "api-key",
    method: "input",
    title: "Anthropic API key",
    message: "Paste your API key",
    secret: true,
  });
  state = reduceStarlingTui(state, { type: "ui.append", value: "sk-sensitive-value" });
  let frame = renderStarlingFrame(state, { width: 72, height: 24, color: false });

  assert.doesNotMatch(frame, /sk-sensitive-value/);
  assert.match(frame, /••••/);

  state = reduceStarlingTui(state, { type: "ui.close" });
  state = dispatchRecord(state, {
    type: "extension_ui_request",
    id: "provider",
    method: "select",
    title: "Select provider",
    options: ["Anthropic", "OpenAI Codex", "GitHub Copilot"],
  });
  state = reduceStarlingTui(state, { type: "ui.select", delta: 1 });
  frame = renderStarlingFrame(state, { width: 72, height: 24, color: false });
  assert.match(frame, /^│ › OpenAI Codex/m);
  assert.match(frame, /^│   Anthropic/m);
});

test("a long OAuth URL in a login dialog stays clickable across wrapped rows", () => {
  let state = sessionState();
  const url = "https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_EMoamEEZ73f0CkXaXp7hrann&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&scope=openid+profile+email&code_challenge=AcSZqUY8pOeRpx8HJPOkyF_WOof4xm";
  state = dispatchRecord(state, {
    type: "extension_ui_request",
    id: "auth-url",
    method: "input",
    title: "Login to OpenAI Codex",
    message: `A browser window should open. Complete login to finish.\nOpen this URL to continue:\n${url}\n\nPaste the authorization code here:`,
  });
  const frame = renderStarlingFrame(state, { width: 72, height: 18, color: true, tick: 1 });
  const urlRows = frame.split("\n").filter((l) => /auth\.openai|response_type|redirect_uri|code_challenge/.test(l));
  assert.ok(urlRows.length > 1, "the URL wraps across multiple rows");
  // Every wrapped row is an OSC 8 hyperlink to the FULL url and underlined.
  for (const row of urlRows) {
    assert.ok(row.includes(`\u001b]8;;${url}\u001b\\`), "wrapped URL row links to the full URL");
    assert.ok(row.includes("\u001b[4;36m"), "wrapped URL row is underlined + cyan");
  }
  // Prose on the same dialog is not turned into a link.
  const prose = frame.split("\n").find((l) => l.includes("browser window"));
  assert.ok(prose && !prose.includes("\u001b]8;;"), "prose row is not a hyperlink");
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
  assert.match(frame, /↑\/↓ select · Tab complete · Enter run · Esc close/);
  assert.equal(frame.match(/^\s*[› ] \/[a-z][^\s]*/gm)?.length, 8, "menu shows at most eight rows");
  assert.equal(lines.at(-1).startsWith("›"), true, "composer remains the final row");
  assert.ok(lines.length <= 18);
  assertFits(lines, 80);
});

test("model picker mirrors OMP search, provider tabs, and current-model selection", () => {
  let state = sessionState();
  const models = availableModelsFromResponse({
    models: [
      { provider: "openai", id: "gpt-5.5", name: "GPT 5.5", reasoning: true, contextWindow: 200_000 },
      { provider: "zai", id: "glm-5.2", name: "GLM-5.2", reasoning: true, contextWindow: 128_000 },
      { provider: "zhipu-coding-plan", id: "glm-5.1", name: "GLM-5.1", reasoning: true, contextWindow: 200_000 },
      { provider: "anthropic", id: "claude-opus-5", name: "Claude Opus 5", contextWindow: 200_000 },
    ],
  });
  state = reduceStarlingTui(state, {
    type: "model.open",
    models,
    current: "zai/glm-5.2",
    roles: {
      default: "zai/glm-5.2",
      slow: "openai/gpt-5.5:high",
    },
  });

  let frame = renderStarlingFrame(state, { width: 86, height: 24, color: false });
  assert.match(frame, /Models:\s+\[ALL\].*ANTHROPIC.*OPENAI.*ZAI/);
  assert.match(frame, /ZHIPU CODING PLAN/, "hyphenated provider IDs render as readable OMP-style tabs");
  assert.doesNotMatch(frame, /Pi SDK agent workspace/, "the modal picker replaces the workspace chrome");
  assert.match(frame, /^› zai\/glm-5\.2\s+CURRENT/m, "current model is initially selected and promoted");
  assert.match(frame, /zai\/glm-5\.2\s+CURRENT\s+DEFAULT/);
  assert.match(frame, /Model Name: GLM-5\.2/);
  assert.match(frame, /↑\/↓ select · Tab provider · Enter use · type to search · Esc close/);

  state = reduceStarlingTui(state, { type: "model.provider", delta: 1 });
  frame = renderStarlingFrame(state, { width: 86, height: 24, color: false });
  assert.match(frame, /Models:\s+ALL.*\[ANTHROPIC\]/);
  assert.match(frame, /claude-opus-5/);
  assert.doesNotMatch(frame, /gpt-5\.5/);

  state = reduceStarlingTui(state, { type: "model.provider", delta: -1 });
  state = reduceStarlingTui(state, { type: "model.query.append", value: "g55" });
  frame = renderStarlingFrame(state, { width: 86, height: 24, color: false });
  assert.match(frame, /^› openai\/gpt-5\.5\s+SLOW/m, "fuzzy search matches model IDs and shows role tags");
  assert.doesNotMatch(frame, /claude-opus-5/);
  assertFits(renderedLines(frame), 86);

  const selected = state.modelPicker.models.find((model) => model.id === "gpt-5.5");
  assert.ok(selected);
  state = reduceStarlingTui(state, { type: "model.action.open", model: selected });
  frame = renderStarlingFrame(state, { width: 86, height: 24, color: false });
  assert.match(frame, /Action for: gpt-5\.5/);
  assert.match(frame, /^› Set as DEFAULT \(Default\)\s*$/m);
  assert.match(frame, /Set as SMOL \(Fast\)/);
  assert.match(frame, /Set as SLOW \(Thinking\)\s+CURRENT/);
  assert.match(frame, /Set as ADVISOR \(Advisor\)/);
  assert.match(frame, /Enter: continue  Esc: cancel/);

  state = reduceStarlingTui(state, { type: "model.action.select", delta: 1 });
  frame = renderStarlingFrame(state, { width: 86, height: 24, color: false });
  assert.match(frame, /^› Set as SMOL \(Fast\)\s*$/m);
  state = reduceStarlingTui(state, { type: "model.thinking.open" });
  frame = renderStarlingFrame(state, { width: 86, height: 24, color: false });
  assert.match(frame, /Thinking for: gpt-5\.5 · SMOL/);
  assert.match(frame, /^› inherit\s+Inherit session default\s*$/m);
  assert.match(frame, /off\s+No reasoning/);
  assert.match(frame, /high\s+Deep reasoning/);
  assert.doesNotMatch(frame, /xhigh|Maximum reasoning/, "Pi only exposes opt-in levels declared by the model");
  state = reduceStarlingTui(state, { type: "model.thinking.select", delta: 5 });
  frame = renderStarlingFrame(state, { width: 86, height: 24, color: false });
  assert.match(frame, /^› high\s+Deep reasoning\s*$/m);
  state = reduceStarlingTui(state, { type: "model.thinking.close" });
  assert.equal(state.modelPicker.stage, "actions");
  state = reduceStarlingTui(state, { type: "model.action.close" });
  assert.equal(state.modelPicker.stage, "models");
});

test("tree picker shows Pi branches and the three-step summary choice", () => {
  let state = sessionState();
  const tree = treePickerFromResponse({
    leafId: "leaf",
    tree: [{
      entry: {
        id: "root",
        parentId: null,
        type: "message",
        message: { role: "user", content: "initial task" },
      },
      children: [
        {
          entry: {
            id: "leaf",
            parentId: "root",
            type: "message",
            message: { role: "assistant", content: "current result" },
          },
          children: [],
        },
        {
          entry: {
            id: "branch",
            parentId: "root",
            type: "message",
            message: { role: "user", content: "alternate path" },
          },
          label: "experiment",
          children: [],
        },
      ],
    }],
  });
  state = reduceStarlingTui(state, { type: "tree.open", ...tree });

  let frame = renderStarlingFrame(state, { width: 88, height: 24, color: false });
  assert.match(frame, /^SESSION TREE/m);
  assert.match(frame, /current result.*CURRENT/);
  assert.match(frame, /alternate path.*\[experiment\]/);
  assert.match(frame, /↑\/↓ select · Enter navigate · type to search · Esc close/);
  assert.doesNotMatch(frame, /Pi SDK agent workspace/);
  assertFits(renderedLines(frame), 88);

  state = reduceStarlingTui(state, { type: "tree.summary.open", targetId: "branch" });
  frame = renderStarlingFrame(state, { width: 88, height: 24, color: false });
  assert.match(frame, /Summarize branch\?/);
  assert.match(frame, /^› No summary/m);
  assert.match(frame, /Summarize with custom prompt/);
  state = reduceStarlingTui(state, { type: "tree.summary.select", delta: 2 });
  state = reduceStarlingTui(state, { type: "tree.custom.open" });
  state = reduceStarlingTui(state, { type: "tree.custom.append", value: "Keep key decisions" });
  frame = renderStarlingFrame(state, { width: 88, height: 24, color: false });
  assert.match(frame, /Custom summarization instructions/);
  assert.match(frame, /Keep key decisions/);
  assert.match(frame, /Alt\+Enter newline/);
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

test("auth picker working view shows the live device code / auth URL", () => {
  let state = sessionState();
  const provider = {
    id: "openai-codex",
    name: "OpenAI Codex",
    authType: "oauth",
    methodName: "OpenAI (ChatGPT Plus/Pro)",
    configured: false,
    stored: false,
    interactive: true,
  };
  state = reduceStarlingTui(state, { type: "auth.open", mode: "login", providers: [provider] });
  state = reduceStarlingTui(state, { type: "auth.working" });

  // Without an auth status line, only the spinner + cancel hint render.
  let frame = renderStarlingFrame(state, { width: 72, height: 12, color: false });
  assert.match(frame, /Logging in to OpenAI Codex/);
  assert.doesNotMatch(frame, /Device code/);

  // The Pi SDK surfaces the device code via setStatus("auth", ...).
  state = dispatchRecord(state, {
    type: "extension_ui_request",
    id: "auth-status-1",
    method: "setStatus",
    statusKey: "auth",
    statusText: "Open https://auth.openai.com/codex/device\nDevice code: XGRZ-0487U\nExpires in 900 seconds",
  });
  frame = renderStarlingFrame(state, { width: 72, height: 12, color: false });
  assert.match(frame, /Logging in to OpenAI Codex/);
  assert.match(frame, /auth\.openai\.com\/codex\/device/);
  assert.match(frame, /Device code: XGRZ-0487U/);
  assert.match(frame, /Expires in 900 seconds/);
  assert.match(frame, /Esc cancel/);

  // With color enabled, the URL is underlined and wrapped as an OSC 8 hyperlink.
  const colorFrame = renderStarlingFrame(state, { width: 72, height: 12, color: true, tick: 1 });
  const urlLine = colorFrame.split("\n").find((l) => l.includes("auth.openai.com"));
  assert.ok(urlLine, "URL line is rendered");
  assert.ok(urlLine.includes("\u001b[4;36m"), "URL token is underlined + cyan");
  assert.ok(
    urlLine.includes("\u001b]8;;https://auth.openai.com/codex/device\u001b\\"),
    "URL token is an OSC 8 hyperlink",
  );
  const codeLine = colorFrame.split("\n").find((l) => l.includes("XGRZ-0487U"));
  assert.ok(codeLine && !codeLine.includes("\u001b[4;36m"), "device code line is not styled as a link");
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
