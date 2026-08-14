import assert from "node:assert/strict";
import test from "node:test";

import {
  completeSlashCommand,
  filterSlashCommands,
  formatSessionStats,
  isSlashInvocation,
  mergeSlashCommands,
  planSlashCommand,
  slashCommandsFromResponse,
} from "../lib/tui/commands.js";

test("merges Starling builtins with Pi commands in dispatch order", () => {
  const commands = mergeSlashCommands([
    { name: "help", description: "shadowed", source: "extension" },
    { name: "deploy:1", description: "Deploy", source: "extension" },
    { name: "review", description: "Review changes", source: "prompt" },
    { name: "skill:check", description: "Check project", source: "skill" },
    { name: "review", description: "duplicate", source: "skill" },
    { name: "bad/name", source: "extension" },
    { name: "unknown", source: "other" },
  ]);

  assert.deepEqual(commands.slice(0, 24).map(({ name, source }) => ({ name, source })), [
    { name: "help", source: "starling" },
    { name: "settings", source: "starling" },
    { name: "new", source: "starling" },
    { name: "resume", source: "starling" },
    { name: "fork", source: "starling" },
    { name: "clone", source: "starling" },
    { name: "import", source: "starling" },
    { name: "export", source: "starling" },
    { name: "copy", source: "starling" },
    { name: "scoped-models", source: "starling" },
    { name: "model", source: "starling" },
    { name: "tree", source: "starling" },
    { name: "login", source: "starling" },
    { name: "logout", source: "starling" },
    { name: "thinking", source: "starling" },
    { name: "compact", source: "starling" },
    { name: "name", source: "starling" },
    { name: "session", source: "starling" },
    { name: "share", source: "starling" },
    { name: "changelog", source: "starling" },
    { name: "hotkeys", source: "starling" },
    { name: "trust", source: "starling" },
    { name: "reload", source: "starling" },
    { name: "quit", source: "starling" },
  ]);
  assert.deepEqual(commands.slice(24).map(({ name, source }) => ({ name, source })), [
    { name: "deploy:1", source: "extension" },
    { name: "review", source: "prompt" },
    { name: "skill:check", source: "skill" },
  ]);
});

test("filters only the slash-name token and prioritizes name prefixes", () => {
  const commands = mergeSlashCommands([
    { name: "inspect", description: "Review a file", source: "extension" },
    { name: "review", description: "Inspect a change", source: "prompt" },
  ]);

  const filtered = filterSlashCommands("/IN", commands).map(({ name }) => name);
  assert.equal(filtered[0], "inspect");
  assert.ok(filtered.includes("login"));
  assert.ok(filtered.includes("review"), "description matches remain available after name matches");
  assert.deepEqual(
    filterSlashCommands("/review ", commands),
    [],
    "argument entry must close the command-name menu",
  );
  assert.deepEqual(filterSlashCommands("plain text", commands), []);
  assert.equal(completeSlashCommand(commands.find(({ name }) => name === "help")), "/help");
  assert.equal(completeSlashCommand(commands.find(({ name }) => name === "model")), "/model ");
});

