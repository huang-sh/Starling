import assert from "node:assert/strict";
import test from "node:test";

import { createChatSession } from "../lib/chat/session.js";

class FakeSession {
  constructor(bindings) {
    this.bindings = bindings;
    this.calls = [];
    this.shutdownCalls = 0;
    this.messages = [{ role: "user", content: "history" }];
    this.sessionId = "in-process";
  }

  getState() {
    return { sessionId: this.sessionId, isStreaming: false };
  }

  getMessages() {
    return this.messages;
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
    return { sessionId: "in-process", totalMessages: this.messages.length };
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
    this.calls.push(["setThinking", level]);
  }

  async getAvailableModels() {
    return [{ provider: "fake", id: "model-a" }];
  }

  async getAuthProviders(mode) {
    this.calls.push(["getAuthProviders", mode]);
    return { providers: [{ id: "anthropic", authType: "oauth" }] };
  }

  async loginProvider(provider, authType) {
    this.calls.push(["loginProvider", provider, authType]);
    return { provider, authType };
  }

  async logoutProvider(provider) {
    this.calls.push(["logoutProvider", provider]);
    return { provider };
  }

  abortAuthentication() {
    this.calls.push(["abortAuthentication"]);
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
    return { cancelled: false, editorText: "restored prompt" };
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

  async newSession() {
    this.calls.push(["newSession"]);
    this.sessionId = "new-session";
    this.messages = [];
    return { cancelled: false };
  }

  async resumeSession(sessionPath) {
    this.calls.push(["resumeSession", sessionPath]);
    this.sessionId = "resumed-session";
    this.messages = [{ role: "user", content: "resumed history" }];
    return { cancelled: false };
  }

  async forkSession(entryId) {
    this.calls.push(["forkSession", entryId]);
    this.sessionId = "forked-session";
    return { cancelled: false, selectedText: "forked prompt" };
  }

  async cloneSession() {
    this.calls.push(["cloneSession"]);
    this.sessionId = "cloned-session";
    return { cancelled: false };
  }

  async importSession(inputPath) {
    this.calls.push(["importSession", inputPath]);
    this.sessionId = "imported-session";
    return { cancelled: false };
  }

  async executeBash(command, excludeFromContext) {
    this.calls.push(["executeBash", command, excludeFromContext]);
    return { output: "fixture output", exitCode: 0, cancelled: false, truncated: false };
  }

  abortBash() {
    this.calls.push(["abortBash"]);
  }

  async exportSession(outputPath) {
    this.calls.push(["exportSession", outputPath]);
    return { path: outputPath ?? "/exports/session.html", format: "html" };
  }

  async copyLastAssistantMessage() {
    this.calls.push(["copyLastAssistantMessage"]);
    return { copied: true };
  }

  async configureSettings() {
    this.calls.push(["configureSettings"]);
    return { message: "Settings updated" };
  }

  async configureScopedModels() {
    this.calls.push(["configureScopedModels"]);
    return { message: "Scoped models updated" };
  }

  async shareSession() {
    this.calls.push(["shareSession"]);
    return { message: "Share URL: https://pi.dev/session/#fixture" };
  }

  getChangelog() {
    this.calls.push(["getChangelog"]);
    return { message: "Pi changelog" };
  }

  async configureProjectTrust() {
    this.calls.push(["configureProjectTrust"]);
    return { message: "Trust decision saved" };
  }

  async cycleModel(direction) {
    this.calls.push(["cycleModel", direction]);
    return { model: { provider: "fake", id: "model-b" }, thinkingLevel: "high" };
  }

  async cycleThinkingLevel() {
    this.calls.push(["cycleThinkingLevel"]);
    return { thinkingLevel: "xhigh" };
  }

  clearQueue() {
    this.calls.push(["clearQueue"]);
    return { steering: ["steer"], followUp: ["follow up"] };
  }

  async setThinkingVisible(visible) {
    this.calls.push(["setThinkingVisible", visible]);
    return { visible };
  }

  async shutdown() {
    this.shutdownCalls += 1;
  }
}

test("exposes Pi SDK commands in-process and forwards lifecycle records", async () => {
  const records = [];
  const adapter = {
    async open(launch, bindings) {
      this.launch = launch;
      this.session = new FakeSession(bindings);
      return this.session;
    },
  };
  const chat = createChatSession({
    launch: {
      cwd: "/work",
      sessionId: "fixed-id",
      extensions: [],
      noExtensions: true,
    },
    adapter,
    onRecord: (record) => records.push(record),
  });

  assert.deepEqual(await chat.request({ type: "get_state" }), {
    sessionId: "in-process",
    isStreaming: false,
  });
  assert.deepEqual(await chat.request({ type: "get_messages" }), {
    messages: [{ role: "user", content: "history" }],
  });
  assert.deepEqual(await chat.request({ type: "get_commands" }), {
    commands: [{
      name: "fake-command",
      description: "Fake command",
      source: "extension",
      sourceInfo: { path: "/fake/extension.mjs" },
    }],
  });
  assert.deepEqual(await chat.request({ type: "get_session_stats" }), {
    sessionId: "in-process",
    totalMessages: 1,
  });
  await chat.request({ type: "set_session_name", name: "  Renamed session  " });
  await chat.request({ type: "reload" });
  await chat.request({
    type: "prompt",
    message: "hello",
    streamingBehavior: "followUp",
  });
  assert.deepEqual(await chat.request({ type: "get_available_models" }), {
    models: [{ provider: "fake", id: "model-a" }],
  });
  assert.deepEqual(await chat.request({ type: "get_model_config" }), {
    defaultProvider: "fake",
    defaultModel: "model-a",
  });
  assert.deepEqual(await chat.request({
    type: "set_model",
    provider: "fake",
    modelId: "model-a",
  }), { provider: "fake", id: "model-a" });
  assert.deepEqual(await chat.request({
    type: "configure_model",
    provider: "fake",
    modelId: "model-a",
    thinkingLevel: "high",
  }), {
    provider: "fake",
    id: "model-a",
    thinkingLevel: "high",
  });
  assert.deepEqual(await chat.request({ type: "get_auth_providers", mode: "login" }), {
    providers: [{ id: "anthropic", authType: "oauth" }],
  });
  assert.deepEqual(await chat.request({
    type: "login_provider",
    provider: "anthropic",
    authType: "oauth",
  }), {
    provider: "anthropic",
    authType: "oauth",
  });
  assert.deepEqual(await chat.request({ type: "logout_provider", provider: "anthropic" }), {
    provider: "anthropic",
  });
  await chat.request({ type: "abort_authentication" });
  assert.deepEqual(await chat.request({ type: "get_tree" }), {
    tree: [{ entry: { id: "root", parentId: null, type: "message" }, children: [] }],
    leafId: "root",
  });
  assert.deepEqual(await chat.request({
    type: "navigate_tree",
    targetId: " root ",
    summarize: true,
    customInstructions: " keep decisions ",
  }), { cancelled: false, editorText: "restored prompt" });
  await chat.request({ type: "abort_tree_navigation" });
  await chat.request({ type: "set_thinking_level", level: "high" });
  assert.deepEqual(await chat.request({
    type: "compact",
    customInstructions: "short",
  }), { summary: "small" });
  assert.deepEqual(await chat.request({ type: "new_session" }), { cancelled: false });
  assert.deepEqual(await chat.request({ type: "get_state" }), {
    sessionId: "new-session",
    isStreaming: false,
  });
  assert.deepEqual(await chat.request({ type: "get_messages" }), { messages: [] });
  assert.deepEqual(await chat.request({
    type: "resume_session",
    sessionPath: "/sessions/resume.jsonl",
  }), { cancelled: false });
  assert.equal((await chat.request({ type: "get_state" })).sessionId, "resumed-session");
  assert.deepEqual(await chat.request({ type: "fork_session", entryId: "message-1" }), {
    cancelled: false,
    selectedText: "forked prompt",
  });
  assert.deepEqual(await chat.request({ type: "clone_session" }), { cancelled: false });
  assert.deepEqual(await chat.request({
    type: "import_session",
    inputPath: "/imports/session.jsonl",
  }), { cancelled: false });
  assert.deepEqual(await chat.request({
    type: "bash",
    command: "pwd",
    excludeFromContext: true,
  }), {
    output: "fixture output",
    exitCode: 0,
    cancelled: false,
    truncated: false,
  });
  await chat.request({ type: "abort_bash" });
  assert.deepEqual(await chat.request({ type: "export_session" }), {
    path: "/exports/session.html",
    format: "html",
  });
  assert.deepEqual(await chat.request({ type: "copy_last_message" }), { copied: true });
  assert.deepEqual(await chat.request({ type: "configure_settings" }), {
    message: "Settings updated",
  });
  assert.deepEqual(await chat.request({ type: "configure_scoped_models" }), {
    message: "Scoped models updated",
  });
  assert.deepEqual(await chat.request({ type: "share_session" }), {
    message: "Share URL: https://pi.dev/session/#fixture",
  });
  assert.deepEqual(await chat.request({ type: "get_changelog" }), {
    message: "Pi changelog",
  });
  assert.deepEqual(await chat.request({ type: "configure_project_trust" }), {
    message: "Trust decision saved",
  });
  assert.deepEqual(await chat.request({ type: "cycle_model", direction: "backward" }), {
    model: { provider: "fake", id: "model-b" },
    thinkingLevel: "high",
  });
  assert.deepEqual(await chat.request({ type: "cycle_thinking_level" }), {
    thinkingLevel: "xhigh",
  });
  assert.deepEqual(await chat.request({ type: "clear_queue" }), {
    steering: ["steer"],
    followUp: ["follow up"],
  });
  assert.deepEqual(await chat.request({ type: "set_thinking_visible", visible: false }), {
    visible: false,
  });
  await chat.request({ type: "abort_compaction" });
  await chat.request({ type: "abort" });

  assert.equal(adapter.launch.sessionId, "fixed-id");
  assert.deepEqual(adapter.session.calls, [
    ["setSessionName", "Renamed session"],
    ["reload"],
    ["prompt", "hello", "followUp"],
    ["setModel", "fake", "model-a"],
    ["configureModel", "fake", "model-a", "high"],
    ["getAuthProviders", "login"],
    ["loginProvider", "anthropic", "oauth"],
    ["logoutProvider", "anthropic"],
    ["abortAuthentication"],
    ["getTree"],
    ["navigateTree", "root", { summarize: true, customInstructions: "keep decisions" }],
    ["abortTreeNavigation"],
    ["setThinking", "high"],
    ["compact", "short"],
    ["newSession"],
    ["resumeSession", "/sessions/resume.jsonl"],
    ["forkSession", "message-1"],
    ["cloneSession"],
    ["importSession", "/imports/session.jsonl"],
    ["executeBash", "pwd", true],
    ["abortBash"],
    ["exportSession", undefined],
    ["copyLastAssistantMessage"],
    ["configureSettings"],
    ["configureScopedModels"],
    ["shareSession"],
    ["getChangelog"],
    ["configureProjectTrust"],
    ["cycleModel", "backward"],
    ["cycleThinkingLevel"],
    ["clearQueue"],
    ["setThinkingVisible", false],
    ["abortCompaction"],
    ["abort"],
  ]);
  assert.ok(records.some((record) => record.type === "agent_start"));

  await chat.close();
  await chat.close();
  assert.equal(adapter.session.shutdownCalls, 1);
  await assert.rejects(
    () => chat.request({ type: "get_state" }),
    /session is closed/,
  );
});

test("delivers startup UI responses before the SDK open barrier", async () => {
  const records = [];
  const adapter = {
    async open(_launch, bindings) {
      this.started = true;
      this.trusted = await bindings.uiContext.confirm(
        "Trust project folder?",
        "/work",
        { timeout: 1_000 },
      );
      this.session = new FakeSession(bindings);
      return this.session;
    },
  };
  const chat = createChatSession({
    launch: { cwd: "/work", extensions: [], noExtensions: true },
    adapter,
    onRecord: (record) => records.push(record),
  });

  // Ordinary work waits for open, while the UI response bypasses that queue.
  const state = chat.request({ type: "get_state" });
  await until(() => records.some((record) => record.type === "extension_ui_request"));
  const prompt = records.find((record) => record.type === "extension_ui_request");
  await assert.rejects(
    () => chat.request({
      type: "extension_ui_response",
      id: prompt.id,
      confirmed: "yes",
    }),
    /Invalid extension UI response/,
  );
  await assert.rejects(
    () => chat.request({
      type: "extension_ui_response",
      id: "unknown-interaction",
      confirmed: true,
    }),
    /Invalid extension UI response/,
  );
  await chat.request({
    type: "extension_ui_response",
    id: prompt.id,
    confirmed: true,
  });

  assert.equal(adapter.trusted, true);
  assert.equal((await state).sessionId, "in-process");
  await chat.close();
  assert.equal(adapter.session.shutdownCalls, 1);
});

test("close cancels pending permission UI and shuts down a late session exactly once", async () => {
  const records = [];
  const adapter = {
    async open(_launch, bindings) {
      this.approved = await bindings.uiContext.confirm(
        "Allow tool?",
        "dangerous input",
      );
      this.session = new FakeSession(bindings);
      return this.session;
    },
  };
  const chat = createChatSession({
    launch: { cwd: "/work", extensions: [], noExtensions: true },
    adapter,
    onRecord: (record) => records.push(record),
  });

  await until(() => records.some((record) => record.type === "extension_ui_request"));
  await chat.close();

  assert.equal(adapter.approved, false, "unanswered approval must fail closed");
  assert.equal(adapter.session.shutdownCalls, 1);
});

test("close waits for an adapter that is still opening and disposes its session", async () => {
  const gate = deferred();
  const adapter = {
    async open(_launch, bindings) {
      this.started = true;
      this.bindings = bindings;
      return gate.promise;
    },
  };
  const chat = createChatSession({
    launch: { cwd: "/work", extensions: [], noExtensions: true },
    adapter,
    onRecord: () => {},
  });
  await until(() => adapter.started === true);

  const closing = chat.close();
  const session = new FakeSession(adapter.bindings);
  gate.resolve(session);
  await closing;

  assert.equal(session.shutdownCalls, 1);
});

test("validates commands without poisoning later requests", async () => {
  const adapter = {
    async open(_launch, bindings) {
      return new FakeSession(bindings);
    },
  };
  const chat = createChatSession({
    launch: { cwd: "/work", extensions: [], noExtensions: true },
    adapter,
    onRecord: () => {},
  });

  await assert.rejects(
    () => chat.request({ type: "prompt", message: 42 }),
    /prompt.message must be a string/,
  );
  await assert.rejects(
    () => chat.request({ type: "unknown" }),
    /Unknown command: unknown/,
  );
  await assert.rejects(
    () => chat.request({ type: "set_session_name", name: 42 }),
    /set_session_name\.name must be a string/,
  );
  await assert.rejects(
    () => chat.request({ type: "set_session_name", name: "  " }),
    /Session name cannot be empty/,
  );
  await assert.rejects(
    () => chat.request({ type: "get_commands", extra: true }),
    /get_commands does not accept field: extra/,
  );
  await assert.rejects(
    () => chat.request({ type: "get_session_stats", id: 7 }),
    /get_session_stats\.id must be a string/,
  );
  await assert.rejects(
    () => chat.request({ type: "reload", force: true }),
    /reload does not accept field: force/,
  );
  await assert.rejects(
    () => chat.request({ type: "abort_compaction", reason: "test" }),
    /abort_compaction does not accept field: reason/,
  );
  assert.equal((await chat.request({ type: "get_state" })).sessionId, "in-process");
  await chat.close();
});

test("abort controls bypass a pending compact command", async () => {
  let rejectCompaction;
  const adapter = {
    async open(_launch, bindings) {
      const session = new FakeSession(bindings);
      session.compact = async () => {
        adapter.compactStarted = true;
        return await new Promise((_resolve, reject) => {
          rejectCompaction = reject;
        });
      };
      session.abortCompaction = () => {
        session.calls.push(["abortCompaction"]);
        rejectCompaction?.(new Error("Compaction cancelled"));
      };
      this.session = session;
      return session;
    },
  };
  const chat = createChatSession({
    launch: { cwd: "/work", extensions: [], noExtensions: true },
    adapter,
    onRecord: () => {},
  });

  const compact = chat.request({ type: "compact" });
  const compactRejected = assert.rejects(compact, /Compaction cancelled/);
  await until(() => adapter.compactStarted === true);
  assert.equal(await Promise.race([
    chat.request({ type: "abort" }).then(() => "aborted"),
    new Promise((resolve) => setTimeout(() => resolve("blocked"), 100)),
  ]), "aborted");
  assert.equal(await Promise.race([
    chat.request({ type: "abort_compaction" }).then(() => "cancelled"),
    new Promise((resolve) => setTimeout(() => resolve("blocked"), 100)),
  ]), "cancelled");
  await compactRejected;
  assert.deepEqual(adapter.session.calls, [
    ["abort"],
    ["abortCompaction"],
  ]);
  await chat.close();
});

test("immediate close shuts down without waiting for a long SDK command", async () => {
  const gate = deferred();
  const adapter = {
    async open(_launch, bindings) {
      const session = new FakeSession(bindings);
      session.compact = async () => {
        adapter.compactStarted = true;
        return gate.promise;
      };
      this.session = session;
      return session;
    },
  };
  const chat = createChatSession({
    launch: { cwd: "/work", extensions: [], noExtensions: true },
    adapter,
    onRecord: () => {},
  });

  const compact = chat.request({ type: "compact" });
  await until(() => adapter.compactStarted === true);
  await chat.close();
  assert.equal(adapter.session.shutdownCalls, 1);

  gate.resolve({ summary: "late" });
  await compact;
});

test("draining close preserves accepted command order before shutdown", async () => {
  const gate = deferred();
  const adapter = {
    async open(_launch, bindings) {
      const session = new FakeSession(bindings);
      session.compact = async () => gate.promise;
      this.session = session;
      return session;
    },
  };
  const chat = createChatSession({
    launch: { cwd: "/work", extensions: [], noExtensions: true },
    adapter,
    onRecord: () => {},
  });

  const compact = chat.request({ type: "compact" });
  const closing = chat.close({ drain: true });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(adapter.session.shutdownCalls, 0);
  gate.resolve({ summary: "done" });
  await compact;
  await closing;
  assert.equal(adapter.session.shutdownCalls, 1);
});

test("an immediate close upgrades an in-progress drain", async () => {
  const gate = deferred();
  const adapter = {
    async open(_launch, bindings) {
      const session = new FakeSession(bindings);
      session.compact = async () => {
        adapter.compactStarted = true;
        return gate.promise;
      };
      this.session = session;
      return session;
    },
  };
  const chat = createChatSession({
    launch: { cwd: "/work", extensions: [], noExtensions: true },
    adapter,
    onRecord: () => {},
  });

  const compact = chat.request({ type: "compact" });
  await until(() => adapter.compactStarted === true);
  const draining = chat.close({ drain: true });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(adapter.session.shutdownCalls, 0);

  assert.equal(await Promise.race([
    chat.close().then(() => "closed"),
    new Promise((resolve) => setTimeout(() => resolve("still-draining"), 100)),
  ]), "closed");
  await draining;
  assert.equal(adapter.session.shutdownCalls, 1);

  gate.resolve({ summary: "late" });
  await compact;
});

test("a throwing shutdown listener cannot prevent SDK cleanup", async () => {
  const diagnostics = [];
  const adapter = {
    async open(_launch, bindings) {
      this.session = new FakeSession(bindings);
      queueMicrotask(() => bindings.requestShutdown());
      return this.session;
    },
  };
  const chat = createChatSession({
    launch: { cwd: "/work", extensions: [], noExtensions: true },
    adapter,
    onRecord: () => {},
    onShutdownRequested: () => {
      throw new Error("listener boom");
    },
    diagnostic: (message) => diagnostics.push(message),
  });

  await assert.rejects(() => chat.request({ type: "get_state" }), /session is closed/);
  await chat.close();
  assert.equal(adapter.session.shutdownCalls, 1);
  assert.ok(diagnostics.some((message) => message.includes("listener boom")));
});

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
