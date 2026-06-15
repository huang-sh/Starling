#!/usr/bin/env node
import {
  formatSpaceTree
} from "./chunk-NL2IKBJO.js";
import {
  shortSessionId
} from "./chunk-N3NDNKER.js";
import {
  addBookmark,
  addSpace,
  catalogPath,
  generateBookmarkId,
  generateSpaceId,
  hasSiblingSpaceName,
  listBookmarks,
  listSpaces,
  removeSpace,
  resolveCatalogReference,
  updateBookmark,
  updateSpace
} from "./chunk-L7RS3LU7.js";
import {
  findSessionCandidates
} from "./chunk-FBJPGCDT.js";
import "./chunk-RWHPIOVN.js";

// src/commands/space.ts
import { Command } from "commander";
import chalk from "chalk";
import Table from "cli-table3";
function registerSpaceCommand(program) {
  const space = new Command("catalog").alias("cat").description("Organize sessions into catalogs with hierarchical nesting");
  space.command("create <name>").description("Create a new catalog").option("-d, --description <desc>", "catalog description").option("--tags <tags>", "comma-separated tags").option("-p, --parent <parent>", "parent catalog name, path, or id").action((name, opts) => {
    let parentId = null;
    if (opts.parent) {
      const parent = resolveCatalogRef(opts.parent);
      parentId = parent.id;
    }
    const isPathCreate = name.split("/").map((part) => part.trim()).filter(Boolean).length > 1;
    const created = createCatalogPath(name, parentId, {
      description: opts.description,
      tags: opts.tags ? opts.tags.split(",").map((t) => t.trim()).filter(Boolean) : [],
      allowExistingLeaf: isPathCreate
    });
    console.log(chalk.green(`Created catalog: ${created.id} "${catalogPath(created)}"`));
    console.log(chalk.gray(`  Parent: ${created.parent_id ?? "-"}`));
  });
  space.command("list").alias("ls").description("List all catalogs (flat)").option("--pins", "show pins in each catalog").option("--json", "output as JSON").action((opts) => {
    const spaces = listSpaces();
    if (spaces.length === 0) {
      console.log(chalk.yellow("No catalogs created yet."));
      return;
    }
    const allBookmarks = listBookmarks();
    const rows = spaces.map((s) => {
      const pins = allBookmarks.filter((b) => b.space_ids.includes(s.id));
      const sessionCount = new Set(pins.map((b) => b.session_id)).size;
      const parentCatalog = s.parent_id ? spaces.find((candidate) => candidate.id === s.parent_id) : void 0;
      const parent = parentCatalog ? parentCatalog.name : s.parent_id ?? "-";
      return {
        space: s,
        id: s.id,
        name: s.name,
        sessions: sessionCount,
        pins: pins.length,
        parent,
        description: s.description || "-"
      };
    });
    if (opts.json) {
      const output = rows.map((row) => {
        if (opts.pins) {
          const pins = allBookmarks.filter((b) => b.space_ids.includes(row.id));
          return { ...row.space, session_count: row.sessions, pin_count: row.pins, pins };
        }
        return { ...row.space, session_count: row.sessions, pin_count: row.pins };
      });
      console.log(JSON.stringify(output, null, 2));
      return;
    }
    const table = new Table({
      head: [
        chalk.green("Catalog ID"),
        chalk.green("Name"),
        chalk.green("Sessions"),
        chalk.green("Pins"),
        chalk.green("Parent"),
        chalk.green("Description")
      ],
      colWidths: [12, 20, 10, 10, 20, 34],
      style: { head: [] }
    });
    const truncate = (value, max) => value.length > max ? value.slice(0, max - 1) + "\u2026" : value;
    for (const row of rows) {
      table.push([
        row.id,
        chalk.bold(row.name),
        String(row.sessions),
        String(row.pins),
        row.parent,
        truncate(row.description, 34)
      ]);
    }
    console.log(table.toString());
    if (opts.pins) {
      for (const row of rows) {
        const pins = allBookmarks.filter((b) => b.space_ids.includes(row.id));
        if (pins.length === 0) continue;
        console.log(`
${chalk.yellow(`Pins in ${row.name} (${row.id})`)}`);
        for (const p of pins) {
          const shortId = p.session_id.length > 13 ? shortSessionId(p.session_id) + "\u2026" : p.session_id;
          console.log(`  ${chalk.cyan(p.id)}  ${p.title}  ${chalk.gray(shortId)}  ${chalk.gray(p.provider)}`);
        }
      }
    }
  });
  space.command("tree").description("Display catalogs as a hierarchical tree").option("--sessions", "show sessions assigned to each catalog").action((opts) => {
    const spaces = listSpaces();
    const bookmarks = opts.sessions ? listBookmarks() : [];
    console.log(formatSpaceTree(spaces, bookmarks));
  });
  space.command("add <catalog> <session-id>").description("Add a session to a catalog").option("-t, --title <title>", "pin title when creating a new pin").option("--tags <tags>", "comma-separated tags when creating a new pin").action(async (catalog, sessionId, opts) => {
    const s = resolveCatalogRef(catalog);
    const existing = findBookmarkBySessionRef(sessionId);
    if (existing) {
      if (existing.space_ids.includes(s.id)) {
        console.log(chalk.yellow(`Already in catalog "${s.name}".`));
        return;
      }
      updateBookmark(existing.id, { space_ids: [...existing.space_ids, s.id] });
      console.log(chalk.green(`Added ${existing.id} to catalog "${s.name}" (${s.id})`));
      return;
    }
    const meta = await resolveSessionMeta(sessionId);
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const bookmark = {
      id: generateBookmarkId(listBookmarks()),
      provider: meta.provider || "unknown",
      session_id: meta.session_id,
      title: opts.title ?? meta.first_prompt?.slice(0, 60) ?? meta.session_id.slice(0, 16),
      category: "",
      tags: opts.tags ? opts.tags.split(",").map((t) => t.trim()).filter(Boolean) : [],
      project_path: meta.project_path ?? "",
      first_prompt: meta.first_prompt ?? "",
      notes: [],
      space_ids: [s.id],
      created_at: now,
      updated_at: now
    };
    addBookmark(bookmark);
    console.log(chalk.green(`Added ${bookmark.id} to catalog "${s.name}" (${s.id})`));
  });
  space.command("show <name>").description("Show catalog details and contents").action((name) => {
    const s = resolveCatalogRef(name);
    const pins = listBookmarks().filter((b) => b.space_ids.includes(s.id));
    const sessions = new Set(pins.map((b) => b.session_id)).size;
    const updated = s.updated_at.slice(0, 10);
    console.log(chalk.bold(`Catalog: ${s.name}`));
    console.log(`Description: ${s.description || "(none)"}`);
    console.log(`Pins: ${pins.length}`);
    console.log(`Sessions: ${sessions}`);
    console.log(`Tags: ${s.tags.join(", ") || "(none)"}`);
    console.log(`Updated: ${updated}`);
    if (pins.length > 0) {
      console.log("");
      for (const p of pins) {
        const shortId = p.session_id.length > 36 ? shortSessionId(p.session_id) + "\u2026" : p.session_id;
        console.log(`  ${chalk.cyan(p.id)}  ${p.title}  ${chalk.gray(shortId)}  ${chalk.gray(p.provider)}`);
      }
    }
  });
  space.command("detach <catalog> <session-id>").description("Detach a session from a catalog").action((catalog, sessionId) => {
    const s = resolveCatalogRef(catalog);
    const bookmark = findBookmarkBySessionRef(sessionId);
    if (!bookmark) {
      console.error(chalk.red(`Session pin not found: ${sessionId}`));
      process.exit(1);
    }
    if (!bookmark.space_ids.includes(s.id)) {
      console.log(chalk.yellow(`Session is not in catalog "${s.name}".`));
      return;
    }
    const spaceIds = bookmark.space_ids.filter((sid) => sid !== s.id);
    updateBookmark(bookmark.id, { space_ids: spaceIds });
    console.log(chalk.green(`Removed "${bookmark.title}" from catalog "${s.name}"`));
  });
  space.command("clear <catalog>").description("Remove all sessions from a catalog").action((catalog) => {
    const s = resolveCatalogRef(catalog);
    for (const bookmark of listBookmarks()) {
      if (!bookmark.space_ids.includes(s.id)) continue;
      updateBookmark(bookmark.id, {
        space_ids: bookmark.space_ids.filter((sid) => sid !== s.id)
      });
    }
    console.log(chalk.green(`Cleared catalog: "${s.name}" (${s.id})`));
  });
  space.command("delete <catalog>").alias("del").description("Remove a catalog").action((catalog) => {
    const s = resolveCatalogRef(catalog);
    removeSpace(s.id);
    console.log(chalk.green(`Removed catalog: "${s.name}" (${s.id})`));
  });
  space.command("tag <name> <tags...>").description("Add tags to a catalog").action((name, newTags) => {
    const s = resolveCatalogRef(name);
    const merged = [.../* @__PURE__ */ new Set([...s.tags, ...newTags])];
    updateSpace(s.id, { tags: merged });
    console.log(chalk.green(`Tagged "${s.name}": ${merged.join(", ")}`));
  });
  space.command("rename <catalog> <new-name>").description("Rename a catalog").action((catalog, newName) => {
    const updated = renameCatalog(catalog, newName);
    console.log(chalk.green(`Renamed catalog: "${updated.name}" (${updated.id})`));
  });
  space.command("move <catalog>").description("Move a catalog under another parent catalog").option("-p, --parent <parent>", "new parent catalog name, path, or id").option("--root", "move catalog to the root level").action((catalog, opts) => {
    const updated = moveCatalog(catalog, opts);
    console.log(chalk.green(`Moved catalog: "${updated.name}" (${updated.id})`));
    console.log(chalk.gray(`  Path: ${catalogPath(updated)}`));
  });
  space.command("edit <name>").description("Edit catalog metadata").option("-d, --description <desc>", "new description").option("--rename <new-name>", "rename the catalog").option("--parent <parent>", "set parent catalog").option("--root", "move catalog to the root level").action((name, opts) => {
    const s = resolveCatalogRef(name);
    const patch = {};
    if (opts.description) patch.description = opts.description;
    if (opts.rename) {
      const nextName2 = validateCatalogName(opts.rename);
      patch.name = nextName2;
    }
    if (opts.parent && opts.root) {
      console.error(chalk.red("Use either --parent or --root, not both."));
      process.exit(1);
    }
    if (opts.parent || opts.root) {
      patch.parent_id = resolveMoveParentId(s, opts);
    }
    const nextName = patch.name ?? s.name;
    const nextParentId = Object.prototype.hasOwnProperty.call(patch, "parent_id") ? patch.parent_id ?? null : s.parent_id;
    if (hasSiblingSpaceName(nextName, nextParentId, s.id)) {
      console.error(chalk.red(`Catalog already exists under this parent: ${nextName}`));
      process.exit(1);
    }
    const updated = updateSpace(s.id, patch);
    if (updated) {
      console.log(chalk.green(`Updated catalog: "${updated.name}" (${updated.id})`));
    }
  });
  program.addCommand(space);
}
function renameCatalog(catalog, newName) {
  const s = resolveCatalogRef(catalog);
  const trimmedName = validateCatalogName(newName);
  if (hasSiblingSpaceName(trimmedName, s.parent_id, s.id)) {
    console.error(chalk.red(`Catalog already exists under this parent: ${trimmedName}`));
    process.exit(1);
  }
  const updated = updateSpace(s.id, { name: trimmedName });
  if (!updated) {
    console.error(chalk.red(`Catalog not found: ${catalog}`));
    process.exit(1);
  }
  return updated;
}
function moveCatalog(catalog, opts) {
  const s = resolveCatalogRef(catalog);
  const parentId = resolveMoveParentId(s, opts);
  if (hasSiblingSpaceName(s.name, parentId, s.id)) {
    console.error(chalk.red(`Catalog already exists under this parent: ${s.name}`));
    process.exit(1);
  }
  const updated = updateSpace(s.id, { parent_id: parentId });
  if (!updated) {
    console.error(chalk.red(`Catalog not found: ${catalog}`));
    process.exit(1);
  }
  return updated;
}
function resolveMoveParentId(catalog, opts) {
  if (opts.parent && opts.root) {
    console.error(chalk.red("Use either --parent or --root, not both."));
    process.exit(1);
  }
  if (!opts.parent && !opts.root) {
    console.error(chalk.red("Specify --parent <catalog> or --root."));
    process.exit(1);
  }
  if (opts.root) {
    return null;
  }
  const parent = resolveCatalogRef(opts.parent);
  if (parent.id === catalog.id) {
    console.error(chalk.red("A catalog cannot be its own parent."));
    process.exit(1);
  }
  if (isDescendantCatalog(parent, catalog, listSpaces())) {
    console.error(chalk.red("A catalog cannot use its descendant as parent."));
    process.exit(1);
  }
  return parent.id;
}
function validateCatalogName(newName) {
  const trimmedName = newName.trim();
  if (!trimmedName) {
    console.error(chalk.red("Catalog name cannot be empty."));
    process.exit(1);
  }
  if (trimmedName.includes("/")) {
    console.error(chalk.red("Catalog rename expects a single catalog name, not a path."));
    process.exit(1);
  }
  return trimmedName;
}
function isDescendantCatalog(candidate, root, spaces) {
  let current = candidate;
  const seen = /* @__PURE__ */ new Set();
  while (current?.parent_id) {
    if (current.parent_id === root.id) return true;
    if (seen.has(current.parent_id)) return false;
    seen.add(current.parent_id);
    current = spaces.find((space) => space.id === current?.parent_id);
  }
  return false;
}
function createCatalogPath(pathRef, parentId, opts) {
  const parts = pathRef.split("/").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) {
    console.error(chalk.red("Catalog name cannot be empty."));
    process.exit(1);
  }
  let currentParentId = parentId;
  let currentSpace;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    const existing = findSiblingSpace(part, currentParentId);
    const isLeaf = index === parts.length - 1;
    if (existing) {
      if (isLeaf && !opts.allowExistingLeaf) {
        console.error(chalk.red(`Catalog already exists under this parent: ${part}`));
        process.exit(1);
      }
      currentSpace = existing;
      currentParentId = existing.id;
      continue;
    }
    const now = (/* @__PURE__ */ new Date()).toISOString();
    currentSpace = {
      id: generateSpaceId(listSpaces()),
      name: part,
      description: isLeaf ? opts.description ?? "" : "",
      tags: isLeaf ? opts.tags ?? [] : [],
      parent_id: currentParentId,
      created_at: now,
      updated_at: now
    };
    addSpace(currentSpace);
    currentParentId = currentSpace.id;
  }
  return currentSpace;
}
function findSiblingSpace(name, parentId) {
  return listSpaces().find((space) => space.name === name && space.parent_id === parentId);
}
function resolveCatalogRef(ref) {
  const resolution = resolveCatalogReference(ref);
  if (resolution.kind === "found") {
    return resolution.space;
  }
  if (resolution.kind === "not_found") {
    console.error(chalk.red(`Catalog not found: ${ref}`));
    process.exit(1);
  }
  console.error(chalk.red(`Ambiguous catalog reference: ${ref}`));
  console.error(chalk.red("Use a catalog path like parent/child or the catalog id."));
  for (const match of resolution.matches) {
    console.error(chalk.gray(`  ${catalogPath(match, listSpaces())} (${match.id})`));
  }
  process.exit(1);
}
function findBookmarkBySessionRef(ref) {
  return listBookmarks().find((bookmark) => bookmark.id === ref || bookmark.session_id === ref);
}
async function resolveSessionMeta(input) {
  const candidates = await findSessionCandidates(input);
  if (candidates.length === 0) {
    console.error(chalk.red(`No session matches: ${input}`));
    process.exit(1);
  }
  if (candidates.length > 1) {
    const exact = candidates.find((candidate) => candidate.session_id === input);
    if (exact) return exact;
    console.error(chalk.red(`Ambiguous session id: ${input}`));
    console.error(chalk.red("Please rerun with full session id."));
    process.exit(1);
  }
  return candidates[0];
}
export {
  registerSpaceCommand
};
