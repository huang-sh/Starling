import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "path";
import { homedir, tmpdir } from "os";
import { mkdtempSync, writeFileSync } from "fs";

describe("constants", () => {
  let root = "";

  beforeEach(() => {
    vi.resetModules();
    root = mkdtempSync(join(tmpdir(), "starling-constants-"));
    delete process.env.STARLING_HOME;
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CODEX_HOME;
    process.env.STARLING_CLI_CONFIG = join(root, "config.json");
  });

  afterEach(() => {
    delete process.env.STARLING_HOME;
    delete process.env.STARLING_CLI_CONFIG;
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CODEX_HOME;
  });

  it("keeps the legacy store path when STARLING_HOME is not set", async () => {
    const module = await import("../src/constants.js");

    expect(module.DEFAULT_STARLING_HOME).toBe(join(homedir(), ".starling"));
    expect(module.DEFAULT_STORE_PATH).toBe(join(homedir(), ".config", "starling", "store.json"));
    expect(module.DEFAULT_RUNS_PATH).toBe(join(homedir(), ".config", "starling", "runs.json"));
  });

  it("moves Starling store under STARLING_HOME when configured", async () => {
    process.env.STARLING_HOME = "/data/starling-home";
    const module = await import("../src/constants.js");

    expect(module.DEFAULT_STARLING_HOME).toBe("/data/starling-home");
    expect(module.DEFAULT_STORE_PATH).toBe(join("/data/starling-home", "store.json"));
    expect(module.DEFAULT_RUNS_PATH).toBe(join("/data/starling-home", "runs.json"));
  });

  it("uses the persisted CLI home setting when STARLING_HOME is not set", async () => {
    writeFileSync(process.env.STARLING_CLI_CONFIG!, JSON.stringify({ homePath: "/data/starling-config-home" }), "utf-8");
    const module = await import("../src/constants.js");

    expect(module.STARLING_HOME_SOURCE).toBe("config");
    expect(module.DEFAULT_STARLING_HOME).toBe("/data/starling-config-home");
    expect(module.DEFAULT_STORE_PATH).toBe(join("/data/starling-config-home", "store.json"));
    expect(module.DEFAULT_RUNS_PATH).toBe(join("/data/starling-config-home", "runs.json"));
  });

  it("expands tilde in STARLING_HOME", async () => {
    process.env.STARLING_HOME = "~/starling-alt";
    const module = await import("../src/constants.js");

    expect(module.DEFAULT_STARLING_HOME).toBe(join(homedir(), "starling-alt"));
    expect(module.DEFAULT_STORE_PATH).toBe(join(homedir(), "starling-alt", "store.json"));
    expect(module.DEFAULT_RUNS_PATH).toBe(join(homedir(), "starling-alt", "runs.json"));
  });

  it("defaults session roots to ~/.claude/projects and ~/.codex/sessions", async () => {
    const module = await import("../src/constants.js");
    expect(module.CLAUDE_SESSIONS_DIR).toBe(join(homedir(), ".claude", "projects"));
    expect(module.CODEX_SESSIONS_DIR).toBe(join(homedir(), ".codex", "sessions"));
    expect(module.claudeSessionRoots()).toEqual([join(homedir(), ".claude", "projects")]);
    expect(module.codexSessionRoots()).toEqual([
      join(homedir(), ".codex", "sessions"),
      join(homedir(), ".codex", "archived_sessions"),
    ]);
  });

  it("honors CLAUDE_CONFIG_DIR and CODEX_HOME for session roots", async () => {
    process.env.CLAUDE_CONFIG_DIR = "/tmp/iso-claude";
    process.env.CODEX_HOME = "/tmp/iso-codex";
    const module = await import("../src/constants.js");
    expect(module.CLAUDE_SESSIONS_DIR).toBe(join("/tmp/iso-claude", "projects"));
    expect(module.CODEX_SESSIONS_DIR).toBe(join("/tmp/iso-codex", "sessions"));
    expect(module.claudeSessionRoots()).toEqual([join("/tmp/iso-claude", "projects")]);
    expect(module.codexSessionRoots()).toEqual([
      join("/tmp/iso-codex", "sessions"),
      join("/tmp/iso-codex", "archived_sessions"),
    ]);
  });

  it("expands tilde in CLAUDE_CONFIG_DIR / CODEX_HOME", async () => {
    process.env.CLAUDE_CONFIG_DIR = "~/iso-claude";
    const module = await import("../src/constants.js");
    expect(module.CLAUDE_SESSIONS_DIR).toBe(join(homedir(), "iso-claude", "projects"));
  });
});
