import { beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync, statSync } from "fs";
import { normalize } from "path";

const files = new Map<string, string>();
const stats = new Map<string, { mtimeMs: number; directory: boolean }>();
const children = new Map<string, string[]>();
const parsedFiles: string[] = [];
const statCalls: string[] = [];
let writtenJson: unknown = null;

function key(path: string): string {
  return normalize(path);
}

function addDir(path: string, names: string[], mtimeMs = 1): void {
  const k = key(path);
  stats.set(k, { mtimeMs, directory: true });
  children.set(k, names);
}

function addFile(path: string, mtimeMs: number): void {
  stats.set(key(path), { mtimeMs, directory: false });
}

function setIndex(builtAt: string, sessions: unknown[], directories: unknown[] = [], filesList: unknown[] = []): void {
  const indexPath = key("/starling/session-index.json");
  files.set(
    indexPath,
    JSON.stringify({
      version: 1,
      built_at: builtAt,
      session_count: sessions.length,
      project_count: 1,
      sessions,
      files: filesList,
      directories,
    })
  );
  addFile(indexPath, Date.parse(builtAt) || 1);
}

vi.mock("fs", () => ({
  existsSync: vi.fn((path: string) => files.has(key(path)) || stats.has(key(path))),
  readFileSync: vi.fn((path: string) => {
    const content = files.get(key(path));
    if (content === undefined) throw new Error(`missing file: ${path}`);
    return content;
  }),
  readdirSync: vi.fn((path: string) => {
    const names = children.get(key(path));
    if (!names) throw new Error(`missing directory: ${path}`);
    return names;
  }),
  statSync: vi.fn((path: string) => {
    statCalls.push(path);
    const st = stats.get(key(path));
    if (!st) throw new Error(`missing stat: ${path}`);
    return { mtimeMs: st.mtimeMs, isDirectory: () => st.directory };
  }),
  unlinkSync: vi.fn(),
}));

vi.mock("../src/constants.js", () => {
  const { normalize } = require("path") as typeof import("path");
  return {
    CLAUDE_SESSIONS_DIR: normalize("/sessions/claude"),
    CODEX_SESSIONS_DIR: normalize("/sessions/codex"),
    DEFAULT_STARLING_HOME: normalize("/starling"),
    claudeSessionRoots: () => [normalize("/sessions/claude")],
    codexSessionRoots: () => [normalize("/sessions/codex")],
  };
});

vi.mock("../src/utils/fs.js", () => ({
  atomicWriteJSON: vi.fn((_path: string, value: unknown) => {
    writtenJson = value;
  }),
}));

vi.mock("../src/lib/session.js", () => ({
  parseJsonlHead: vi.fn(async (filePath: string) => {
    parsedFiles.push(`head:${filePath}`);
    return [];
  }),
  parseJsonlFile: vi.fn(async (filePath: string) => {
    parsedFiles.push(`full:${filePath}`);
    return [];
  }),
  extractClaudeSessionMeta: vi.fn((_entries, filePath: string, modifiedAt: string) => ({
    session_id: filePath.split(/[\\/]/).pop()?.replace(".jsonl", "") ?? filePath,
    provider: "claude",
    model: "claude-test",
    project_path: "/work/new",
    first_prompt: "",
    file_path: filePath,
    created_at: modifiedAt,
    modified_at: modifiedAt,
  })),
  extractCodexSessionMeta: vi.fn((_entries, filePath: string, modifiedAt: string) => ({
    session_id: filePath.split(/[\\/]/).pop()?.replace(".jsonl", "") ?? filePath,
    provider: "codex",
    model: "codex-test",
    project_path: "/work/new",
    first_prompt: "",
    file_path: filePath,
    created_at: modifiedAt,
    modified_at: modifiedAt,
  })),
}));

const claudeSession = (id: string) => ({
  session_id: id,
  provider: "claude",
  model: "claude-old",
  project_path: "/work/old",
  first_prompt: "",
  file_path: normalize(`/sessions/claude/project/${id}.jsonl`),
  created_at: "2026-01-01T00:00:00.000Z",
  modified_at: "2026-01-01T00:00:00.000Z",
});

const codexSession = (id: string) => ({
  session_id: id,
  provider: "codex",
  model: "codex-old",
  project_path: "/work/old",
  first_prompt: "",
  file_path: normalize(`/sessions/codex/${id}.jsonl`),
  created_at: "2026-01-01T00:00:00.000Z",
  modified_at: "2026-01-01T00:00:00.000Z",
});

