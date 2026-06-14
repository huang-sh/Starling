import { mkdtempSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let root = "";

vi.mock("../src/constants.js", () => ({
  DEFAULT_STARLING_HOME: join(root, ".starling"),
  DEFAULT_STARLING_SETTINGS_DIR: join(root, ".starling", "settings"),
  DEFAULT_CODEX_SETTINGS_DIR: join(root, ".starling", "settings", "codex"),
  DEFAULT_CODEX_HOME: join(root, ".codex"),
}));

describe("codex provider profiles", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "starling-codex-provider-"));
    vi.resetModules();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("creates a TOML profile and activates config plus auth", async () => {
    const {
      saveCodexProviderProfile,
      getCodexProviderProfile,
      useCodexProvider,
      getCurrentCodexProvider,
    } = await import("../src/lib/codexProvider.js");

    const saved = saveCodexProviderProfile("deepseek", {
      apiKey: "sk-test-key",
      model: "deepseek-v4-pro",
      baseUrl: "https://api.deepseek.com/v1",
      wireApi: "responses",
    });

    expect(saved.name).toBe("deepseek");
    expect(saved.filePath.endsWith("deepseek.toml")).toBe(true);
    expect(readFileSync(join(root, ".starling", "settings", "codex", "deepseek.toml"), "utf-8")).toContain("experimental_bearer_token");
    expect(getCodexProviderProfile("deepseek")?.hasAuth).toBe(true);
    expect(getCodexProviderProfile("deepseek")?.hasConfig).toBe(true);

    const activated = useCodexProvider("deepseek");

    expect(activated.wroteAuth).toBe(true);
    expect(activated.wroteConfig).toBe(true);
    expect(getCurrentCodexProvider()).toBe("deepseek");
    expect(readFileSync(join(root, ".codex", "auth.json"), "utf-8")).toContain("sk-test-key");
    expect(readFileSync(join(root, ".codex", "config.toml"), "utf-8")).toContain("deepseek-v4-pro");
    expect(readFileSync(join(root, ".codex", "config.toml"), "utf-8")).toContain("https://api.deepseek.com/v1");
  });

  it("updates an existing TOML profile without dropping unrelated config fields", async () => {
    const { saveCodexProviderProfile, readCodexProviderProfileFile } = await import("../src/lib/codexProvider.js");

    saveCodexProviderProfile("demo", {
      apiKey: "sk-first",
      model: "gpt-5.2",
      baseUrl: "https://api.example.com/v1",
      config: {
        disable_response_storage: true,
        model_reasoning_effort: "high",
      },
    });
    saveCodexProviderProfile("demo", {
      model: "gpt-5.3",
    });

    const profile = readCodexProviderProfileFile("demo");

    expect(profile.auth?.OPENAI_API_KEY).toBe("sk-first");
    expect(profile.config?.model).toBe("gpt-5.3");
    expect(profile.config?.disable_response_storage).toBe(true);
    expect(profile.config?.model_reasoning_effort).toBe("high");
  });

});
