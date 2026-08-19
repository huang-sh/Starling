import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { runAgentHost } from "../lib/agents/pi/host.js";
import {
  MAX_JSONL_LINE_BYTES,
  attachStrictJsonlReader,
  serializeJsonLine,
} from "../lib/agents/pi/jsonl.js";
import { createPiSdkAdapter } from "../lib/agents/pi/sdk-adapter.js";
import { parseAgentHostArgs } from "../lib/agents/pi/types.js";

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

  getCommands() {
    return [{
      name: "fake-command",
      description: "Fake command",
      source: "extension",
      sourceInfo: { path: "/fake/extension.mjs" },
    }];
  }

  getSessionStats() {
    return { sessionId: "fake-session", totalMessages: 1 };
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

  async getModelConfig() {
    return {
      defaultProvider: "fake",
      defaultModel: "model-a",
    };
  }

  async configureModel(provider, modelId, thinkingLevel) {
    this.calls.push(["configureModel", provider, modelId, thinkingLevel]);
    return { provider, id: modelId, thinkingLevel };
  }

  setThinkingLevel(level) {
    this.thinking = level;
    this.calls.push(["setThinking", level]);
  }

  async getAvailableModels() {
    return [{ provider: "fake", id: "model-a" }];
  }

  getTree() {
    this.calls.push(["getTree"]);
    return {
      tree: [{ entry: { id: "root", parentId: null, type: "message" }, children: [] }],
      leafId: "root",
    };
  }

  async navigateTree(targetId, options) {
    this.calls.push(["navigateTree", targetId, options]);
    return { cancelled: false };
  }

  abortTreeNavigation() {
    this.calls.push(["abortTreeNavigation"]);
  }

  async compact(customInstructions) {
    this.calls.push(["compact", customInstructions]);
    return { summary: "small" };
  }

  abortCompaction() {
    this.calls.push(["abortCompaction"]);
  }

  setSessionName(name) {
    this.calls.push(["setSessionName", name]);
  }

  async reload() {
    this.calls.push(["reload"]);
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
    "--starling-managed",
    "--extension", "gate.mjs",
  ], "/root");

  assert.deepEqual(parsed, {
    cwd: path.resolve("/root", "project"),
    sessionPath: undefined,
    sessionId: "session-1",
    name: "Named",
    provider: "anthropic",
    model: "claude-test",
    thinking: "high",
    extensions: [path.resolve("/root", "project", "gate.mjs")],
    noExtensions: true,
    starlingManaged: true,
  });
  assert.throws(
    () => parseAgentHostArgs(["--session", "relative.jsonl"], "/root"),
    /absolute Pi transcript/,
  );
});

