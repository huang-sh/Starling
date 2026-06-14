import { Command } from "commander";
import chalk from "chalk";
import { spawn, spawnSync } from "child_process";
import { existsSync, unlinkSync } from "fs";
import { findSessionCandidates, findSessions, looksLikeSessionIdQuery, streamSessions } from "../lib/discovery.js";
import { formatSessionTable } from "../lib/format.js";
import { addBookmark, listBookmarks, listSpaces, removeBookmark, updateBookmark } from "../lib/store.js";
import { generateBookmarkId, generateNoteId } from "../lib/id.js";
import { shortSessionId } from "../lib/sessionDisplay.js";
import { catalogPath, resolveCatalogReference } from "../lib/catalogResolver.js";
import {
  clearSessionIndex,
  findIndexedSessionCandidates,
  findIndexedSessionById,
  loadSessionIndex,
  refreshIndexedSessionsById,
  removeSessionFromIndex,
  rebuildSessionIndex,
  SESSION_INDEX_PATH,
} from "../lib/sessionIndex.js";
import type { Bookmark, SessionMeta } from "../types.js";

function formatSessionLine(s: SessionMeta): string {
  const agent = s.provider === "codex" ? "codex" : "claude";
  const shortId = shortSessionId(s.session_id);
  const shortProject = s.project_path
    ? s.project_path.length > 40
      ? "…" + s.project_path.slice(-39)
      : s.project_path
    : "-";
  const date = s.modified_at.slice(0, 16).replace("T", " ");
  const inputTokens = s.token_usage?.input_tokens ?? "-";
  const outputTokens = s.token_usage?.output_tokens ?? "-";
  const totalTokens = s.token_usage?.total_tokens ?? "-";
  const cacheTokens = s.token_usage?.cache_tokens ?? "-";
  return `${chalk.cyan(shortId.padEnd(15))}  ${chalk.gray(agent.padEnd(7))}  ${(s.model || "-").padEnd(18)}  ${shortProject.padEnd(42)}  ${chalk.gray(date)}  ${chalk.yellow(String(inputTokens)).padEnd(10)} ${chalk.yellow(String(outputTokens)).padEnd(10)} ${chalk.yellow(String(totalTokens)).padEnd(10)} ${chalk.yellow(String(cacheTokens)).padEnd(10)}`;
}

