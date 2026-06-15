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
    process.env.STARLING_CLI_CONFIG = join(root, "config.json");
  });

  afterEach(() => {
    delete process.env.STARLING_HOME;
    delete process.env.STARLING_CLI_CONFIG;
  });

  it("keeps the legacy store path when STARLING_HOME is not set", async () => {
    const module = await import("../src/constants.js");

    expect(module.DEFAULT_STARLING_HOME).toBe(join(homedir(), ".starling"));
    expect(module.DEFAULT_STORE_PATH).toBe(join(homedir(), ".config", "starling", "store.json"));
  });

  it("moves Starling store under STARLING_HOME when configured", async () => {
    process.env.STARLING_HOME = "/data/starling-home";
    const module = await import("../src/constants.js");

    expect(module.DEFAULT_STARLING_HOME).toBe("/data/starling-home");
    expect(module.DEFAULT_STORE_PATH).toBe("/data/starling-home/store.json");
  });

  it("uses the persisted CLI home setting when STARLING_HOME is not set", async () => {
    writeFileSync(process.env.STARLING_CLI_CONFIG!, JSON.stringify({ homePath: "/data/starling-config-home" }), "utf-8");
    const module = await import("../src/constants.js");

    expect(module.STARLING_HOME_SOURCE).toBe("config");
    expect(module.DEFAULT_STARLING_HOME).toBe("/data/starling-config-home");
    expect(module.DEFAULT_STORE_PATH).toBe("/data/starling-config-home/store.json");
  });

  it("expands tilde in STARLING_HOME", async () => {
    process.env.STARLING_HOME = "~/starling-alt";
    const module = await import("../src/constants.js");

    expect(module.DEFAULT_STARLING_HOME).toBe(join(homedir(), "starling-alt"));
    expect(module.DEFAULT_STORE_PATH).toBe(join(homedir(), "starling-alt", "store.json"));
  });
});
