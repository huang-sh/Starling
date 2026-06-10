#!/usr/bin/env node

// src/index.ts
import { Command as Command4 } from "commander";

// src/commands/session.ts
import { Command } from "commander";
import chalk2 from "chalk";

// src/lib/discovery.ts
import { readdirSync, statSync } from "fs";
import { join as join2 } from "path";

// src/constants.ts
import { homedir } from "os";
import { join } from "path";
var DEFAULT_CONFIG_DIR = join(homedir(), ".config", "starling");
var DEFAULT_STORE_PATH = join(DEFAULT_CONFIG_DIR, "store.json");
var STORE_VERSION = 1;
var CLAUDE_SESSIONS_DIR = join(homedir(), ".claude", "projects");
var ENV_CONFIG_KEY = "STARLING_CONFIG";

// src/lib/session.ts
import { createReadStream } from "fs";
import { createInterface } from "readline";
async function parseJsonlHead(filePath, maxLines = 50) {
  const entries = [];
  const rl = createInterface({ input: createReadStream(filePath, "utf-8"), crlfDelay: Infinity });
  let count = 0;
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
    }
    count++;
    if (count >= maxLines) break;
  }
  return entries;
}
function extractClaudeSessionMeta(entries, filePath, modifiedAt) {
  let sessionId = "";
  let model = "";
  let projectPath = "";
  let firstPrompt = "";
  for (const entry of entries) {
    if (entry.sessionId && typeof entry.sessionId === "string" && !sessionId) {
      sessionId = entry.sessionId;
    }
    if (entry.session_id && typeof entry.session_id === "string" && !sessionId) {
      sessionId = entry.session_id;
    }
    if (entry.model && typeof entry.model === "string" && !model) {
      model = entry.model;
    }
    if (entry.cwd && typeof entry.cwd === "string" && !projectPath) {
      projectPath = entry.cwd;
    }
    if (entry.projectPath && typeof entry.projectPath === "string" && !projectPath) {
      projectPath = entry.projectPath;
    }
    if ((entry.type === "user" || entry.type === "human") && entry.message && typeof entry.message === "object") {
      const msg = entry.message;
      if (!firstPrompt && msg.content) {
        if (typeof msg.content === "string") {
          firstPrompt = msg.content;
        } else if (Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (typeof part === "object" && part !== null && "text" in part && typeof part.text === "string") {
              firstPrompt = part.text;
              break;
            }
          }
        }
      }
    }
  }
  if (!sessionId) {
    const parts = filePath.split("/");
    const filename = parts[parts.length - 1].replace(".jsonl", "");
    sessionId = filename;
  }
  const createdAt = modifiedAt;
  return {
    session_id: sessionId,
    provider: "claude",
    model,
    project_path: projectPath,
    first_prompt: firstPrompt.slice(0, 200),
    file_path: filePath,
    created_at: createdAt,
    modified_at: modifiedAt
  };
}

// src/lib/discovery.ts
function* walkJsonlFiles(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join2(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      yield* walkJsonlFiles(full);
    } else if (entry.endsWith(".jsonl")) {
      yield full;
    }
  }
}
async function findSessions(limit = 50) {
  const results = [];
  for (const filePath of walkJsonlFiles(CLAUDE_SESSIONS_DIR)) {
    try {
      const st = statSync(filePath);
      const modifiedAt = st.mtime.toISOString();
      const entries = await parseJsonlHead(filePath);
      const meta = extractClaudeSessionMeta(entries, filePath, modifiedAt);
      if (meta) {
        results.push(meta);
      }
    } catch {
    }
    if (results.length >= limit * 2) break;
  }
  results.sort((a, b) => b.modified_at.localeCompare(a.modified_at));
  return results.slice(0, limit);
}
async function findSessionById(sessionId) {
  for (const filePath of walkJsonlFiles(CLAUDE_SESSIONS_DIR)) {
    if (filePath.includes(sessionId)) {
      try {
        const st = statSync(filePath);
        const entries = await parseJsonlHead(filePath);
        return extractClaudeSessionMeta(entries, filePath, st.mtime.toISOString());
      } catch {
        continue;
      }
    }
  }
  return null;
}

