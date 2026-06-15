#!/usr/bin/env node
import {
  DEFAULT_STORE_PATH,
  ENV_CONFIG_KEY,
  STORE_VERSION,
  atomicWriteJSON,
  readJSON
} from "./chunk-RWHPIOVN.js";

// src/lib/id.ts
function generateBookmarkId(bookmarks) {
  let max = 0;
  for (const b of bookmarks) {
    const num = parseInt(b.id.replace("starling_", ""), 10);
    if (!isNaN(num) && num > max) max = num;
  }
  return `starling_${String(max + 1).padStart(4, "0")}`;
}
function generateSpaceId(spaces) {
  let max = 0;
  for (const s of spaces) {
    const normalizedId = s.id.replace(/^cat_/, "").replace(/^space_/, "");
    const num = parseInt(normalizedId, 10);
    if (!isNaN(num) && num > max) max = num;
  }
  return `cat_${String(max + 1).padStart(4, "0")}`;
}
function generateNoteId() {
  return `note_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// src/lib/store.ts
function storePath() {
  const env = process.env[ENV_CONFIG_KEY];
  return env ?? DEFAULT_STORE_PATH;
}
function loadStore() {
  const path = storePath();
  const data = readJSON(path);
  if (!data) {
    const now = (/* @__PURE__ */ new Date()).toISOString();
    return {
      version: STORE_VERSION,
      bookmarks: [],
      spaces: [
        { id: "cat_0001", name: "claude", description: "Claude Code sessions", tags: [], parent_id: null, created_at: now, updated_at: now },
        { id: "cat_0002", name: "codex", description: "Codex sessions", tags: [], parent_id: null, created_at: now, updated_at: now }
      ],
      categories: []
    };
  }
  let migrated = false;
  const legacyIdMap = /* @__PURE__ */ new Map();
  const usedCatalogIds = new Set(data.spaces.map((space) => space.id).filter((id) => id.startsWith("cat_")));
  let nextId = 1;
  const nextCatalogId = () => {
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
        space.parent_id = legacyIdMap.get(space.parent_id);
      }
    }
  }
  if (!data.spaces.some((s) => s.name === "claude")) {
    const now = (/* @__PURE__ */ new Date()).toISOString();
    data.spaces.push({ id: generateSpaceId(data.spaces), name: "claude", description: "Claude Code sessions", tags: [], parent_id: null, created_at: now, updated_at: now });
    migrated = true;
  }
  if (!data.spaces.some((s) => s.name === "codex")) {
    const now = (/* @__PURE__ */ new Date()).toISOString();
    data.spaces.push({ id: generateSpaceId(data.spaces), name: "codex", description: "Codex sessions", tags: [], parent_id: null, created_at: now, updated_at: now });
    migrated = true;
  }
  if (migrated) {
    saveStore(data);
  }
  return data;
}
function saveStore(store) {
  atomicWriteJSON(storePath(), store);
}
function addBookmark(bookmark) {
  const store = loadStore();
  store.bookmarks.push(bookmark);
  if (bookmark.category && !store.categories.includes(bookmark.category)) {
    store.categories.push(bookmark.category);
  }
  saveStore(store);
  return bookmark;
}
function findBookmark(id) {
  return loadStore().bookmarks.find((b) => b.id === id || b.session_id === id);
}
function updateBookmark(id, patch) {
  const store = loadStore();
  const idx = store.bookmarks.findIndex((b) => b.id === id || b.session_id === id);
  if (idx === -1) return null;
  store.bookmarks[idx] = { ...store.bookmarks[idx], ...patch, updated_at: (/* @__PURE__ */ new Date()).toISOString() };
  if (patch.category && !store.categories.includes(patch.category)) {
    store.categories.push(patch.category);
  }
  saveStore(store);
  return store.bookmarks[idx];
}
function removeBookmark(id) {
  const store = loadStore();
  const idx = store.bookmarks.findIndex((b) => b.id === id || b.session_id === id);
  if (idx === -1) return false;
  store.bookmarks.splice(idx, 1);
  saveStore(store);
  return true;
}
function listBookmarks(filter) {
  const store = loadStore();
  let result = store.bookmarks;
  if (filter?.category) {
    result = result.filter((b) => b.category === filter.category);
  }
  if (filter?.tag) {
    result = result.filter((b) => b.tags.includes(filter.tag));
  }
  return result;
}
function addSpace(space) {
  const store = loadStore();
  store.spaces.push(space);
  saveStore(store);
  return space;
}
function findSpaceCandidates(idNameOrPath) {
  const store = loadStore();
  const exactId = store.spaces.find((space) => space.id === idNameOrPath);
  if (exactId) return [exactId];
  if (idNameOrPath.includes("/")) {
    return findSpacePathCandidates(idNameOrPath, store.spaces);
  }
  return store.spaces.filter((space) => space.name === idNameOrPath);
}
function findSpacePathCandidates(pathRef, spaces) {
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
function hasSiblingSpaceName(name, parentId, excludeId) {
  return loadStore().spaces.some(
    (space) => space.name === name && space.parent_id === parentId && space.id !== excludeId
  );
}
function updateSpace(id, patch) {
  const store = loadStore();
  const idx = store.spaces.findIndex((s) => s.id === id || s.name === id);
  if (idx === -1) return null;
  store.spaces[idx] = { ...store.spaces[idx], ...patch, updated_at: (/* @__PURE__ */ new Date()).toISOString() };
  saveStore(store);
  return store.spaces[idx];
}
function removeSpace(id) {
  const store = loadStore();
  const idx = store.spaces.findIndex((s) => s.id === id || s.name === id);
  if (idx === -1) return false;
  const space = store.spaces[idx];
  const idsToRemove = /* @__PURE__ */ new Set([space.id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const candidate of store.spaces) {
      if (candidate.parent_id && idsToRemove.has(candidate.parent_id) && !idsToRemove.has(candidate.id)) {
        idsToRemove.add(candidate.id);
        changed = true;
      }
    }
  }
  for (const b of store.bookmarks) {
    b.space_ids = b.space_ids.filter((sid) => !idsToRemove.has(sid));
  }
  store.spaces = store.spaces.filter((s) => !idsToRemove.has(s.id));
  saveStore(store);
  return true;
}
function listSpaces() {
  return loadStore().spaces;
}

// src/lib/catalogResolver.ts
function resolveCatalogReference(ref) {
  const matches = findSpaceCandidates(ref);
  if (matches.length === 1) {
    return { kind: "found", space: matches[0] };
  }
  if (matches.length === 0) {
    return { kind: "not_found" };
  }
  return { kind: "ambiguous", matches };
}
function catalogPath(space, spaces = listSpaces()) {
  const parts = [space.name];
  let current = space;
  const seen = /* @__PURE__ */ new Set();
  while (current.parent_id && !seen.has(current.parent_id)) {
    seen.add(current.parent_id);
    const parent = spaces.find((candidate) => candidate.id === current.parent_id);
    if (!parent) break;
    parts.unshift(parent.name);
    current = parent;
  }
  return parts.join("/");
}

export {
  generateBookmarkId,
  generateSpaceId,
  generateNoteId,
  addBookmark,
  findBookmark,
  updateBookmark,
  removeBookmark,
  listBookmarks,
  addSpace,
  hasSiblingSpaceName,
  updateSpace,
  removeSpace,
  listSpaces,
  resolveCatalogReference,
  catalogPath
};
