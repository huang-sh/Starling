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
    assert.match(resizePaint, /^\u001b\[2J\u001b\[H\u001b\[3J/);
    assert.doesNotMatch(resizePaint, /\u001b\[\?1049[hl]/);

    input.destroy();
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

test("/new replaces the Pi session through the real Starling command surface", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const originalInput = Object.getOwnPropertyDescriptor(process, "stdin");
  const originalOutput = Object.getOwnPropertyDescriptor(process, "stdout");
  const requests = [];
  const updates = [];
  let currentSessionId = "old-session";
  let messages = [{ role: "assistant", content: "old transcript" }];
  let launch;

  Object.defineProperty(process, "stdin", { configurable: true, value: input });
  Object.defineProperty(process, "stdout", { configurable: true, value: output });

  try {
    const running = runStarlingTui({
      cwd: process.cwd(),
      env: { STARLING_TUI_SYNC_OUTPUT: "0" },
      async createRun() {
        return {
          runId: "new-session-run",
          async updateSession(patch) {
            updates.push(patch);
          },
          async finish() {},
        };
      },
      createSession(options) {
        launch = options.launch;
        return {
          async request(request) {
            requests.push(request);
            if (request.type === "get_state") {
              return {
                sessionId: currentSessionId,
                model: { provider: "fake", id: "model-a" },
              };
            }
            if (request.type === "get_messages") return { messages };
            if (request.type === "get_commands") return { commands: [] };
            if (request.type === "new_session") {
              currentSessionId = "new-session";
              messages = [];
              return { cancelled: false };
            }
            return undefined;
          },
          async close() {},
        };
      },
    });

    await until(() => output.text().includes("old transcript"));
    input.write("/new\r");
    await until(() => requests.some(({ type }) => type === "new_session"));
    await until(() => output.text().includes("New session started"));
    await until(() => updates.some(({ sessionId }) => sessionId === "new-session"));

    assert.equal(launch.starlingManaged, undefined, "bare Starling must allow Pi runtime replacement");
    assert.match(output.text(), /new-session/);
    assert.ok(
      requests.filter(({ type }) => type === "get_messages").length >= 2,
      "the replacement transcript must be hydrated through ChatSession",
    );

    input.write("\u0004");
    assert.equal(await running, 0);
  } finally {
    if (originalInput) Object.defineProperty(process, "stdin", originalInput);
    if (originalOutput) Object.defineProperty(process, "stdout", originalOutput);
    input.destroy();
    output.destroy();
  }
});

test("! and !! execute Pi user bash and render command output in Starling", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const originalInput = Object.getOwnPropertyDescriptor(process, "stdin");
  const originalOutput = Object.getOwnPropertyDescriptor(process, "stdout");
  const requests = [];
  let sessionOptions;
  let sequence = 0;

  Object.defineProperty(process, "stdin", { configurable: true, value: input });
  Object.defineProperty(process, "stdout", { configurable: true, value: output });

  try {
    const running = runStarlingTui({
      cwd: process.cwd(),
      env: { STARLING_TUI_SYNC_OUTPUT: "0" },
      async createRun() {
        return {
          runId: "bash-run",
          async updateSession() {},
          async finish() {},
        };
      },
      createSession(options) {
        sessionOptions = options;
        return {
          async request(request) {
            requests.push(request);
            if (request.type === "get_state") {
              return { sessionId: "bash-session", model: { provider: "fake", id: "model-a" } };
            }
            if (request.type === "get_messages") return { messages: [] };
            if (request.type === "get_commands") return { commands: [] };
            if (request.type === "bash") {
              const id = `bash-${++sequence}`;
              sessionOptions.onRecord({
                type: "starling_bash_started",
                id,
                command: request.command,
                excludeFromContext: request.excludeFromContext,
              });
              sessionOptions.onRecord({ type: "starling_bash_updated", id, output: "fixture shell output" });
              const result = {
                output: "fixture shell output",
                exitCode: 0,
                cancelled: false,
                truncated: false,
              };
              sessionOptions.onRecord({ type: "starling_bash_completed", id, result });
              return result;
            }
            return undefined;
          },
          async close() {},
        };
      },
    });

    await until(() => requests.some(({ type }) => type === "get_commands"));
    input.write("!pwd\r");
    await until(() => requests.some((request) =>
      request.type === "bash"
      && request.command === "pwd"
      && request.excludeFromContext === false));
    await until(() => output.text().includes("fixture shell output"));

    input.write("!!printf hidden\r");
    await until(() => requests.some((request) =>
      request.type === "bash"
      && request.command === "printf hidden"
      && request.excludeFromContext === true));

    input.write("\u0004");
    assert.equal(await running, 0);
  } finally {
    if (originalInput) Object.defineProperty(process, "stdin", originalInput);
    if (originalOutput) Object.defineProperty(process, "stdout", originalOutput);
    input.destroy();
    output.destroy();
  }
});

test("Pi application shortcuts execute through the real Starling TUI key path", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const originalInput = Object.getOwnPropertyDescriptor(process, "stdin");
  const originalOutput = Object.getOwnPropertyDescriptor(process, "stdout");
  const requests = [];
  let model = { provider: "fake", id: "model-a" };
  let thinkingLevel = "medium";

  Object.defineProperty(process, "stdin", { configurable: true, value: input });
  Object.defineProperty(process, "stdout", { configurable: true, value: output });

  try {
    const running = runStarlingTui({
      cwd: process.cwd(),
      env: { STARLING_TUI_SYNC_OUTPUT: "0" },
      async createRun() {
        return { runId: "pi-keys-run", async updateSession() {}, async finish() {} };
      },
      createSession() {
        return {
          async request(request) {
            requests.push(request);
            if (request.type === "get_state") {
              return { sessionId: "pi-keys-session", model, thinkingLevel };
            }
            if (request.type === "get_messages") return { messages: [] };
            if (request.type === "get_commands") return { commands: [] };
            if (request.type === "cycle_thinking_level") {
              thinkingLevel = "high";
              return { thinkingLevel };
            }
            if (request.type === "cycle_model") {
              model = { provider: "fake", id: request.direction === "forward" ? "model-b" : "model-a" };
              return { model, thinkingLevel, isScoped: true };
            }
            if (request.type === "copy_last_message") return { copied: true };
            if (request.type === "clear_queue") {
              return { steering: ["queued steer"], followUp: ["queued follow-up"] };
            }
            if (request.type === "set_thinking_visible") return { visible: request.visible };
            return undefined;
          },
          async close() {},
        };
      },
    });

    await until(() => requests.some(({ type }) => type === "get_commands"));
    input.write("\u001b[Z");
    await until(() => requests.some(({ type }) => type === "cycle_thinking_level"));
    await until(() => output.text().includes("Thinking level: high"));

    input.write("\u0010");
    await until(() => requests.some(({ type, direction }) => type === "cycle_model" && direction === "forward"));
    await until(() => output.text().includes("Model: fake/model-b"));

    input.write("\u001b[112;6u");
    await until(() => requests.some(({ type, direction }) => type === "cycle_model" && direction === "backward"));
    input.write("\u000f");
    await until(() => output.text().includes("Tool output:"));
    input.write("\u0014");
    await until(() => requests.some(({ type, visible }) => type === "set_thinking_visible" && visible === false));
    input.write("\u0018");
    await until(() => requests.some(({ type }) => type === "copy_last_message"));

    input.write("\u001b[1;3A");
    await until(() => output.text().includes("queued steer") && output.text().includes("queued follow-up"));
    input.write("\u0015");
    input.write("\u0004");
    assert.equal(await running, 0);
  } finally {
    if (originalInput) Object.defineProperty(process, "stdin", originalInput);
    if (originalOutput) Object.defineProperty(process, "stdout", originalOutput);
    input.destroy();
    output.destroy();
  }
});

test("up arrow in the empty composer does not scroll the entire TUI", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const originalInput = Object.getOwnPropertyDescriptor(process, "stdin");
  const originalOutput = Object.getOwnPropertyDescriptor(process, "stdout");

  Object.defineProperty(process, "stdin", { configurable: true, value: input });
  Object.defineProperty(process, "stdout", { configurable: true, value: output });

  try {
    const running = runStarlingTui({
      cwd: process.cwd(),
      env: { STARLING_TUI_SYNC_OUTPUT: "0" },
      async createRun() {
        return {
          runId: "up-arrow-run",
          async updateSession() {},
          async finish() {},
        };
      },
      createSession() {
        return {
          async request(request) {
            if (request.type === "get_state") {
              return { sessionId: "up-arrow-session", model: { provider: "fake", id: "model-a" } };
            }
            if (request.type === "get_messages") {
              return { messages: [{ role: "assistant", content: "visible timeline row" }] };
            }
            if (request.type === "get_commands") return { commands: [] };
            return undefined;
          },
          async close() {},
        };
      },
    });

    await until(() => output.text().includes("visible timeline row"));
    const writesBeforeUp = output.chunks.length;
    input.write("\u001b[A");
    output.emit("resize");
    await until(() => output.chunks.length > writesBeforeUp);

    const upArrowPaint = output.chunks.slice(writesBeforeUp).join("");
    assert.doesNotMatch(upArrowPaint, /lines? back/, "Up must edit/navigate the composer, not scroll the viewport");

    input.write("\u0004");
    assert.equal(await running, 0);
  } finally {
    if (originalInput) Object.defineProperty(process, "stdin", originalInput);
    if (originalOutput) Object.defineProperty(process, "stdout", originalOutput);
    input.destroy();
    output.destroy();
  }
});

