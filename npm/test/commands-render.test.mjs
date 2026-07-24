import assert from "node:assert/strict";
import test from "node:test";

import { renderCommandResult } from "../lib/render/commands.js";

test("renders model profiles in Claude, Codex, Pi, then extension-agent order", () => {
  const output = renderCommandResult({ kind: "modelList", rustArgs: [] }, [
    { agent: "pi", name: "pi-default", model: "claude-sonnet-4-5" },
    { agent: "zeta", name: "zeta-default", model: "zeta-1" },
    { agent: "codex", name: "codex-default", model: "gpt-5" },
    { agent: "claude", name: "claude-default", model: "claude-opus-4-6" },
  ]);

  assert.ok(output.indexOf("Claude") < output.indexOf("Codex"));
  assert.ok(output.indexOf("Codex") < output.indexOf("Pi"));
  assert.ok(output.indexOf("Pi") < output.indexOf("Zeta"));
});

test("renders the Pi settings directory in config output", () => {
  const output = renderCommandResult({ kind: "configShow", rustArgs: [] }, {
    configPath: "/tmp/starling/config.json",
    effectiveHomePath: "/tmp/starling",
    homeSource: "default",
    storePath: "/tmp/starling/store.json",
    runsPath: "/tmp/starling/runs.json",
    settingsClaudePath: "/tmp/starling/settings/claude",
    settingsCodexPath: "/tmp/starling/settings/codex",
    settingsPiPath: "/tmp/starling/settings/pi",
  });

  assert.match(output, /Pi settings:\s+\/tmp\/starling\/settings\/pi/);
});
