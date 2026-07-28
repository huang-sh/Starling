import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import { runAgentHost } from "../lib/agent-host/host.js";
import { serializeJsonLine } from "../lib/agent-host/jsonl.js";
import { createPiSdkAdapter } from "../lib/agent-host/sdk-adapter.js";
import { parseAgentHostArgs } from "../lib/agent-host/types.js";

class FakeSession {
  constructor(bindings) {
    this.bindings = bindings;
    this.calls = [];
    this.shutdownCalls = [];
    this.thinking = "medium";
  }

  getState() {
    return {
      sessionId: "fake-session",
      sessionFile: "/work/fake.jsonl",
      thinkingLevel: this.thinking,
      isStreaming: false,
    };
  }

  getMessages() {
    return [{ role: "user", content: "history" }];
  }

  prompt(message, streamingBehavior, accepted) {
    this.calls.push(["prompt", message, streamingBehavior]);
    accepted();
    this.bindings.emitEvent({ type: "agent_start" });
  }

  async abort() {
    this.calls.push(["abort"]);
  }

  async setModel(provider, modelId) {
    this.calls.push(["setModel", provider, modelId]);
    return { provider, id: modelId };
  }

  setThinkingLevel(level) {
    this.thinking = level;
    this.calls.push(["setThinking", level]);
  }

  async getAvailableModels() {
    return [{ provider: "fake", id: "model-a" }];
  }

  async compact(customInstructions) {
    this.calls.push(["compact", customInstructions]);
    return { summary: "small" };
  }

  async shutdown() {
    this.shutdownCalls.push("shutdown");
  }
}

class FakeAdapter {
  async open(options, bindings) {
    this.options = options;
    this.session = new FakeSession(bindings);
    this.opened = true;
    return this.session;
  }
}

test("parses Rust-compatible Pi arguments without exposing Pi CLI mode", () => {
  const parsed = parseAgentHostArgs([
    "--mode", "rpc",
    "--cwd", "project",
    "--session-id", "session-1",
    "--name=Named",
    "--provider", "anthropic",
    "--model", "claude-test",
    "--thinking", "high",
    "--no-extensions",
    "--extension", "gate.mjs",
  ], "/root");

  assert.deepEqual(parsed, {
    cwd: "/root/project",
    sessionPath: undefined,
    sessionId: "session-1",
    name: "Named",
    provider: "anthropic",
    model: "claude-test",
    thinking: "high",
    extensions: ["/root/project/gate.mjs"],
    noExtensions: true,
  });
  assert.throws(
    () => parseAgentHostArgs(["--session", "relative.jsonl"], "/root"),
    /absolute Pi transcript/,
  );
});

test("serves the existing Pi RPC command surface through an injected adapter", async () => {
  const input = new PassThrough();
  const output = [];
  const diagnostics = [];
  const adapter = new FakeAdapter();
  const running = runAgentHost({
    argv: ["--mode", "rpc", "--session", "/sessions/existing.jsonl"],
    processCwd: "/work",
    input,
    output: (value) => output.push(value),
    diagnostic: (message) => diagnostics.push(message),
    adapter,
  });
  await until(() => adapter.opened === true);

  for (const command of [
    { id: "state", type: "get_state" },
    { id: "messages", type: "get_messages" },
    { id: "prompt", type: "prompt", message: "hello", streamingBehavior: "followUp" },
    { id: "thinking", type: "set_thinking_level", level: "high" },
    { id: "models", type: "get_available_models" },
    { id: "model", type: "set_model", provider: "fake", modelId: "model-a" },
    { id: "compact", type: "compact", customInstructions: "short" },
    { id: "abort", type: "abort" },
  ]) {
    input.write(serializeJsonLine(command));
  }
  await until(() => response(output, "abort") !== undefined);
  input.end();

  assert.equal(await running, 0);
  assert.equal(diagnostics.length, 0);
  assert.equal(adapter.options.sessionPath, "/sessions/existing.jsonl");
  assert.equal(response(output, "state").data.sessionId, "fake-session");
  assert.deepEqual(response(output, "messages").data.messages, [
    { role: "user", content: "history" },
  ]);
  assert.equal(response(output, "prompt").success, true);
  assert.ok(output.some((record) => record.type === "agent_start"));
  assert.deepEqual(response(output, "models").data.models, [
    { provider: "fake", id: "model-a" },
  ]);
  assert.deepEqual(response(output, "model").data, { provider: "fake", id: "model-a" });
  assert.deepEqual(response(output, "compact").data, { summary: "small" });
  assert.deepEqual(adapter.session.calls, [
    ["prompt", "hello", "followUp"],
    ["setThinking", "high"],
    ["setModel", "fake", "model-a"],
    ["compact", "short"],
    ["abort"],
  ]);
  assert.deepEqual(adapter.session.shutdownCalls, ["shutdown"]);
});

