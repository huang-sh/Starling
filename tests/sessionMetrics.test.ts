import { mkdtempSync, writeFileSync, rmSync, utimesSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearSessionMetricsCache,
  getSessionLiveMetrics,
  modelContextWindow,
} from "../src/lib/sessionMetrics.js";

function assistant(
  model: string,
  opts: { input?: number; output?: number; cc?: number; cr?: number; tool?: string; toolInput?: unknown; text?: string; ts?: string } = {}
): string {
  const content: unknown[] = opts.tool
    ? [{ type: "tool_use", id: "tu1", name: opts.tool, input: opts.toolInput ?? {} }]
    : [];
  if (opts.text !== undefined) content.push({ type: "text", text: opts.text });
  if (content.length === 0) content.push({ type: "text", text: "ok" });
  const entry: Record<string, unknown> = {
    type: "assistant",
    message: {
      role: "assistant",
      model,
      content,
      usage: {
        input_tokens: opts.input ?? 0,
        output_tokens: opts.output ?? 0,
        cache_creation_input_tokens: opts.cc ?? 0,
        cache_read_input_tokens: opts.cr ?? 0,
      },
    },
  };
  if (opts.ts) entry.timestamp = opts.ts;
  return JSON.stringify(entry);
}

function user(text: string, opts: { toolResult?: boolean; ts?: string } = {}): string {
  const content = opts.toolResult
    ? [{ type: "tool_result", tool_use_id: "tu1", content: "ok" }]
    : [{ type: "text", text }];
  const entry: Record<string, unknown> = {
    type: "user",
    message: { role: "user", content },
  };
  if (opts.ts) entry.timestamp = opts.ts;
  return JSON.stringify(entry);
}

describe("sessionMetrics modelContextWindow", () => {
  it("returns 200k for known models and 1M for 1m variants", () => {
    expect(modelContextWindow("claude-opus-4-6")).toBe(200000);
    expect(modelContextWindow("claude-sonnet-4-5")).toBe(200000);
    expect(modelContextWindow("claude-1m")).toBe(1000000);
    expect(modelContextWindow(null)).toBe(200000);
  });
});

