import { DEFAULT_STORE_PATH, ENV_CONFIG_KEY, STORE_VERSION } from "../constants.js";
import type { Bookmark, Space, Store } from "../types.js";
import { atomicWriteJSON, readJSON } from "../utils/fs.js";
import { generateSpaceId } from "./id.js";

export function storePath(): string {
  const env = process.env[ENV_CONFIG_KEY];
  return env ?? DEFAULT_STORE_PATH;
}

export function loadStore(): Store {
  const path = storePath();
  const data = readJSON<Store>(path);
  if (!data) {
    const now = new Date().toISOString();
    return {
      version: STORE_VERSION,
      bookmarks: [],
      spaces: [
        { id: "cat_0001", name: "claude", description: "Claude Code sessions", tags: [], parent_id: null, created_at: now, updated_at: now },
        { id: "cat_0002", name: "codex", description: "Codex sessions", tags: [], parent_id: null, created_at: now, updated_at: now },
      ],
      categories: [],
    };
  }
  let migrated = false;
  const legacyIdMap = new Map<string, string>();
  const usedCatalogIds = new Set(data.spaces.map((space) => space.id).filter((id) => id.startsWith("cat_")));
  let nextId = 1;
  const nextCatalogId = (): string => {
    while (usedCatalogIds.has(`cat_${String(nextId).padStart(4, "0")}`)) {
      nextId += 1;
    }
    const id = `cat_${String(nextId).padStart(4, "0")}`;
    usedCatalogIds.add(id);
    nextId += 1;
    return id;
  };

  for (const space of data.spaces) {
    if (space.id.startsWith("space_")) {
      const newId = nextCatalogId();
      legacyIdMap.set(space.id, newId);
      space.id = newId;
      migrated = true;
    }
  }

  if (migrated) {
    for (const bookmark of data.bookmarks) {
      bookmark.space_ids = bookmark.space_ids.map((sid) => legacyIdMap.get(sid) ?? sid);
    }
    for (const space of data.spaces) {
      if (space.parent_id && legacyIdMap.has(space.parent_id)) {
        space.parent_id = legacyIdMap.get(space.parent_id)!;
      }
    }
  }

  // Ensure default spaces exist for existing stores
  if (!data.spaces.some((s) => s.name === "claude")) {
    const now = new Date().toISOString();
    data.spaces.push({ id: generateSpaceId(data.spaces), name: "claude", description: "Claude Code sessions", tags: [], parent_id: null, created_at: now, updated_at: now });
    migrated = true;
  }
  if (!data.spaces.some((s) => s.name === "codex")) {
    const now = new Date().toISOString();
    data.spaces.push({ id: generateSpaceId(data.spaces), name: "codex", description: "Codex sessions", tags: [], parent_id: null, created_at: now, updated_at: now });
    migrated = true;
  }
  if (migrated) {
    saveStore(data);
  }
  return data;
}

export function saveStore(store: Store): void {
  atomicWriteJSON(storePath(), store);
}

// --- Bookmark CRUD ---

export function addBookmark(bookmark: Bookmark): Bookmark {
  const store = loadStore();
  store.bookmarks.push(bookmark);
  if (bookmark.category && !store.categories.includes(bookmark.category)) {
    store.categories.push(bookmark.category);
  }
  saveStore(store);
  return bookmark;
}

export function findBookmark(id: string): Bookmark | undefined {
  return loadStore().bookmarks.find((b) => b.id === id || b.session_id === id);
}

export function updateBookmark(id: string, patch: Partial<Bookmark>): Bookmark | null {
  const store = loadStore();
  const idx = store.bookmarks.findIndex((b) => b.id === id || b.session_id === id);
  if (idx === -1) return null;
  store.bookmarks[idx] = { ...store.bookmarks[idx], ...patch, updated_at: new Date().toISOString() };
  if (patch.category && !store.categories.includes(patch.category)) {
    store.categories.push(patch.category);
  }
  saveStore(store);
  return store.bookmarks[idx];
}

export function removeBookmark(id: string): boolean {
  const store = loadStore();
  const idx = store.bookmarks.findIndex((b) => b.id === id || b.session_id === id);
  if (idx === -1) return false;
  store.bookmarks.splice(idx, 1);
  saveStore(store);
  return true;
}

export function listBookmarks(filter?: { category?: string; tag?: string }): Bookmark[] {
  const store = loadStore();
  let result = store.bookmarks;
  if (filter?.category) {
    result = result.filter((b) => b.category === filter.category);
  }
  if (filter?.tag) {
    result = result.filter((b) => b.tags.includes(filter.tag!));
  }
  return result;
}

export function searchBookmarks(query: string): Bookmark[] {
  const q = query.toLowerCase();
  const store = loadStore();
  return store.bookmarks.filter(
    (b) =>
      b.title.toLowerCase().includes(q) ||
      b.category.toLowerCase().includes(q) ||
      b.tags.some((t) => t.toLowerCase().includes(q)) ||
      b.first_prompt.toLowerCase().includes(q) ||
      b.notes.some((n) => n.content.toLowerCase().includes(q))
  );
}

// --- Space CRUD ---

export function addSpace(space: Space): Space {
  const store = loadStore();
  store.spaces.push(space);
  saveStore(store);
  return space;
}

export function findSpace(idOrName: string): Space | undefined {
  const matches = findSpaceCandidates(idOrName);
  return matches.length === 1 ? matches[0] : undefined;
}

export function findSpaceCandidates(idNameOrPath: string): Space[] {
  const store = loadStore();
  const exactId = store.spaces.find((space) => space.id === idNameOrPath);
  if (exactId) return [exactId];

  if (idNameOrPath.includes("/")) {
    return findSpacePathCandidates(idNameOrPath, store.spaces);
  }

  return store.spaces.filter((space) => space.name === idNameOrPath);
}

function findSpacePathCandidates(pathRef: string, spaces: Space[]): Space[] {
  const parts = pathRef.split("/").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return [];

  let candidates = spaces.filter((space) => space.name === parts[0] && space.parent_id === null);
  for (const part of parts.slice(1)) {
    const parentIds = new Set(candidates.map((space) => space.id));
    candidates = spaces.filter((space) => space.name === part && space.parent_id !== null && parentIds.has(space.parent_id));
    if (candidates.length === 0) return [];
  }

  return candidates;
}

export function hasSiblingSpaceName(name: string, parentId: string | null, excludeId?: string): boolean {
  return loadStore().spaces.some(
    (space) =>
      space.name === name &&
      space.parent_id === parentId &&
      space.id !== excludeId
  );
}

export function updateSpace(id: string, patch: Partial<Space>): Space | null {
  const store = loadStore();
  const idx = store.spaces.findIndex((s) => s.id === id || s.name === id);
  if (idx === -1) return null;
  store.spaces[idx] = { ...store.spaces[idx], ...patch, updated_at: new Date().toISOString() };
  saveStore(store);
  return store.spaces[idx];
}

export function removeSpace(id: string): boolean {
  const store = loadStore();
  const idx = store.spaces.findIndex((s) => s.id === id || s.name === id);
  if (idx === -1) return false;
  const space = store.spaces[idx];
  // remove space_id from bookmarks
  for (const b of store.bookmarks) {
    b.space_ids = b.space_ids.filter((sid) => sid !== space.id);
  }
  // re-parent children
  for (const s of store.spaces) {
    if (s.parent_id === space.id) {
      s.parent_id = space.parent_id;
    }
  }
  store.spaces.splice(idx, 1);
  saveStore(store);
  return true;
}

export function listSpaces(): Space[] {
  return loadStore().spaces;
}
