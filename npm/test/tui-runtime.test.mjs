import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("direct SDK TUI preserves the normal screen in a real pseudo-terminal", (context) => {
  if (process.platform !== "linux") {
    context.skip("util-linux script smoke test is Linux-specific");
    return;
  }
  const probe = spawnSync("script", ["--version"], { encoding: "utf8" });
  if (probe.error?.code === "ENOENT") {
    context.skip("util-linux script is unavailable");
    return;
  }
  assert.equal(probe.status, 0, probe.stderr);

  const fixture = fileURLToPath(new URL("./fixtures/tui-sdk-smoke.mjs", import.meta.url));
  const command = `${shellQuote(process.execPath)} ${shellQuote(fixture)}`;
  const result = spawnSync("script", ["-qefc", command, "/dev/null"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, TERM: "xterm-256color" },
    timeout: 10_000,
  });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.doesNotMatch(result.stdout, /\u001b\[\?1049[hl]/);
  assert.doesNotMatch(result.stdout, /\u001b\[2J|\u001b\[H|\u001b\[\d+;\d+H/);
  assert.match(result.stdout, /\u001b\[\?2004h/);
  assert.match(result.stdout, /\u001b\[\?2004l/);
  assert.match(result.stdout, /STARLING_TUI_PTY_OK/);
});

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
