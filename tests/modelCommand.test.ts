import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let root = "";

vi.mock("../src/constants.js", () => ({
  DEFAULT_STARLING_HOME: join(root, ".starling"),
  DEFAULT_STARLING_SETTINGS_DIR: join(root, ".starling", "settings"),
  DEFAULT_CLAUDE_SETTINGS_DIR: join(root, ".starling", "settings", "claude"),
  DEFAULT_CODEX_SETTINGS_DIR: join(root, ".starling", "settings", "codex"),
  DEFAULT_CODEX_HOME: join(root, ".codex"),
}));

describe("model command helpers", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "starling-model-"));
    vi.resetModules();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("deletes a Claude model profile without touching default settings", async () => {
    const constants = await import("../src/constants.js");
    const settingsDir = constants.DEFAULT_CLAUDE_SETTINGS_DIR;
    mkdirSync(settingsDir, { recursive: true });
    const profilePath = join(settingsDir, "mi.json");
    const defaultPath = join(root, ".claude", "settings.json");
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(profilePath, JSON.stringify({ env: { ANTHROPIC_MODEL: "mi" } }));
    writeFileSync(defaultPath, JSON.stringify({ env: { ANTHROPIC_MODEL: "default" } }));

    const { deleteModelProfile } = await import("../src/commands/model.js");
    const result = deleteModelProfile("mi", "claude");

    expect(result.sources).toEqual([profilePath]);
    expect(existsSync(profilePath)).toBe(false);
    expect(existsSync(defaultPath)).toBe(true);
  });

  it("deletes a Codex TOML model profile", async () => {
    const constants = await import("../src/constants.js");
    const settingsDir = constants.DEFAULT_CODEX_SETTINGS_DIR;
    mkdirSync(settingsDir, { recursive: true });
    const profilePath = join(settingsDir, "ds2.toml");
    writeFileSync(
      profilePath,
      [
        'model_provider = "custom"',
        'model = "deepseek-v4-pro"',
        "",
        "[model_providers.custom]",
        'base_url = "https://api.deepseek.com"',
        'experimental_bearer_token = "sk-test"',
        "",
      ].join("\n")
    );

    expect(existsSync(profilePath)).toBe(true);

    const { deleteModelProfile } = await import("../src/commands/model.js");
    const result = deleteModelProfile("ds2", "codex");

    expect(result.sources).toEqual([profilePath]);
    expect(existsSync(profilePath)).toBe(false);
  });
});