export function registerSessionCommand(program: Command): void {
  const session = new Command("session")
    .description("Discover and manage agent sessions");

  session
    .command("list")
    .alias("ls")
    .description("List recent agent sessions")
    .option("-n, --limit <number>", "max sessions to show", "20")
    .option("-a, --agent <agent>", "filter by agent: claude | codex")
    .option("--cataloged", "only show sessions assigned to any catalog")
    .option("-c, --catalog <catalog>", "only show sessions assigned to a catalog")
    .option("--all", "list all sessions (streaming with pager)")
    .option("--json", "output as JSON")
    .action(async (opts: { limit: string; agent?: string; cataloged?: boolean; catalog?: string; all?: boolean; json?: boolean }) => {
      const provider = opts.agent as "claude" | "codex" | undefined;
      const hasCatalogFilter = Boolean(opts.cataloged || opts.catalog);

      // All mode: stream + pager
      if (opts.all) {
        const filteredSessions = hasCatalogFilter
          ? await findCatalogSessions(opts.cataloged, opts.catalog, provider)
          : await collectStreamedSessions(provider);
        if (opts.json) {
          console.log(JSON.stringify(filteredSessions, null, 2));
          return;
        }

        const header = `${"SESSION".padEnd(15)}  ${"AGENT".padEnd(7)}  ${"MODEL".padEnd(18)}  ${"PROJECT".padEnd(42)}  MODIFIED  ${"INPUT".padEnd(10)} ${"OUTPUT".padEnd(10)} ${"TOTAL".padEnd(10)} ${"CACHE".padEnd(10)}\n${"─".repeat(145)}`;
        const usePager = process.stdout.isTTY;
        const pager = usePager ? spawn("less", ["-RFX"], { stdio: ["pipe", "inherit", "inherit"] }) : null;
        let pipeBroken = false;

        if (pager) {
          pager.stdin.on("error", () => { pipeBroken = true; });
          pager.on("close", () => { pipeBroken = true; });
        }
        const out = (line: string) => {
          if (pipeBroken) return;
          if (pager) {
            pager.stdin.write(line + "\n");
          } else {
            console.log(line);
          }
        };

        out(header);
        let count = 0;
        for (const meta of filteredSessions) {
          if (pipeBroken) break;
          out(formatSessionLine(meta));
          count++;
        }

        if (!pipeBroken) out(chalk.gray(`\nTotal: ${count} sessions`));

        if (pager && !pipeBroken) {
          pager.stdin.end();
          await new Promise<void>((resolve) => pager.on("close", () => resolve()));
        }
        return;
      }

      // Default mode: table with limit
      const limit = parseInt(opts.limit, 10) || 20;
      const sessions = hasCatalogFilter
        ? (await findCatalogSessions(opts.cataloged, opts.catalog, provider)).slice(0, limit)
        : await findSessions(limit, provider);
      if (sessions.length === 0) {
        console.log(chalk.yellow("No sessions found."));
        return;
      }
      if (opts.json) {
        console.log(JSON.stringify(sessions, null, 2));
        return;
      }
      console.log(formatSessionTable(sessions));
    });

  const index = new Command("index").description("Manage the local session index");

  index
    .command("status")
    .description("Show session index status")
    .option("--json", "output as JSON")
    .action((opts: { json?: boolean }) => {
      const current = loadSessionIndex();
      const payload = current
        ? {
          path: SESSION_INDEX_PATH,
          exists: true,
          built_at: current.built_at,
          session_count: current.session_count,
          project_count: current.project_count,
        }
        : {
          path: SESSION_INDEX_PATH,
          exists: false,
        };

      if (opts.json) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }

      if (!current) {
        console.log(chalk.yellow("No session index found."));
        console.log(chalk.gray(`  Path: ${SESSION_INDEX_PATH}`));
        return;
      }
      console.log(chalk.green("Session index"));
      console.log(`  Path:     ${SESSION_INDEX_PATH}`);
      console.log(`  Built:    ${current.built_at}`);
      console.log(`  Sessions: ${current.session_count}`);
      console.log(`  Projects: ${current.project_count}`);
    });

  index
    .command("rebuild")
    .description("Rebuild ~/.starling/session-index.json")
    .option("-a, --agent <agent>", "filter by agent: claude | codex")
    .option("--json", "output as JSON")
    .action(async (opts: { agent?: string; json?: boolean }) => {
      const provider = opts.agent as "claude" | "codex" | undefined;
      const rebuilt = await rebuildSessionIndex(provider);
      if (opts.json) {
        console.log(JSON.stringify({ path: SESSION_INDEX_PATH, ...rebuilt }, null, 2));
        return;
      }
      console.log(chalk.green("Rebuilt session index"));
      console.log(`  Path:     ${SESSION_INDEX_PATH}`);
      console.log(`  Sessions: ${rebuilt.session_count}`);
      console.log(`  Projects: ${rebuilt.project_count}`);
    });

  index
    .command("clear")
    .description("Remove ~/.starling/session-index.json")
    .action(() => {
      const removed = clearSessionIndex();
      console.log(removed ? chalk.green("Session index removed.") : chalk.yellow("No session index found."));
    });

  session.addCommand(index);

  session
    .command("show <session-id>")
    .description("Show session details")
    .option("--json", "output as JSON")
    .action(async (sessionId: string, opts: { json?: boolean }) => {
      const meta = await resolveSessionById(sessionId);
      if (!meta) {
        console.error(chalk.red(`Session not found: ${sessionId}`));
        process.exit(1);
      }
      const catalogs = findSessionCatalogs(meta.session_id);
      const metadata = findSessionBookmark(meta.session_id);
      if (opts.json) {
        console.log(JSON.stringify({ ...meta, catalogs, metadata: metadata ?? null }, null, 2));
        return;
      }
      console.log(chalk.bold.cyan(`Session: ${meta.session_id}`));
      console.log(`  Provider:    ${meta.provider}`);
      console.log(`  Model:       ${meta.model || "-"}`);
      console.log(`  Project:     ${meta.project_path || "-"}`);
      console.log(`  File:        ${meta.file_path}`);
      console.log(`  Modified:    ${meta.modified_at}`);
      console.log(`  Catalogs:    ${catalogs.length > 0 ? catalogs.map((catalog) => `${catalog.name} (${catalog.id})`).join(", ") : "-"}`);
      if (metadata) {
        console.log(`  Title:       ${metadata.title || "-"}`);
        console.log(`  Tags:        ${metadata.tags.join(", ") || "-"}`);
        if (metadata.notes.length > 0) {
          console.log("  Notes:");
          for (const note of metadata.notes) {
            console.log(`    ${note.id}: ${note.content}`);
          }
        }
      }
      const tokenUsage = meta.token_usage;
      if (tokenUsage) {
        console.log("  Token Usage:");
        console.log(`    Input:   ${tokenUsage.input_tokens ?? "-"}`);
        console.log(`    Output:  ${tokenUsage.output_tokens ?? "-"}`);
        console.log(`    Total:   ${tokenUsage.total_tokens ?? "-"}`);
        console.log(`    Cache:   ${tokenUsage.cache_tokens ?? "-"}`);
      }
      if (meta.first_prompt) {
        console.log(`  First Prompt:`);
        console.log(`    ${meta.first_prompt}`);
      }
    });

  session
    .command("resume <session-id>")
    .description("Resume an agent session")
    .action(async (sessionId: string) => {
      await resumeSession(sessionId);
    });

  session
    .command("meta <session-id>")
    .description("Create or update session metadata")
    .option("-t, --title <title>", "session title")
    .option("--tags <tags>", "comma-separated tags (replaces existing)")
    .option("--add-tags <tags>", "add tags (appends)")
    .action(async (sessionId: string, opts: {
      title?: string;
      tags?: string;
      addTags?: string;
    }) => {
      const meta = await resolveSessionMeta(sessionId);
      const bookmark = ensureSessionBookmark(meta);
      const patch: Partial<Bookmark> = {};
      if (opts.title !== undefined) patch.title = opts.title;
      if (opts.tags !== undefined) patch.tags = parseTags(opts.tags);
      if (opts.addTags !== undefined) {
        patch.tags = [...new Set([...bookmark.tags, ...parseTags(opts.addTags)])];
      }

      if (Object.keys(patch).length === 0) {
        console.log(chalk.yellow(`No metadata changes provided for ${bookmark.id}.`));
        return;
      }

      const updated = updateBookmark(bookmark.id, patch);
      console.log(chalk.green(`Updated session metadata: ${updated?.id ?? bookmark.id}`));
    });

  session
    .command("note <session-id> <content...>")
    .description("Add a note to a session")
    .action(async (sessionId: string, contentParts: string[]) => {
      const content = contentParts.join(" ").trim();
      if (!content) {
        console.error(chalk.red("Note content is required."));
        process.exit(1);
      }

      const meta = await resolveSessionMeta(sessionId);
      const bookmark = ensureSessionBookmark(meta);
      const note = { id: generateNoteId(), content, created_at: new Date().toISOString() };
      const notes = [...bookmark.notes, note];
      updateBookmark(bookmark.id, { notes });
      console.log(chalk.green(`Note added to ${bookmark.id}: ${note.id}`));
    });

  session
    .command("unpin <session-id>")
    .description("Remove Starling metadata for a session without deleting the session file")
    .action((sessionId: string) => {
      const bookmark = findSessionBookmark(sessionId);
      if (!bookmark) {
        console.log(chalk.yellow(`Session metadata not found: ${sessionId}`));
        return;
      }
      removeBookmark(bookmark.id);
      console.log(chalk.green(`Removed pin metadata for ${shortSessionId(bookmark.session_id)}`));
    });

  session
    .command("delete <session-id>")
    .description("Delete a session file and remove Starling metadata")
    .option("-y, --yes", "confirm deletion")
    .action(async (sessionId: string, opts: { yes?: boolean }) => {
      if (!opts.yes) {
        console.error(chalk.red("Deleting a session file requires --yes."));
        process.exit(1);
      }

      const meta = await resolveSessionMeta(sessionId);
      if (!meta.file_path) {
        console.error(chalk.red(`Session file path is unknown: ${meta.session_id}`));
        process.exit(1);
      }
      if (!existsSync(meta.file_path)) {
        console.error(chalk.red(`Session file not found: ${meta.file_path}`));
        process.exit(1);
      }

      unlinkSync(meta.file_path);
      const bookmark = findSessionBookmark(meta.session_id);
      if (bookmark) {
        removeBookmark(bookmark.id);
      }
      removeSessionFromIndex(meta.session_id);
      console.log(chalk.green(`Deleted session ${shortSessionId(meta.session_id)}`));
      console.log(chalk.gray(`  File: ${meta.file_path}`));
      if (bookmark) {
        console.log(chalk.gray(`  Removed pin: ${bookmark.id}`));
      }
    });

  const catalog = new Command("catalog").description("Manage session catalog assignments");

  catalog
    .command("add <session-id> <catalog>")
    .description("Add a session to a catalog")
    .option("-t, --title <title>", "pin title when creating a new pin")
    .option("--tags <tags>", "comma-separated tags when creating a new pin")
    .action(async (sessionId: string, catalog: string, opts: { title?: string; tags?: string }) => {
      const catalogEntry = resolveCatalog(catalog);
      const meta = await resolveSessionMeta(sessionId);
      const bookmark = ensureSessionBookmark(meta, {
        title: opts.title,
        tags: opts.tags ? parseTags(opts.tags) : undefined,
      });
      if (bookmark.space_ids.includes(catalogEntry.id)) {
        console.log(chalk.yellow(`Session already in catalog "${catalogEntry.name}".`));
        return;
      }
      updateBookmark(bookmark.id, { space_ids: [...bookmark.space_ids, catalogEntry.id] });
      console.log(chalk.green(`Added session ${shortSessionId(bookmark.session_id)} to catalog "${catalogEntry.name}"`));
    });

  catalog
    .command("remove <session-id> <catalog>")
    .alias("rm")
    .description("Remove a session from a catalog")
    .action((sessionId: string, catalog: string) => {
      const catalogEntry = resolveCatalog(catalog);
      const bookmark = findSessionBookmark(sessionId);
      if (!bookmark) {
        console.error(chalk.red(`Session metadata not found: ${sessionId}`));
        process.exit(1);
      }
      if (!bookmark.space_ids.includes(catalogEntry.id)) {
        console.log(chalk.yellow(`Session is not in catalog "${catalogEntry.name}".`));
        return;
      }
      updateBookmark(bookmark.id, {
        space_ids: bookmark.space_ids.filter((catalogId) => catalogId !== catalogEntry.id),
      });
      console.log(chalk.green(`Removed session ${shortSessionId(bookmark.session_id)} from catalog "${catalogEntry.name}"`));
    });

  catalog
    .command("clear <session-id>")
    .description("Remove a session from all catalogs")
    .action((sessionId: string) => {
      const bookmark = findSessionBookmark(sessionId);
      if (!bookmark) {
        console.error(chalk.red(`Session metadata not found: ${sessionId}`));
        process.exit(1);
      }
      updateBookmark(bookmark.id, { space_ids: [] });
      console.log(chalk.green(`Removed session ${shortSessionId(bookmark.session_id)} from all catalogs`));
    });

  session.addCommand(catalog);

  program.addCommand(session);
}

