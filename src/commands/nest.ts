import { Command } from "commander";
import chalk from "chalk";
import { addNest, findNest, updateNest, removeNest, listNests, updateBookmark, listBookmarks } from "../lib/store.js";
import { generateNestId } from "../lib/id.js";
import { formatNestTree } from "../lib/format.js";
import type { Nest } from "../types.js";

export function registerNestCommand(program: Command): void {
  const nest = new Command("nest")
    .description("Organize sessions into collections with hierarchical nesting");

  // nest create
  nest
    .command("create <name>")
    .description("Create a new nest")
    .option("-d, --description <desc>", "nest description")
    .option("--tags <tags>", "comma-separated tags")
    .option("--parent <parent>", "parent nest name or id")
    .action((name: string, opts: { description?: string; tags?: string; parent?: string }) => {
      // Check duplicate name
      if (findNest(name)) {
        console.error(chalk.red(`Nest already exists: ${name}`));
        process.exit(1);
      }

      let parentId: string | null = null;
      if (opts.parent) {
        const parent = findNest(opts.parent);
        if (!parent) {
          console.error(chalk.red(`Parent nest not found: ${opts.parent}`));
          process.exit(1);
        }
        parentId = parent.id;
      }

      const now = new Date().toISOString();
      const newNest: Nest = {
        id: generateNestId(listNests()),
        name,
        description: opts.description ?? "",
        tags: opts.tags ? opts.tags.split(",").map((t) => t.trim()) : [],
        parent_id: parentId,
        created_at: now,
        updated_at: now,
      };

      addNest(newNest);
      console.log(chalk.green(`Created nest: ${newNest.id} "${name}"`));
      if (parentId) {
        console.log(chalk.gray(`  Parent: ${parentId}`));
      }
    });

  // nest list
  nest
    .command("list")
    .alias("ls")
    .description("List all nests (flat)")
    .option("--json", "output as JSON")
    .action((opts: { json?: boolean }) => {
      const nests = listNests();
      if (nests.length === 0) {
        console.log(chalk.yellow("No nests created yet."));
        return;
      }
      if (opts.json) {
        console.log(JSON.stringify(nests, null, 2));
        return;
      }
      for (const n of nests) {
        const tagStr = n.tags.length > 0 ? chalk.gray(` [${n.tags.join(", ")}]`) : "";
        const parentStr = n.parent_id ? chalk.gray(` → parent: ${n.parent_id}`) : "";
        console.log(`  ${chalk.green(n.id)}  ${chalk.bold(n.name)}${tagStr}${parentStr}`);
        if (n.description) {
          console.log(chalk.gray(`    ${n.description}`));
        }
      }
    });

  // nest tree
  nest
    .command("tree")
    .description("Display nests as a hierarchical tree")
    .action(() => {
      const nests = listNests();
      const bookmarks = listBookmarks();
      console.log(formatNestTree(nests, bookmarks));
    });

  // nest show
  nest
    .command("show <name>")
    .description("Show nest details and contents")
    .action((name: string) => {
      const n = findNest(name);
      if (!n) {
        console.error(chalk.red(`Nest not found: ${name}`));
        process.exit(1);
      }
      console.log(chalk.bold.green(`Nest: ${n.name} (${n.id})`));
      console.log(`  Description: ${n.description || "(none)"}`);
      console.log(`  Tags:        ${n.tags.join(", ") || "(none)"}`);
      console.log(`  Parent:      ${n.parent_id ?? "(root)"}`);
      console.log(`  Created:     ${n.created_at}`);

      // Show bookmarks in this nest
      const bookmarks = listBookmarks().filter((b) => b.nest_ids.includes(n.id));
      if (bookmarks.length > 0) {
        console.log(chalk.bold("\n  Bookmarks:"));
        for (const b of bookmarks) {
          console.log(`    ${chalk.cyan(b.id)}  ${b.title}`);
        }
      } else {
        console.log(chalk.gray("\n  (no bookmarks)"));
      }
    });

  // nest add
  nest
    .command("add <nest-name> <bookmark-id>")
    .description("Add a bookmark to a nest")
    .action((nestName: string, bookmarkId: string) => {
      const n = findNest(nestName);
      if (!n) {
        console.error(chalk.red(`Nest not found: ${nestName}`));
        process.exit(1);
      }
      const bookmark = listBookmarks().find(
        (b) => b.id === bookmarkId || b.session_id === bookmarkId
      );
      if (!bookmark) {
        console.error(chalk.red(`Bookmark not found: ${bookmarkId}`));
        process.exit(1);
      }
      if (bookmark.nest_ids.includes(n.id)) {
        console.log(chalk.yellow(`Already in nest "${n.name}".`));
        return;
      }
      bookmark.nest_ids.push(n.id);
      updateBookmark(bookmark.id, { nest_ids: bookmark.nest_ids });
      console.log(chalk.green(`Added "${bookmark.title}" to nest "${n.name}"`));
    });

  // nest rm (remove bookmark from nest, or remove nest with --delete)
  nest
    .command("rm <name>")
    .description("Remove a nest")
    .option("--bookmark <bookmark-id>", "remove a specific bookmark from the nest")
    .action((name: string, opts: { bookmark?: string }) => {
      const n = findNest(name);
      if (!n) {
        console.error(chalk.red(`Nest not found: ${name}`));
        process.exit(1);
      }

      if (opts.bookmark) {
        // Remove bookmark from nest
        const bookmark = listBookmarks().find(
          (b) => b.id === opts.bookmark || b.session_id === opts.bookmark
        );
        if (!bookmark) {
          console.error(chalk.red(`Bookmark not found: ${opts.bookmark}`));
          process.exit(1);
        }
        bookmark.nest_ids = bookmark.nest_ids.filter((nid) => nid !== n.id);
        updateBookmark(bookmark.id, { nest_ids: bookmark.nest_ids });
        console.log(chalk.green(`Removed "${bookmark.title}" from nest "${n.name}"`));
      } else {
        // Remove the nest entirely
        removeNest(n.id);
        console.log(chalk.green(`Removed nest: "${n.name}" (${n.id})`));
      }
    });

  // nest tag
  nest
    .command("tag <name> <tags...>")
    .description("Add tags to a nest")
    .action((name: string, newTags: string[]) => {
      const n = findNest(name);
      if (!n) {
        console.error(chalk.red(`Nest not found: ${name}`));
        process.exit(1);
      }
      const merged = [...new Set([...n.tags, ...newTags])];
      updateNest(n.id, { tags: merged });
      console.log(chalk.green(`Tagged "${n.name}": ${merged.join(", ")}`));
    });

  // nest edit
  nest
    .command("edit <name>")
    .description("Edit nest metadata")
    .option("-d, --description <desc>", "new description")
    .option("--rename <new-name>", "rename the nest")
    .option("--parent <parent>", "set parent nest")
    .action((name: string, opts: { description?: string; rename?: string; parent?: string }) => {
      const n = findNest(name);
      if (!n) {
        console.error(chalk.red(`Nest not found: ${name}`));
        process.exit(1);
      }
      const patch: Partial<Nest> = {};
      if (opts.description) patch.description = opts.description;
      if (opts.rename) patch.name = opts.rename;
      if (opts.parent) {
        const parent = findNest(opts.parent);
        if (!parent) {
          console.error(chalk.red(`Parent nest not found: ${opts.parent}`));
          process.exit(1);
        }
        if (parent.id === n.id) {
          console.error(chalk.red("A nest cannot be its own parent."));
          process.exit(1);
        }
        patch.parent_id = parent.id;
      }

      const updated = updateNest(n.id, patch);
      if (updated) {
        console.log(chalk.green(`Updated nest: "${updated.name}" (${updated.id})`));
      }
    });

  program.addCommand(nest);
}
