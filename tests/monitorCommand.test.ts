import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { registerMonitorCommand } from "../src/commands/monitor.js";
import { ENV_CONFIG_KEY } from "../src/constants.js";

// Heavy / live paths are stubbed; store + runs stay real.
let detectedMap = new Map<string, { pid?: number; provider: "claude" | "codex"; project_path?: string; file_path?: string; home?: string }>();

vi.mock("../src/lib/runs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/runs.js")>();
  return { ...actual, detectRunningSessions: vi.fn(async () => new Map(detectedMap)) };
});
vi.mock("../src/lib/processMetrics.js", () => ({
  getProcessTreeMetrics: vi.fn(() => ({ pids: [123], cpuPct: 23, memKb: 524288 })),
  resetCpuSampler: vi.fn(),
}));
vi.mock("../src/lib/sessionMetrics.js", () => ({
  getSessionLiveMetrics: vi.fn(async () => ({
    model: "claude-opus-4-6",
    tokens: { input: 45000, output: 12000, cache: 30000, total: 57000 },
    ctxPct: 78,
    lastTool: "Edit",
    toolCount: 8,
    lastActivityMs: Date.now(),
    truncated: false,
    startedAtMs: 0,
    pendingSinceMs: 0,
    thinkingSinceMs: 0,
    tokenHistory: [10000, 20000, 30000],
    contextHistory: [10000, 20000, 30000],
    compactionCount: 1,
    currentTask: "/work/demo/file.ts",
    toolCallsTail: [{ name: "Edit", arg: "/work/demo/file.ts", duration_ms: 0 }],
    chatTail: [{ role: "user", text: "fix the bug" }],
  })),
  clearSessionMetricsCache: vi.fn(),
}));
vi.mock("../src/lib/sessionIndex.js", () => ({ loadSessionIndex: vi.fn(() => null) }));

function programWithMonitor(): Command {
  const program = new Command();
  program.exitOverride();
  registerMonitorCommand(program);
  return program;
}

let root = "";
let storePath = "";
let runsPath = "";
let previousStoreEnv: string | undefined;
let previousRunsEnv: string | undefined;

