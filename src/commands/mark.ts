import { Command } from "commander";
import chalk from "chalk";
import {
  addBookmark,
  findBookmark,
  updateBookmark,
  removeBookmark,
  listBookmarks,
  searchBookmarks,
} from "../lib/store.js";
import { generateBookmarkId, generateNoteId } from "../lib/id.js";
import { findSessions, findSessionById } from "../lib/discovery.js";
import { formatBookmarkTable, formatBookmarkDetail } from "../lib/format.js";
import type { Bookmark } from "../types.js";

export function registerMarkCommand(program: Command): void {
  const mark = new Command("mark")
    .description("Bookmark and annotate agent sessions")
    .argument("[session-id]", "session ID to bookmark, or omit to list all bookmarks")
    .option("-t, --title <title>", "bookmark title")
    .option("-c, --category <category>", "category")
    .option("--tags <tags>", "comma-separated tags")
    .option("--current", "bookmark the most recent session")
    .action(async (sessionId: string | undefined, opts: {
      title?: string;
      category?: string;
      tags?: string;
      current?: boolean;
    }) => {
      // No session-id and no --current → list bookmarks
      if (!sessionId && !opts.current) {
        const bookmarks = listBookmarks();
        if (bookmarks.length === 0) {
          console.log(chalk.yellow("No bookmarks found."));
          return;
        }
        console.log(formatBookmarkTable(bookmarks));
        return;
      }

      // Bookmark mode
      let targetSessionId = sessionId;

      if (opts.current && !targetSessionId) {
        const sessions = await findSessions(1);
        if (sessions.length === 0) {
          console.error(chalk.red("No sessions found."));
          process.exit(1);
        }
        targetSessionId = sessions[0].session_id;
      }

      if (!targetSessionId) {
        console.error(chalk.red("Please provide a session-id or use --current"));
        process.exit(1);
      }

      // Check if already bookmarked
      const existing = findBookmark(targetSessionId);
      if (existing) {
        console.log(chalk.yellow(`Already bookmarked as: ${existing.id}`));
        return;
      }

      // Find session meta
      const meta = await findSessionById(targetSessionId);
      const now = new Date().toISOString();

      const bookmark: Bookmark = {
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
        updated_at: now,
      };

      addBookmark(bookmark);
      console.log(chalk.green(`Bookmarked: ${bookmark.id}`));
      console.log(`  Title:    ${bookmark.title}`);
      console.log(`  Category: ${bookmark.category || "(none)"}`);
      console.log(`  Tags:     ${bookmark.tags.join(", ") || "(none)"}`);
    });

  // mark ls — filtered list
  mark
    .command("ls")
    .description("List bookmarks with optional filters")
    .option("-c, --category <category>", "filter by category")
    .option("--tag <tag>", "filter by tag")
    .option("--json", "output as JSON")
    .action((opts: { category?: string; tag?: string; json?: boolean }) => {
      const bookmarks = listBookmarks({ category: opts.category, tag: opts.tag });
      if (bookmarks.length === 0) {
        console.log(chalk.yellow("No bookmarks found."));
        return;
      }
      if (opts.json) {
        console.log(JSON.stringify(bookmarks, null, 2));
        return;
      }
      console.log(formatBookmarkTable(bookmarks));
    });

  // mark show
  mark
    .command("show <id>")
    .description("Show bookmark details")
    .action((id: string) => {
      const bookmark = findBookmark(id);
      if (!bookmark) {
        console.error(chalk.red(`Bookmark not found: ${id}`));
        process.exit(1);
      }
      console.log(formatBookmarkDetail(bookmark));
    });

  // mark edit
  mark
    .command("edit <id>")
    .description("Edit bookmark metadata")
    .option("-t, --title <title>", "new title")
    .option("-c, --category <category>", "new category")
    .option("--tags <tags>", "new comma-separated tags (replaces existing)")
    .option("--add-tags <tags>", "add tags (appends)")
    .action((id: string, opts: {
      title?: string;
      category?: string;
      tags?: string;
      addTags?: string;
    }) => {
      const patch: Partial<Bookmark> = {};
      if (opts.title) patch.title = opts.title;
      if (opts.category) patch.category = opts.category;
      if (opts.tags) patch.tags = opts.tags.split(",").map((t) => t.trim());
      if (opts.addTags) {
        const existing = findBookmark(id);
        const currentTags = existing?.tags ?? [];
        const newTags = opts.addTags.split(",").map((t) => t.trim());
        patch.tags = [...new Set([...currentTags, ...newTags])];
      }

      const updated = updateBookmark(id, patch);
      if (!updated) {
        console.error(chalk.red(`Bookmark not found: ${id}`));
        process.exit(1);
      }
      console.log(chalk.green(`Updated: ${updated.id}`));
    });

  // mark rm
  mark
    .command("rm <id>")
    .description("Remove a bookmark")
    .action((id: string) => {
      if (!removeBookmark(id)) {
        console.error(chalk.red(`Bookmark not found: ${id}`));
        process.exit(1);
      }
      console.log(chalk.green(`Removed: ${id}`));
    });

  // mark search
  mark
    .command("search <query>")
    .description("Search bookmarks")
    .action((query: string) => {
      const results = searchBookmarks(query);
      if (results.length === 0) {
        console.log(chalk.yellow(`No bookmarks matching: "${query}"`));
        return;
      }
      console.log(formatBookmarkTable(results));
    });

  // mark note
  mark
    .command("note <id> <content...>")
    .description("Add a note to a bookmark")
    .action((id: string, contentParts: string[]) => {
      const bookmark = findBookmark(id);
      if (!bookmark) {
        console.error(chalk.red(`Bookmark not found: ${id}`));
        process.exit(1);
      }
      const content = contentParts.join(" ");
      const note = { id: generateNoteId(), content, created_at: new Date().toISOString() };
      bookmark.notes.push(note);
      updateBookmark(id, { notes: bookmark.notes });
      console.log(chalk.green(`Note added to ${id}: ${note.id}`));
    });

  program.addCommand(mark);
}
