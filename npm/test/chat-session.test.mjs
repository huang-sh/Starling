import assert from "node:assert/strict";
import test from "node:test";

import { createChatSession } from "../lib/chat/session.js";

class FakeSession {
  constructor(bindings) {
    this.bindings = bindings;
    this.calls = [];
    this.shutdownCalls = 0;
    this.messages = [{ role: "user", content: "history" }];
  }

  getState() {
    return { sessionId: "in-process", isStreaming: false };
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

  setThinkingLevel(level) {
    this.calls.push(["setThinking", level]);
  }

  async getAvailableModels() {
    return [{ provider: "fake", id: "model-a" }];
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
  assert.deepEqual(await chat.request({
    type: "set_model",
    provider: "fake",
    modelId: "model-a",
  }), { provider: "fake", id: "model-a" });
  await chat.request({ type: "set_thinking_level", level: "high" });
  assert.deepEqual(await chat.request({
    type: "compact",
    customInstructions: "short",
  }), { summary: "small" });
  await chat.request({ type: "abort_compaction" });
  await chat.request({ type: "abort" });

  assert.equal(adapter.launch.sessionId, "fixed-id");
  assert.deepEqual(adapter.session.calls, [
    ["setSessionName", "Renamed session"],
    ["reload"],
    ["prompt", "hello", "followUp"],
    ["setModel", "fake", "model-a"],
    ["setThinking", "high"],
    ["compact", "short"],
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