// src/lib/format.ts
import chalk from "chalk";
import Table from "cli-table3";
function formatSessionTable(sessions) {
  const table = new Table({
    head: [chalk.cyan("Session ID"), chalk.cyan("Model"), chalk.cyan("Project"), chalk.cyan("Modified")],
    colWidths: [40, 25, 40, 22],
    style: { head: [] }
  });
  for (const s of sessions) {
    const shortId = s.session_id.length > 36 ? s.session_id.slice(0, 36) + "\u2026" : s.session_id;
    const shortProject = s.project_path ? s.project_path.length > 38 ? "\u2026" + s.project_path.slice(-37) : s.project_path : "-";
    const shortDate = s.modified_at.slice(0, 19).replace("T", " ");
    table.push([shortId, s.model || "-", shortProject, shortDate]);
  }
  return table.toString();
}
function formatBookmarkTable(bookmarks) {
  const table = new Table({
    head: [chalk.green("ID"), chalk.green("Title"), chalk.green("Category"), chalk.green("Tags"), chalk.green("Created")],
    colWidths: [16, 30, 15, 20, 22],
    style: { head: [] }
  });
  for (const b of bookmarks) {
    const title = b.title.length > 28 ? b.title.slice(0, 28) + "\u2026" : b.title;
    const tags = b.tags.join(", ") || "-";
    const date = b.created_at.slice(0, 19).replace("T", " ");
    table.push([b.id, title, b.category || "-", tags, date]);
  }
  return table.toString();
}
function formatBookmarkDetail(b) {
  const lines = [
    chalk.bold.green(`Bookmark: ${b.id}`),
    `  Title:       ${b.title}`,
    `  Provider:    ${b.provider}`,
    `  Session:     ${b.session_id}`,
    `  Category:    ${b.category || "(none)"}`,
    `  Tags:        ${b.tags.join(", ") || "(none)"}`,
    `  Project:     ${b.project_path}`,
    `  First Prompt:${b.first_prompt ? "\n" + wrapText(b.first_prompt, 60, "    ") : " (none)"}`,
    `  Created:     ${b.created_at}`,
    `  Updated:     ${b.updated_at}`
  ];
  if (b.nest_ids.length > 0) {
    lines.push(`  Nests:       ${b.nest_ids.join(", ")}`);
  }
  if (b.notes.length > 0) {
    lines.push(chalk.bold("  Notes:"));
    for (const n of b.notes) {
      lines.push(`    [${n.id}] ${wrapText(n.content, 56, "      ")}`);
      lines.push(chalk.gray(`      ${n.created_at}`));
    }
  }
  return lines.join("\n");
}
function formatNestTree(nests, bookmarks) {
  if (nests.length === 0) return chalk.yellow("No nests created yet.");
  const childrenMap = /* @__PURE__ */ new Map();
  for (const n of nests) {
    const parent = n.parent_id ?? null;
    if (!childrenMap.has(parent)) childrenMap.set(parent, []);
    childrenMap.get(parent).push(n);
  }
  const bookmarkByNest = /* @__PURE__ */ new Map();
  for (const b of bookmarks) {
    for (const nid of b.nest_ids) {
      if (!bookmarkByNest.has(nid)) bookmarkByNest.set(nid, []);
      bookmarkByNest.get(nid).push(b.title);
    }
  }
  function renderNode(nest, prefix, isLast) {
    const connector = isLast ? "\u2514\u2500\u2500 " : "\u251C\u2500\u2500 ";
    const lines2 = [];
    const tagStr = nest.tags.length > 0 ? chalk.gray(` [${nest.tags.join(", ")}]`) : "";
    lines2.push(`${prefix}${connector}${chalk.bold(nest.name)}${tagStr}`);
    const childPrefix = prefix + (isLast ? "    " : "\u2502   ");
    const bk = bookmarkByNest.get(nest.id) || [];
    for (let i = 0; i < bk.length; i++) {
      const bIsLast = i === bk.length - 1 && !childrenMap.has(nest.id);
      const bConn = bIsLast ? "\u2514\u2500\u2500 " : "\u251C\u2500\u2500 ";
      lines2.push(`${childPrefix}${bConn}${chalk.cyan(bk[i])}`);
    }
    const children = childrenMap.get(nest.id) || [];
    for (let i = 0; i < children.length; i++) {
      lines2.push(...renderNode(children[i], childPrefix, i === children.length - 1 && bk.length === 0));
    }
    return lines2;
  }
  const roots = childrenMap.get(null) || [];
  const lines = [chalk.bold("starling")];
  for (let i = 0; i < roots.length; i++) {
    lines.push(...renderNode(roots[i], "", i === roots.length - 1));
  }
  return lines.join("\n");
}
function wrapText(text, width, indent) {
  const words = text.split(" ");
  const lines = [];
  let current = "";
  for (const word of words) {
    if ((current + " " + word).trim().length > width) {
      lines.push(current.trim());
      current = indent + word;
    } else {
      current += " " + word;
    }
  }
  if (current.trim()) lines.push(current.trim());
  return lines.join("\n");
}

