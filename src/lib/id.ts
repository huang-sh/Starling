import type { Bookmark, Nest } from "../types.js";

export function generateBookmarkId(bookmarks: Bookmark[]): string {
  let max = 0;
  for (const b of bookmarks) {
    const num = parseInt(b.id.replace("starling_", ""), 10);
    if (!isNaN(num) && num > max) max = num;
  }
  return `starling_${String(max + 1).padStart(4, "0")}`;
}

export function generateNestId(nests: Nest[]): string {
  let max = 0;
  for (const n of nests) {
    const num = parseInt(n.id.replace("nest_", ""), 10);
    if (!isNaN(num) && num > max) max = num;
  }
  return `nest_${String(max + 1).padStart(4, "0")}`;
}

export function generateNoteId(): string {
  return `note_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