test("keeps strict LF framing and routes extension UI responses while a prompt is active", async () => {
  const input = new PassThrough();
  const output = [];
  const adapter = new FakeAdapter();
  const running = runAgentHost({
    argv: [],
    processCwd: "/work",
    input,
    output: (value) => output.push(value),
    diagnostic: () => {},
    adapter,
  });
  await until(() => adapter.opened === true);

  const confirm = adapter.session.bindings.uiContext.confirm(
    "Allow tool?",
    "details",
    { timeout: 500 },
  );
  await until(() => output.some((record) => record.type === "extension_ui_request"));
  const request = output.find((record) => record.type === "extension_ui_request");
  input.write(serializeJsonLine({
    type: "extension_ui_response",
    id: request.id,
    confirmed: true,
  }));
  assert.equal(await confirm, true);

  const json = Buffer.from(`${JSON.stringify({
    id: "unicode",
    type: "prompt",
    message: "a\u2028b\u2029😀",
  })}\n`, "utf8");
  const emoji = json.indexOf(Buffer.from("😀"));
  input.write(json.subarray(0, emoji + 1));
  input.write(json.subarray(emoji + 1));
  await until(() => response(output, "unicode") !== undefined);
  input.write("not-json\n");
  await until(() => response(output, undefined, "parse") !== undefined);
  input.end();
  await running;

  assert.equal(adapter.session.calls[0][1], "a\u2028b\u2029😀");
  assert.match(response(output, undefined, "parse").error, /Failed to parse command/);
});

test("accepts trust UI responses during open and queues ordinary commands until ready", async () => {
  const input = new PassThrough();
  const output = [];
  const adapter = {
    async open(_options, bindings) {
      this.started = true;
      const trusted = await bindings.uiContext.confirm(
        "Trust project folder?",
        "/work",
        { timeout: 1_000 },
      );
      this.trusted = trusted;
      this.session = new FakeSession(bindings);
      return this.session;
    },
  };
  const running = runAgentHost({
    argv: [],
    processCwd: "/work",
    input,
    output: (value) => output.push(value),
    diagnostic: () => {},
    adapter,
  });

  await until(() => adapter.started === true);
  input.write(serializeJsonLine({ id: "early-state", type: "get_state" }));
  await until(() => output.some((record) => record.type === "extension_ui_request"));
  assert.equal(response(output, "early-state"), undefined);

  const request = output.find((record) => record.type === "extension_ui_request");
  input.write(serializeJsonLine({
    type: "extension_ui_response",
    id: request.id,
    confirmed: true,
  }));
  await until(() => response(output, "early-state") !== undefined);
  input.end();

  assert.equal(await running, 0);
  assert.equal(adapter.trusted, true);
  assert.equal(response(output, "early-state").data.sessionId, "fake-session");
  assert.deepEqual(adapter.session.shutdownCalls, ["shutdown"]);
});

test("does not leak a session when EOF or abort arrives while open is pending", async (t) => {
  for (const stop of ["eof", "abort"]) {
    await t.test(stop, async () => {
      const input = new PassThrough();
      const controller = new AbortController();
      const gate = deferred();
      const adapter = {
        async open(_options, bindings) {
          this.started = true;
          this.bindings = bindings;
          return gate.promise;
        },
      };
      const running = runAgentHost({
        argv: [],
        processCwd: "/work",
        input,
        output: () => {},
        diagnostic: () => {},
        shutdownSignal: controller.signal,
        adapter,
      });
      await until(() => adapter.started === true);

      if (stop === "eof") input.end();
      else controller.abort();

      const session = new FakeSession(adapter.bindings);
      gate.resolve(session);
      assert.equal(await running, 0);
      assert.deepEqual(session.shutdownCalls, ["shutdown"]);
    });
  }
});

