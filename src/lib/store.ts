import { DEFAULT_STORE_PATH, ENV_CONFIG_KEY, STORE_VERSION } from "../constants.js";
import type { Bookmark, Nest, Store } from "../types.js";
import { atomicWriteJSON, readJSON } from "../utils/fs.js";

export function storePath(): string {
  const env = process.env[ENV_CONFIG_KEY];
  return env ?? DEFAULT_STORE_PATH;
}

export function loadStore(): Store {
  const path = storePath();
  const data = readJSON<Store>(path);
  if (!data) {
    return { version: STORE_VERSION, bookmarks: [], nests: [], categories: [] };
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

// --- Nest CRUD ---

export function addNest(nest: Nest): Nest {
  const store = loadStore();
  store.nests.push(nest);
  saveStore(store);
  return nest;
}

export function findNest(idOrName: string): Nest | undefined {
  const store = loadStore();
  return store.nests.find((n) => n.id === idOrName || n.name === idOrName);
}

export function updateNest(id: string, patch: Partial<Nest>): Nest | null {
  const store = loadStore();
  const idx = store.nests.findIndex((n) => n.id === id || n.name === id);
  if (idx === -1) return null;
  store.nests[idx] = { ...store.nests[idx], ...patch, updated_at: new Date().toISOString() };
  saveStore(store);
  return store.nests[idx];
}

export function removeNest(id: string): boolean {
  const store = loadStore();
  const idx = store.nests.findIndex((n) => n.id === id || n.name === id);
  if (idx === -1) return false;
  // remove nest_id from bookmarks
  const nest = store.nests[idx];
  for (const b of store.bookmarks) {
    b.nest_ids = b.nest_ids.filter((nid) => nid !== nest.id);
  }
  // re-parent children
  for (const n of store.nests) {
    if (n.parent_id === nest.id) {
      n.parent_id = nest.parent_id;
    }
  }
  store.nests.splice(idx, 1);
  saveStore(store);
  return true;
}

export function listNests(): Nest[] {
  return loadStore().nests;
}