test("strict JSONL input drops an oversized line and recovers at the next LF", async () => {
  const input = new PassThrough();
  const lines = [];
  const errors = [];
  attachStrictJsonlReader(input, (line) => lines.push(line), (error) => errors.push(error.message));
  const ended = new Promise((resolve) => input.once("end", resolve));

  input.end(`${"界".repeat(Math.ceil(MAX_JSONL_LINE_BYTES / 3) + 1)}\n{"ok":true}\n`);
  await ended;

  assert.deepEqual(lines, ['{"ok":true}']);
  assert.deepEqual(errors, [`JSONL line exceeds ${MAX_JSONL_LINE_BYTES} bytes`]);
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
    { id: "commands", type: "get_commands" },
    { id: "stats", type: "get_session_stats" },
    { id: "name", type: "set_session_name", name: "  Renamed session  " },
    { id: "reload", type: "reload" },
    { id: "prompt", type: "prompt", message: "hello", streamingBehavior: "followUp" },
    { id: "thinking", type: "set_thinking_level", level: "high" },
    { id: "models", type: "get_available_models" },
    { id: "tree", type: "get_tree" },
    { id: "navigate-tree", type: "navigate_tree", targetId: "root", summarize: false },
    { id: "model-config", type: "get_model_config" },
    { id: "model", type: "set_model", provider: "fake", modelId: "model-a" },
    {
      id: "configure-model",
      type: "configure_model",
      provider: "fake",
      modelId: "model-a",
      thinkingLevel: "medium",
    },
    { id: "compact", type: "compact", customInstructions: "short" },
  ]) {
    input.write(serializeJsonLine(command));
  }
  await until(() => response(output, "compact") !== undefined);
  input.write(serializeJsonLine({ id: "abort-compact", type: "abort_compaction" }));
  await until(() => response(output, "abort-compact") !== undefined);
  input.write(serializeJsonLine({ id: "abort-tree", type: "abort_tree_navigation" }));
  await until(() => response(output, "abort-tree") !== undefined);
  input.write(serializeJsonLine({ id: "abort", type: "abort" }));
  await until(() => response(output, "abort") !== undefined);
  input.end();

  assert.equal(await running, 0);
  assert.equal(diagnostics.length, 0);
  assert.equal(adapter.options.sessionPath, path.normalize("/sessions/existing.jsonl"));
  assert.equal(response(output, "state").data.sessionId, "fake-session");
  assert.deepEqual(response(output, "messages").data.messages, [
    { role: "user", content: "history" },
  ]);
  assert.deepEqual(response(output, "commands").data.commands, [{
    name: "fake-command",
    description: "Fake command",
    source: "extension",
    sourceInfo: { path: "/fake/extension.mjs" },
  }]);
  assert.deepEqual(response(output, "stats").data, {
    sessionId: "fake-session",
    totalMessages: 1,
  });
  assert.equal(response(output, "name").success, true);
  assert.equal(response(output, "reload").success, true);
  assert.equal(response(output, "prompt").success, true);
  assert.ok(output.some((record) => record.type === "agent_start"));
  assert.deepEqual(response(output, "models").data.models, [
    { provider: "fake", id: "model-a" },
  ]);
  assert.equal(response(output, "tree").data.leafId, "root");
  assert.deepEqual(response(output, "navigate-tree").data, { cancelled: false });
  assert.deepEqual(response(output, "model-config").data, {
    defaultProvider: "fake",
    defaultModel: "model-a",
  });
  assert.deepEqual(response(output, "model").data, { provider: "fake", id: "model-a" });
  assert.deepEqual(response(output, "configure-model").data, {
    provider: "fake",
    id: "model-a",
    thinkingLevel: "medium",
  });
  assert.deepEqual(response(output, "compact").data, { summary: "small" });
  assert.equal(response(output, "abort-compact").success, true);
  assert.deepEqual(adapter.session.calls, [
    ["setSessionName", "Renamed session"],
    ["reload"],
    ["prompt", "hello", "followUp"],
    ["setThinking", "high"],
    ["getTree"],
    ["navigateTree", "root", { summarize: false }],
    ["setModel", "fake", "model-a"],
    ["configureModel", "fake", "model-a", "medium"],
    ["compact", "short"],
    ["abortCompaction"],
    ["abortTreeNavigation"],
    ["abort"],
  ]);
  assert.deepEqual(adapter.session.shutdownCalls, ["shutdown"]);
});

