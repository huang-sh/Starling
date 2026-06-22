#!/usr/bin/env node
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const installHome = process.env.STARLING_INSTALL_HOME || homedir();
const source = join(packageRoot, "skills", "starling", "SKILL.md");
const targets = [
  join(installHome, ".codex", "skills", "starling", "SKILL.md"),
  join(installHome, ".claude", "skills", "starling", "SKILL.md"),
];
const claudeSettingsPath = join(installHome, ".claude", "settings.json");
const defaultHookFile = join(installHome, ".starling", "run-hooks", "default-claude.jsonl");
const starlingBin = findStarlingBin();
const managedHookMarker = "default-claude.jsonl";
const claudeHookEvents = [
  "UserPromptSubmit",
  "SessionStart",
  "PreToolUse",
  "PermissionRequest",
  "Notification",
  "Stop",
  "StopFailure",
  "SessionEnd",
];

try {
  if (!existsSync(source)) {
    console.warn(`[starling] Codex skill not found in package: ${source}`);
  } else {
    for (const target of targets) {
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(source, target);
      console.log(`[starling] Installed skill: ${target}`);
    }
  }

  if (process.env.STARLING_INSTALL_CLAUDE_HOOK !== "0") {
    installClaudeDefaultHooks();
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[starling] Could not finish postinstall setup: ${message}`);
}

function installClaudeDefaultHooks() {
  if (!existsSync(starlingBin)) {
    console.warn(`[starling] Could not install Claude status hooks: starling wrapper not found`);
    return;
  }
  mkdirSync(dirname(claudeSettingsPath), { recursive: true });
  mkdirSync(dirname(defaultHookFile), { recursive: true });

  const settings = readJsonObject(claudeSettingsPath);
  if (!isObject(settings.hooks)) {
    settings.hooks = {};
  }

  for (const event of claudeHookEvents) {
    const existing = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
    const retained = existing.filter((entry) => !isManagedStarlingHook(entry));
    retained.push(claudeHookEntry(event));
    settings.hooks[event] = retained;
  }

  writeFileSync(claudeSettingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  console.log(`[starling] Installed Claude status hooks: ${claudeSettingsPath}`);
}

function readJsonObject(path) {
  if (!existsSync(path)) {
    return {};
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return isObject(parsed) ? parsed : {};
  } catch (error) {
    const backup = `${path}.starling-bak-${Date.now()}`;
    copyFileSync(path, backup);
    console.warn(`[starling] Backed up invalid Claude settings to ${backup}`);
    return {};
  }
}

function claudeHookEntry(event) {
  return {
    hooks: [
      {
        type: "command",
        command: [
          shellQuote(process.execPath),
          shellQuote(starlingBin),
          "top",
          "hook",
          "--provider",
          "claude",
          "--event",
          shellQuote(event),
          "--hook-file",
          shellQuote(defaultHookFile),
        ].join(" "),
        timeout: 5,
      },
    ],
  };
}

function isManagedStarlingHook(entry) {
  if (!isObject(entry) || !Array.isArray(entry.hooks)) {
    return false;
  }
  return entry.hooks.some((hook) => {
    const command = isObject(hook) && typeof hook.command === "string" ? hook.command : "";
    return command.includes("top hook")
      && command.includes("--provider")
      && command.includes("claude")
      && command.includes(managedHookMarker);
  });
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function shellQuote(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(text)) {
    return text;
  }
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function findStarlingBin() {
  const candidates = [
    join(packageRoot, "bin", "starling.js"),
    join(packageRoot, "npm", "bin", "starling.js"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) || candidates[0];
}