describe("isSessionIndexFresh", () => {
  beforeEach(() => {
    files.clear();
    stats.clear();
    children.clear();
    parsedFiles.length = 0;
    statCalls.length = 0;
    writtenJson = null;
  });

  it("returns true within the TTL window without touching the session roots", async () => {
    setIndex(new Date().toISOString(), [claudeSession("abc")]);
    const { isSessionIndexFresh } = await import("../src/lib/sessionIndex.js");

    const fresh = isSessionIndexFresh();

    expect(fresh).toBe(true);
    expect(statCalls).not.toContain(normalize("/sessions/claude"));
    expect(statCalls).not.toContain(normalize("/sessions/codex"));
  });

  it("returns true when TTL elapsed but root mtime is not newer than built_at", async () => {
    const builtAtMs = Date.parse("2026-01-01T00:00:00.000Z");
    setIndex("2026-01-01T00:00:00.000Z", [claudeSession("abc")]);
    addDir("/sessions/claude", [], builtAtMs);
    addDir("/sessions/codex", [], builtAtMs);
    const { isSessionIndexFresh } = await import("../src/lib/sessionIndex.js");

    const fresh = isSessionIndexFresh(undefined, Date.parse("2026-03-01T00:00:00.000Z"));

    expect(fresh).toBe(true);
    expect(statCalls).toContain(normalize("/sessions/claude"));
    expect(statCalls).toContain(normalize("/sessions/codex"));
  });

  it("returns false when a session root is newer than built_at", async () => {
    const builtAtMs = Date.parse("2026-01-01T00:00:00.000Z");
    setIndex("2026-01-01T00:00:00.000Z", [claudeSession("abc")]);
    addDir("/sessions/claude", [], builtAtMs + 10_000);
    addDir("/sessions/codex", [], builtAtMs);
    const { isSessionIndexFresh } = await import("../src/lib/sessionIndex.js");

    const fresh = isSessionIndexFresh(undefined, Date.parse("2026-03-01T00:00:00.000Z"));

    expect(fresh).toBe(false);
  });

  it("returns false when the index is missing", async () => {
    const { isSessionIndexFresh } = await import("../src/lib/sessionIndex.js");

    expect(isSessionIndexFresh()).toBe(false);
  });

  it("scopes the root check to the requested provider", async () => {
    const builtAtMs = Date.parse("2026-01-01T00:00:00.000Z");
    setIndex("2026-01-01T00:00:00.000Z", [claudeSession("abc")]);
    // codex root is newer but we only ask about claude
    addDir("/sessions/claude", [], builtAtMs);
    addDir("/sessions/codex", [], builtAtMs + 10_000);
    const { isSessionIndexFresh } = await import("../src/lib/sessionIndex.js");

    const fresh = isSessionIndexFresh("claude", Date.parse("2026-03-01T00:00:00.000Z"));

    expect(fresh).toBe(true);
    expect(statCalls).toContain(normalize("/sessions/claude"));
    expect(statCalls).not.toContain(normalize("/sessions/codex"));
  });
});

describe("lookupIndexedSessions fast path", () => {
  beforeEach(() => {
    files.clear();
    stats.clear();
    children.clear();
    parsedFiles.length = 0;
    statCalls.length = 0;
    writtenJson = null;
    vi.mocked(readdirSync).mockClear();
    vi.mocked(statSync).mockClear();
  });

  it("returns exact and prefix matches from the index without walking or writing", async () => {
    setIndex(new Date().toISOString(), [
      claudeSession("aa11bb22-0000"),
      claudeSession("aa11bb22-1111"),
      claudeSession("ff99ee88"),
    ]);
    const { lookupIndexedSessions } = await import("../src/lib/sessionIndex.js");

    const result = await lookupIndexedSessions(["aa11bb22", "ff99ee88", "missing-id"]);

    expect(result.size).toBe(3);
    expect(result.get("aa11bb22-0000")).toBeTruthy();
    expect(result.get("aa11bb22-1111")).toBeTruthy();
    expect(result.get("ff99ee88")).toBeTruthy();
    expect(result.get("missing-id")).toBeUndefined();
    // Fast path: no directory walk, no index rewrite, no jsonl parse.
    expect(vi.mocked(readdirSync)).not.toHaveBeenCalled();
    expect(writtenJson).toBeNull();
    expect(parsedFiles).toEqual([]);
  });

  it("respects the provider filter", async () => {
    setIndex(new Date().toISOString(), [
      claudeSession("shared-id"),
      codexSession("shared-id"),
    ]);
    const { lookupIndexedSessions } = await import("../src/lib/sessionIndex.js");

    const result = await lookupIndexedSessions(["shared-id"], "codex");

    expect(result.size).toBe(1);
    expect([...result.values()][0]?.provider).toBe("codex");
  });

  it("returns an empty map for empty input without touching the index", async () => {
    const { lookupIndexedSessions } = await import("../src/lib/sessionIndex.js");

    const result = await lookupIndexedSessions([]);

    expect(result.size).toBe(0);
    expect(vi.mocked(readdirSync)).not.toHaveBeenCalled();
    expect(writtenJson).toBeNull();
  });
});

describe("lookupIndexedSessions slow path", () => {
  beforeEach(() => {
    files.clear();
    stats.clear();
    children.clear();
    parsedFiles.length = 0;
    statCalls.length = 0;
    writtenJson = null;
    vi.mocked(readdirSync).mockClear();
  });

  it("refreshes via loadSessionIndexWithNewFiles once when the index is stale", async () => {
    const builtAtMs = Date.parse("2026-01-01T00:00:00.000Z");
    setIndex("2026-01-01T00:00:00.000Z", [claudeSession("existing")]);
    // Stale: root newer than built_at, plus a brand-new file to force a write.
    addDir("/sessions/claude", ["project"], builtAtMs + 10_000);
    addDir("/sessions/claude/project", ["existing.jsonl", "fresh.jsonl"], builtAtMs + 10_000);
    addFile("/sessions/claude/project/existing.jsonl", builtAtMs);
    addFile("/sessions/claude/project/fresh.jsonl", builtAtMs + 10_000);
    addDir("/sessions/codex", [], builtAtMs);
    const { lookupIndexedSessions } = await import("../src/lib/sessionIndex.js");

    const manyIds = ["existing", ...Array.from({ length: 49 }, (_, i) => `existing-${i}`)];
    const result = await lookupIndexedSessions(manyIds);

    // Slow path runs exactly one refresh regardless of input size: the walk
    // touches the directory tree, the new file gets parsed, and the index is
    // rewritten at most once.
    expect(vi.mocked(readdirSync)).toHaveBeenCalled();
    expect(parsedFiles).toEqual([`head:${normalize("/sessions/claude/project/fresh.jsonl")}`]);
    expect(writtenJson).toMatchObject({ version: 1 });
    // Existing session is still resolvable after refresh.
    expect(result.get("existing")).toBeTruthy();
  });
});