test("queues stdin that was already buffered before the SDK host starts", async () => {
  const input = new PassThrough();
  const output = [];
  const adapter = new FakeAdapter();
  input.end(serializeJsonLine({ id: "early", type: "get_state" }));

  const code = await runAgentHost({
    argv: [],
    processCwd: "/work",
    input,
    output: (value) => output.push(value),
    diagnostic: () => {},
    adapter,
  });

  assert.equal(code, 0);
  assert.equal(response(output, "early").data.sessionId, "fake-session");
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

test("a signal upgrades an EOF drain instead of waiting for a stuck command", async () => {
  const input = new PassThrough();
  const controller = new AbortController();
  const gate = deferred();
  const adapter = {
    async open(_options, bindings) {
      const session = new FakeSession(bindings);
      session.compact = async () => {
        adapter.compactStarted = true;
        return gate.promise;
      };
      this.session = session;
      this.opened = true;
      return session;
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
  await until(() => adapter.opened === true);
  input.write(serializeJsonLine({ id: "compact", type: "compact" }));
  await until(() => adapter.compactStarted === true);

  input.end();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(adapter.session.shutdownCalls, []);
  controller.abort();
  assert.equal(await Promise.race([
    running,
    new Promise((resolve) => setTimeout(() => resolve("still-draining"), 100)),
  ]), 0);
  assert.deepEqual(adapter.session.shutdownCalls, ["shutdown"]);

  gate.resolve({ summary: "late" });
});

test("SDK-requested shutdown ends the JSONL host without waiting for EOF", async () => {
  const input = new PassThrough();
  const adapter = new FakeAdapter();
  const running = runAgentHost({
    argv: [],
    processCwd: "/work",
    input,
    output: () => {},
    diagnostic: () => {},
    adapter,
  });
  await until(() => adapter.opened === true);

  adapter.session.bindings.requestShutdown();
  assert.equal(await running, 0);
  assert.deepEqual(adapter.session.shutdownCalls, ["shutdown"]);
});

test("SDK-requested shutdown failure is diagnosed once", async () => {
  const input = new PassThrough();
  const diagnostics = [];
  const adapter = new FakeAdapter();
  const running = runAgentHost({
    argv: [],
    processCwd: "/work",
    input,
    output: () => {},
    diagnostic: (message) => diagnostics.push(message),
    adapter,
  });
  await until(() => adapter.opened === true);
  adapter.session.shutdown = async () => {
    throw new Error("shutdown boom");
  };

  adapter.session.bindings.requestShutdown();
  assert.equal(await running, 1);
  assert.equal(diagnostics.filter((message) => message.includes("shutdown boom")).length, 1);
});

test("a distinct cleanup failure remains visible after an input failure", async () => {
  const input = new PassThrough();
  const diagnostics = [];
  const adapter = new FakeAdapter();
  const running = runAgentHost({
    argv: [],
    processCwd: "/work",
    input,
    output: () => {},
    diagnostic: (message) => diagnostics.push(message),
    adapter,
  });
  await until(() => adapter.opened === true);
  adapter.session.shutdown = async () => {
    throw new Error("cleanup boom");
  };

  input.emit("error", new Error("input boom"));
  assert.equal(await running, 1);
  assert.ok(diagnostics.some((message) => message.includes("input boom")));
  assert.ok(diagnostics.some((message) => message.includes("cleanup boom")));
});

test("EOF followed by a delayed SDK open failure exits unsuccessfully", async () => {
  const input = new PassThrough();
  const diagnostics = [];
  const gate = deferred();
  const adapter = {
    async open() {
      this.started = true;
      return gate.promise;
    },
  };
  const running = runAgentHost({
    argv: [],
    processCwd: "/work",
    input,
    output: () => {},
    diagnostic: (message) => diagnostics.push(message),
    adapter,
  });
  await until(() => adapter.started === true);
  input.end();
  gate.reject(new Error("delayed open failure"));

  assert.equal(await running, 1);
  assert.equal(diagnostics.filter((message) => message.includes("delayed open failure")).length, 1);
});

test("real adapter follows OMP's public createAgentSession lifecycle", async (t) => {
  const calls = [];
  const extensionPath = "/tmp/starling-gate.mjs";
  const selectedModel = { provider: "fake", id: "model-a" };
  const sdkSession = makeSdkSession(calls, {
    model: selectedModel,
    thinkingLevel: "high",
    async navigateTree(targetId, options) {
      calls.push(["navigateTree", targetId, options]);
      return { cancelled: false, editorText: "restored prompt" };
    },
    abortBranchSummary() {
      calls.push(["abortBranchSummary"]);
    },
  });
  const sessionTree = [{
    entry: { id: "root", parentId: null, type: "message" },
    children: [],
  }];
  const extensionSource = { path: "/extensions/example.mjs", scope: "project" };
  const promptSource = { path: "/prompts/review.md", scope: "user" };
  const skillSource = { path: "/skills/check/SKILL.md", scope: "project" };
  sdkSession.extensionRunner.getRegisteredCommands = () => [{
    invocationName: "example:run",
    description: "Run the example extension",
    sourceInfo: extensionSource,
  }];
  sdkSession.promptTemplates = [{
    name: "review",
    description: "Review the current change",
    sourceInfo: promptSource,
  }];
  sdkSession.resourceLoader = {
    getSkills() {
      return {
        skills: [{
          name: "check",
          description: "Check the project",
          sourceInfo: skillSource,
        }],
      };
    },
  };
  sdkSession.getSessionStats = () => ({
    sessionId: "sdk-session",
    totalMessages: 3,
  });
  sdkSession.reload = async () => {
    calls.push(["sessionReload"]);
  };
  let loaderOptions;
  let createOptions;
  const fakeSdk = makeMinimalPiSdk(calls, {
    session: sdkSession,
    sessionManager: {
      getCwd: () => "/work",
      getTree: () => sessionTree,
      getLeafId: () => "root",
    },
    modelRuntime: {
      async getAvailable() {
        return [selectedModel];
      },
      getModel(provider, modelId) {
        return provider === selectedModel.provider && modelId === selectedModel.id
          ? selectedModel
          : undefined;
      },
    },
    extensionResult: {
      extensions: [{
        path: extensionPath,
        resolvedPath: extensionPath,
        sourceInfo: { source: extensionPath },
      }],
      errors: [],
    },
    onLoader(options) {
      loaderOptions = options;
    },
    onCreateAgentSession(options) {
      createOptions = options;
    },
  });

  const environment = {};
  const ignoreScriptNames = [
    "NPM_CONFIG_IGNORE_SCRIPTS",
    "npm_config_ignore_scripts",
    "PNPM_CONFIG_IGNORE_SCRIPTS",
  ];
  const previousIgnoreScripts = new Map(ignoreScriptNames.map((name) => [name, process.env[name]]));
  t.after(() => {
    for (const [name, value] of previousIgnoreScripts) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  const adapter = createPiSdkAdapter(async () => fakeSdk, environment);
  const session = await adapter.open({
    cwd: "/work",
    name: "Starling session",
    provider: "fake",
    model: "model-a",
    thinking: "high",
    extensions: [extensionPath],
    noExtensions: true,
    surface: "tui",
    starlingManaged: true,
  }, emptyBindings());

  const sessionCreate = calls.find(([name]) => name === "sessionCreate");
  assert.deepEqual(sessionCreate, [
    "sessionCreate",
    "/work",
    "/settings/sessions",
    undefined,
  ]);
  assertCallOrder(calls, [
    "settings",
    "sessionCreate",
    "modelRuntime",
    "loader",
    "reload",
    "createAgentSession",
    "sessionName",
    "bindExtensions",
    "subscribe",
  ]);
  assert.deepEqual(calls.find(([name]) => name === "sessionName"), [
    "sessionName",
    "Starling session",
  ]);
  assert.deepEqual(environment, {
    NPM_CONFIG_IGNORE_SCRIPTS: "true",
    npm_config_ignore_scripts: "true",
    PNPM_CONFIG_IGNORE_SCRIPTS: "true",
  });
  for (const name of ignoreScriptNames) assert.equal(process.env[name], "true");
  assert.equal(createOptions.cwd, "/work");
  assert.equal(createOptions.model, selectedModel);
  assert.equal(createOptions.thinkingLevel, "high");
  assert.deepEqual(loaderOptions.additionalExtensionPaths, [extensionPath]);
  assert.equal(loaderOptions.noExtensions, true);
  assert.equal(loaderOptions.extensionFactories.length, 1);
  const inlineExtension = loaderOptions.extensionFactories[0];
  assert.deepEqual(
    { name: inlineExtension.name, hidden: inlineExtension.hidden },
    { name: "starling-managed", hidden: true },
  );
  assert.equal(typeof inlineExtension.factory, "function");

  const handlers = {};
  inlineExtension.factory({
    on(event, handler) {
      handlers[event] = handler;
    },
  });
  const confirmTitles = [];
  const deniedContext = {
    ui: {
      async confirm(title) {
        confirmTitles.push(title);
        return false;
      },
      notify() {},
    },
  };
  assert.equal(await handlers.tool_call({ toolName: "read", input: {} }, deniedContext), undefined);
  for (const toolName of ["bash", "write", "custom"]) {
    assert.deepEqual(
      await handlers.tool_call({ toolName, input: {} }, deniedContext),
      {
        block: true,
        reason: `Starling denied Pi tool '${toolName}' because approval was not granted.`,
      },
    );
  }
  assert.deepEqual(confirmTitles, [
    "Allow Pi tool: bash?",
    "Allow Pi tool: write?",
    "Allow Pi tool: custom?",
  ]);
  assert.deepEqual(await handlers.session_before_switch({}, deniedContext), { cancel: true });

  let accepted = false;
  session.prompt("hello", undefined, () => {
    accepted = true;
  }, assert.fail);
  await until(() => accepted);
  assert.equal(sdkSession.bindings.mode, "tui");
  assert.equal(sdkSession.promptOptions.source, "interactive");
  assert.equal(typeof sdkSession.promptOptions.preflightResult, "function");
  assert.deepEqual(session.getCommands(), [
    {
      name: "example:run",
      description: "Run the example extension",
      source: "extension",
      sourceInfo: extensionSource,
    },
    {
      name: "review",
      description: "Review the current change",
      source: "prompt",
      sourceInfo: promptSource,
    },
    {
      name: "skill:check",
      description: "Check the project",
      source: "skill",
      sourceInfo: skillSource,
    },
  ]);
  assert.deepEqual(session.getSessionStats(), {
    sessionId: "sdk-session",
    totalMessages: 3,
  });
  assert.deepEqual(session.getTree(), { tree: sessionTree, leafId: "root" });
  assert.deepEqual(await session.navigateTree("root", { summarize: false }), {
    cancelled: false,
    editorText: "restored prompt",
  });
  session.abortTreeNavigation();
  session.setSessionName("Renamed through adapter");
  await session.reload();
  assert.deepEqual(calls.filter(([name]) => name === "sessionName"), [
    ["sessionName", "Starling session"],
    ["sessionName", "Renamed through adapter"],
  ]);
  assert.equal(calls.some(([name]) => name === "sessionReload"), true);
  assert.deepEqual(calls.filter(([name]) => name === "navigateTree"), [
    ["navigateTree", "root", { summarize: false }],
  ]);
  assert.equal(calls.filter(([name]) => name === "abortBranchSummary").length, 1);

  const shutdownStart = calls.length;
  await session.shutdown();
  await session.shutdown();
  assert.deepEqual(calls.slice(shutdownStart).map(([name]) => name), [
    "abortBranchSummary",
    "abortCompaction",
    "abort",
    "abortCompaction",
    "session_shutdown",
    "unsubscribe",
    "dispose",
  ]);
});

test("adapter persists the selected default through public Pi settings APIs", async (t) => {
  const agentDir = mkdtempSync(join(tmpdir(), "starling-model-config-"));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));
  const settingsPath = join(agentDir, "settings.json");
  writeFileSync(settingsPath, JSON.stringify({
    defaultProvider: "fake",
    defaultModel: "model-a",
    defaultThinkingLevel: "low",
    packages: ["pi-taskflow"],
  }, null, 2));

  const calls = [];
  const models = [
    { provider: "fake", id: "model-a", name: "Model A", reasoning: true },
    {
      provider: "fake",
      id: "model-b",
      name: "Model B",
      reasoning: true,
      thinkingLevelMap: { xhigh: "xhigh", max: "max" },
    },
  ];
  let defaultProvider = "fake";
  let defaultModel = "model-a";
  let defaultThinkingLevel = "low";
  const settingsManager = {
    getSessionDir: () => undefined,
    getDefaultProvider: () => defaultProvider,
    getDefaultModel: () => defaultModel,
    getDefaultThinkingLevel: () => defaultThinkingLevel,
    setDefaultModelAndProvider(provider, modelId) {
      defaultProvider = provider;
      defaultModel = modelId;
      const current = JSON.parse(readFileSync(settingsPath, "utf8"));
      writeFileSync(settingsPath, JSON.stringify({
        ...current,
        defaultProvider: provider,
        defaultModel: modelId,
      }, null, 2));
    },
    setDefaultThinkingLevel(level) {
      defaultThinkingLevel = level;
      const current = JSON.parse(readFileSync(settingsPath, "utf8"));
      writeFileSync(settingsPath, JSON.stringify({
        ...current,
        defaultThinkingLevel: level,
      }, null, 2));
    },
    async flush() {},
  };
  const sdkSession = makeSdkSession(calls, { model: models[0] });
  const fakeSdk = makeMinimalPiSdk(calls, {
    agentDir,
    session: sdkSession,
    createSettings: () => settingsManager,
    modelRuntime: {
      async getAvailable() {
        return models;
      },
      getModel(provider, modelId) {
        return models.find((model) => model.provider === provider && model.id === modelId);
      },
    },
  });
  const adapter = createPiSdkAdapter(async () => fakeSdk, {});
  const session = await adapter.open({
    cwd: "/work",
    extensions: [],
    noExtensions: true,
  }, emptyBindings());

  assert.deepEqual(await session.getModelConfig(), {
    defaultProvider: "fake",
    defaultModel: "model-a",
    defaultThinkingLevel: "low",
  });
  await session.configureModel("fake", "model-b", "max");

  const saved = JSON.parse(readFileSync(settingsPath, "utf8"));
  assert.deepEqual(saved.packages, ["pi-taskflow"], "unrelated Pi settings must survive");
  assert.equal(saved.defaultProvider, "fake");
  assert.equal(saved.defaultModel, "model-b");
  assert.equal(saved.defaultThinkingLevel, "max");
  assert.deepEqual(sdkSession.model, models[1], "configuration switches the live SDK session");
  await assert.rejects(
    () => session.configureModel("fake", "model-b", "invalid"),
    /Invalid configured thinking level/,
  );

  await session.shutdown();
});

test("adapter registers the OMP-compatible Zhipu Coding Plan provider", async () => {
  const calls = [];
  let registered;
  let requested;
  const models = [];
  const modelRuntime = {
    registerProvider(provider, config) {
      registered = { provider, config };
      models.push(...config.models.map((model) => ({
        ...model,
        provider,
        api: config.api,
        baseUrl: config.baseUrl,
      })));
    },
    async getAvailable() {
      return models;
    },
    getModel(provider, modelId) {
      return models.find((model) => model.provider === provider && model.id === modelId);
    },
  };
  const adapter = createPiSdkAdapter(
    async () => makeMinimalPiSdk(calls, { modelRuntime }),
    { ZHIPU_API_KEY: "zhipu-test-key" },
    async (input, init) => {
      requested = { url: String(input), authorization: init?.headers?.Authorization };
      return new Response(JSON.stringify({
        data: [
          { id: "glm-5.1", name: "GLM-5.1" },
          { id: "glm-5.2", name: "GLM-5.2" },
        ],
      }), { headers: { "content-type": "application/json" } });
    },
  );
  const session = await adapter.open({
    cwd: "/work",
    extensions: [],
    noExtensions: true,
  }, emptyBindings());

  assert.deepEqual(requested, {
    url: "https://open.bigmodel.cn/api/coding/paas/v4/models",
    authorization: "Bearer zhipu-test-key",
  });
  assert.equal(registered.provider, "zhipu-coding-plan");
  assert.equal(registered.config.name, "Zhipu Coding Plan (智谱)");
  assert.equal(registered.config.api, "openai-completions");
  assert.equal(registered.config.baseUrl, "https://open.bigmodel.cn/api/coding/paas/v4");
  assert.equal(registered.config.apiKey, "zhipu-test-key");
  assert.deepEqual(
    (await session.getAvailableModels()).map((model) => `${model.provider}/${model.id}`),
    ["zhipu-coding-plan/glm-5.1", "zhipu-coding-plan/glm-5.2"],
  );

  await session.shutdown();
});

test("adapter drives Pi SDK provider login and logout through Starling auth UI", async () => {
  const calls = [];
  const notices = [];
  const prompts = [];
  const provider = {
    id: "anthropic",
    name: "Anthropic",
    auth: {
      oauth: { name: "Anthropic subscription", login() {} },
      apiKey: { name: "Anthropic API key", login() {} },
    },
  };
  const modelRuntime = {
    async getAvailable() {
      return [];
    },
    getProviders() {
      return [provider];
    },
    getProvider(providerId) {
      return providerId === provider.id ? provider : undefined;
    },
    getProviderAuthStatus() {
      return { configured: false };
    },
    async login(providerId, authType, interaction) {
      interaction.notify({
        type: "auth_url",
        url: "https://auth.example.test/start",
        instructions: "Sign in in your browser",
      });
      const value = await interaction.prompt({
        type: "secret",
        message: "Paste API key",
        placeholder: "sk-...",
      });
      calls.push(["runtimeLogin", providerId, authType, value]);
      return { type: "api_key", key: value };
    },
    async listCredentials() {
      return [{ providerId: "anthropic", type: "api_key" }];
    },
    async logout(providerId) {
      calls.push(["runtimeLogout", providerId]);
    },
  };
  const adapter = createPiSdkAdapter(
    async () => makeMinimalPiSdk(calls, { modelRuntime }),
    {},
  );
  const bindings = {
    ...emptyBindings(),
    uiContext: {
      async input(title, placeholder, options) {
        prompts.push({ type: "input", title, placeholder, options });
        return "sk-test-key";
      },
      notify(message, type) {
        notices.push({ message, type });
      },
      setStatus() {},
    },
  };
  const session = await adapter.open({
    cwd: "/work",
    extensions: [],
    noExtensions: true,
  }, bindings);

  const providerOptions = await session.getAuthProviders("login");
  assert.deepEqual(providerOptions.providers.map(({ id, authType, stored, interactive }) => ({
    id,
    authType,
    stored,
    interactive,
  })), [
    { id: "anthropic", authType: "api_key", stored: true, interactive: true },
    { id: "anthropic", authType: "oauth", stored: false, interactive: true },
  ]);
  assert.deepEqual(await session.loginProvider("anthropic", "api_key"), {
    provider: "anthropic",
    name: "Anthropic",
    authType: "api_key",
  });
  assert.deepEqual(prompts, [
    {
      type: "input",
      title: "Login to Anthropic",
      placeholder: "sk-...",
      options: {
        signal: prompts[0].options.signal,
        message: "Sign in in your browser\nOpen this URL to continue:\nhttps://auth.example.test/start\n\nPaste API key",
        secret: true,
      },
    },
  ]);
  assert.deepEqual(notices, [{
    message: "Sign in in your browser\nOpen this URL to continue:\nhttps://auth.example.test/start",
    type: "info",
  }]);
  assert.ok(!JSON.stringify(notices).includes("sk-test-key"));
  assert.deepEqual(await session.logoutProvider("anthropic"), {
    provider: "anthropic",
    name: "Anthropic",
    authType: "api_key",
  });
  assert.ok(calls.some((call) => call[0] === "runtimeLogin"));
  assert.ok(calls.some((call) => call[0] === "runtimeLogout"));

  await session.shutdown();
});

test("adapter shutdown cancels and settles compaction before disposing", async () => {
  const calls = [];
  let compactionController;
  const sdkSession = makeSdkSession(calls);
  sdkSession.compact = async () => {
    calls.push(["compactStart"]);
    // Pi creates its compaction controller only after this initial abort.
    await sdkSession.abort();
    calls.push(["compactionControllerCreated"]);
    try {
      return await new Promise((_resolve, reject) => {
        compactionController = { reject };
      });
    } finally {
      compactionController = undefined;
      calls.push(["compactionSettled"]);
    }
  };
  sdkSession.abortCompaction = () => {
    calls.push(["abortCompaction", compactionController !== undefined]);
    compactionController?.reject(new Error("Compaction cancelled"));
  };
  const adapter = createPiSdkAdapter(
    async () => makeMinimalPiSdk(calls, { session: sdkSession }),
    {},
  );
  const session = await adapter.open({
    cwd: "/work",
    extensions: [],
    noExtensions: true,
  }, emptyBindings());
  const operationStart = calls.length;

  const compact = session.compact();
  const compactRejected = assert.rejects(compact, /Compaction cancelled/);
  await session.shutdown();
  await compactRejected;

  assert.deepEqual(calls.slice(operationStart).map(([name, state]) =>
    state === undefined ? name : [name, state]
  ), [
    "compactStart",
    "abort",
    ["abortCompaction", false],
    "abort",
    "compactionControllerCreated",
    ["abortCompaction", true],
    "compactionSettled",
    ["session_shutdown", { type: "session_shutdown", reason: "quit" }],
    "unsubscribe",
    "dispose",
  ]);
});

test("resume derives SDK resources from transcript cwd and persists asked trust", async () => {
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
    createSettings(cwd, agentDir, settingsOptions) {
      calls.push(["settings", cwd, agentDir, settingsOptions]);
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
    ...emptyBindings(),
    uiContext: {
      async confirm(...args) {
        confirmCalls.push(args);
        return true;
      },
    },
  });

  assert.deepEqual(calls.find(([name]) => name === "sessionOpen"), [
    "sessionOpen",
    "/sessions/resume.jsonl",
  ]);
  const runtimeSettings = calls.find((call) =>
    call[0] === "settings" && call[1] === transcriptCwd
  );
  assert.deepEqual(runtimeSettings, [
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
  const diagnostics = [];
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
      if (settingsOptions) settingsTrust = settingsOptions.projectTrusted;
      return {
        getSessionDir: () => undefined,
        getHideThinkingBlock: () => false,
      };
    },
  });
  const running = runAgentHost({
    argv: [],
    processCwd: "/work",
    input,
    output: (value) => output.push(value),
    diagnostic: (message) => diagnostics.push(message),
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

  assert.equal(await running, 0, diagnostics.join("\n"));
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

function makeSdkSession(calls, overrides = {}) {
  const session = {
    model: overrides.model,
    thinkingLevel: overrides.thinkingLevel,
    messages: [],
    sessionId: "sdk-session",
    extensionRunner: {
      async emit(event) {
        calls.push(["session_shutdown", event]);
      },
    },
    async bindExtensions(bindings) {
      session.bindings = bindings;
      calls.push(["bindExtensions", bindings]);
    },
    subscribe() {
      calls.push(["subscribe"]);
      return () => calls.push(["unsubscribe"]);
    },
    async prompt(message, promptOptions) {
      session.promptOptions = promptOptions;
      calls.push(["prompt", message, promptOptions]);
      promptOptions?.preflightResult?.(true);
    },
    async abort() {
      calls.push(["abort"]);
    },
    async setModel(model) {
      session.model = model;
    },
    setThinkingLevel(level) {
      session.thinkingLevel = level;
    },
    async compact() {
      return {};
    },
    abortCompaction() {
      calls.push(["abortCompaction"]);
    },
    setSessionName(name) {
      calls.push(["sessionName", name]);
    },
    dispose() {
      calls.push(["dispose"]);
    },
    ...overrides,
  };
  return session;
}

function makeMinimalPiSdk(calls, options = {}) {
  const modelRuntime = options.modelRuntime ?? {
    async getAvailable() {
      return [];
    },
  };
  const session = options.session ?? makeSdkSession(calls);

  return {
    getAgentDir: () => options.agentDir ?? "/agent",
    getPackageDir: () => "/package",
    async resolveModelScopeWithDiagnostics() {
      return { scopedModels: [], diagnostics: [] };
    },
    async copyToClipboard(text) {
      calls.push(["copyToClipboard", text]);
    },
    ModelRuntime: {
      async create(runtimeOptions) {
        calls.push(["modelRuntime", runtimeOptions]);
        return modelRuntime;
      },
    },
    SessionManager: {
      create(cwd, sessionDir, sessionOptions) {
        calls.push(["sessionCreate", cwd, sessionDir, sessionOptions]);
        return options.sessionManager ?? {
          getCwd: () => cwd,
        };
      },
      open(...args) {
        if (options.openSessionManager) return options.openSessionManager(...args);
        return options.sessionManager ?? { getCwd: () => "/work" };
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
        this.options = loaderOptions;
        calls.push(["loader", loaderOptions]);
        options.onLoader?.(loaderOptions);
      }
      async reload() {
        calls.push(["reload"]);
      }
      getExtensions() {
        return options.extensionResult ?? { extensions: [], errors: [] };
      }
    },
    async createAgentSession(sessionOptions) {
      calls.push(["createAgentSession", sessionOptions]);
      options.onCreateAgentSession?.(sessionOptions);
      session.sessionManager = sessionOptions.sessionManager;
      session.resourceLoader ??= sessionOptions.resourceLoader;
      return { session };
    },
    async createAgentSessionRuntime(factory, runtimeOptions) {
      calls.push(["createAgentSessionRuntime", runtimeOptions]);
      if (options.createRuntimeHost) {
        return await options.createRuntimeHost(factory, runtimeOptions);
      }
      let current = await factory(runtimeOptions);
      let beforeSessionInvalidate;
      let rebindSession;
      return {
        get session() {
          return current.session;
        },
        get services() {
          return current.services;
        },
        setBeforeSessionInvalidate(callback) {
          beforeSessionInvalidate = callback;
        },
        setRebindSession(callback) {
          rebindSession = callback;
        },
        async newSession() {
          if (!options.newSessionRuntime) throw new Error("Fake runtime cannot create a new session");
          current = await options.newSessionRuntime(factory, runtimeOptions, current);
          await rebindSession?.(current.session);
          return { cancelled: false };
        },
        async fork() {
          return { cancelled: true };
        },
        async switchSession() {
          return { cancelled: true };
        },
        async dispose() {
          await current.session.extensionRunner?.emit({
            type: "session_shutdown",
            reason: "quit",
          });
          beforeSessionInvalidate?.();
          current.session.dispose();
        },
      };
    },
  };
}

function assertCallOrder(calls, names) {
  let previous = -1;
  for (const name of names) {
    const index = calls.findIndex((call, candidateIndex) =>
      candidateIndex > previous && call[0] === name
    );
    assert.notEqual(index, -1, `Expected ${name} after call index ${previous}`);
    previous = index;
  }
}