test("plans builtins and dynamic Pi commands without treating slash typos as prompts", () => {
  const commands = slashCommandsFromResponse({
    commands: [{ name: "skill:check", description: "Check", source: "skill" }],
  });

  assert.deepEqual(planSlashCommand("/model openrouter/anthropic/claude", commands, false), {
    kind: "request",
    command: commands.find(({ name }) => name === "model"),
    request: {
      type: "set_model",
      provider: "openrouter",
      modelId: "anthropic/claude",
    },
    successMessage: "Model changed to openrouter/anthropic/claude",
    refreshMetadata: true,
  });
  assert.deepEqual(planSlashCommand("/skill:check focus", commands, true), {
    kind: "dynamic",
    command: commands.find(({ name }) => name === "skill:check"),
    request: {
      type: "prompt",
      message: "/skill:check focus",
      streamingBehavior: "followUp",
    },
  });
  assert.deepEqual(planSlashCommand("/login anthropic", commands, false), {
    kind: "local",
    command: commands.find(({ name }) => name === "login"),
    action: "login",
    argument: "anthropic",
  });
  assert.deepEqual(planSlashCommand("/logout", commands, false), {
    kind: "local",
    command: commands.find(({ name }) => name === "logout"),
    action: "logout",
  });
  assert.deepEqual(planSlashCommand("/tree", commands, false), {
    kind: "local",
    command: commands.find(({ name }) => name === "tree"),
    action: "tree",
  });
  assert.deepEqual(planSlashCommand("/new", commands, false), {
    kind: "request",
    command: commands.find(({ name }) => name === "new"),
    request: { type: "new_session" },
    successMessage: "New session started",
    refreshTranscript: true,
    refreshCommands: true,
  });
  assert.deepEqual(planSlashCommand("/resume /sessions/old.jsonl", commands, false), {
    kind: "request",
    command: commands.find(({ name }) => name === "resume"),
    request: { type: "resume_session", sessionPath: "/sessions/old.jsonl" },
    successMessage: "Session resumed",
    refreshTranscript: true,
    refreshCommands: true,
  });
  assert.deepEqual(planSlashCommand("/fork", commands, false), {
    kind: "request",
    command: commands.find(({ name }) => name === "fork"),
    request: { type: "fork_session" },
    successMessage: "Forked to new session",
    refreshTranscript: true,
    refreshCommands: true,
  });
  assert.deepEqual(planSlashCommand("/clone", commands, false), {
    kind: "request",
    command: commands.find(({ name }) => name === "clone"),
    request: { type: "clone_session" },
    successMessage: "Cloned to new session",
    refreshTranscript: true,
    refreshCommands: true,
  });
  assert.deepEqual(planSlashCommand("/import /tmp/session.jsonl", commands, false), {
    kind: "request",
    command: commands.find(({ name }) => name === "import"),
    request: { type: "import_session", inputPath: "/tmp/session.jsonl" },
    successMessage: "Session imported",
    refreshTranscript: true,
    refreshCommands: true,
  });
  assert.deepEqual(planSlashCommand("/export '/tmp/session review.html'", commands, false), {
    kind: "request",
    command: commands.find(({ name }) => name === "export"),
    request: { type: "export_session", outputPath: "/tmp/session review.html" },
    successMessage: "Session exported",
  });
  assert.deepEqual(planSlashCommand("/copy", commands, false), {
    kind: "request",
    command: commands.find(({ name }) => name === "copy"),
    request: { type: "copy_last_message" },
    successMessage: "Copied last agent message to clipboard",
  });
  assert.deepEqual(planSlashCommand("/settings", commands, false), {
    kind: "request",
    command: commands.find(({ name }) => name === "settings"),
    request: { type: "configure_settings" },
  });
  assert.deepEqual(planSlashCommand("/scoped-models", commands, false), {
    kind: "request",
    command: commands.find(({ name }) => name === "scoped-models"),
    request: { type: "configure_scoped_models" },
  });
  assert.deepEqual(planSlashCommand("/share", commands, false), {
    kind: "request",
    command: commands.find(({ name }) => name === "share"),
    request: { type: "share_session" },
  });
  assert.deepEqual(planSlashCommand("/changelog", commands, false), {
    kind: "request",
    command: commands.find(({ name }) => name === "changelog"),
    request: { type: "get_changelog" },
  });
  assert.deepEqual(planSlashCommand("/hotkeys", commands, false), {
    kind: "local",
    command: commands.find(({ name }) => name === "hotkeys"),
    action: "hotkeys",
  });
  assert.deepEqual(planSlashCommand("/trust", commands, false), {
    kind: "request",
    command: commands.find(({ name }) => name === "trust"),
    request: { type: "configure_project_trust" },
  });
  assert.match(planSlashCommand("/missing", commands, false).message, /Unknown command/);
  assert.match(planSlashCommand("/model invalid", commands, false).message, /Usage/);
  assert.match(planSlashCommand("/reload", commands, true).message, /while Pi is working/);
  assert.match(planSlashCommand("/tree", commands, true).message, /while Pi is working/);
});

test("session stats preserve unknown context usage", () => {
  const output = formatSessionStats({
    sessionId: "session-1",
    totalMessages: 0,
    tokens: { total: 0 },
    contextUsage: { tokens: null, contextWindow: 200_000, percent: null },
  });
  assert.match(output, /Context: unknown \/ 200,000 tokens/);
  assert.doesNotMatch(output, /Context: 0 \/ 200,000/);
});

test("isSlashInvocation tells file paths apart from slash commands", () => {
  // Real command invocations.
  assert.equal(isSlashInvocation("/login"), true);
  assert.equal(isSlashInvocation("/login anthropic"), true);
  assert.equal(isSlashInvocation("/model openai/gpt-5"), true);
  assert.equal(isSlashInvocation("/skill:check focus"), true);
  // Absolute file paths must NOT be treated as commands — they go to the model.
  assert.equal(isSlashInvocation("/data20T/dev/foo.txt"), false);
  assert.equal(isSlashInvocation("/data20T/dev/some file.txt"), false);
  assert.equal(isSlashInvocation("/"), false);
  // Plain messages are not commands.
  assert.equal(isSlashInvocation("explain this path: /etc/hosts"), false);
});
