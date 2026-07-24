import assert from "node:assert/strict";
import test from "node:test";

Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
delete process.env.NO_COLOR;
const { renderTopSnapshot } = await import("../lib/render/top.js");

function row(overrides = {}) {
  return {
    session_id: "00000000-0000-4000-8000-000000000000",
    pinned: true,
    title: "idle task",
    provider: "claude",
    model: "glm-5.2",
    status: "idle",
    pid: undefined,
    cpu_pct: 0,
    mem_kb: 0,
    ctx_pct: -1,
    tokens_in: 0,
    tokens_out: 0,
    tokens_cache: 0,
    last_tool: null,
    tool_count: 0,
    last_skill: null,
    skill_count: 0,
    skill_usage: [],
    skill_calls_tail: [],
    project_path: "/tmp/project",
    project: "project",
    last_activity_ms: 1_000,
    started_at_ms: 0,
    elapsed_secs: 0,
    pending_since_ms: 0,
    thinking_since_ms: 0,
    token_history: [],
    context_history: [],
    compaction_count: 0,
    current_task: "",
    tool_calls_tail: [],
    chat_tail: [],
    ...overrides,
  };
}

function stripAnsi(value) {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

test("renders top rows in running, stale, waiting, failure, aborted, idle, stopped order", () => {
  const output = stripAnsi(renderTopSnapshot({
    pinned_total: 7,
    recent_total: 0,
    active: 2,
    pinned: [
      row({ session_id: "stopped-0000-4000-8000-000000000000", status: "stopped", title: "stopped task", last_activity_ms: 4_000 }),
      row({ session_id: "idle-000000-4000-8000-000000000000", status: "idle", title: "idle task", last_activity_ms: 3_000 }),
      row({ session_id: "aborted-00-4000-8000-000000000000", status: "aborted", title: "aborted task", current_task: "turn aborted", last_activity_ms: 2_750 }),
      row({ session_id: "failure-00-4000-8000-000000000000", status: "failure", title: "failure task", current_task: "api failed", last_activity_ms: 2_500 }),
      row({ session_id: "waiting-00-4000-8000-000000000000", status: "waiting", title: "waiting task", current_task: "approve git remote", last_activity_ms: 2_000 }),
      row({ session_id: "stale-0000-4000-8000-000000000000", status: "stale_running", title: "stale task", current_task: "last prompt still open", last_activity_ms: 1_500 }),
      row({ session_id: "running-00-4000-8000-000000000000", status: "running", title: "running task", current_task: "cargo test", pid: 1234, cpu_pct: 12.3, mem_kb: 1024 * 900, last_activity_ms: 1_000 }),
    ],
    recent: [],
  }, { width: 132, now: new Date(10_000) }));

  const firstLine = output.split("\n")[0] ?? "";
  assert.match(firstLine, /^Starling top\s+\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\s+7 pinned · 2 active$/);
  assert.match(output, /SID\s+S\s+AGT\s+MODEL\s+PID\s+CPU\s+MEM\s+CTX\s+TOK\s+AGE\s+TASK/);
  assert.ok(output.indexOf("cargo test") < output.indexOf("approve git remote"));
  assert.ok(output.indexOf("cargo test") < output.indexOf("last prompt still open"));
  assert.ok(output.indexOf("last prompt still open") < output.indexOf("approve git remote"));
  assert.ok(output.indexOf("approve git remote") < output.indexOf("api failed"));
  assert.ok(output.indexOf("api failed") < output.indexOf("turn aborted"));
  assert.ok(output.indexOf("turn aborted") < output.indexOf("idle task"));
  assert.ok(output.indexOf("idle task") < output.indexOf("stopped task"));
});

test("renders empty top snapshot with startup hint", () => {
  const output = stripAnsi(renderTopSnapshot({
    pinned_total: 0,
    recent_total: 0,
    active: 0,
    pinned: [],
    recent: [],
  }, { width: 100, now: new Date(10_000) }));

  assert.match(output, /No agent sessions to display/);
  assert.match(output, /start or pin an agent session/);
});

test("labels mixed pinned and unpinned snapshots as sessions", () => {
  const output = stripAnsi(renderTopSnapshot({
    pinned_total: 1,
    recent_total: 1,
    active: 0,
    pinned: [
      row({ session_id: "pinned-0000-4000-8000-000000000000", pinned: true, title: "pinned task" }),
    ],
    recent: [
      row({ session_id: "recent-0000-4000-8000-000000000000", pinned: false, title: "recent task" }),
    ],
  }, { width: 132, now: new Date(10_000) }));

  assert.match(output, /Sessions \(2; 1 pinned, 1 unpinned\)/);
  assert.doesNotMatch(output, /Pinned \(1\)/);
});

test("respects explicit row order from Rust sort mode", () => {
  const output = stripAnsi(renderTopSnapshot({
    pinned_total: 1,
    recent_total: 1,
    active: 1,
    rows: [
      row({ session_id: "idle-000000-4000-8000-000000000000", status: "idle", title: "idle first", last_activity_ms: 1_000 }),
      row({ session_id: "running-00-4000-8000-000000000000", status: "running", title: "running second", last_activity_ms: 2_000 }),
    ],
    pinned: [
      row({ session_id: "running-00-4000-8000-000000000000", status: "running", title: "running second", last_activity_ms: 2_000 }),
    ],
    recent: [
      row({ session_id: "idle-000000-4000-8000-000000000000", status: "idle", title: "idle first", last_activity_ms: 1_000 }),
    ],
  }, { width: 132, now: new Date(10_000) }));

  assert.ok(output.indexOf("idle first") < output.indexOf("running second"));
});

test("keeps pid visible and project column absent in default top table", () => {
  const output = stripAnsi(renderTopSnapshot({
    pinned_total: 1,
    recent_total: 0,
    active: 1,
    pinned: [
      row({
        session_id: "8fa13c6d-3b35-4c83-834a-5043d755b223",
        status: "waiting",
        title: "permission wait",
        provider: "claude",
        model: "glm-5.2",
        pid: 851731,
        current_task: "cd /repo && git remote -v",
      }),
    ],
    recent: [],
  }, { width: 132, now: new Date(10_000) }));

  const header = output.split("\n").find((line) => line.includes("SID") && line.includes("TASK")) ?? "";
  assert.match(header, /\bPID\b/);
  assert.doesNotMatch(header, /\bPROJECT\b/);
  assert.match(output, /851731/);
  assert.match(output, /cd \/repo && git remote -v/);
});

test("renders skill usage beside last tool in task column", () => {
  const output = stripAnsi(renderTopSnapshot({
    pinned_total: 1,
    recent_total: 0,
    active: 1,
    pinned: [
      row({
        session_id: "skill-0000-4000-8000-000000000000",
        provider: "codex",
        status: "idle",
        last_tool: "exec_command",
        tool_count: 16,
        last_skill: "openai-docs",
        skill_count: 2,
      }),
    ],
    recent: [],
  }, { width: 132, now: new Date(10_000) }));

  assert.match(output, /skills 2/);
  assert.match(output, /skills×2 · exec_command/);
});

test("renders a dedicated skill column on wide terminals", () => {
  const output = stripAnsi(renderTopSnapshot({
    pinned_total: 1,
    recent_total: 0,
    active: 1,
    pinned: [
      row({
        session_id: "skill-0000-4000-8000-000000000000",
        provider: "codex",
        status: "idle",
        last_tool: "exec_command",
        tool_count: 16,
        last_skill: "openai-docs",
        skill_count: 2,
      }),
    ],
    recent: [],
  }, { width: 170, now: new Date(10_000) }));

  assert.match(output, /SID\s+S\s+AGT\s+MODEL\s+PID\s+CPU\s+MEM\s+CTX\s+TOK\s+AGE\s+SKILLS\s+TASK/);
  assert.match(output, /\s2\s+exec_command×16/);
});

test("renders Pi as a first-class agent", () => {
  const output = renderTopSnapshot({
    pinned_total: 1,
    recent_total: 0,
    active: 1,
    pinned: [
      row({
        session_id: "pi-agent-00-4000-8000-000000000000",
        provider: "pi",
        model: "claude-sonnet-4-5",
        status: "running",
        title: "Pi task",
      }),
    ],
    recent: [],
  }, { width: 132, now: new Date(10_000) });

  assert.match(output, /\x1b\[36mpi\x1b\[39m/);
  assert.match(stripAnsi(output), /Pi task/);
});
