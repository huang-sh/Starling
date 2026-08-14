import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runStarlingTui } from "../../lib/tui/index.js";

const cwd = mkdtempSync(join(tmpdir(), "starling-pi-extension-"));
const agentDir = join(cwd, "agent");
const extensionDir = join(cwd, ".pi", "extensions");
mkdirSync(extensionDir, { recursive: true });
writeFileSync(join(extensionDir, "fixture.ts"), `
export default function (pi) {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.onTerminalInput((data) => {
      if (data !== "#") return undefined;
      ctx.ui.notify("Fixture consumed raw terminal input", "info");
      return { consume: true };
    });
  });
  pi.registerCommand("fixture-new", {
    description: "Replace the session from a real Pi extension",
    handler: async (_args, ctx) => {
      const previous = ctx.sessionManager.getSessionId();
      await ctx.newSession({
        withSession: async (next) => {
          next.ui.notify(
            \`Fixture replaced \${previous} -> \${next.sessionManager.getSessionId()}\`,
            "info",
          );
          setTimeout(() => next.shutdown(), 100);
        },
      });
    },
  });
}
`);

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
const writes = [];
const originalWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...args) => {
  writes.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
  return originalWrite(chunk, ...args);
};

const updates = [];
try {
  const running = runStarlingTui({
    cwd,
    env: {
      ...process.env,
      STARLING_PROJECT_TRUST: "always",
      STARLING_TUI_SYNC_OUTPUT: "0",
    },
    async createRun() {
      return {
        runId: "pi-extension-run",
        async updateSession(patch) {
          updates.push(patch);
        },
        async finish() {},
      };
    },
  });

  await until(() => updates.length > 0, 15_000);
  process.stdin.emit("data", "#");
  await until(() => output().includes("Fixture consumed raw terminal input"), 20_000);
  process.stdin.emit("data", "/fixture-new\r");
  await until(() => output().includes("Fixture replaced"), 20_000);

  assert.equal(await running, 0);
  assert.match(plainOutput(), /Fixture replaced [\w-]+ -> [\w-]+/);
  assert.match(plainOutput(), /Fixture consumed raw terminal input/);
  assert.ok(updates.length >= 2, "extension-driven replacement must update Starling session state");
  assert.notEqual(updates[0].sessionId, updates.at(-1).sessionId);
  originalWrite("STARLING_PI_EXTENSION_TUI_OK\n");
} finally {
  process.stdout.write = originalWrite;
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  rmSync(cwd, { recursive: true, force: true });
}
process.exit(0);

function output() {
  return writes.join("");
}

function plainOutput() {
  return output().replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\s+/g, " ");
}

async function until(predicate, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for real Pi extension TUI output");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