function findSessionCatalogs(sessionId: string): Array<{ id: string; name: string }> {
  const bookmark = findSessionBookmark(sessionId);
  if (!bookmark) return [];

  const spaces = listSpaces();
  return bookmark.space_ids.map((catalogId) => {
    const catalog = spaces.find((space) => space.id === catalogId);
    return {
      id: catalogId,
      name: catalog?.name ?? catalogId,
    };
  });
}

async function collectStreamedSessions(provider?: "claude" | "codex"): Promise<SessionMeta[]> {
  const sessions: SessionMeta[] = [];
  for await (const meta of streamSessions(provider)) {
    sessions.push(meta);
  }
  return sessions;
}

async function findCatalogSessions(
  cataloged?: boolean,
  catalogRef?: string,
  provider?: "claude" | "codex"
): Promise<SessionMeta[]> {
  const sessionIds = getCatalogSessionIds(cataloged, catalogRef);
  const wantedIds = new Set(sessionIds.map((sessionId) => sessionId.toLowerCase()));
  const index = await refreshIndexedSessionsById(sessionIds, provider);
  const sessions = index.sessions.filter((session) => {
    if (provider && session.provider !== provider) return false;
    return matchesCatalogSessionId(wantedIds, session.session_id);
  });

  sessions.sort((a, b) => b.modified_at.localeCompare(a.modified_at));
  return sessions;
}

