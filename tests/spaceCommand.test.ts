import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { registerSpaceCommand } from "../src/commands/space.js";
import { ENV_CONFIG_KEY, STORE_VERSION } from "../src/constants.js";

vi.mock("../src/lib/discovery.js", () => ({
  findSessionCandidates: vi.fn(async (input: string) => [
    {
      session_id: input,
      provider: "codex",
      model: "gpt-test",
      project_path: "/work/test",
      first_prompt: "hello from session",
      file_path: `/sessions/${input}.jsonl`,
      created_at: "2026-01-01T00:00:00.000Z",
      modified_at: "2026-01-01T00:00:00.000Z",
    },
  ]),
}));

let root = "";
let storePath = "";
let previousStoreEnv: string | undefined;

describe("catalog command", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "starling-catalog-"));
    storePath = join(root, "store.json");
    previousStoreEnv = process.env[ENV_CONFIG_KEY];
    process.env[ENV_CONFIG_KEY] = storePath;
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
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

  it("removes a catalog by name", async () => {
    writeFileSync(
      storePath,
      JSON.stringify({
        version: STORE_VERSION,
        bookmarks: [],
        spaces: [
          catalog("cat_0001", "claude"),
          catalog("cat_0002", "codex"),
          catalog("cat_0003", "scratch"),
        ],
        categories: [],
      })
    );

    const program = new Command();
    program.exitOverride();
    registerSpaceCommand(program);

    await program.parseAsync(["node", "starling", "catalog", "delete", "scratch"]);

    const store = JSON.parse(readFileSync(storePath, "utf-8")) as { spaces: Array<{ name: string }> };
    expect(store.spaces.map((space) => space.name)).toEqual(["claude", "codex"]);
  });

  it("removes a catalog with del alias", async () => {
    writeFileSync(
      storePath,
      JSON.stringify({
        version: STORE_VERSION,
        bookmarks: [],
        spaces: [
          catalog("cat_0001", "claude"),
          catalog("cat_0002", "codex"),
          catalog("cat_0003", "scratch"),
        ],
        categories: [],
      })
    );

    const program = new Command();
    program.exitOverride();
    registerSpaceCommand(program);

    await program.parseAsync(["node", "starling", "catalog", "del", "scratch"]);

    const store = JSON.parse(readFileSync(storePath, "utf-8")) as { spaces: Array<{ name: string }> };
    expect(store.spaces.map((space) => space.name)).toEqual(["claude", "codex"]);
  });

  it("deletes child catalogs when removing a parent catalog", async () => {
    writeFileSync(
      storePath,
      JSON.stringify({
        version: STORE_VERSION,
        bookmarks: [
          bookmark("pin_0001", "session-1", ["cat_0003", "cat_0005"]),
          bookmark("pin_0002", "session-2", ["cat_0004"]),
        ],
        spaces: [
          catalog("cat_0001", "claude"),
          catalog("cat_0002", "codex"),
          catalog("cat_0003", "parent"),
          catalog("cat_0004", "child", "cat_0003"),
          catalog("cat_0005", "sibling"),
          catalog("cat_0006", "grandchild", "cat_0004"),
        ],
        categories: [],
      })
    );

    const program = new Command();
    program.exitOverride();
    registerSpaceCommand(program);

    await program.parseAsync(["node", "starling", "catalog", "delete", "parent"]);

    const store = JSON.parse(readFileSync(storePath, "utf-8")) as {
      spaces: Array<{ id: string; name: string }>;
      bookmarks: Array<{ session_id: string; space_ids: string[] }>;
    };
    expect(store.spaces.map((space) => space.name)).toEqual(["claude", "codex", "sibling"]);
    expect(store.bookmarks).toEqual([
      expect.objectContaining({ session_id: "session-1", space_ids: ["cat_0005"] }),
      expect.objectContaining({ session_id: "session-2", space_ids: [] }),
    ]);
  });

  it("adds an existing session pin to a catalog", async () => {
    writeFileSync(
      storePath,
      JSON.stringify({
        version: STORE_VERSION,
        bookmarks: [
          {
            id: "pin_0001",
            provider: "codex",
            session_id: "session-1",
            title: "Existing",
            category: "",
            tags: [],
            project_path: "/work/test",
            first_prompt: "",
            notes: [],
            space_ids: [],
            created_at: "2026-01-01T00:00:00.000Z",
            updated_at: "2026-01-01T00:00:00.000Z",
          },
        ],
        spaces: [catalog("cat_0001", "target")],
        categories: [],
      })
    );

    const program = new Command();
    program.exitOverride();
    registerSpaceCommand(program);

    await program.parseAsync(["node", "starling", "catalog", "add", "target", "session-1"]);

    const store = JSON.parse(readFileSync(storePath, "utf-8")) as {
      bookmarks: Array<{ session_id: string; space_ids: string[] }>;
    };
    expect(store.bookmarks[0]).toMatchObject({ session_id: "session-1", space_ids: ["cat_0001"] });
  });

  it("creates a pin when adding an unpinned session to a catalog", async () => {
    writeFileSync(
      storePath,
      JSON.stringify({
        version: STORE_VERSION,
        bookmarks: [],
        spaces: [catalog("cat_0001", "target")],
        categories: [],
      })
    );

    const program = new Command();
    program.exitOverride();
    registerSpaceCommand(program);

    await program.parseAsync(["node", "starling", "catalog", "add", "target", "new-session"]);

    const store = JSON.parse(readFileSync(storePath, "utf-8")) as {
      bookmarks: Array<{ session_id: string; title: string; space_ids: string[] }>;
    };
    expect(store.bookmarks).toHaveLength(1);
    expect(store.bookmarks[0]).toMatchObject({
      session_id: "new-session",
      title: "hello from session",
      space_ids: ["cat_0001"],
    });
  });

  it("removes a session from a catalog without deleting the pin", async () => {
    writeFileSync(
      storePath,
      JSON.stringify({
        version: STORE_VERSION,
        bookmarks: [
          {
            id: "pin_0001",
            provider: "codex",
            session_id: "session-1",
            title: "Existing",
            category: "",
            tags: [],
            project_path: "/work/test",
            first_prompt: "",
            notes: [],
            space_ids: ["cat_0001", "cat_0002"],
            created_at: "2026-01-01T00:00:00.000Z",
            updated_at: "2026-01-01T00:00:00.000Z",
          },
        ],
        spaces: [catalog("cat_0001", "target"), catalog("cat_0002", "other")],
        categories: [],
      })
    );

    const program = new Command();
    program.exitOverride();
    registerSpaceCommand(program);

    await program.parseAsync(["node", "starling", "catalog", "detach", "target", "session-1"]);

    const store = JSON.parse(readFileSync(storePath, "utf-8")) as {
      bookmarks: Array<{ session_id: string; space_ids: string[] }>;
    };
    expect(store.bookmarks).toHaveLength(1);
    expect(store.bookmarks[0]).toMatchObject({ session_id: "session-1", space_ids: ["cat_0002"] });
  });

  it("clears all sessions from a catalog without deleting the catalog", async () => {
    writeFileSync(
      storePath,
      JSON.stringify({
        version: STORE_VERSION,
        bookmarks: [
          bookmark("pin_0001", "session-1", ["cat_0001", "cat_0002"]),
          bookmark("pin_0002", "session-2", ["cat_0001"]),
        ],
        spaces: [catalog("cat_0001", "target"), catalog("cat_0002", "other")],
        categories: [],
      })
    );

    const program = new Command();
    program.exitOverride();
    registerSpaceCommand(program);

    await program.parseAsync(["node", "starling", "catalog", "clear", "target"]);

    const store = JSON.parse(readFileSync(storePath, "utf-8")) as {
      spaces: Array<{ name: string }>;
      bookmarks: Array<{ session_id: string; space_ids: string[] }>;
    };
    expect(store.spaces.map((space) => space.name)).toEqual(expect.arrayContaining(["target", "other"]));
    expect(store.bookmarks).toEqual([
      expect.objectContaining({ session_id: "session-1", space_ids: ["cat_0002"] }),
      expect.objectContaining({ session_id: "session-2", space_ids: [] }),
    ]);
  });

  it("renames a catalog", async () => {
    writeFileSync(
      storePath,
      JSON.stringify({
        version: STORE_VERSION,
        bookmarks: [],
        spaces: [catalog("cat_0001", "old-name")],
        categories: [],
      })
    );

    const program = new Command();
    program.exitOverride();
    registerSpaceCommand(program);

    await program.parseAsync(["node", "starling", "catalog", "rename", "old-name", "new-name"]);

    const store = JSON.parse(readFileSync(storePath, "utf-8")) as {
      spaces: Array<{ id: string; name: string }>;
    };
    expect(store.spaces).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "cat_0001", name: "new-name" }),
    ]));
  });

  it("rejects renaming a catalog to an existing sibling name", async () => {
    writeFileSync(
      storePath,
      JSON.stringify({
        version: STORE_VERSION,
        bookmarks: [],
        spaces: [
          catalog("cat_0001", "parent"),
          catalog("cat_0002", "source", "cat_0001"),
          catalog("cat_0003", "target", "cat_0001"),
        ],
        categories: [],
      })
    );

    const program = new Command();
    program.exitOverride();
    registerSpaceCommand(program);

    await expect(
      program.parseAsync(["node", "starling", "catalog", "rename", "parent/source", "target"])
    ).rejects.toThrow();
  });

  it("allows duplicate catalog names under different parents", async () => {
    writeFileSync(
      storePath,
      JSON.stringify({
        version: STORE_VERSION,
        bookmarks: [],
        spaces: [
          catalog("cat_0001", "parent-a"),
          catalog("cat_0002", "parent-b"),
        ],
        categories: [],
      })
    );

    const program = new Command();
    program.exitOverride();
    registerSpaceCommand(program);

    await program.parseAsync(["node", "starling", "catalog", "create", "child", "--parent", "parent-a"]);
    await program.parseAsync(["node", "starling", "catalog", "create", "child", "--parent", "parent-b"]);

    const store = JSON.parse(readFileSync(storePath, "utf-8")) as {
      spaces: Array<{ name: string; parent_id: string | null }>;
    };
    const children = store.spaces.filter((space) => space.name === "child");
    expect(children).toHaveLength(2);
    expect(children.map((space) => space.parent_id).sort()).toEqual(["cat_0001", "cat_0002"]);
  });

  it("rejects duplicate catalog names under the same parent", async () => {
    writeFileSync(
      storePath,
      JSON.stringify({
        version: STORE_VERSION,
        bookmarks: [],
        spaces: [
          catalog("cat_0001", "parent"),
          catalog("cat_0002", "child", "cat_0001"),
        ],
        categories: [],
      })
    );

    const program = new Command();
    program.exitOverride();
    registerSpaceCommand(program);

    await expect(
      program.parseAsync(["node", "starling", "catalog", "create", "child", "--parent", "parent"])
    ).rejects.toThrow();
  });

  it("requires a path or id when a catalog name is ambiguous", async () => {
    writeFileSync(
      storePath,
      JSON.stringify({
        version: STORE_VERSION,
        bookmarks: [],
        spaces: [
          catalog("cat_0001", "parent-a"),
          catalog("cat_0002", "parent-b"),
          catalog("cat_0003", "child", "cat_0001"),
          catalog("cat_0004", "child", "cat_0002"),
        ],
        categories: [],
      })
    );

    const program = new Command();
    program.exitOverride();
    registerSpaceCommand(program);

    await expect(program.parseAsync(["node", "starling", "catalog", "show", "child"])).rejects.toThrow();
  });

  it("resolves duplicate catalog names by catalog path", async () => {
    writeFileSync(
      storePath,
      JSON.stringify({
        version: STORE_VERSION,
        bookmarks: [
          {
            id: "pin_0001",
            provider: "codex",
            session_id: "session-1",
            title: "Existing",
            category: "",
            tags: [],
            project_path: "/work/test",
            first_prompt: "",
            notes: [],
            space_ids: [],
            created_at: "2026-01-01T00:00:00.000Z",
            updated_at: "2026-01-01T00:00:00.000Z",
          },
        ],
        spaces: [
          catalog("cat_0001", "parent-a"),
          catalog("cat_0002", "parent-b"),
          catalog("cat_0003", "child", "cat_0001"),
          catalog("cat_0004", "child", "cat_0002"),
        ],
        categories: [],
      })
    );

    const program = new Command();
    program.exitOverride();
    registerSpaceCommand(program);

    await program.parseAsync(["node", "starling", "catalog", "add", "parent-b/child", "session-1"]);

    const store = JSON.parse(readFileSync(storePath, "utf-8")) as {
      bookmarks: Array<{ session_id: string; space_ids: string[] }>;
    };
    expect(store.bookmarks[0]).toMatchObject({ session_id: "session-1", space_ids: ["cat_0004"] });
  });

  it("creates nested catalog paths", async () => {
    writeFileSync(
      storePath,
      JSON.stringify({
        version: STORE_VERSION,
        bookmarks: [],
        spaces: [],
        categories: [],
      })
    );

    const program = new Command();
    program.exitOverride();
    registerSpaceCommand(program);

    await program.parseAsync(["node", "starling", "catalog", "create", "A/B/C"]);

    const store = JSON.parse(readFileSync(storePath, "utf-8")) as {
      spaces: Array<{ id: string; name: string; parent_id: string | null }>;
    };
    const a = store.spaces.find((space) => space.name === "A");
    const b = store.spaces.find((space) => space.name === "B");
    const c = store.spaces.find((space) => space.name === "C");
    expect(a).toMatchObject({ parent_id: null });
    expect(b).toMatchObject({ parent_id: a?.id });
    expect(c).toMatchObject({ parent_id: b?.id });
  });

  it("creates a nested catalog path under -p parent and reuses existing path nodes", async () => {
    writeFileSync(
      storePath,
      JSON.stringify({
        version: STORE_VERSION,
        bookmarks: [],
        spaces: [
          catalog("cat_0001", "root"),
          catalog("cat_0002", "A", "cat_0001"),
        ],
        categories: [],
      })
    );

    const program = new Command();
    program.exitOverride();
    registerSpaceCommand(program);

    await program.parseAsync(["node", "starling", "catalog", "create", "A/B/C", "-p", "root"]);

    const store = JSON.parse(readFileSync(storePath, "utf-8")) as {
      spaces: Array<{ id: string; name: string; parent_id: string | null }>;
    };
    expect(store.spaces.filter((space) => space.name === "A")).toHaveLength(1);
    const b = store.spaces.find((space) => space.name === "B");
    const c = store.spaces.find((space) => space.name === "C");
    expect(b).toMatchObject({ parent_id: "cat_0002" });
    expect(c).toMatchObject({ parent_id: b?.id });
  });
});

function catalog(id: string, name: string, parentId: string | null = null) {
  return {
    id,
    name,
    description: "",
    tags: [],
    parent_id: parentId,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
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
