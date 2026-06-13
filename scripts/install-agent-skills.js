#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(packageRoot, "skills", "starling", "SKILL.md");
const targets = [
  join(homedir(), ".codex", "skills", "starling", "SKILL.md"),
  join(homedir(), ".claude", "skills", "starling", "SKILL.md"),
];

try {
  if (!existsSync(source)) {
    console.warn(`[starling] Codex skill not found in package: ${source}`);
    process.exit(0);
  }

  for (const target of targets) {
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
    console.log(`[starling] Installed skill: ${target}`);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[starling] Could not install skills: ${message}`);
}
