import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { registerStatusCommand } from "../src/commands/status.js";
import { ENV_CONFIG_KEY } from "../src/constants.js";

// Preserve the real runs store layer, but stub the expensive /proc detection.
vi.mock("../src/lib/runs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/runs.js")>();
  return { ...actual, detectRunningSessions: vi.fn(async () => new Map()) };
});

function programWithStatus(): Command {
  const program = new Command();
  program.exitOverride(); // turn process.exit into thrown errors
  registerStatusCommand(program);
  return program;
}

let root = "";
let storePath = "";
let runsPath = "";
let previousStoreEnv: string | undefined;
let previousRunsEnv: string | undefined;

function writeStore(bookmarks: unknown[], spaces?: unknown[]): void {
  const now = "2026-01-01T00:00:00.000Z";
  const data = {
    version: 1,
    bookmarks,
    spaces: spaces ?? [
      { id: "cat_0001", name: "claude", description: "Claude Code sessions", tags: [], parent_id: null, created_at: now, updated_at: now },
    ],
    categories: [],
  };
  writeFileSync(storePath, JSON.stringify(data), "utf-8");
}

function writeRuns(records: unknown[]): void {
  writeFileSync(runsPath, JSON.stringify({ version: 1, runs: records }, null, 2), "utf-8");
}

function readRuns(): { runs: { run_id: string; status: string; session_id?: string }[] } {
  return JSON.parse(readFileSync(runsPath, "utf-8"));
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

describe("status command", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "starling-status-"));
    storePath = join(root, "store.json");
    runsPath = join(root, "runs.json");
    previousStoreEnv = process.env[ENV_CONFIG_KEY];
    previousRunsEnv = process.env.STARLING_RUNS;
    process.env[ENV_CONFIG_KEY] = storePath;
    process.env.STARLING_RUNS = runsPath;
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

  it("reports no catalog-archived sessions when the store is empty", async () => {
    writeStore([]);
    const program = programWithStatus();
    await program.parseAsync(["node", "starling", "status"]);
    const out = (console.log as unknown as { mock: { calls: string[][] } }).mock.calls.map((c) => c.join(" ")).join("\n");
    expect(out).toContain("No catalog-archived sessions");
  });

  it("renders a table with the session status from run records", async () => {
    writeStore([bookmark("starling_0001", "sess-completed", "Done run")]);
    writeRuns([
      { run_id: "r1", session_id: "sess-completed", provider: "claude", status: "completed", exit_code: 0, started_at: "2026-06-01T00:00:00.000Z", ended_at: "2026-06-01T00:05:00.000Z", source: "starling-run" },
    ]);
    const program = programWithStatus();
    await program.parseAsync(["node", "starling", "status"]);
    const out = (console.log as unknown as { mock: { calls: string[][] } }).mock.calls.map((c) => c.join(" ")).join("\n");
    expect(out).toContain("Done run");
    expect(out).toContain("completed");
  });

  it("emits JSON with the expected shape", async () => {
    writeStore([bookmark("starling_0001", "sess-x", "Title X")]);
    writeRuns([
      { run_id: "r1", session_id: "sess-x", provider: "claude", status: "errored", exit_code: 1, started_at: "2026-06-01T00:00:00.000Z", ended_at: "2026-06-01T00:05:00.000Z", source: "starling-run" },
    ]);
    const program = programWithStatus();
    await program.parseAsync(["node", "starling", "status", "--json"]);
    const jsonArg = (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0] as string;
    const parsed = JSON.parse(jsonArg);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ session_id: "sess-x", status: "errored", exit_code: 1, catalog: "claude" });
  });

  it("filters by catalog name", async () => {
    writeStore(
      [bookmark("starling_0001", "sess-a", "A"), bookmark("starling_0002", "sess-b", "B", ["cat_0002"])],
      [
        { id: "cat_0001", name: "claude", description: "", tags: [], parent_id: null, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" },
        { id: "cat_0002", name: "research", description: "", tags: [], parent_id: null, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" },
      ]
    );
    writeRuns([]);
    const program = programWithStatus();
    await program.parseAsync(["node", "starling", "status", "research", "--json"]);
    const parsed = JSON.parse((console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0] as string);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].session_id).toBe("sess-b");
  });

  it("errors on an unknown catalog", async () => {
    writeStore([bookmark("starling_0001", "sess-a", "A")]);
    const program = programWithStatus();
    await expect(program.parseAsync(["node", "starling", "status", "nope"])).rejects.toThrow();
    const errOut = (console.error as unknown as { mock: { calls: string[][] } }).mock.calls.map((c) => c.join(" ")).join("\n");
    expect(errOut).toContain("Catalog not found");
  });

  it("prune removes crashed records", async () => {
    writeRuns([
      { run_id: "r1", session_id: "s1", provider: "claude", status: "crashed", started_at: "2026-01-01T00:00:00.000Z", source: "starling-run" },
      { run_id: "r2", session_id: "s2", provider: "claude", status: "completed", started_at: "2026-01-01T00:00:00.000Z", source: "starling-run" },
    ]);
    const program = programWithStatus();
    await program.parseAsync(["node", "starling", "status", "prune"]);
    const after = readRuns();
    expect(after.runs).toHaveLength(1);
    expect(after.runs[0]!.run_id).toBe("r2");
  });

  it("clear removes a run by run_id and by session_id", async () => {
    writeRuns([
      { run_id: "run-aaa", session_id: "s1", provider: "claude", status: "completed", started_at: "2026-01-01T00:00:00.000Z", source: "starling-run" },
      { run_id: "run-bbb", session_id: "s2", provider: "claude", status: "errored", started_at: "2026-01-01T00:00:00.000Z", source: "starling-run" },
      { run_id: "run-ccc", session_id: "s2", provider: "claude", status: "completed", started_at: "2026-01-02T00:00:00.000Z", source: "starling-run" },
    ]);
    const p1 = programWithStatus();
    await p1.parseAsync(["node", "starling", "status", "clear", "run-aaa"]);
    expect(readRuns().runs).toHaveLength(2);

    const p2 = programWithStatus();
    await p2.parseAsync(["node", "starling", "status", "clear", "s2"]);
    expect(readRuns().runs).toHaveLength(0);
  });
});
