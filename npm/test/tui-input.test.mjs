import assert from "node:assert/strict";
import test from "node:test";

import { parseStarlingKeys, StarlingInputDecoder } from "../lib/tui/index.js";

test("terminal input parser recognizes navigation, control, Unicode, and alt-enter", () => {
  assert.deepEqual(parseStarlingKeys("你\u001b[A\u001b[6~\u001b\r\u007f\u0003"), [
    { type: "text", value: "你" },
    { type: "up" },
    { type: "page-down" },
    { type: "alt-enter" },
    { type: "backspace" },
    { type: "ctrl-c" },
  ]);
});

test("bracketed paste remains one edit across arbitrary stream chunks", () => {
  const decoder = new StarlingInputDecoder();

  assert.deepEqual(decoder.push("\u001b[20"), []);
  assert.deepEqual(decoder.push("0~first\r\nsecond\u001b[2"), []);
  assert.deepEqual(decoder.push("01~x"), [
    { type: "paste", value: "first\nsecond" },
    { type: "text", value: "x" },
  ]);
  assert.deepEqual(decoder.end(), []);
});

test("an unterminated paste flushes safely without submitting embedded newlines", () => {
  const decoder = new StarlingInputDecoder();

  assert.deepEqual(decoder.push("\u001b[200~a\0b\rc"), []);
  assert.deepEqual(decoder.end(), [{ type: "paste", value: "ab\nc" }]);
});

test("a lone escape can be flushed while unsupported control sequences never leak text", () => {
  const escape = new StarlingInputDecoder();
  assert.deepEqual(escape.push("\u001b"), []);
  assert.equal(escape.hasPendingEscape, true);
  assert.deepEqual(escape.flushPendingEscape(), [{ type: "escape" }]);

  const controls = new StarlingInputDecoder();
  assert.deepEqual(controls.push("\u001b[H\u001b[3~ok"), [
    { type: "text", value: "o" },
    { type: "text", value: "k" },
  ]);
});

test("oversized bracketed paste remains synchronized through its terminator", () => {
  const decoder = new StarlingInputDecoder();
  const oversized = "x".repeat(1024 * 1024 + 20);
  assert.deepEqual(decoder.push(`\u001b[200~${oversized}`), []);
  const keys = decoder.push("\u001b[201~z");

  assert.equal(keys[0].type, "paste");
  assert.equal(keys[0].value.length, 1024 * 1024);
  assert.deepEqual(keys[1], { type: "text", value: "z" });
});
