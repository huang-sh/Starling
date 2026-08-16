import assert from "node:assert/strict";
import test from "node:test";

import {
  completeSlashCommand,
  filterSlashCommands,
  formatSessionStats,
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

  assert.deepEqual(commands.slice(0, 8).map(({ name, source }) => ({ name, source })), [
    { name: "help", source: "starling" },
    { name: "model", source: "starling" },
    { name: "thinking", source: "starling" },
    { name: "compact", source: "starling" },
    { name: "name", source: "starling" },
    { name: "session", source: "starling" },
    { name: "reload", source: "starling" },
    { name: "quit", source: "starling" },
  ]);
  assert.deepEqual(commands.slice(8).map(({ name, source }) => ({ name, source })), [
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
  assert.deepEqual(filtered.slice(0, 2), ["inspect", "thinking"]);
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
  assert.match(planSlashCommand("/missing", commands, false).message, /Unknown command/);
  assert.match(planSlashCommand("/model invalid", commands, false).message, /Usage/);
  assert.match(planSlashCommand("/reload", commands, true).message, /while Pi is working/);
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