test("bare /model selects a Pi SDK default model and thinking level", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const originalInput = Object.getOwnPropertyDescriptor(process, "stdin");
  const originalOutput = Object.getOwnPropertyDescriptor(process, "stdout");
  const requests = [];
  let activeModel = { provider: "zai", id: "glm-5.2" };

  Object.defineProperty(process, "stdin", { configurable: true, value: input });
  Object.defineProperty(process, "stdout", { configurable: true, value: output });

  try {
    const running = runStarlingTui({
      cwd: process.cwd(),
      env: { STARLING_TUI_SYNC_OUTPUT: "0" },
      async createRun() {
        return {
          runId: "model-picker-run",
          async updateSession() {},
          async finish() {},
        };
      },
      createSession() {
        return {
          async request(request) {
            requests.push(request);
            if (request.type === "get_state") {
              return { sessionId: "model-picker-session", model: activeModel };
            }
            if (request.type === "get_messages") return { messages: [] };
            if (request.type === "get_commands") return { commands: [] };
            if (request.type === "get_available_models") {
              return {
                models: [
                  { ...activeModel, name: "GLM-5.2", reasoning: true },
                  { provider: "openai", id: "gpt-5.5", name: "GPT-5.5", reasoning: true },
                ],
              };
            }
            if (request.type === "configure_model") {
              activeModel = { provider: request.provider, id: request.modelId };
              return activeModel;
            }
            return undefined;
          },
          async close() {},
        };
      },
    });

    await until(() => requests.some(({ type }) => type === "get_commands"));
    input.write("/model\r");
    await until(() => output.text().includes("Models:"));
    assert.match(output.text(), /Model Name: GLM-5\.2/);

    input.write("g55");
    await until(() => output.text().includes("Model Name: GPT-5.5"));
    input.write("\r");
    await until(() => output.text().includes("Thinking for: gpt-5.5"));
    assert.equal(
      requests.some((request) => request.type === "configure_model"),
      false,
      "choosing a model must open the thinking-level menu before changing configuration",
    );
    assert.match(output.text(), /inherit\s+Inherit session default/);
    assert.match(output.text(), /high\s+Deep reasoning/);
    input.write("\r");
    await until(() => requests.some((request) =>
      request.type === "configure_model"
      && request.provider === "openai"
      && request.modelId === "gpt-5.5"
      && request.thinkingLevel === "inherit"));
    await until(() => output.text().includes("Model set to openai/gpt-5.5"));

    input.write("\u0004");
    assert.equal(await running, 0);
  } finally {
    if (originalInput) Object.defineProperty(process, "stdin", originalInput);
    if (originalOutput) Object.defineProperty(process, "stdout", originalOutput);
    input.destroy();
    output.destroy();
  }
});

