import { describe, expect, it } from "vitest";
import { aggregateProjectsFromSessions } from "../src/lib/sessionIndex.js";
import type { SessionMeta } from "../src/types.js";

describe("aggregateProjectsFromSessions", () => {
  it("builds sorted project summaries from a session index", () => {
    const sessions: SessionMeta[] = [
      session("old", "claude", "/work/a", "2025-01-01T00:00:00.000Z", "claude-3"),
      session("new", "codex", "/work/a", "2025-01-03T00:00:00.000Z", "gpt-5"),
      session("b", "codex", "/work/b", "2025-01-02T00:00:00.000Z", "gpt-5"),
      session("missing-project", "codex", "", "2025-01-04T00:00:00.000Z", "gpt-5"),
    ];

    const projects = aggregateProjectsFromSessions(sessions);

    expect(projects.map((p) => p.project_path)).toEqual(["/work/a", "/work/b"]);
    expect(projects[0].session_count).toBe(2);
    expect(projects[0].agents).toEqual({ claude: 1, codex: 1 });
    expect(projects[0].models).toEqual({ "claude-3": 1, "gpt-5": 1 });
    expect(projects[0].last_active).toBe("2025-01-03T00:00:00.000Z");
  });
});

function session(
  id: string,
  provider: "claude" | "codex",
  projectPath: string,
  modifiedAt: string,
  model: string
): SessionMeta {
  return {
    session_id: id,
    provider,
    model,
    project_path: projectPath,
    first_prompt: "",
    file_path: `/tmp/${id}.jsonl`,
    created_at: modifiedAt,
    modified_at: modifiedAt,
  };
}
