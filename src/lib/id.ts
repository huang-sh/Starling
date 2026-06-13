import type { Bookmark, Space } from "../types.js";

export function generateBookmarkId(bookmarks: Bookmark[]): string {
  let max = 0;
  for (const b of bookmarks) {
    const num = parseInt(b.id.replace("starling_", ""), 10);
    if (!isNaN(num) && num > max) max = num;
  }
  return `starling_${String(max + 1).padStart(4, "0")}`;
}

export function generateSpaceId(spaces: Space[]): string {
  let max = 0;
  for (const s of spaces) {
    const normalizedId = s.id.replace(/^cat_/, "").replace(/^space_/, "");
    const num = parseInt(normalizedId, 10);
    if (!isNaN(num) && num > max) max = num;
  }
  return `cat_${String(max + 1).padStart(4, "0")}`;
}

export function generateNoteId(): string {
  return `note_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
