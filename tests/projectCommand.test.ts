import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { registerProjectCommand } from "../src/commands/project.js";

const state = vi.hoisted(() => ({
  sessions: [] as Array<{
    session_id: string;
    provider: "claude" | "codex";
    model: string;
    project_path: string;
    first_prompt: string;
    file_path: string;
    created_at: string;
    modified_at: string;
  }>,
}));

vi.mock("../src/lib/discovery.js", () => ({
  streamSessions: vi.fn(async function* () {
    for (const session of state.sessions) yield session;
  }),
}));

vi.mock("../src/lib/sessionIndex.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/sessionIndex.js")>("../src/lib/sessionIndex.js");
  return {
    ...actual,
    loadSessionIndexWithNewFiles: vi.fn(async () => ({
      version: 1,
      built_at: "2026-01-01T00:00:00.000Z",
      session_count: state.sessions.length,
      project_count: state.sessions.length,
      sessions: state.sessions,
    })),
    rebuildSessionIndex: vi.fn(async () => ({
      version: 1,
      built_at: "2026-01-01T00:00:00.000Z",
      session_count: state.sessions.length,
      project_count: state.sessions.length,
      sessions: state.sessions,
    })),
  };
});

describe("project command", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    state.sessions = Array.from({ length: 120 }, (_, index) => {
      const n = String(index + 1).padStart(3, "0");
      const timestamp = new Date(Date.UTC(2026, 0, 1, 0, index + 1, 0)).toISOString();
      return {
        session_id: `session-${n}`,
        provider: "codex" as const,
        model: "gpt-test",
        project_path: `/work/project-${n}`,
        first_prompt: "",
        file_path: `/sessions/session-${n}.jsonl`,
        created_at: timestamp,
        modified_at: timestamp,
      };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("limits project list output by default when using the session index", async () => {
    const logs = captureLogs();
    const program = programWithProject();

    await program.parseAsync(["node", "starling", "project", "list", "--json"]);

    const output = JSON.parse(logs[0]) as Array<{ project_path: string }>;
    expect(output).toHaveLength(100);
    expect(output[0].project_path).toBe("/work/project-120");
  });

  it("shows all projects when --all is passed", async () => {
    const logs = captureLogs();
    const program = programWithProject();

    await program.parseAsync(["node", "starling", "project", "list", "--json", "--all"]);

    const output = JSON.parse(logs[0]) as Array<{ project_path: string }>;
    expect(output).toHaveLength(120);
  });
});

function programWithProject(): Command {
  const program = new Command();
  program.exitOverride();
  registerProjectCommand(program);
  return program;
}

function captureLogs(): string[] {
  const logs: string[] = [];
  vi.mocked(console.log).mockImplementation((message?: unknown) => {
    logs.push(String(message));
  });
  return logs;
}