// src/commands/session.ts
function registerSessionCommand(program2) {
  const session = new Command("session").description("Discover and manage agent sessions");
  session.command("list").alias("ls").description("List recent agent sessions").option("-n, --limit <number>", "max sessions to show", "20").option("--json", "output as JSON").action(async (opts) => {
    const limit = parseInt(opts.limit, 10) || 20;
    const sessions = await findSessions(limit);
    if (sessions.length === 0) {
      console.log(chalk2.yellow("No sessions found."));
      return;
    }
    if (opts.json) {
      console.log(JSON.stringify(sessions, null, 2));
      return;
    }
    console.log(formatSessionTable(sessions));
  });
  session.command("show <session-id>").description("Show session details").option("--json", "output as JSON").action(async (sessionId, opts) => {
    const meta = await findSessionById(sessionId);
    if (!meta) {
      console.error(chalk2.red(`Session not found: ${sessionId}`));
      process.exit(1);
    }
    if (opts.json) {
      console.log(JSON.stringify(meta, null, 2));
      return;
    }
    console.log(chalk2.bold.cyan(`Session: ${meta.session_id}`));
    console.log(`  Provider:    ${meta.provider}`);
    console.log(`  Model:       ${meta.model || "-"}`);
    console.log(`  Project:     ${meta.project_path || "-"}`);
    console.log(`  File:        ${meta.file_path}`);
    console.log(`  Modified:    ${meta.modified_at}`);
    if (meta.first_prompt) {
      console.log(`  First Prompt:`);
      console.log(`    ${meta.first_prompt}`);
    }
  });
  session.command("resume <session-id>").description("Resume an agent session").action(async (sessionId) => {
    const meta = await findSessionById(sessionId);
    if (!meta) {
      console.error(chalk2.red(`Session not found: ${sessionId}`));
      process.exit(1);
    }
    console.log(chalk2.green(`Resuming session: ${sessionId}`));
    console.log(chalk2.gray(`Provider: ${meta.provider}`));
    console.log(chalk2.gray(`Project:  ${meta.project_path}`));
    const args = ["--resume", meta.session_id];
    if (meta.provider === "claude") {
      console.log(chalk2.cyan(`
Run: claude ${args.join(" ")}`));
      if (meta.project_path) {
        console.log(chalk2.gray(`  cd ${meta.project_path} && claude --resume ${meta.session_id}`));
      }
    }
  });
  program2.addCommand(session);
}

// src/commands/mark.ts
import { Command as Command2 } from "commander";
import chalk3 from "chalk";

