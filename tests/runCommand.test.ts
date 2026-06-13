import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { syncClaudeProfileSettingsFromRunSettings } from "../src/commands/run.js";

let root = "";

describe("run command Claude settings sync", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "starling-run-"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  it("syncs Claude permission changes from temporary run settings", () => {
    const source = join(root, "mi.json");
    const runSettings = join(root, "run.settings.json");

    writeFileSync(
      source,
      JSON.stringify({
        env: { ANTHROPIC_MODEL: "mimo-v2.5-pro" },
        permissions: { allow: ["Bash:ls"], defaultMode: "plan" },
      })
    );
    writeFileSync(
      runSettings,
      JSON.stringify({
        env: { ANTHROPIC_MODEL: "mimo-v2.5-pro" },
        permissions: { allow: ["Bash:ls", "Bash:git status"], defaultMode: "acceptEdits" },
        hooks: {
          SessionStart: [
            {
              hooks: [{ type: "command", command: "starling temporary hook" }],
            },
          ],
        },
      })
    );

    expect(syncClaudeProfileSettingsFromRunSettings(source, runSettings)).toBe(true);

    const updated = JSON.parse(readFileSync(source, "utf-8")) as {
      env?: Record<string, unknown>;
      permissions?: { allow?: string[]; defaultMode?: string };
      hooks?: unknown;
    };
    expect(updated.env).toEqual({ ANTHROPIC_MODEL: "mimo-v2.5-pro" });
    expect(updated.permissions).toEqual({
      allow: ["Bash:ls", "Bash:git status"],
      defaultMode: "acceptEdits",
    });
    expect(updated.hooks).toBeUndefined();
  });

  it("syncs trust settings without copying temporary hooks", () => {
    const source = join(root, "mi.json");
    const runSettings = join(root, "run.settings.json");

    writeFileSync(source, JSON.stringify({ permissions: { allow: [] } }));
    writeFileSync(
      runSettings,
      JSON.stringify({
        permissions: { allow: [] },
        projects: {
          "/data20T/dev/Starling": {
            trust_level: "trusted",
          },
        },
        hooks: {
          SessionStart: [
            {
              hooks: [{ type: "command", command: "starling temporary hook" }],
            },
          ],
        },
      })
    );

    expect(syncClaudeProfileSettingsFromRunSettings(source, runSettings)).toBe(true);

    const updated = JSON.parse(readFileSync(source, "utf-8")) as {
      projects?: Record<string, unknown>;
      hooks?: unknown;
    };
    expect(updated.projects).toEqual({
      "/data20T/dev/Starling": {
        trust_level: "trusted",
      },
    });
    expect(updated.hooks).toBeUndefined();
  });
});
