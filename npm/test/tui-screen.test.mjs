import assert from "node:assert/strict";
import test from "node:test";

import {
  shouldUseSynchronizedOutput,
  StarlingScreen,
} from "../lib/tui/index.js";

test("screen appends its first frame and then repaints changed rows relatively", () => {
  const writes = [];
  const screen = new StarlingScreen((value) => writes.push(value), {
    synchronizedOutput: true,
  });

  assert.equal(screen.paint("header\nbody\nfooter"), true);
  assert.match(writes[0], /\u001b\[\?2026h/);
  assert.match(writes[0], /header\r\nbody\r\nfooter/);
  assert.doesNotMatch(writes[0], /\u001b\[2J|\u001b\[H|\u001b\[\d+;\d+H/);
  assert.doesNotMatch(writes[0], /\u001b\[2K/);
  assert.equal(screen.paint("header\nbody\nfooter"), false);
  assert.equal(writes.length, 1);

  assert.equal(screen.paint("header\nupdated\nfooter"), true);
  assert.match(writes[1], /^\u001b\[\?2026h\u001b\[\?25l\u001b\[\?7l\r\u001b\[2A/);
  assert.match(writes[1], /\r\n\r\u001b\[2K\u001b\[0mupdated\r\n/);
  assert.doesNotMatch(writes[1], /header|footer/);
  assert.doesNotMatch(writes[1], /\u001b\[\d+;\d+H/);

  screen.reset();
  assert.equal(screen.paint("header\nupdated\nfooter"), true);
  assert.match(writes[2], /header\r\nupdated\r\nfooter/);
  assert.doesNotMatch(writes[2], /\u001b\[2A/);
});

test("screen grows and shrinks a dynamic frame without losing its anchor", () => {
  const writes = [];
  const screen = new StarlingScreen((value) => writes.push(value), {
    synchronizedOutput: false,
  });

  screen.paint("one\ntwo\nthree");
  assert.equal(screen.paint("one\ntwo\nthree\nfour"), true);
  assert.match(writes[1], /\r\u001b\[2A/);
  assert.match(writes[1], /\r\n\r\n\r\n\r\u001b\[2K\u001b\[0mfour/);

  assert.equal(screen.paint("one\ntwo"), true);
  assert.match(writes[2], /\r\u001b\[3A/);
  assert.equal((writes[2].match(/\u001b\[2K/g) ?? []).length, 2);
  assert.match(writes[2], /\r\u001b\[2A\u001b\[\?7h$/);

  assert.equal(screen.paint("one\nchanged"), true);
  assert.match(writes[3], /\r\u001b\[1A/);
  assert.match(writes[3], /changed/);
});

test("forced repaint retains the current relative anchor", () => {
  const writes = [];
  const screen = new StarlingScreen((value) => writes.push(value), {
    synchronizedOutput: false,
  });

  screen.paint("alpha\nbeta");
  assert.equal(screen.paint("alpha\nbeta", true), true);
  assert.match(writes[1], /^\u001b\[\?25l\u001b\[\?7l\r\u001b\[1A/);
  assert.match(writes[1], /alpha\r\n/);
  assert.match(writes[1], /beta/);
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
