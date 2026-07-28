import assert from "node:assert/strict";
import test from "node:test";

import { parseStarlingKeys } from "../lib/tui/index.js";

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
