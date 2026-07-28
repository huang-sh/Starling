import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import { runStarlingTui } from "../lib/tui/index.js";

test("runs the Starling TUI against an in-process ChatSession", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const originalInput = Object.getOwnPropertyDescriptor(process, "stdin");
  const originalOutput = Object.getOwnPropertyDescriptor(process, "stdout");
  const requests = [];
  let factoryOptions;
  let runOptions;
  let closeCalls = 0;
  const runUpdates = [];
  const runFinishes = [];

  Object.defineProperty(process, "stdin", { configurable: true, value: input });
  Object.defineProperty(process, "stdout", { configurable: true, value: output });

  try {
    const running = runStarlingTui({
      cwd: process.cwd(),
      env: { STARLING_TUI_SYNC_OUTPUT: "0" },
      async createRun(options) {
        runOptions = options;
        return {
          runId: "direct-run",
          async updateSession(patch) {
            runUpdates.push(patch);
          },
          async finish(patch) {
            runFinishes.push(patch);
          },
        };
      },
      createSession(options) {
        factoryOptions = options;
        queueMicrotask(() => {
          options.onRecord({
            type: "extension_ui_request",
            id: "trust-project",
            method: "confirm",
            title: "Trust this project?",
            message: "Allow project resources",
          });
        });
        return {
          async request(request) {
            requests.push(request);
            if (request.type === "get_state") {
              return {
                sessionId: "direct-session",
                model: { provider: "fake", id: "model-a" },
                thinkingLevel: "medium",
                isStreaming: false,
                pendingMessageCount: 0,
              };
            }
            if (request.type === "get_messages") {
              return { messages: [{ role: "user", content: "history" }] };
            }
            return undefined;
          },
          async close() {
            assert.equal(input.isRaw, false, "terminal raw mode must be restored before SDK close");
            assert.match(output.text(), /\u001b\[\?2004l/);
            assert.doesNotMatch(output.text(), /\u001b\[\?1049[hl]/);
            closeCalls += 1;
          },
        };
      },
    });

    await until(() => requests.some((request) => request.type === "get_messages"));
    assert.deepEqual(factoryOptions.launch, {
      cwd: process.cwd(),
      extensions: [],
      noExtensions: false,
      surface: "tui",
      starlingManaged: true,
    });
    assert.equal(runOptions.cwd, process.cwd());
    assert.equal(runOptions.pid, process.pid);
    assert.equal(factoryOptions.environment.STARLING_TUI_SYNC_OUTPUT, "0");
    await until(() => runUpdates.length === 1);
    assert.deepEqual(runUpdates, [{
      sessionId: "direct-session",
      sessionFile: undefined,
      model: "fake/model-a",
      title: undefined,
    }]);

    await until(() => output.text().includes("Trust this project?"));
    input.write("y");
    await until(() => requests.some((request) =>
      request.type === "extension_ui_response"
      && request.id === "trust-project"
      && request.confirmed === true));

    await new Promise((resolve) => setTimeout(resolve, 25));
    const writesBeforeResize = output.chunks.length;
    output.columns = 72;
    output.emit("resize");
    await until(() => output.chunks.length > writesBeforeResize);
    const resizePaint = output.chunks.slice(writesBeforeResize).join("");
    assert.match(resizePaint, /\r\u001b\[\d+A/);
    assert.doesNotMatch(resizePaint, /\u001b\[\?1049[hl]|\u001b\[2J|\u001b\[H/);

    input.write("\u0004");
    assert.equal(await running, 0);
    assert.equal(closeCalls, 1);
    assert.deepEqual(runFinishes, [{ exitCode: 0 }]);
    assert.deepEqual(input.rawModes, [true, false]);
    assert.match(output.text(), /\u001b\[\?2004h/);
    assert.match(output.text(), /\u001b\[\?2004l/);
    assert.doesNotMatch(output.text(), /\u001b\[\?1049[hl]/);
  } finally {
    if (originalInput) Object.defineProperty(process, "stdin", originalInput);
    if (originalOutput) Object.defineProperty(process, "stdout", originalOutput);
    input.destroy();
    output.destroy();
  }
});

test("discovers, completes, and invokes Pi SDK slash commands in the Starling TUI", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const originalInput = Object.getOwnPropertyDescriptor(process, "stdin");
  const originalOutput = Object.getOwnPropertyDescriptor(process, "stdout");
  const requests = [];
  let launch;
  let sessionOptions;

  Object.defineProperty(process, "stdin", { configurable: true, value: input });
  Object.defineProperty(process, "stdout", { configurable: true, value: output });

  try {
    const running = runStarlingTui({
      cwd: process.cwd(),
      env: { STARLING_TUI_SYNC_OUTPUT: "0" },
      async createRun() {
        return {
          runId: "slash-run",
          async updateSession() {},
          async finish() {},
        };
      },
      createSession(options) {
        sessionOptions = options;
        launch = options.launch;
        return {
          async request(request) {
            requests.push(request);
            if (request.type === "get_state") {
              return { sessionId: "slash-session", model: { provider: "fake", id: "model-a" } };
            }
            if (request.type === "get_messages") return { messages: [] };
            if (request.type === "get_commands") {
              return {
                commands: [{
                  name: "echo",
                  description: "Echo through a Pi extension",
                  source: "extension",
                  sourceInfo: { path: "/extensions/echo.mjs" },
                }],
              };
            }
            return undefined;
          },
          async close() {},
        };
      },
    });

    await until(() => requests.some(({ type }) => type === "get_commands"));
    input.write("/ec");
    await until(() => output.text().includes("/echo"));
    input.write("\t");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(requests.some(({ type }) => type === "prompt"), false, "completion must not execute");

    input.write("helo");
    input.write("\u001b[D");
    input.write("l\r");
    await until(() => requests.some((request) =>
      request.type === "prompt" && request.message === "/echo hello"));
    assert.equal(launch.noExtensions, false, "bare Starling must load trusted Pi commands");

    sessionOptions.onRecord({ type: "compaction_start", reason: "manual" });
    await until(() => output.text().includes("Compacting context"));
    input.write("\u001b");
    await until(() => requests.some(({ type }) => type === "abort_compaction"));
    sessionOptions.onRecord({
      type: "compaction_end",
      reason: "manual",
      aborted: true,
      willRetry: false,
    });

    input.write("\u0004");
    assert.equal(await running, 0);
  } finally {
    if (originalInput) Object.defineProperty(process, "stdin", originalInput);
    if (originalOutput) Object.defineProperty(process, "stdout", originalOutput);
    input.destroy();
    output.destroy();
  }
});

test("dead TTY errors cannot skip SDK shutdown or run finalization", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const originalInput = Object.getOwnPropertyDescriptor(process, "stdin");
  const originalOutput = Object.getOwnPropertyDescriptor(process, "stdout");
  let closeCalls = 0;
  let sessionCreated = false;
  const finishes = [];

  Object.defineProperty(process, "stdin", { configurable: true, value: input });
  Object.defineProperty(process, "stdout", { configurable: true, value: output });

  try {
    const running = runStarlingTui({
      cwd: process.cwd(),
      env: { STARLING_TUI_SYNC_OUTPUT: "0" },
      async createRun() {
        return {
          runId: "dead-tty-run",
          async updateSession() {},
          async finish(patch) {
            finishes.push(patch);
          },
        };
      },
      createSession() {
        sessionCreated = true;
        return {
          async request(request) {
            if (request.type === "get_state") {
              return { sessionId: "dead-tty-session", model: { provider: "p", id: "m" } };
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

    await until(() => sessionCreated);
    input.failRestore = true;
    output.failLeave = true;
    input.write("\u0004");

    assert.equal(await running, 1);
    assert.equal(closeCalls, 1);
    assert.deepEqual(finishes, [{ exitCode: 1 }]);
  } finally {
    if (originalInput) Object.defineProperty(process, "stdin", originalInput);
    if (originalOutput) Object.defineProperty(process, "stdout", originalOutput);
    input.destroy();
    output.destroy();
  }
});

test("asynchronous terminal stream errors still close the SDK and managed run", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const originalInput = Object.getOwnPropertyDescriptor(process, "stdin");
  const originalOutput = Object.getOwnPropertyDescriptor(process, "stdout");
  let sessionCreated = false;
  let closeCalls = 0;
  const finishes = [];

  Object.defineProperty(process, "stdin", { configurable: true, value: input });
  Object.defineProperty(process, "stdout", { configurable: true, value: output });

  try {
    const running = runStarlingTui({
      cwd: process.cwd(),
      env: { STARLING_TUI_SYNC_OUTPUT: "0" },
      async createRun() {
        return {
          runId: "async-dead-tty-run",
          async updateSession() {},
          async finish(patch) {
            finishes.push(patch);
          },
        };
      },
      createSession() {
        sessionCreated = true;
        return {
          async request(request) {
            if (request.type === "get_state") {
              return { sessionId: "async-dead-tty", model: { provider: "p", id: "m" } };
            }
            return { messages: [] };
          },
          async close() {
            closeCalls += 1;
          },
        };
      },
    });

    await until(() => sessionCreated);
    queueMicrotask(() => output.emit("error", new Error("async tty EPIPE")));

    assert.equal(await running, 1);
    assert.equal(closeCalls, 1);
    assert.deepEqual(finishes, [{ exitCode: 1 }]);
  } finally {
    if (originalInput) Object.defineProperty(process, "stdin", originalInput);
    if (originalOutput) Object.defineProperty(process, "stdout", originalOutput);
    input.destroy();
    output.destroy();
  }
});

test("a synchronous session factory failure finalizes the run as errored", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const originalInput = Object.getOwnPropertyDescriptor(process, "stdin");
  const originalOutput = Object.getOwnPropertyDescriptor(process, "stdout");
  const finishes = [];

  Object.defineProperty(process, "stdin", { configurable: true, value: input });
  Object.defineProperty(process, "stdout", { configurable: true, value: output });

  try {
    const running = runStarlingTui({
      cwd: process.cwd(),
      env: { STARLING_TUI_SYNC_OUTPUT: "0" },
      async createRun() {
        return {
          runId: "sync-factory-failure",
          async updateSession() {},
          async finish(patch) {
            finishes.push(patch);
          },
        };
      },
      createSession() {
        throw new Error("session factory failed synchronously");
      },
    });

    await assert.rejects(running, /session factory failed synchronously/);
    assert.deepEqual(finishes, [{ exitCode: 1 }]);
  } finally {
    if (originalInput) Object.defineProperty(process, "stdin", originalInput);
    if (originalOutput) Object.defineProperty(process, "stdout", originalOutput);
    input.destroy();
    output.destroy();
  }
});

test("SDK startup failure finalizes the managed run as errored", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const originalInput = Object.getOwnPropertyDescriptor(process, "stdin");
  const originalOutput = Object.getOwnPropertyDescriptor(process, "stdout");
  const finishes = [];
  let closeCalls = 0;

  Object.defineProperty(process, "stdin", { configurable: true, value: input });
  Object.defineProperty(process, "stdout", { configurable: true, value: output });

  try {
    const running = runStarlingTui({
      cwd: process.cwd(),
      env: { STARLING_TUI_SYNC_OUTPUT: "0" },
      async createRun() {
        return {
          runId: "failed-start-run",
          async updateSession() {},
          async finish(patch) {
            finishes.push(patch);
          },
        };
      },
      createSession() {
        return {
          async request(request) {
            if (request.type === "get_state") throw new Error("SDK startup failed");
            return { messages: [] };
          },
          async close() {
            closeCalls += 1;
          },
        };
      },
    });

    await assert.rejects(running, /SDK startup failed/);
    assert.equal(closeCalls, 1);
    assert.deepEqual(finishes, [{ exitCode: 1 }]);
  } finally {
    if (originalInput) Object.defineProperty(process, "stdin", originalInput);
    if (originalOutput) Object.defineProperty(process, "stdout", originalOutput);
    input.destroy();
    output.destroy();
  }
});

class FakeInput extends PassThrough {
  isTTY = true;
  isRaw = false;
  rawModes = [];
  failRestore = false;

  setRawMode(value) {
    this.isRaw = value;
    this.rawModes.push(value);
    if (!value && this.failRestore) throw new Error("tty disappeared");
    return this;
  }
}

class FakeOutput extends PassThrough {
  isTTY = true;
  columns = 100;
  rows = 32;
  chunks = [];
  failLeave = false;

  constructor() {
    super();
    this.resume();
  }

  write(chunk, ...args) {
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    if (this.failLeave && text.includes("\u001b[?2004l")) throw new Error("tty write failed");
    this.chunks.push(text);
    return super.write(chunk, ...args);
  }

  text() {
    return this.chunks.join("");
  }
}

async function until(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for TUI state");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
