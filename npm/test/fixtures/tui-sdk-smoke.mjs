import assert from "node:assert/strict";
import { runStarlingTui } from "../../lib/tui/index.js";

let closeCalls = 0;
let finishPatch;
let updatePatch;

const exitCode = await runStarlingTui({
  cwd: process.cwd(),
  env: { ...process.env, STARLING_TUI_SYNC_OUTPUT: "0" },
  async createRun(options) {
    assert.equal(options.pid, process.pid);
    return {
      runId: "pty-run",
      async updateSession(patch) {
        updatePatch = patch;
      },
      async finish(patch) {
        finishPatch = patch;
      },
    };
  },
  createSession(options) {
    assert.deepEqual(options.launch, {
      cwd: process.cwd(),
      extensions: [],
      noExtensions: false,
      surface: "tui",
      starlingManaged: true,
    });
    setTimeout(options.onShutdownRequested, 40);
    return {
      async request(request) {
        if (request.type === "get_state") {
          return {
            sessionId: "pty-session",
            model: { provider: "fake", id: "model" },
            isStreaming: false,
          };
        }
        if (request.type === "get_messages") return { messages: [] };
        return undefined;
      },
      async close() {
        closeCalls += 1;
      },
    };
  },
});

assert.equal(exitCode, 0);
assert.equal(closeCalls, 1);
assert.deepEqual(updatePatch, {
  sessionId: "pty-session",
  sessionFile: undefined,
  model: "fake/model",
  title: undefined,
});
assert.deepEqual(finishPatch, { exitCode: 0 });
process.stdout.write("STARLING_TUI_PTY_OK\n");
process.exit(0);
