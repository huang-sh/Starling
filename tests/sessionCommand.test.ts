import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { registerSessionCommand } from "../src/commands/session.js";
import { ENV_CONFIG_KEY, STORE_VERSION } from "../src/constants.js";

const discoveryState = vi.hoisted(() => ({
  sessions: [] as ReturnType<typeof sessionMeta>[],
  indexSessions: [] as ReturnType<typeof sessionMeta>[],
}));

vi.mock("../src/lib/discovery.js", () => ({
  findSessionCandidates: vi.fn(async (input: string) => [
    sessionMeta(input),
  ]),
  findSessionById: vi.fn(async (input: string) => sessionMeta(input)),
  findSessions: vi.fn(async () => discoveryState.sessions),
  looksLikeSessionIdQuery: vi.fn((input: string) => /^[0-9a-f-]{8,}$/i.test(input)),
  streamSessions: vi.fn(async function* () {
    for (const session of discoveryState.sessions) yield session;
  }),
}));

vi.mock("../src/lib/sessionIndex.js", () => ({
  SESSION_INDEX_PATH: "/tmp/session-index.json",
  clearSessionIndex: vi.fn(() => false),
  findIndexedSessionCandidates: vi.fn(async (input: string) => (
    discoveryState.indexSessions.filter((session) => session.session_id === input || session.session_id.startsWith(input))
  )),
  findIndexedSessionById: vi.fn(async (input: string) => (
    discoveryState.indexSessions.find((session) => session.session_id === input || session.session_id.startsWith(input)) ?? null
  )),
  loadSessionIndex: vi.fn(() => null),
  loadSessionIndexWithNewFiles: vi.fn(async () => ({
    version: 1,
    built_at: "2026-01-01T00:00:00.000Z",
    session_count: discoveryState.indexSessions.length,
    project_count: 1,
    sessions: discoveryState.indexSessions,
  })),
  refreshIndexedSessionsById: vi.fn(async () => ({
    version: 1,
    built_at: "2026-01-01T00:00:00.000Z",
    session_count: discoveryState.indexSessions.length,
    project_count: 1,
    sessions: discoveryState.indexSessions,
  })),
  removeSessionFromIndex: vi.fn(() => false),
  rebuildSessionIndex: vi.fn(async () => ({
    version: 1,
    built_at: "2026-01-01T00:00:00.000Z",
    session_count: discoveryState.indexSessions.length,
    project_count: 1,
    sessions: discoveryState.indexSessions,
  })),
}));

let root = "";
let storePath = "";
let previousStoreEnv: string | undefined;