test("drains queued commands before shutdown when stdin ends during open", async () => {
  const input = new PassThrough();
  const output = [];
  const gate = deferred();
  const adapter = {
    async open(_options, bindings) {
      this.started = true;
      this.bindings = bindings;
      return gate.promise;
    },
  };
  const running = runAgentHost({
    argv: [],
    processCwd: "/work",
    input,
    output: (value) => output.push(value),
    diagnostic: () => {},
    adapter,
  });

  input.end(serializeJsonLine({ id: "piped-state", type: "get_state" }));
  await until(() => adapter.started === true);
  const session = new FakeSession(adapter.bindings);
  gate.resolve(session);

  assert.equal(await running, 0);
  assert.equal(response(output, "piped-state").data.sessionId, "fake-session");
  assert.deepEqual(session.shutdownCalls, ["shutdown"]);
});

test("real adapter uses the public Pi SDK constructors and shuts down in order", async () => {
  const calls = [];
  const modelRuntime = {
    async getAvailable() {
      return [{ provider: "fake", id: "model-a" }];
    },
    getModel(provider, modelId) {
      return { provider, id: modelId };
    },
  };
  const sdkSession = {
    model: { provider: "fake", id: "model-a" },
    thinkingLevel: "high",
    messages: [],
    sessionId: "sdk-session",
    extensionRunner: {
      async emit(event) {
        calls.push(["session_shutdown", event]);
      },
    },
    async bindExtensions(bindings) {
      calls.push(["bind", bindings.mode]);
    },
    subscribe() {
      calls.push(["subscribe"]);
      return () => calls.push(["unsubscribe"]);
    },
    async prompt(_message, options) {
      options.preflightResult(true);
    },
    async abort() {
      calls.push(["abort"]);
    },
    async setModel() {},
    setThinkingLevel() {},
    async compact() {
      return {};
    },
    setSessionName(name) {
      calls.push(["name", name]);
    },
    dispose() {
      calls.push(["dispose"]);
    },
  };
  let loaderOptions;
  const fakeSdk = {
    getAgentDir: () => "/agent",
    ModelRuntime: {
      async create(options) {
        calls.push(["modelRuntime", options]);
        return modelRuntime;
      },
    },
    SessionManager: {
      create(cwd, sessionDir, options) {
        calls.push(["sessionCreate", cwd, sessionDir, options]);
        return { getCwd: () => cwd };
      },
      open() {
        throw new Error("unexpected open");
      },
    },
    SettingsManager: {
      create(cwd, agentDir, options) {
        calls.push(["settings", cwd, agentDir, options]);
        return { getSessionDir: () => "/settings/sessions" };
      },
    },
    ProjectTrustStore: class {
      get() {
        return null;
      }
      set() {}
    },
    hasTrustRequiringProjectResources: () => false,
    DefaultResourceLoader: class {
      constructor(options) {
        loaderOptions = options;
        calls.push(["loader"]);
      }
      async reload() {
        calls.push(["reload"]);
      }
      getExtensions() {
        return {
          extensions: [{
            path: "/tmp/starling-gate.mjs",
            resolvedPath: "/tmp/starling-gate.mjs",
            sourceInfo: { source: "/tmp/starling-gate.mjs" },
          }],
          errors: [],
        };
      }
    },
    async createAgentSession(options) {
      calls.push(["createAgentSession", options]);
      return { session: sdkSession };
    },
  };

  const adapter = createPiSdkAdapter(async () => fakeSdk, {});
  const session = await adapter.open({
    cwd: "/work",
    sessionId: "fixed-id",
    name: "Starling session",
    provider: "fake",
    model: "model-a",
    thinking: "high",
    extensions: ["/tmp/starling-gate.mjs"],
    noExtensions: true,
  }, {
    uiContext: {},
    emitEvent: () => {},
    emitExtensionError: () => {},
    requestShutdown: () => {},
  });

  assert.deepEqual(loaderOptions.additionalExtensionPaths, ["/tmp/starling-gate.mjs"]);
  assert.equal(loaderOptions.noExtensions, true);
  assert.ok(calls.some(([name]) => name === "modelRuntime"));
  assert.ok(calls.some(([name]) => name === "settings"));
  assert.ok(calls.some(([name]) => name === "sessionCreate"));
  assert.ok(calls.some(([name]) => name === "createAgentSession"));
  assert.ok(calls.some((call) =>
    call[0] === "settings" && call[3].projectTrusted === true
  ));
  assert.ok(calls.some((call) =>
    call[0] === "sessionCreate" && call[2] === "/settings/sessions"
  ));

  await session.shutdown();
  assert.deepEqual(calls.slice(-4).map(([name]) => name), [
    "abort",
    "session_shutdown",
    "unsubscribe",
    "dispose",
  ]);
});

