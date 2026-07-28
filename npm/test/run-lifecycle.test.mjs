import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createManagedRun,
  resolveRunsPath,
} from "../lib/run-lifecycle.js";

test("managed SDK run uses the Rust run schema and finalizes once", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "starling-run-lifecycle-"));
  const runsPath = path.join(directory, "runs.json");
  const dates = [
    new Date("2026-07-28T10:00:00.000Z"),
    new Date("2026-07-28T10:01:00.000Z"),
    new Date("2026-07-28T10:02:00.000Z"),
  ];
  let dateIndex = 0;

  const run = await createManagedRun({
    runId: "run-direct-sdk",
    cwd: directory,
    pid: 4242,
    environment: { STARLING_RUNS: runsPath },
    now: () => dates[dateIndex++] ?? dates.at(-1),
  });
  await run.updateSession({
    sessionId: "pi-session",
    sessionFile: "/sessions/pi-session.jsonl",
    model: "anthropic/claude-sonnet",
    title: "Direct SDK session",
  });
  await run.finish({ exitCode: 0 });
  await run.finish({ exitCode: 9 });

  const data = JSON.parse(await readFile(runsPath, "utf8"));
  assert.equal(data.version, 1);
  assert.deepEqual(data.runs, [{
    run_id: "run-direct-sdk",
    provider: "pi",
    project_path: directory,
    pid: 4242,
    status: "completed",
    started_at: "2026-07-28T10:00:00.000Z",
    source: "starling-run",
    session_id: "pi-session",
    session_file: "/sessions/pi-session.jsonl",
    model: "anthropic/claude-sonnet",
    title: "Direct SDK session",
    exit_code: 0,
    ended_at: "2026-07-28T10:01:00.000Z",
  }]);
});

test("concurrent managed SDK runs do not overwrite one another", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "starling-run-concurrent-"));
  const runsPath = path.join(directory, "runs.json");
  const count = 8;

  const runs = await Promise.all(Array.from({ length: count }, (_, index) =>
    createManagedRun({
      runId: `concurrent-${index}`,
      cwd: path.join(directory, `project-${index}`),
      pid: 5_000 + index,
      environment: { STARLING_RUNS: runsPath },
    })));
  await Promise.all(runs.map((run, index) => run.updateSession({
    sessionId: `session-${index}`,
    sessionFile: `/sessions/session-${index}.jsonl`,
    model: `provider/model-${index}`,
  })));

  const data = JSON.parse(await readFile(runsPath, "utf8"));
  assert.equal(data.runs.length, count);
  assert.deepEqual(
    new Set(data.runs.map((run) => run.run_id)),
    new Set(Array.from({ length: count }, (_, index) => `concurrent-${index}`)),
  );
  for (let index = 0; index < count; index += 1) {
    const record = data.runs.find((run) => run.run_id === `concurrent-${index}`);
    assert.equal(record.session_id, `session-${index}`);
    assert.equal(record.session_file, `/sessions/session-${index}.jsonl`);
    assert.equal(record.model, `provider/model-${index}`);
  }
});

test("managed SDK run preserves records from every provider and future fields", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "starling-run-preserve-"));
  const runsPath = path.join(directory, "runs.json");
  const existing = {
    run_id: "claude-crash",
    provider: "claude",
    project_path: "/work/elsewhere",
    pid: 17,
    status: "crashed",
    started_at: "2026-07-27T00:00:00.000Z",
    source: "detected",
    future_field: { keep: true },
  };
  await writeFile(runsPath, JSON.stringify({ version: 99, runs: [existing] }), "utf8");

  await createManagedRun({
    runId: "pi-running",
    cwd: directory,
    environment: { STARLING_RUNS: runsPath },
  });

  const data = JSON.parse(await readFile(runsPath, "utf8"));
  assert.equal(data.version, 1);
  assert.deepEqual(data.runs[0], existing);
  assert.equal(data.runs[1].provider, "pi");
  assert.equal(data.runs[1].status, "running");
});

test("runs path follows explicit file, Starling home, and configured home precedence", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "starling-run-path-"));
  const configPath = path.join(directory, "config.json");
  await writeFile(configPath, JSON.stringify({ home_path: "~/custom-starling" }), "utf8");

  assert.equal(
    await resolveRunsPath({ HOME: directory, STARLING_RUNS: "/tmp/explicit-runs.json" }),
    "/tmp/explicit-runs.json",
  );
  assert.equal(
    await resolveRunsPath({ HOME: directory, STARLING_HOME: "~/env-starling" }),
    path.join(directory, "env-starling", "runs.json"),
  );
  assert.equal(
    await resolveRunsPath({ HOME: directory, STARLING_CLI_CONFIG: configPath }),
    path.join(directory, "custom-starling", "runs.json"),
  );
});