describe("session metadata commands", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "starling-session-"));
    storePath = join(root, "store.json");
    previousStoreEnv = process.env[ENV_CONFIG_KEY];
    process.env[ENV_CONFIG_KEY] = storePath;
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    discoveryState.sessions = [];
    discoveryState.indexSessions = [];
    writeStore([]);
  });

  afterEach(() => {
    if (previousStoreEnv === undefined) {
      delete process.env[ENV_CONFIG_KEY];
    } else {
      process.env[ENV_CONFIG_KEY] = previousStoreEnv;
    }
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  it("creates session metadata from a session id", async () => {
    const program = programWithSession();

    await program.parseAsync(["node", "starling", "session", "meta", "session-1", "-t", "Important", "--tags", "a,b"]);

    const store = readStore();
    expect(store.bookmarks).toHaveLength(1);
    expect(store.bookmarks[0]).toMatchObject({
      session_id: "session-1",
      title: "Important",
      tags: ["a", "b"],
      provider: "codex",
      project_path: "/work/test",
    });
  });

  it("updates existing session metadata", async () => {
    writeStore([
      {
        id: "starling_0001",
        provider: "codex",
        session_id: "session-1",
        title: "Old",
        category: "",
        tags: ["old"],
        project_path: "/work/test",
        first_prompt: "",
        notes: [],
        space_ids: [],
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      },
    ]);
    const program = programWithSession();

    await program.parseAsync(["node", "starling", "session", "meta", "session-1", "-t", "New", "--add-tags", "x,y"]);

    const store = readStore();
    expect(store.bookmarks).toHaveLength(1);
    expect(store.bookmarks[0]).toMatchObject({
      session_id: "session-1",
      title: "New",
      tags: ["old", "x", "y"],
    });
  });

  it("adds notes through session note", async () => {
    const program = programWithSession();

    await program.parseAsync(["node", "starling", "session", "note", "session-1", "remember", "this"]);

    const store = readStore();
    expect(store.bookmarks).toHaveLength(1);
    expect(store.bookmarks[0].notes).toHaveLength(1);
    expect(store.bookmarks[0].notes[0].content).toBe("remember this");
  });

  it("lists only sessions assigned to any catalog with --cataloged", async () => {
    discoveryState.sessions = [];
    discoveryState.indexSessions = [sessionMeta("session-1"), sessionMeta("session-2"), sessionMeta("session-3")];
    writeStore([
      bookmark("starling_0001", "session-1", ["cat_0001"]),
      bookmark("starling_0002", "session-2", []),
    ], [catalog("cat_0001", "target")]);
    const logs = captureLogs();
    const program = programWithSession();

    await program.parseAsync(["node", "starling", "session", "ls", "--cataloged", "--json"]);

    const output = JSON.parse(logs[0]) as Array<{ session_id: string }>;
    expect(output.map((session) => session.session_id)).toEqual(["session-1"]);
  });

  it("lists only sessions assigned to a specific catalog with --catalog", async () => {
    discoveryState.sessions = [];
    discoveryState.indexSessions = [sessionMeta("session-1"), sessionMeta("session-2"), sessionMeta("session-3")];
    writeStore([
      bookmark("starling_0001", "session-1", ["cat_0001"]),
      bookmark("starling_0002", "session-2", ["cat_0002"]),
    ], [catalog("cat_0001", "target"), catalog("cat_0002", "other")]);
    const logs = captureLogs();
    const program = programWithSession();

    await program.parseAsync(["node", "starling", "session", "ls", "--catalog", "target", "--json"]);

    const output = JSON.parse(logs[0]) as Array<{ session_id: string }>;
    expect(output.map((session) => session.session_id)).toEqual(["session-1"]);
  });

  it("adds a session to a catalog through session catalog add", async () => {
    writeStore([], [catalog("cat_0001", "target")]);
    const program = programWithSession();

    await program.parseAsync([
      "node",
      "starling",
      "session",
      "catalog",
      "add",
      "session-1",
      "target",
      "-t",
      "Custom title",
      "--tags",
      "x,y",
    ]);

    const store = readStore();
    expect(store.bookmarks).toHaveLength(1);
    expect(store.bookmarks[0]).toMatchObject({
      session_id: "session-1",
      title: "Custom title",
      tags: ["x", "y"],
      space_ids: ["cat_0001"],
    });
  });

  it("keeps ambiguous indexed session prefixes from mutating catalog metadata", async () => {
    discoveryState.indexSessions = [sessionMeta("abcdef120000"), sessionMeta("abcdef12ffff")];
    writeStore([], [catalog("cat_0001", "target")]);
    vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null | undefined) => {
      throw new Error(`exit ${code}`);
    }) as never);
    const program = programWithSession();

    await expect(program.parseAsync(["node", "starling", "session", "catalog", "add", "abcdef12", "target"])).rejects.toThrow("exit 1");

    expect(readStore().bookmarks).toHaveLength(0);
  });

  it("removes a session from one catalog through session catalog remove", async () => {
    writeStore(
      [bookmark("starling_0001", "session-1", ["cat_0001", "cat_0002"])],
      [catalog("cat_0001", "target"), catalog("cat_0002", "other")]
    );
    const program = programWithSession();

    await program.parseAsync(["node", "starling", "session", "catalog", "remove", "session-1", "target"]);

    const store = readStore();
    expect(store.bookmarks[0]).toMatchObject({
      session_id: "session-1",
      space_ids: ["cat_0002"],
    });
  });

  it("clears all catalogs from a session through session catalog clear", async () => {
    writeStore(
      [bookmark("starling_0001", "session-1", ["cat_0001", "cat_0002"])],
      [catalog("cat_0001", "target"), catalog("cat_0002", "other")]
    );
    const program = programWithSession();

    await program.parseAsync(["node", "starling", "session", "catalog", "clear", "session-1"]);

    const store = readStore();
    expect(store.bookmarks[0]).toMatchObject({
      session_id: "session-1",
      space_ids: [],
    });
  });

  it("removes only session metadata through session unpin", async () => {
    writeStore([bookmark("starling_0001", "session-1", ["cat_0001"])], [catalog("cat_0001", "target")]);
    const program = programWithSession();

    await program.parseAsync(["node", "starling", "session", "unpin", "session-1"]);

    const store = readStore();
    expect(store.bookmarks).toHaveLength(0);
  });

  it("deletes the session file and metadata through session delete", async () => {
    const filePath = join(root, "session-1.jsonl");
    writeFileSync(filePath, "{}\n");
    writeStore([bookmark("starling_0001", "session-1", ["cat_0001"])], [catalog("cat_0001", "target")]);
    const program = programWithSession();

    await program.parseAsync(["node", "starling", "session", "delete", "session-1", "--yes"]);

    const store = readStore();
    expect(store.bookmarks).toHaveLength(0);
    expect(existsSync(filePath)).toBe(false);
  });
});

function programWithSession(): Command {
  const program = new Command();
  program.exitOverride();
  registerSessionCommand(program);
  return program;
}

function captureLogs(): string[] {
  const logs: string[] = [];
  vi.mocked(console.log).mockImplementation((value?: unknown) => {
    logs.push(String(value));
  });
  return logs;
}

function writeStore(bookmarks: unknown[], spaces: unknown[] = []): void {
  writeFileSync(
    storePath,
    JSON.stringify({
      version: STORE_VERSION,
      bookmarks,
      spaces,
      categories: [],
    })
  );
}

function readStore(): {
  bookmarks: Array<{
    session_id: string;
    title: string;
    tags: string[];
    provider: string;
    project_path: string;
    notes: Array<{ content: string }>;
    space_ids: string[];
  }>;
} {
  return JSON.parse(readFileSync(storePath, "utf-8"));
}

function sessionMeta(id: string) {
  return {
    session_id: id,
    provider: "codex",
    model: "gpt-test",
    project_path: "/work/test",
    first_prompt: "hello from session",
    file_path: root ? join(root, `${id}.jsonl`) : `/sessions/${id}.jsonl`,
    created_at: "2026-01-01T00:00:00.000Z",
    modified_at: "2026-01-01T00:00:00.000Z",
  };
}

function bookmark(id: string, sessionId: string, spaceIds: string[]) {
  return {
    id,
    provider: "codex",
    session_id: sessionId,
    title: sessionId,
    category: "",
    tags: [],
    project_path: "/work/test",
    first_prompt: "",
    notes: [],
    space_ids: spaceIds,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

function catalog(id: string, name: string) {
  return {
    id,
    name,
    description: "",
    tags: [],
    parent_id: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}