function writeStore(bookmarks: unknown[], spaces?: unknown[]): void {
  const now = "2026-01-01T00:00:00.000Z";
  writeFileSync(
    storePath,
    JSON.stringify({
      version: 1,
      bookmarks,
      spaces: spaces ?? [
        { id: "cat_0001", name: "claude", description: "", tags: [], parent_id: null, created_at: now, updated_at: now },
      ],
      categories: [],
    }),
    "utf-8"
  );
}
function writeRuns(records: unknown[]): void {
  writeFileSync(runsPath, JSON.stringify({ version: 1, runs: records }, null, 2), "utf-8");
}
function bookmark(id: string, sessionId: string, title: string, spaceIds: string[] = ["cat_0001"]): unknown {
  return {
    id,
    provider: "claude",
    session_id: sessionId,
    title,
    category: "",
    tags: [],
    project_path: "/work/demo",
    first_prompt: "",
    notes: [],
    space_ids: spaceIds,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

function output(): string {
  return (console.log as unknown as { mock: { calls: string[][] } }).mock.calls.map((c) => c.join(" ")).join("\n");
}

describe("monitor command", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "starling-monitor-"));
    storePath = join(root, "store.json");
    runsPath = join(root, "runs.json");
    previousStoreEnv = process.env[ENV_CONFIG_KEY];
    previousRunsEnv = process.env.STARLING_RUNS;
    process.env[ENV_CONFIG_KEY] = storePath;
    process.env.STARLING_RUNS = runsPath;
    detectedMap = new Map();
    writeStore([]);
    writeRuns([]);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    if (previousStoreEnv === undefined) delete process.env[ENV_CONFIG_KEY];
    else process.env[ENV_CONFIG_KEY] = previousStoreEnv;
    if (previousRunsEnv === undefined) delete process.env.STARLING_RUNS;
    else process.env.STARLING_RUNS = previousRunsEnv;
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  it("renders an empty pinned section when the store has no catalog bookmarks", async () => {
    const program = programWithMonitor();
    await program.parseAsync(["node", "starling", "monitor"]);
    expect(output()).toContain("Pinned (0)");
    expect(output()).toContain("(none)");
  });

  it("shows a pinned session with completed status from run records (no live process)", async () => {
    writeStore([bookmark("starling_0001", "sess-done", "Finished task")]);
    writeRuns([
      { run_id: "r1", session_id: "sess-done", provider: "claude", status: "completed", exit_code: 0, started_at: "2026-06-01T00:00:00.000Z", ended_at: "2026-06-01T00:05:00.000Z", source: "starling-run" },
    ]);
    await programWithMonitor().parseAsync(["node", "starling", "monitor"]);
    const out = output();
    expect(out).toContain("Pinned (1)");
    expect(out).toContain("sess-done".slice(0, 13));
    // Monitor uses a status glyph, not the word. ✓ = completed.
    expect(out).toContain("✓");
  });

  it("renders live CPU/mem/CTX/tokens for a running, detected session", async () => {
    writeStore([bookmark("starling_0001", "sess-live", "Live task")]);
    writeRuns([
      { run_id: "r1", session_id: "sess-live", provider: "claude", status: "running", pid: 123, started_at: "2026-06-01T00:00:00.000Z", source: "starling-run" },
    ]);
    detectedMap.set("sess-live", { pid: 123, provider: "claude", project_path: "/work/demo", file_path: "/work/demo/sess-live.jsonl" });
    await programWithMonitor().parseAsync(["node", "starling", "monitor"]);
    const out = output();
    expect(out).toContain("23%"); // CPU
    expect(out).toContain("512M"); // mem (524288 kB)
    expect(out).toContain("78%"); // CTX
    expect(out).toContain("45k/12k"); // tokens
    // Task column now shows current_task (truncated) instead of "Edit×8".
    expect(out).toContain("/work/demo");
    // LiveStatus glyph for an active session with pending tools would be ▸ (executing),
    // but the mock has no pendingSinceMs; with thinkingSinceMs=0 and recent lastActivityMs
    // (Date.now()), resolveLiveStatus returns "executing" via the recent-activity branch.
    expect(out).toContain("▸");
  });

  it("emits JSON with pinned + recent sections and the row shape", async () => {
    writeStore([bookmark("starling_0001", "sess-x", "Title X")]);
    writeRuns([
      { run_id: "r1", session_id: "sess-x", provider: "claude", status: "errored", exit_code: 1, started_at: "2026-06-01T00:00:00.000Z", ended_at: "2026-06-01T00:05:00.000Z", source: "starling-run" },
    ]);
    await programWithMonitor().parseAsync(["node", "starling", "monitor", "--json"]);
    const parsed = JSON.parse((console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0] as string);
    expect(parsed.pinned).toHaveLength(1);
    expect(parsed.recent).toEqual([]);
    // errored RunStatus → done LiveStatus
    expect(parsed.pinned[0]).toMatchObject({ session_id: "sess-x", pinned: true, status: "done" });
    expect(parsed.pinned[0]).toHaveProperty("tokens_in");
    expect(parsed.pinned[0]).toHaveProperty("ctx_pct");
    // Tier 1 enrichment fields present.
    expect(parsed.pinned[0]).toHaveProperty("started_at_ms");
    expect(parsed.pinned[0]).toHaveProperty("elapsed_secs");
    expect(parsed.pinned[0]).toHaveProperty("current_task");
    expect(parsed.pinned[0]).toHaveProperty("token_history");
    expect(parsed.pinned[0]).toHaveProperty("context_history");
    expect(parsed.pinned[0]).toHaveProperty("compaction_count");
    expect(parsed.pinned[0]).toHaveProperty("chat_tail");
    expect(parsed.pinned[0]).toHaveProperty("tool_calls_tail");
  });

  it("filters pinned sessions by catalog and hides recent", async () => {
    writeStore(
      [bookmark("starling_0001", "sess-a", "A"), bookmark("starling_0002", "sess-b", "B", ["cat_0002"])],
      [
        { id: "cat_0001", name: "claude", description: "", tags: [], parent_id: null, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" },
        { id: "cat_0002", name: "research", description: "", tags: [], parent_id: null, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" },
      ]
    );
    await programWithMonitor().parseAsync(["node", "starling", "monitor", "research", "--json"]);
    const parsed = JSON.parse((console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0] as string);
    expect(parsed.pinned).toHaveLength(1);
    expect(parsed.pinned[0].session_id).toBe("sess-b");
    expect(parsed.recent).toEqual([]);
  });

  it("errors on an unknown catalog", async () => {
    writeStore([bookmark("starling_0001", "sess-a", "A")]);
    await expect(programWithMonitor().parseAsync(["node", "starling", "monitor", "nope"])).rejects.toThrow();
    const errOut = (console.error as unknown as { mock: { calls: string[][] } }).mock.calls.map((c) => c.join(" ")).join("\n");
    expect(errOut).toContain("Catalog not found");
  });

  it("hides the recent unpinned section by default", async () => {
    writeStore([bookmark("starling_0001", "sess-a", "A")]);
    await programWithMonitor().parseAsync(["node", "starling", "monitor"]);
    expect(output()).not.toContain("Recent unpinned");
  });

  it("respects --limit to cap the displayed pinned rows while keeping the full total", async () => {
    writeStore([
      bookmark("starling_0001", "sess-1", "T1"),
      bookmark("starling_0002", "sess-2", "T2"),
      bookmark("starling_0003", "sess-3", "T3"),
      bookmark("starling_0004", "sess-4", "T4"),
      bookmark("starling_0005", "sess-5", "T5"),
    ]);
    await programWithMonitor().parseAsync(["node", "starling", "monitor", "--limit", "2", "--json"]);
    const parsed = JSON.parse((console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0] as string);
    expect(parsed.pinned).toHaveLength(2);
    expect(parsed.pinned_total).toBe(5);
  });
});