// src/utils/fs.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, mkdtempSync, chmodSync } from "fs";
import { dirname, join as join3 } from "path";
function ensureDir(filePath) {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}
function atomicWriteJSON(filePath, data) {
  ensureDir(filePath);
  const dir = dirname(filePath);
  const tmpDir = join3(dir, ".starling-tmp");
  if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
  const prefix = join3(tmpDir, "starling-");
  const tmpPath = mkdtempSync(prefix) + "/tmp.json";
  try {
    writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
    chmodSync(tmpPath, 384);
    renameSync(tmpPath, filePath);
  } finally {
    if (existsSync(tmpPath)) {
      unlinkSync(tmpPath);
    }
  }
}
function readJSON(filePath) {
  if (!existsSync(filePath)) return null;
  const raw = readFileSync(filePath, "utf-8");
  return JSON.parse(raw);
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
    return { version: STORE_VERSION, bookmarks: [], nests: [], categories: [] };
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
function searchBookmarks(query) {
  const q = query.toLowerCase();
  const store = loadStore();
  return store.bookmarks.filter(
    (b) => b.title.toLowerCase().includes(q) || b.category.toLowerCase().includes(q) || b.tags.some((t) => t.toLowerCase().includes(q)) || b.first_prompt.toLowerCase().includes(q) || b.notes.some((n) => n.content.toLowerCase().includes(q))
  );
}
function addNest(nest) {
  const store = loadStore();
  store.nests.push(nest);
  saveStore(store);
  return nest;
}
function findNest(idOrName) {
  const store = loadStore();
  return store.nests.find((n) => n.id === idOrName || n.name === idOrName);
}
function updateNest(id, patch) {
  const store = loadStore();
  const idx = store.nests.findIndex((n) => n.id === id || n.name === id);
  if (idx === -1) return null;
  store.nests[idx] = { ...store.nests[idx], ...patch, updated_at: (/* @__PURE__ */ new Date()).toISOString() };
  saveStore(store);
  return store.nests[idx];
}
function removeNest(id) {
  const store = loadStore();
  const idx = store.nests.findIndex((n) => n.id === id || n.name === id);
  if (idx === -1) return false;
  const nest = store.nests[idx];
  for (const b of store.bookmarks) {
    b.nest_ids = b.nest_ids.filter((nid) => nid !== nest.id);
  }
  for (const n of store.nests) {
    if (n.parent_id === nest.id) {
      n.parent_id = nest.parent_id;
    }
  }
  store.nests.splice(idx, 1);
  saveStore(store);
  return true;
}
function listNests() {
  return loadStore().nests;
}

// src/lib/id.ts
function generateBookmarkId(bookmarks) {
  let max = 0;
  for (const b of bookmarks) {
    const num = parseInt(b.id.replace("starling_", ""), 10);
    if (!isNaN(num) && num > max) max = num;
  }
  return `starling_${String(max + 1).padStart(4, "0")}`;
}
function generateNestId(nests) {
  let max = 0;
  for (const n of nests) {
    const num = parseInt(n.id.replace("nest_", ""), 10);
    if (!isNaN(num) && num > max) max = num;
  }
  return `nest_${String(max + 1).padStart(4, "0")}`;
}
function generateNoteId() {
  return `note_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// src/commands/mark.ts
function registerMarkCommand(program2) {
  const mark = new Command2("mark").description("Bookmark and annotate agent sessions").argument("[session-id]", "session ID to bookmark, or omit to list all bookmarks").option("-t, --title <title>", "bookmark title").option("-c, --category <category>", "category").option("--tags <tags>", "comma-separated tags").option("--current", "bookmark the most recent session").action(async (sessionId, opts) => {
    if (!sessionId && !opts.current) {
      const bookmarks = listBookmarks();
      if (bookmarks.length === 0) {
        console.log(chalk3.yellow("No bookmarks found."));
        return;
      }
      console.log(formatBookmarkTable(bookmarks));
      return;
    }
    let targetSessionId = sessionId;
    if (opts.current && !targetSessionId) {
      const sessions = await findSessions(1);
      if (sessions.length === 0) {
        console.error(chalk3.red("No sessions found."));
        process.exit(1);
      }
      targetSessionId = sessions[0].session_id;
    }
    if (!targetSessionId) {
      console.error(chalk3.red("Please provide a session-id or use --current"));
      process.exit(1);
    }
    const existing = findBookmark(targetSessionId);
    if (existing) {
      console.log(chalk3.yellow(`Already bookmarked as: ${existing.id}`));
      return;
    }
    const meta = await findSessionById(targetSessionId);
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const bookmark = {
      id: generateBookmarkId(listBookmarks()),
      provider: meta?.provider ?? "unknown",
      session_id: targetSessionId,
      title: opts.title ?? meta?.first_prompt?.slice(0, 60) ?? targetSessionId.slice(0, 16),
      category: opts.category ?? "",
      tags: opts.tags ? opts.tags.split(",").map((t) => t.trim()) : [],
      project_path: meta?.project_path ?? "",
      first_prompt: meta?.first_prompt ?? "",
      notes: [],
      nest_ids: [],
      created_at: now,
      updated_at: now
    };
    addBookmark(bookmark);
    console.log(chalk3.green(`Bookmarked: ${bookmark.id}`));
    console.log(`  Title:    ${bookmark.title}`);
    console.log(`  Category: ${bookmark.category || "(none)"}`);
    console.log(`  Tags:     ${bookmark.tags.join(", ") || "(none)"}`);
  });
  mark.command("ls").description("List bookmarks with optional filters").option("-c, --category <category>", "filter by category").option("--tag <tag>", "filter by tag").option("--json", "output as JSON").action((opts) => {
    const bookmarks = listBookmarks({ category: opts.category, tag: opts.tag });
    if (bookmarks.length === 0) {
      console.log(chalk3.yellow("No bookmarks found."));
      return;
    }
    if (opts.json) {
      console.log(JSON.stringify(bookmarks, null, 2));
      return;
    }
    console.log(formatBookmarkTable(bookmarks));
  });
  mark.command("show <id>").description("Show bookmark details").action((id) => {
    const bookmark = findBookmark(id);
    if (!bookmark) {
      console.error(chalk3.red(`Bookmark not found: ${id}`));
      process.exit(1);
    }
    console.log(formatBookmarkDetail(bookmark));
  });
  mark.command("edit <id>").description("Edit bookmark metadata").option("-t, --title <title>", "new title").option("-c, --category <category>", "new category").option("--tags <tags>", "new comma-separated tags (replaces existing)").option("--add-tags <tags>", "add tags (appends)").action((id, opts) => {
    const patch = {};
    if (opts.title) patch.title = opts.title;
    if (opts.category) patch.category = opts.category;
    if (opts.tags) patch.tags = opts.tags.split(",").map((t) => t.trim());
    if (opts.addTags) {
      const existing = findBookmark(id);
      const currentTags = existing?.tags ?? [];
      const newTags = opts.addTags.split(",").map((t) => t.trim());
      patch.tags = [.../* @__PURE__ */ new Set([...currentTags, ...newTags])];
    }
    const updated = updateBookmark(id, patch);
    if (!updated) {
      console.error(chalk3.red(`Bookmark not found: ${id}`));
      process.exit(1);
    }
    console.log(chalk3.green(`Updated: ${updated.id}`));
  });
  mark.command("rm <id>").description("Remove a bookmark").action((id) => {
    if (!removeBookmark(id)) {
      console.error(chalk3.red(`Bookmark not found: ${id}`));
      process.exit(1);
    }
    console.log(chalk3.green(`Removed: ${id}`));
  });
  mark.command("search <query>").description("Search bookmarks").action((query) => {
    const results = searchBookmarks(query);
    if (results.length === 0) {
      console.log(chalk3.yellow(`No bookmarks matching: "${query}"`));
      return;
    }
    console.log(formatBookmarkTable(results));
  });
  mark.command("note <id> <content...>").description("Add a note to a bookmark").action((id, contentParts) => {
    const bookmark = findBookmark(id);
    if (!bookmark) {
      console.error(chalk3.red(`Bookmark not found: ${id}`));
      process.exit(1);
    }
    const content = contentParts.join(" ");
    const note = { id: generateNoteId(), content, created_at: (/* @__PURE__ */ new Date()).toISOString() };
    bookmark.notes.push(note);
    updateBookmark(id, { notes: bookmark.notes });
    console.log(chalk3.green(`Note added to ${id}: ${note.id}`));
  });
  program2.addCommand(mark);
}

// src/commands/nest.ts
import { Command as Command3 } from "commander";
import chalk4 from "chalk";
function registerNestCommand(program2) {
  const nest = new Command3("nest").description("Organize sessions into collections with hierarchical nesting");
  nest.command("create <name>").description("Create a new nest").option("-d, --description <desc>", "nest description").option("--tags <tags>", "comma-separated tags").option("--parent <parent>", "parent nest name or id").action((name, opts) => {
    if (findNest(name)) {
      console.error(chalk4.red(`Nest already exists: ${name}`));
      process.exit(1);
    }
    let parentId = null;
    if (opts.parent) {
      const parent = findNest(opts.parent);
      if (!parent) {
        console.error(chalk4.red(`Parent nest not found: ${opts.parent}`));
        process.exit(1);
      }
      parentId = parent.id;
    }
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const newNest = {
      id: generateNestId(listNests()),
      name,
      description: opts.description ?? "",
      tags: opts.tags ? opts.tags.split(",").map((t) => t.trim()) : [],
      parent_id: parentId,
      created_at: now,
      updated_at: now
    };
    addNest(newNest);
    console.log(chalk4.green(`Created nest: ${newNest.id} "${name}"`));
    if (parentId) {
      console.log(chalk4.gray(`  Parent: ${parentId}`));
    }
  });
  nest.command("list").alias("ls").description("List all nests (flat)").option("--json", "output as JSON").action((opts) => {
    const nests = listNests();
    if (nests.length === 0) {
      console.log(chalk4.yellow("No nests created yet."));
      return;
    }
    if (opts.json) {
      console.log(JSON.stringify(nests, null, 2));
      return;
    }
    for (const n of nests) {
      const tagStr = n.tags.length > 0 ? chalk4.gray(` [${n.tags.join(", ")}]`) : "";
      const parentStr = n.parent_id ? chalk4.gray(` \u2192 parent: ${n.parent_id}`) : "";
      console.log(`  ${chalk4.green(n.id)}  ${chalk4.bold(n.name)}${tagStr}${parentStr}`);
      if (n.description) {
        console.log(chalk4.gray(`    ${n.description}`));
      }
    }
  });
  nest.command("tree").description("Display nests as a hierarchical tree").action(() => {
    const nests = listNests();
    const bookmarks = listBookmarks();
    console.log(formatNestTree(nests, bookmarks));
  });
  nest.command("show <name>").description("Show nest details and contents").action((name) => {
    const n = findNest(name);
    if (!n) {
      console.error(chalk4.red(`Nest not found: ${name}`));
      process.exit(1);
    }
    console.log(chalk4.bold.green(`Nest: ${n.name} (${n.id})`));
    console.log(`  Description: ${n.description || "(none)"}`);
    console.log(`  Tags:        ${n.tags.join(", ") || "(none)"}`);
    console.log(`  Parent:      ${n.parent_id ?? "(root)"}`);
    console.log(`  Created:     ${n.created_at}`);
    const bookmarks = listBookmarks().filter((b) => b.nest_ids.includes(n.id));
    if (bookmarks.length > 0) {
      console.log(chalk4.bold("\n  Bookmarks:"));
      for (const b of bookmarks) {
        console.log(`    ${chalk4.cyan(b.id)}  ${b.title}`);
      }
    } else {
      console.log(chalk4.gray("\n  (no bookmarks)"));
    }
  });
  nest.command("add <nest-name> <bookmark-id>").description("Add a bookmark to a nest").action((nestName, bookmarkId) => {
    const n = findNest(nestName);
    if (!n) {
      console.error(chalk4.red(`Nest not found: ${nestName}`));
      process.exit(1);
    }
    const bookmark = listBookmarks().find(
      (b) => b.id === bookmarkId || b.session_id === bookmarkId
    );
    if (!bookmark) {
      console.error(chalk4.red(`Bookmark not found: ${bookmarkId}`));
      process.exit(1);
    }
    if (bookmark.nest_ids.includes(n.id)) {
      console.log(chalk4.yellow(`Already in nest "${n.name}".`));
      return;
    }
    bookmark.nest_ids.push(n.id);
    updateBookmark(bookmark.id, { nest_ids: bookmark.nest_ids });
    console.log(chalk4.green(`Added "${bookmark.title}" to nest "${n.name}"`));
  });
  nest.command("rm <name>").description("Remove a nest").option("--bookmark <bookmark-id>", "remove a specific bookmark from the nest").action((name, opts) => {
    const n = findNest(name);
    if (!n) {
      console.error(chalk4.red(`Nest not found: ${name}`));
      process.exit(1);
    }
    if (opts.bookmark) {
      const bookmark = listBookmarks().find(
        (b) => b.id === opts.bookmark || b.session_id === opts.bookmark
      );
      if (!bookmark) {
        console.error(chalk4.red(`Bookmark not found: ${opts.bookmark}`));
        process.exit(1);
      }
      bookmark.nest_ids = bookmark.nest_ids.filter((nid) => nid !== n.id);
      updateBookmark(bookmark.id, { nest_ids: bookmark.nest_ids });
      console.log(chalk4.green(`Removed "${bookmark.title}" from nest "${n.name}"`));
    } else {
      removeNest(n.id);
      console.log(chalk4.green(`Removed nest: "${n.name}" (${n.id})`));
    }
  });
  nest.command("tag <name> <tags...>").description("Add tags to a nest").action((name, newTags) => {
    const n = findNest(name);
    if (!n) {
      console.error(chalk4.red(`Nest not found: ${name}`));
      process.exit(1);
    }
    const merged = [.../* @__PURE__ */ new Set([...n.tags, ...newTags])];
    updateNest(n.id, { tags: merged });
    console.log(chalk4.green(`Tagged "${n.name}": ${merged.join(", ")}`));
  });
  nest.command("edit <name>").description("Edit nest metadata").option("-d, --description <desc>", "new description").option("--rename <new-name>", "rename the nest").option("--parent <parent>", "set parent nest").action((name, opts) => {
    const n = findNest(name);
    if (!n) {
      console.error(chalk4.red(`Nest not found: ${name}`));
      process.exit(1);
    }
    const patch = {};
    if (opts.description) patch.description = opts.description;
    if (opts.rename) patch.name = opts.rename;
    if (opts.parent) {
      const parent = findNest(opts.parent);
      if (!parent) {
        console.error(chalk4.red(`Parent nest not found: ${opts.parent}`));
        process.exit(1);
      }
      if (parent.id === n.id) {
        console.error(chalk4.red("A nest cannot be its own parent."));
        process.exit(1);
      }
      patch.parent_id = parent.id;
    }
    const updated = updateNest(n.id, patch);
    if (updated) {
      console.log(chalk4.green(`Updated nest: "${updated.name}" (${updated.id})`));
    }
  });
  program2.addCommand(nest);
}

// src/index.ts
var program = new Command4();
program.name("starling").description("Agent session manager \u2014 discover, bookmark, and organize AI coding sessions").version("0.1.0");
registerSessionCommand(program);
registerMarkCommand(program);
registerNestCommand(program);
program.parse();
