import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testDir, "..", "..");

const hookEvents = [
  "UserPromptSubmit",
  "SessionStart",
  "PreToolUse",
  "PermissionRequest",
  "Notification",
  "Stop",
  "StopFailure",
  "SessionEnd",
];

test("postinstall adds idempotent Claude status hooks without removing user hooks", () => {
  const home = join(tmpdir(), `starling-postinstall-${process.pid}-${Date.now()}`);
  const claudeDir = join(home, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  const settingsPath = join(claudeDir, "settings.json");
  writeFileSync(settingsPath, JSON.stringify({
    hooks: {
      PreToolUse: [
        {
          hooks: [
            {
              type: "command",
              command: "echo user-hook",
            },
          ],
        },
      ],
    },
  }, null, 2));

  for (let i = 0; i < 2; i += 1) {
    const result = spawnSync(process.execPath, ["scripts/install-agent-skills.js"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        STARLING_INSTALL_HOME: home,
      },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
  }

  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  for (const event of hookEvents) {
    assert.ok(Array.isArray(settings.hooks[event]), `${event} hook array`);
    const starlingHooks = settings.hooks[event].filter((entry) =>
      JSON.stringify(entry).includes("default-claude.jsonl"),
    );
    assert.equal(starlingHooks.length, 1, `${event} has one managed Starling hook`);
    const command = starlingHooks[0].hooks[0].command;
    assert.match(command, /top hook --provider claude/);
    assert.match(command, new RegExp(`--event ${event}`));
    assert.match(command, /npm\/bin\/starling\.js|bin\/starling\.js/);
  }

  assert.ok(
    settings.hooks.PreToolUse.some((entry) => JSON.stringify(entry).includes("echo user-hook")),
    "user hook is retained",
  );
});