function matchesCatalogSessionId(wantedIds: Set<string>, sessionId: string): boolean {
  const normalizedSessionId = sessionId.toLowerCase();
  if (wantedIds.has(normalizedSessionId)) return true;

  for (const wantedId of wantedIds) {
    if (wantedId && normalizedSessionId.startsWith(wantedId)) return true;
  }
  return false;
}

function getCatalogSessionIds(cataloged?: boolean, catalogRef?: string): string[] {
  const bookmarks = listBookmarks();

  if (catalogRef) {
    const catalog = resolveCatalog(catalogRef);
    return unique(
      bookmarks
        .filter((bookmark) => bookmark.space_ids.includes(catalog.id))
        .map((bookmark) => bookmark.session_id)
    );
  }

  if (cataloged) {
    return unique(
      bookmarks
        .filter((bookmark) => bookmark.space_ids.length > 0)
        .map((bookmark) => bookmark.session_id)
    );
  }

  return [];
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function findSessionBookmark(sessionId: string): Bookmark | undefined {
  return listBookmarks().find((entry) => entry.session_id === sessionId);
}

function resolveCatalog(catalogRef: string): { id: string; name: string } {
  const resolution = resolveCatalogReference(catalogRef);
  if (resolution.kind === "found") {
    return { id: resolution.space.id, name: resolution.space.name };
  }
  if (resolution.kind === "not_found") {
    console.error(chalk.red(`Catalog not found: ${catalogRef}`));
    process.exit(1);
  }
  console.error(chalk.red(`Ambiguous catalog reference: ${catalogRef}`));
  console.error(chalk.red("Use a catalog path like parent/child or the catalog id."));
  for (const match of resolution.matches) {
    console.error(chalk.gray(`  ${catalogPath(match, listSpaces())} (${match.id})`));
  }
  process.exit(1);
}

function parseTags(value: string): string[] {
  return value.split(",").map((tag) => tag.trim()).filter(Boolean);
}

async function resolveSessionMeta(input: string): Promise<SessionMeta> {
  const inputLooksLikeSessionId = looksLikeSessionIdQuery(input);
  if (inputLooksLikeSessionId) {
    const indexedCandidates = await findIndexedSessionCandidates(input);
    if (indexedCandidates.length > 0) return pickSessionCandidate(input, indexedCandidates);
    console.error(chalk.red(`No session matches: ${input}`));
    process.exit(1);
  }

  const candidates = await findSessionCandidates(input);
  if (candidates.length === 0) {
    console.error(chalk.red(`No session matches: ${input}`));
    process.exit(1);
  }
  return pickSessionCandidate(input, candidates);
}

async function resolveSessionById(input: string): Promise<SessionMeta | null> {
  if (!looksLikeSessionIdQuery(input)) return null;
  return findIndexedSessionById(input);
}

function pickSessionCandidate(input: string, candidates: SessionMeta[]): SessionMeta {
  if (candidates.length === 1) return candidates[0];
  const exact = candidates.find((candidate) => candidate.session_id === input);
  if (exact) return exact;
  console.error(chalk.red(`Ambiguous session id: ${input}`));
  console.error(chalk.red("Please rerun with full session id."));
  process.exit(1);
}

function ensureSessionBookmark(
  meta: SessionMeta,
  defaults: { title?: string; tags?: string[] } = {}
): Bookmark {
  const existing = findSessionBookmark(meta.session_id);
  if (existing) return existing;

  const now = new Date().toISOString();
  return addBookmark({
    id: generateBookmarkId(listBookmarks()),
    provider: meta.provider || "unknown",
    session_id: meta.session_id,
    title: defaults.title ?? meta.first_prompt?.slice(0, 60) ?? meta.session_id.slice(0, 16),
    category: "",
    tags: defaults.tags ?? [],
    project_path: meta.project_path ?? "",
    first_prompt: meta.first_prompt ?? "",
    notes: [],
    space_ids: [],
    created_at: now,
    updated_at: now,
  });
}

export async function resumeSession(sessionId: string): Promise<void> {
  const meta = await resolveSessionById(sessionId);
  if (!meta) {
    console.error(chalk.red(`Session not found: ${sessionId}`));
    process.exit(1);
  }

  const cwd = meta.project_path || undefined;

  if (meta.provider === "claude") {
    console.log(chalk.green(`Resuming claude session: ${shortSessionId(meta.session_id)}…`));
    if (cwd) console.log(chalk.gray(`  Project: ${cwd}`));
    const result = spawnSync("claude", ["--resume", meta.session_id], { stdio: "inherit", cwd });
    if (result.status !== 0) {
      process.exit(1);
    }
  } else if (meta.provider === "codex") {
    console.log(chalk.green(`Resuming codex session: ${shortSessionId(meta.session_id)}…`));
    if (cwd) console.log(chalk.gray(`  Project: ${cwd}`));
    const result = spawnSync("codex", ["resume", meta.session_id], { stdio: "inherit", cwd });
    if (result.status !== 0) {
      process.exit(1);
    }
  } else {
    console.error(chalk.red(`Unknown provider: ${meta.provider}`));
    process.exit(1);
  }
}
