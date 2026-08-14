import assert from "node:assert/strict";
import test from "node:test";

import {
  shouldUseSynchronizedOutput,
  StarlingScreen,
} from "../lib/tui/index.js";

const ESC = "\x1b";

function makeScreen(sync = false) {
  const writes = [];
  const screen = new StarlingScreen((value) => writes.push(value), {
    synchronizedOutput: sync,
  });
  return {
    screen,
    writes,
    out: () => writes.join(""),
  };
}

test("first normal frame paints straight down from the cursor without clearing or entering an alternate screen", () => {
  const { screen, writes, out } = makeScreen(false);

  assert.equal(screen.paint({ mode: "normal", committed: [], live: ["a", "b"] }, { height: 10 }), true);
  assert.equal(writes.length, 1);
  const frame = out();
  // Never enters the alternate screen buffer.
  assert.doesNotMatch(frame, /\[?1049/);
  // No absolute positioning or screen clear: the shell above stays intact and
  // the content hugs the prompt instead of being stretched to the bottom.
  assert.doesNotMatch(frame, /\x1b\[H/);
  assert.doesNotMatch(frame, /\x1b\[J/);
  assert.match(frame, /^a\r\nb/);
});

test("a tall first frame paints every row so the terminal scrolls the overflow into scrollback itself", () => {
  const { screen, out } = makeScreen(false);
  const committed = [
    "alpha", "beta", "gamma", "delta", "epsilon",
    "zeta", "eta", "theta", "iota", "kappa", "lambda", "mu",
  ];
  // The first frame paints the whole frame (12 committed + live). A real
  // terminal scrolls the rows above the viewport into native scrollback; the
  // painter never enters an alternate screen or repositions absolutely.
  assert.equal(screen.paint({ mode: "normal", committed, live: ["OMEGA"] }, { height: 5 }), true);
  const frame = out();
  assert.match(frame, /alpha/);
  assert.match(frame, /OMEGA/);
  assert.doesNotMatch(frame, /\[?1049/);
  assert.doesNotMatch(frame, /\x1b\[H/);
});

test("overlay frame takes over the screen with a full clear and no scrollback disturbance", () => {
  const { screen, out } = makeScreen(false);
  assert.equal(screen.paint({ mode: "overlay", committed: [], live: ["p1", "p2"] }, { height: 10 }), true);
  const frame = out();
  assert.match(frame, /\[2J/);
  assert.match(frame, /p1\r\np2/);
  assert.doesNotMatch(frame, /\[?1049h/);
});

test("handing off from overlay back to normal clears the overlay residue before repainting", () => {
  const { screen, writes, out } = makeScreen(false);
  screen.paint({ mode: "overlay", committed: [], live: ["picker"] }, { height: 10 });
  writes.length = 0;
  assert.equal(screen.paint({ mode: "normal", committed: [], live: ["chat"] }, { height: 10 }), true);
  const frame = out();
  // The first normal frame after an overlay clears the whole screen once.
  assert.match(frame, /\[2J/);
  assert.match(frame, /chat/);
});

test("an unchanged normal window is not repainted, but force overrides the skip", () => {
  const { screen, writes } = makeScreen(false);
  assert.equal(screen.paint({ mode: "normal", committed: [], live: ["same"] }, { height: 5 }), true);
  writes.length = 0;
  assert.equal(screen.paint({ mode: "normal", committed: [], live: ["same"] }, { height: 5 }), false);
  assert.equal(writes.length, 0);
  assert.equal(screen.paint({ mode: "normal", committed: [], live: ["same"] }, { height: 5, force: true }), true);
  assert.equal(writes.length, 1);
});

test("width changes clear terminal reflow before repainting", () => {
  const { screen, writes, out } = makeScreen(false);
  const wide = ["FRAME-A".padEnd(99, "·"), "FRAME-B".padEnd(99, "·")];
  screen.paint({ mode: "normal", committed: [], live: wide }, { width: 100, height: 20 });

  writes.length = 0;
  const narrow = ["FRAME-A".padEnd(71, "·"), "FRAME-B".padEnd(71, "·")];
  screen.paint(
    { mode: "normal", committed: [], live: narrow },
    { width: 72, height: 20, force: true },
  );

  assert.match(out(), /^\x1b\[2J\x1b\[H\x1b\[3J/);
});

test("reset clears the live window, restores modes, and leaves scrollback history intact", () => {
  const { screen, writes, out } = makeScreen(false);
  screen.paint({ mode: "normal", committed: ["old"], live: ["editor"] }, { height: 10 });
  writes.length = 0;
  screen.reset();
  const reset = out();
  // Cursor comes back, bracketed paste is disabled, prompt drops to a fresh line.
  assert.match(reset, /\[?25h/);
  assert.match(reset, /\[?2004l/);
  assert.match(reset, /\r\n$/);
  // Never exits an alternate screen — there was none to exit.
  assert.doesNotMatch(reset, /\[?1049l/);
  // Normal reset keeps the rendered window as history: no screen clear is emitted.
  assert.doesNotMatch(reset, /\[2J/);
});

test("synchronized output wraps each frame in DEC mode 2026", () => {
  const { screen, out } = makeScreen(true);
  screen.paint({ mode: "normal", committed: [], live: ["a"] }, { height: 5 });
  const frame = out();
  assert.match(frame, /\[?2026h/);
  assert.match(frame, /\[?2026l/);
});

test("synchronized output is opt-in by capability and explicitly overridable", () => {
  assert.equal(shouldUseSynchronizedOutput({}), false);
  assert.equal(shouldUseSynchronizedOutput({ TERM_PROGRAM: "WezTerm" }), true);
  assert.equal(shouldUseSynchronizedOutput({ VSCODE_PID: "42" }), true);
  assert.equal(shouldUseSynchronizedOutput({ TERM_PROGRAM: "WarpTerminal" }), false);
  assert.equal(shouldUseSynchronizedOutput({ TMUX: "1", TERM_PROGRAM: "WezTerm" }), false);
  assert.equal(shouldUseSynchronizedOutput({
    TMUX: "1",
    STARLING_TUI_SYNC_OUTPUT: "true",
  }), true);
  assert.equal(shouldUseSynchronizedOutput({
    VSCODE_PID: "42",
    STARLING_TUI_SYNC_OUTPUT: "off",
  }), false);
});
