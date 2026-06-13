import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { mkdtempSync } from "fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let root = "";

describe("codex default config guard", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "starling-codex-guard-"));
    mkdirSync(join(root, ".codex"), { recursive: true });
    vi.resetModules();
    vi.doMock("../src/constants.js", () => ({
      DEFAULT_CODEX_HOME: join(root, ".codex"),
    }));
  });

  afterEach(() => {
    vi.doUnmock("../src/constants.js");
    rmSync(root, { recursive: true, force: true });
  });

  it("restores config.toml and auth.json after a run mutates them", async () => {
    const configPath = join(root, ".codex", "config.toml");
    const authPath = join(root, ".codex", "auth.json");
    writeFileSync(configPath, "[projects.\"/work\"]\ntrust_level = \"trusted\"\n", "utf-8");
    writeFileSync(authPath, "{\"auth_mode\":\"chatgpt\"}\n", "utf-8");
    const { snapshotCodexDefaultConfig, restoreCodexDefaultConfig } = await import("../src/lib/codexDefaultGuard.js");

    const snapshot = snapshotCodexDefaultConfig();
    writeFileSync(configPath, "model_provider = \"custom\"\n", "utf-8");
    writeFileSync(authPath, "{\"OPENAI_API_KEY\":\"sk-test\"}\n", "utf-8");

    restoreCodexDefaultConfig(snapshot);

    expect(readFileSync(configPath, "utf-8")).toBe("[projects.\"/work\"]\ntrust_level = \"trusted\"\n");
    expect(readFileSync(authPath, "utf-8")).toBe("{\"auth_mode\":\"chatgpt\"}\n");
  });

  it("removes files that did not exist before the guarded run", async () => {
    const configPath = join(root, ".codex", "config.toml");
    const authPath = join(root, ".codex", "auth.json");
    const { snapshotCodexDefaultConfig, restoreCodexDefaultConfig } = await import("../src/lib/codexDefaultGuard.js");

    const snapshot = snapshotCodexDefaultConfig();
    writeFileSync(configPath, "model = \"deepseek\"\n", "utf-8");
    writeFileSync(authPath, "{\"OPENAI_API_KEY\":\"sk-test\"}\n", "utf-8");

    restoreCodexDefaultConfig(snapshot);

    expect(existsSync(configPath)).toBe(false);
    expect(existsSync(authPath)).toBe(false);
  });
});
