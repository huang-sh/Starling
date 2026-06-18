import { mkdtempSync, writeFileSync, rmSync, utimesSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearSessionMetricsCache,
  getSessionLiveMetrics,
  modelContextWindow,
} from "../src/lib/sessionMetrics.js";

function assistant(model: string, opts: { input?: number; output?: number; cc?: number; cr?: number; tool?: string } = {}): string {
  const content = opts.tool
    ? [{ type: "tool_use", name: opts.tool, input: {} }]
    : [{ type: "text", text: "ok" }];
  return JSON.stringify({
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
  });
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
});
