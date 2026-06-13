import type { Space } from "../types.js";
import { findSpaceCandidates, listSpaces } from "./store.js";

export type CatalogResolution =
  | { kind: "found"; space: Space }
  | { kind: "not_found" }
  | { kind: "ambiguous"; matches: Space[] };

export function resolveCatalogReference(ref: string): CatalogResolution {
  const matches = findSpaceCandidates(ref);
  if (matches.length === 1) {
    return { kind: "found", space: matches[0] };
  }
  if (matches.length === 0) {
    return { kind: "not_found" };
  }
  return { kind: "ambiguous", matches };
}

export function catalogPath(space: Space, spaces = listSpaces()): string {
  const parts = [space.name];
  let current = space;
  const seen = new Set<string>();
  while (current.parent_id && !seen.has(current.parent_id)) {
    seen.add(current.parent_id);
    const parent = spaces.find((candidate) => candidate.id === current.parent_id);
    if (!parent) break;
    parts.unshift(parent.name);
    current = parent;
  }
  return parts.join("/");
}