test("/tree navigates the Pi session tree and refreshes the transcript", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const originalInput = Object.getOwnPropertyDescriptor(process, "stdin");
  const originalOutput = Object.getOwnPropertyDescriptor(process, "stdout");
  const requests = [];
  let navigated = false;

  Object.defineProperty(process, "stdin", { configurable: true, value: input });
  Object.defineProperty(process, "stdout", { configurable: true, value: output });

  try {
    const running = runStarlingTui({
      cwd: process.cwd(),
      env: { STARLING_TUI_SYNC_OUTPUT: "0" },
      async createRun() {
        return {
          runId: "tree-run",
          async updateSession() {},
          async finish() {},
        };
      },
      createSession() {
        return {
          async request(request) {
            requests.push(request);
            if (request.type === "get_state") {
              return { sessionId: "tree-session", model: { provider: "fake", id: "model-a" } };
            }
            if (request.type === "get_messages") {
              return {
                messages: navigated
                  ? [{ role: "user", content: "first question" }]
                  : [{ role: "assistant", content: "latest answer" }],
              };
            }
            if (request.type === "get_commands") return { commands: [] };
            if (request.type === "get_tree") {
              return {
                leafId: "leaf",
                tree: [{
                  entry: {
                    id: "root",
                    parentId: null,
                    type: "message",
                    message: { role: "user", content: "first question" },
                  },
                  children: [{
                    entry: {
                      id: "target",
                      parentId: "root",
                      type: "message",
                      message: { role: "user", content: "earlier question" },
                    },
                    children: [{
                      entry: {
                        id: "leaf",
                        parentId: "target",
                        type: "message",
                        message: { role: "assistant", content: "latest answer" },
                      },
                      children: [],
                    }],
                  }],
                }],
              };
            }
            if (request.type === "navigate_tree") {
              navigated = true;
              return { cancelled: false, editorText: "earlier question" };
            }
            return undefined;
          },
          async close() {},
        };
      },
    });

    await until(() => requests.some(({ type }) => type === "get_commands"));
    input.write("/tree\r");
    await until(() => output.text().includes("SESSION TREE"));
    assert.match(output.text(), /latest answer.*CURRENT/);

    input.write("\u001b[A");
    input.write("\r");
    await until(() => output.text().includes("Summarize branch?"));
    assert.match(output.text(), /No summary/);
    assert.match(output.text(), /Summarize with custom prompt/);
    input.write("\r");

    await until(() => requests.some((request) => request.type === "navigate_tree"));
    assert.deepEqual(requests.find(({ type }) => type === "navigate_tree"), {
      type: "navigate_tree",
      targetId: "target",
      summarize: false,
    });
    await until(() => output.text().includes("Navigated to selected point"));
    assert.match(output.text(), /first question/);
    assert.match(output.text(), /earlier question/);
    assert.match(output.text(), /Navigated to selected point/);

    input.write("\u0015");
    input.write("\u0004");
    assert.equal(await running, 0);
  } finally {
    if (originalInput) Object.defineProperty(process, "stdin", originalInput);
    if (originalOutput) Object.defineProperty(process, "stdout", originalOutput);
    input.destroy();
    output.destroy();
  }
});