test("resume derives SDK services from the transcript cwd and persists an asked trust decision", async () => {
  const calls = [];
  const trustWrites = [];
  const transcriptCwd = "/projects/from-transcript";
  let loaderOptions;
  let createOptions;
  const fakeSdk = makeMinimalPiSdk(calls, {
    hasProjectResources: true,
    openSessionManager(...args) {
      calls.push(["sessionOpen", ...args]);
      return { getCwd: () => transcriptCwd };
    },
    createSettings(cwd, agentDir, options) {
      calls.push(["settings", cwd, agentDir, options]);
      return { getSessionDir: () => "/settings/sessions" };
    },
    createTrustStore() {
      return {
        get(cwd) {
          calls.push(["trustGet", cwd]);
          return null;
        },
        set(cwd, decision) {
          trustWrites.push([cwd, decision]);
        },
      };
    },
    onLoader(options) {
      loaderOptions = options;
    },
    onCreateAgentSession(options) {
      createOptions = options;
    },
  });
  const confirmCalls = [];
  const adapter = createPiSdkAdapter(async () => fakeSdk, {
    STARLING_PROJECT_TRUST: "ask",
  });
  const session = await adapter.open({
    cwd: "/ignored/launcher-cwd",
    sessionPath: "/sessions/resume.jsonl",
    extensions: [],
    noExtensions: false,
  }, {
    uiContext: {
      async confirm(...args) {
        confirmCalls.push(args);
        return true;
      },
    },
    emitEvent: () => {},
    emitExtensionError: () => {},
    requestShutdown: () => {},
  });

  assert.deepEqual(calls.find(([name]) => name === "sessionOpen"), [
    "sessionOpen",
    "/sessions/resume.jsonl",
  ]);
  assert.deepEqual(calls.find(([name]) => name === "settings"), [
    "settings",
    transcriptCwd,
    "/agent",
    { projectTrusted: true },
  ]);
  assert.equal(loaderOptions.cwd, transcriptCwd);
  assert.equal(createOptions.cwd, transcriptCwd);
  assert.equal(confirmCalls.length, 1);
  assert.deepEqual(trustWrites, [[transcriptCwd, true]]);
  await session.shutdown();
});

test("a cancelled startup trust prompt defaults to untrusted without persisting", async () => {
  const input = new PassThrough();
  const output = [];
  const calls = [];
  const trustWrites = [];
  let settingsTrust;
  const fakeSdk = makeMinimalPiSdk(calls, {
    hasProjectResources: true,
    createTrustStore() {
      return {
        get: () => null,
        set(cwd, decision) {
          trustWrites.push([cwd, decision]);
        },
      };
    },
    createSettings(_cwd, _agentDir, settingsOptions) {
      settingsTrust = settingsOptions.projectTrusted;
      return { getSessionDir: () => undefined };
    },
  });
  const running = runAgentHost({
    argv: [],
    processCwd: "/work",
    input,
    output: (value) => output.push(value),
    diagnostic: () => {},
    adapter: createPiSdkAdapter(async () => fakeSdk, {}),
  });

  await until(() => output.some((record) => record.type === "extension_ui_request"));
  const request = output.find((record) => record.type === "extension_ui_request");
  input.write(serializeJsonLine({
    type: "extension_ui_response",
    id: request.id,
    cancelled: true,
  }));
  input.write(serializeJsonLine({ id: "ready", type: "get_state" }));
  await until(() => response(output, "ready") !== undefined);
  input.end();

  assert.equal(await running, 0);
  assert.equal(settingsTrust, false);
  assert.deepEqual(trustWrites, []);
});

