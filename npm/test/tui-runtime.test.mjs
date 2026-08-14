import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("direct SDK TUI stays on the main screen and restores terminal modes on exit", (context) => {
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
    timeout: 30_000,
  });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.doesNotMatch(result.stdout, /\u001b\[\?1049[hl]/);
  assert.match(result.stdout, /\u001b\[\d+A/);
  assert.doesNotMatch(result.stdout, /\u001b\[H|\u001b\[\d+;\d+H/);
  assert.match(result.stdout, /\u001b\[\?2004h/);
  assert.match(result.stdout, /\u001b\[\?2004l/);
  assert.match(result.stdout, /STARLING_TUI_PTY_OK/);
});

test("a real Pi fixture extension replaces sessions through the Starling UI", (context) => {
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

  const fixture = fileURLToPath(new URL("./fixtures/tui-pi-extension.mjs", import.meta.url));
  const command = `${shellQuote(process.execPath)} ${shellQuote(fixture)}`;
  const result = spawnSync("script", ["-qefc", command, "/dev/null"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, TERM: "xterm-256color" },
    timeout: 60_000,
  });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Fixture consumed raw terminal input/);
  assert.match(result.stdout, /Fixture replaced/);
  assert.match(result.stdout, /STARLING_PI_EXTENSION_TUI_OK/);
});

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
