import assert from "node:assert/strict";
import test from "node:test";

import {
  isActiveLiveStatus,
  monitorRows,
  normalizeMonitorSnapshot,
} from "../lib/protocol.js";

function row(overrides = {}) {
  return {
    session_id: "session-a",
    pinned: true,
    title: "Example",
    provider: "claude",
    model: "glm-5.2",
    status: "idle",
    cpu_pct: 0,
    mem_kb: 0,
    ctx_pct: -1,
    tokens_in: 0,
    tokens_out: 0,
    tokens_cache: 0,
    last_tool: null,
    tool_count: 0,
    project_path: "/tmp/project",
    project: "project",
    last_activity_ms: 0,
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

test("normalizes legacy monitor arrays into pinned/recent groups", () => {
  const snapshot = normalizeMonitorSnapshot([
    row({ session_id: "pinned", pinned: true, status: "busy" }),
    row({ session_id: "recent", pinned: false, status: "permission" }),
  ]);

  assert.equal(snapshot.pinned_total, 1);
  assert.equal(snapshot.recent_total, 1);
  assert.equal(snapshot.active, 2);
  assert.equal(snapshot.pinned[0].status, "running");
  assert.equal(snapshot.recent[0].status, "waiting");
});

test("normalizes status aliases used by old Rust and extension builds", () => {
  const snapshot = normalizeMonitorSnapshot({
    pinned_total: 3,
    recent_total: 0,
    active: 0,
    pinned: [
      row({ session_id: "needs-attention", status: "needs_attention" }),
      row({ session_id: "thinking", status: "thinking" }),
      row({ session_id: "stale", status: "stale-running" }),
      row({ session_id: "interrupted", status: "interrupted" }),
      row({ session_id: "failed", status: "failed" }),
      row({ session_id: "done", status: "done" }),
    ],
    recent: [],
  });

  assert.deepEqual(
    monitorRows(snapshot).map((item) => item.status),
    ["waiting", "running", "stale_running", "aborted", "failure", "stopped"],
  );
  assert.equal(isActiveLiveStatus("waiting"), true);
  assert.equal(isActiveLiveStatus("running"), true);
  assert.equal(isActiveLiveStatus("stale_running"), false);
  assert.equal(isActiveLiveStatus("aborted"), false);
  assert.equal(isActiveLiveStatus("failure"), false);
  assert.equal(isActiveLiveStatus("idle"), false);
});

test("fills numeric defaults and normalizes tool/chat tails", () => {
  const snapshot = normalizeMonitorSnapshot({
    pinned: [
      row({
        mem_kb: undefined,
        rss_kb: 2048,
        tool_calls_tail: [{ name: "Bash", arg: "git status" }],
        chat_tail: [{ role: "assistant", text: "ready" }, { text: "hello" }],
      }),
    ],
    recent: [],
  });

  const item = snapshot.pinned[0];
  assert.equal(item.mem_kb, 2048);
  assert.equal(item.rss_kb, 2048);
  assert.deepEqual(item.tool_calls_tail[0], {
    name: "Bash",
    arg: "git status",
    duration_ms: 0,
  });
  assert.deepEqual(item.chat_tail.map((chat) => chat.role), ["assistant", "user"]);
});