test("new sessions prefer PI_CODING_AGENT_SESSION_DIR over settings", async () => {
  const calls = [];
  const fakeSdk = makeMinimalPiSdk(calls, {
    createSettings() {
      return { getSessionDir: () => "/settings/sessions" };
    },
  });
  const adapter = createPiSdkAdapter(async () => fakeSdk, {
    PI_CODING_AGENT_SESSION_DIR: "/environment/sessions",
  });
  const session = await adapter.open({
    cwd: "/work",
    sessionId: "new-id",
    extensions: [],
    noExtensions: false,
  }, emptyBindings());

  assert.deepEqual(calls.find(([name]) => name === "sessionCreate"), [
    "sessionCreate",
    "/work",
    "/environment/sessions",
    { id: "new-id" },
  ]);
  await session.shutdown();
});

test("fails closed when an explicit extension was not loaded", async () => {
  const calls = [];
  const extensionPath = "/work/gate.mjs";
  const fakeSdk = makeMinimalPiSdk(calls, {
    extensionResult: {
      extensions: [],
      errors: [{ path: extensionPath, error: "synthetic load failure" }],
    },
  });
  const adapter = createPiSdkAdapter(async () => fakeSdk, {});

  await assert.rejects(() => adapter.open({
    cwd: "/work",
    extensions: [extensionPath],
    noExtensions: true,
  }, emptyBindings()), /Explicit extension failed to load.*synthetic load failure/);
  assert.equal(calls.some(([name]) => name === "createAgentSession"), false);
});

function response(records, id, command) {
  return records.find((record) =>
    record.type === "response"
      && (id === undefined || record.id === id)
      && (command === undefined || record.command === command)
  );
}

async function until(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for test condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function emptyBindings() {
  return {
    uiContext: {},
    emitEvent: () => {},
    emitExtensionError: () => {},
    requestShutdown: () => {},
  };
}

function makeMinimalPiSdk(calls, options = {}) {
  const makeSession = () => ({
    messages: [],
    async bindExtensions() {},
    subscribe() {
      return () => {};
    },
    async prompt(_message, promptOptions) {
      promptOptions?.preflightResult?.(true);
    },
    async abort() {},
    async setModel() {},
    setThinkingLevel() {},
    async compact() {
      return {};
    },
    dispose() {},
  });

  return {
    getAgentDir: () => "/agent",
    ModelRuntime: {
      async create() {
        return { async getAvailable() { return []; } };
      },
    },
    SessionManager: {
      create(cwd, sessionDir, sessionOptions) {
        calls.push(["sessionCreate", cwd, sessionDir, sessionOptions]);
        return { getCwd: () => cwd };
      },
      open(...args) {
        if (options.openSessionManager) return options.openSessionManager(...args);
        return { getCwd: () => "/work" };
      },
    },
    SettingsManager: {
      create(cwd, agentDir, settingsOptions) {
        if (options.createSettings) {
          return options.createSettings(cwd, agentDir, settingsOptions);
        }
        calls.push(["settings", cwd, agentDir, settingsOptions]);
        return { getSessionDir: () => "/settings/sessions" };
      },
    },
    ProjectTrustStore: class {
      constructor() {
        return options.createTrustStore?.() ?? { get: () => null, set: () => {} };
      }
    },
    hasTrustRequiringProjectResources: () => options.hasProjectResources === true,
    DefaultResourceLoader: class {
      constructor(loaderOptions) {
        options.onLoader?.(loaderOptions);
      }
      async reload() {}
      getExtensions() {
        return options.extensionResult ?? { extensions: [], errors: [] };
      }
    },
    async createAgentSession(sessionOptions) {
      calls.push(["createAgentSession", sessionOptions]);
      options.onCreateAgentSession?.(sessionOptions);
      return { session: makeSession() };
    },
  };
}