test("/login selects a Pi provider and never renders the entered API key", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const originalInput = Object.getOwnPropertyDescriptor(process, "stdin");
  const originalOutput = Object.getOwnPropertyDescriptor(process, "stdout");
  const requests = [];
  let sessionOptions;
  let resolveLogin;

  Object.defineProperty(process, "stdin", { configurable: true, value: input });
  Object.defineProperty(process, "stdout", { configurable: true, value: output });

  try {
    const running = runStarlingTui({
      cwd: process.cwd(),
      env: { STARLING_TUI_SYNC_OUTPUT: "0" },
      async createRun() {
        return {
          runId: "login-run",
          async updateSession() {},
          async finish() {},
        };
      },
      createSession(options) {
        sessionOptions = options;
        return {
          async request(request) {
            requests.push(request);
            if (request.type === "get_state") {
              return { sessionId: "login-session", model: { provider: "fake", id: "model-a" } };
            }
            if (request.type === "get_messages") return { messages: [] };
            if (request.type === "get_commands") return { commands: [] };
            if (request.type === "get_auth_providers") {
              return {
                providers: [{
                  id: "anthropic",
                  name: "Anthropic",
                  authType: "api_key",
                  methodName: "Anthropic API key",
                  configured: false,
                  stored: false,
                  interactive: true,
                }],
              };
            }
            if (request.type === "login_provider") {
              queueMicrotask(() => sessionOptions.onRecord({
                type: "extension_ui_request",
                id: "api-key-prompt",
                method: "input",
                title: "Login to Anthropic",
                message: "Paste API key",
                secret: true,
              }));
              return await new Promise((resolve) => {
                resolveLogin = () => resolve({ provider: "anthropic", authType: "api_key" });
              });
            }
            if (request.type === "extension_ui_response" && request.id === "api-key-prompt") {
              resolveLogin?.();
            }
            return undefined;
          },
          async close() {},
        };
      },
    });

    await until(() => requests.some(({ type }) => type === "get_commands"));
    input.write("/login anthropic\r");
    await until(() => output.text().includes("Paste API key"));
    input.write("sk-super-secret\r");
    await until(() => output.text().includes("Saved API key for Anthropic"));

    assert.ok(requests.some((request) =>
      request.type === "login_provider"
      && request.provider === "anthropic"
      && request.authType === "api_key"));
    assert.ok(requests.some((request) =>
      request.type === "extension_ui_response"
      && request.value === "sk-super-secret"));
    assert.doesNotMatch(output.text(), /sk-super-secret/);

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

test("login lets the user choose Pi's login method before logout", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const originalInput = Object.getOwnPropertyDescriptor(process, "stdin");
  const originalOutput = Object.getOwnPropertyDescriptor(process, "stdout");
  const requests = [];
  let resolveLogin;

  Object.defineProperty(process, "stdin", { configurable: true, value: input });
  Object.defineProperty(process, "stdout", { configurable: true, value: output });

  try {
    const running = runStarlingTui({
      cwd: process.cwd(),
      env: { STARLING_TUI_SYNC_OUTPUT: "0" },
      async createRun() {
        return {
          runId: "auth-run",
          async updateSession() {},
          async finish() {},
        };
      },
      createSession(options) {
        return {
          async request(request) {
            requests.push(request);
            if (request.type === "get_state") {
              return { sessionId: "auth-session", model: { provider: "fake", id: "model-a" } };
            }
            if (request.type === "get_messages") return { messages: [] };
            if (request.type === "get_commands") return { commands: [] };
            if (request.type === "get_auth_providers") {
              return {
                providers: [{
                  id: "openai-codex",
                  name: "OpenAI Codex",
                  authType: "oauth",
                  methodName: "OpenAI Codex",
                  configured: request.mode === "logout",
                  stored: request.mode === "logout",
                  interactive: true,
                }],
              };
            }
            if (request.type === "login_provider") {
              queueMicrotask(() => options.onRecord({
                type: "extension_ui_request",
                id: "openai-login-method",
                method: "select",
                title: "Select OpenAI Codex login method:",
                options: ["Browser login (default)", "Device code login (headless)"],
              }));
              return await new Promise((resolve) => {
                resolveLogin = () => resolve({ provider: "openai-codex" });
              });
            }
            if (request.type === "extension_ui_response" && request.id === "openai-login-method") {
              resolveLogin?.();
            }
            if (request.type === "logout_provider") return { provider: "openai-codex" };
            return undefined;
          },
          async close() {},
        };
      },
    });

    await until(() => requests.some(({ type }) => type === "get_commands"));
    input.write("/login\r");
    await until(() => output.text().includes("LOGIN · Select provider authentication"));
    input.write("\r");
    await until(() => requests.some(({ type }) => type === "login_provider"));
    await until(() => output.text().includes("Select OpenAI Codex login method:"));
    assert.match(output.text(), /Browser login \(default\)[\s\S]*Device code login \(headless\)/);
    input.write("\u001b[B");
    input.write("\r");
    await until(() => requests.some((request) =>
      request.type === "extension_ui_response"
      && request.id === "openai-login-method"
      && request.value === "Device code login (headless)"));
    await until(() => output.text().includes("Logged in to OpenAI Codex"));

    input.write("/logout\r");
    await until(() => output.text().includes("LOGOUT · Select stored credential"));
    input.write("\r");
    await until(() => requests.some(({ type }) => type === "logout_provider"));
    await until(() => output.text().includes("Logged out of OpenAI Codex"));

    assert.deepEqual(
      requests.filter(({ type }) =>
        type.includes("auth")
        || type.includes("login")
        || type.includes("logout")
        || type === "extension_ui_response"),
      [
        { type: "get_auth_providers", mode: "login" },
        { type: "login_provider", provider: "openai-codex", authType: "oauth" },
        {
          type: "extension_ui_response",
          id: "openai-login-method",
          value: "Device code login (headless)",
        },
        { type: "get_auth_providers", mode: "logout" },
        { type: "logout_provider", provider: "openai-codex" },
      ],
    );

    input.write("\u0004");
    assert.equal(await running, 0);
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

test("Up arrow recalls the previous prompt into the composer", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const originalInput = Object.getOwnPropertyDescriptor(process, "stdin");
  const originalOutput = Object.getOwnPropertyDescriptor(process, "stdout");
  const requests = [];

  Object.defineProperty(process, "stdin", { configurable: true, value: input });
  Object.defineProperty(process, "stdout", { configurable: true, value: output });

  try {
    const running = runStarlingTui({
      cwd: process.cwd(),
      env: { STARLING_TUI_SYNC_OUTPUT: "0" },
      async createRun() {
        return { runId: "history-run", async updateSession() {}, async finish() {} };
      },
      createSession() {
        return {
          async request(request) {
            requests.push(request);
            if (request.type === "get_state") {
              return {
                sessionId: "history-session",
                model: { provider: "fake", id: "model-a" },
                thinkingLevel: "medium",
                isStreaming: false,
                pendingMessageCount: 0,
              };
            }
            if (request.type === "get_messages") {
              return { messages: [{ role: "user", content: "recall this prompt" }] };
            }
            return undefined;
          },
          async close() {},
        };
      },
    });

    await until(() => requests.some((r) => r.type === "get_messages"));
    // Transcript hydrates the prior user turn; the composer cursor marker ▏
    // distinguishes the live composer line from the transcript copy.
    await until(() => output.text().includes("recall this prompt"), 2500);
    const composerHasRecall = (text) => /recall this prompt(\u001b\[[0-9;]*m)*▏/.test(text);
    assert.equal(composerHasRecall(output.text()), false, "composer is empty before Up");

    input.write("\u001b[A"); // Up
    await until(() => composerHasRecall(output.text()), 2500);
    assert.equal(composerHasRecall(output.text()), true, "Up recalls the prior prompt");

    // Composer is non-empty after recall; clear it first so ctrl-d exits.
    input.write("\u0015\u0004");
    assert.equal(await running, 0);
  } finally {
    if (originalInput) Object.defineProperty(process, "stdin", originalInput);
    if (originalOutput) Object.defineProperty(process, "stdout", originalOutput);
    input.destroy();
    output.destroy();
  }
});