describe("sessionMetrics getSessionLiveMetrics", () => {
  let dir = "";
  let path = "";

  beforeEach(() => {
    clearSessionMetricsCache();
    dir = mkdtempSync(join(tmpdir(), "starling-smetrics-"));
    path = join(dir, "sess.jsonl");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("sums cumulative tokens, computes ctx% from the last usage, tracks tools/model", async () => {
    writeFileSync(
      path,
      [
        assistant("claude-opus-4-6", { input: 100, output: 50, cc: 20, cr: 80 }),
        assistant("claude-opus-4-6", { input: 300, output: 40, cc: 10, cr: 190, tool: "Edit" }),
        "",
      ].join("\n")
    );
    const live = await getSessionLiveMetrics(path);
    expect(live.model).toBe("claude-opus-4-6");
    expect(live.tokens.input).toBe(400);
    expect(live.tokens.output).toBe(90);
    expect(live.tokens.cache).toBe(300);
    expect(live.tokens.total).toBe(490);
    // ctxInput = 300 + 10 + 190 = 500 → 500/200000*100 = 0.25
    expect(live.ctxPct).toBeCloseTo(0.25, 5);
    expect(live.lastTool).toBe("Edit");
    expect(live.toolCount).toBe(1);
    expect(live.truncated).toBe(false);
  });

  it("reports ctxPct -1 and zero tokens when no usage entries exist", async () => {
    writeFileSync(path, `${JSON.stringify({ type: "user", message: { role: "user", content: "hi" } })}\n`);
    const live = await getSessionLiveMetrics(path);
    expect(live.ctxPct).toBe(-1);
    expect(live.tokens.total).toBe(0);
    expect(live.lastTool).toBeNull();
    expect(live.toolCount).toBe(0);
  });

  it("caches by mtime — a second call with unchanged mtime returns the same result", async () => {
    writeFileSync(path, assistant("claude-opus-4-6", { input: 10, output: 5 }));
    const first = await getSessionLiveMetrics(path);
    const second = await getSessionLiveMetrics(path);
    expect(second).toBe(first);
  });

  it("re-parses when the file mtime advances", async () => {
    writeFileSync(path, assistant("claude-opus-4-6", { input: 10, output: 5 }));
    const before = await getSessionLiveMetrics(path);
    // bump mtime by 10s and append a richer entry
    const future = new Date(Date.now() / 1000 + 10);
    writeFileSync(path, assistant("claude-opus-4-6", { input: 1000, output: 500, tool: "Bash" }));
    utimesSync(path, future, future);
    const after = await getSessionLiveMetrics(path);
    expect(after).not.toBe(before);
    expect(after.tokens.input).toBe(1000);
    expect(after.lastTool).toBe("Bash");
  });

  it("captures startedAtMs from the first entry timestamp", async () => {
    writeFileSync(
      path,
      [
        user("hi", { ts: "2026-06-01T00:00:00.000Z" }),
        assistant("claude-opus-4-6", { input: 10, output: 5, ts: "2026-06-01T00:00:05.000Z" }),
        "",
      ].join("\n")
    );
    const live = await getSessionLiveMetrics(path);
    expect(live.startedAtMs).toBe(Date.parse("2026-06-01T00:00:00.000Z"));
  });

  it("sets pendingSinceMs when the last assistant turn has tool_use not yet closed", async () => {
    writeFileSync(
      path,
      [
        user("hi", { ts: "2026-06-01T00:00:00.000Z" }),
        assistant("claude-opus-4-6", { input: 10, output: 5, tool: "Edit", toolInput: { file_path: "/x/y.ts" }, ts: "2026-06-01T00:00:05.000Z" }),
        "",
      ].join("\n")
    );
    const live = await getSessionLiveMetrics(path);
    expect(live.pendingSinceMs).toBe(Date.parse("2026-06-01T00:00:05.000Z"));
    expect(live.thinkingSinceMs).toBe(0);
    // current_task captured from the tool_use input.
    expect(live.currentTask).toBe("/x/y.ts");
  });

  it("clears pendingSinceMs and sets thinkingSinceMs when a tool_result follows", async () => {
    writeFileSync(
      path,
      [
        user("hi", { ts: "2026-06-01T00:00:00.000Z" }),
        assistant("claude-opus-4-6", { input: 10, output: 5, tool: "Edit", ts: "2026-06-01T00:00:05.000Z" }),
        user("ok", { toolResult: true, ts: "2026-06-01T00:00:10.000Z" }),
        "",
      ].join("\n")
    );
    const live = await getSessionLiveMetrics(path);
    expect(live.pendingSinceMs).toBe(0);
    expect(live.thinkingSinceMs).toBe(Date.parse("2026-06-01T00:00:10.000Z"));
  });

  it("pushes token/context history at each assistant turn with usage", async () => {
    writeFileSync(
      path,
      [
        assistant("claude-opus-4-6", { input: 100, output: 10, cc: 0, cr: 0, ts: "2026-06-01T00:00:00.000Z" }),
        assistant("claude-opus-4-6", { input: 200, output: 20, cc: 0, cr: 0, ts: "2026-06-01T00:00:05.000Z" }),
        "",
      ].join("\n")
    );
    const live = await getSessionLiveMetrics(path);
    expect(live.tokenHistory).toHaveLength(2);
    // history is cumulative at each turn; both tokens + cache are summed
    expect(live.tokenHistory[0]).toBe(110); // 100 + 10 + 0 cache
    expect(live.tokenHistory[1]).toBe(330); // 300 input + 30 output + 0 cache
    expect(live.contextHistory).toEqual([100, 200]); // input only, no cache
  });

  it("counts compaction events on >30% drops in context_history", async () => {
    // turn 1 ctx=100k → turn 2 ctx=10k is a 90% drop → 1 compaction event
    writeFileSync(
      path,
      [
        assistant("claude-opus-4-6", { input: 100000, output: 10, cc: 0, cr: 0, ts: "2026-06-01T00:00:00.000Z" }),
        assistant("claude-opus-4-6", { input: 10000, output: 10, cc: 0, cr: 0, ts: "2026-06-01T00:00:05.000Z" }),
        "",
      ].join("\n")
    );
    const live = await getSessionLiveMetrics(path);
    expect(live.compactionCount).toBe(1);
  });

  it("populates chatTail with the most-recent user/assistant text (max 6)", async () => {
    const lines: string[] = [];
    for (let i = 0; i < 8; i++) {
      lines.push(user(`u${i}`, { ts: new Date(Date.parse("2026-06-01T00:00:00.000Z") + i * 5000).toISOString() }));
      lines.push(assistant("claude-opus-4-6", { input: 1, output: 1, text: `a${i}`, ts: new Date(Date.parse("2026-06-01T00:00:00.000Z") + i * 5000 + 1000).toISOString() }));
    }
    lines.push("");
    writeFileSync(path, lines.join("\n"));
    const live = await getSessionLiveMetrics(path);
    // 16 pushes but tail capped at 6 → last 6 messages, newest last.
    expect(live.chatTail).toHaveLength(6);
    expect(live.chatTail.map((m) => m.text)).toEqual(["u5", "a5", "u6", "a6", "u7", "a7"]);
    // All entries have a valid role.
    for (const m of live.chatTail) {
      expect(m.role === "user" || m.role === "assistant").toBe(true);
    }
  });

  it("populates toolCallsTail with name + arg per tool_use, max 12", async () => {
    const lines: string[] = [];
    for (let i = 0; i < 15; i++) {
      lines.push(assistant("claude-opus-4-6", {
        input: 1,
        output: 1,
        tool: i % 2 === 0 ? "Read" : "Bash",
        toolInput: i % 2 === 0 ? { file_path: `/f${i}.ts` } : { command: `echo ${i}` },
      }));
    }
    lines.push("");
    writeFileSync(path, lines.join("\n"));
    const live = await getSessionLiveMetrics(path);
    expect(live.toolCallsTail).toHaveLength(12);
    // Tail keeps i=3..14; first is i=3 (Bash "echo 3"), last is i=14 (Read /f14.ts).
    expect(live.toolCallsTail[0]).toMatchObject({ name: "Bash", arg: "echo 3" });
    expect(live.toolCallsTail[11]).toMatchObject({ name: "Read", arg: "/f14.ts" });
  });

  it("extracts Bash command as current_task", async () => {
    writeFileSync(
      path,
      [
        assistant("claude-opus-4-6", { input: 1, output: 1, tool: "Bash", toolInput: { command: "npm run build" } }),
        "",
      ].join("\n")
    );
    const live = await getSessionLiveMetrics(path);
    expect(live.currentTask).toBe("npm run build");
  });

  it("skips tool_result-only user entries from chatTail but still clears pendingSinceMs", async () => {
    writeFileSync(
      path,
      [
        user("hello", { ts: "2026-06-01T00:00:00.000Z" }),
        assistant("claude-opus-4-6", { input: 1, output: 1, text: "working", tool: "Read", ts: "2026-06-01T00:00:05.000Z" }),
        user("ignored", { toolResult: true, ts: "2026-06-01T00:00:10.000Z" }),
        "",
      ].join("\n")
    );
    const live = await getSessionLiveMetrics(path);
    expect(live.pendingSinceMs).toBe(0);
    // tool_result-only entries do not contribute to chat tail.
    expect(live.chatTail.map((m) => m.text)).toEqual(["hello", "working"]);
  });
});
