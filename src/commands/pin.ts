import { Command } from "commander";
import chalk from "chalk";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import {
  addBookmark,
  findBookmark,
  updateBookmark,
  listBookmarks,
} from "../lib/store.js";
import { generateBookmarkId } from "../lib/id.js";
import { findSessionCandidates, findSessions } from "../lib/discovery.js";
import { shortSessionId } from "../lib/sessionDisplay.js";
import { catalogPath, resolveCatalogReference } from "../lib/catalogResolver.js";
import { listSpaces } from "../lib/store.js";
import type { Space } from "../types.js";
import type { Bookmark } from "../types.js";
import type { SessionMeta } from "../types.js";

export function registerPinCommand(program: Command): void {
  const pin = new Command("pin")
    .description("Pin and annotate agent sessions")
    .argument("[session-id]", "session ID to pin")
    .option("-t, --title <title>", "pin title")
    .option("--tags <tags>", "comma-separated tags")
    .option("--to <catalog>", "add pin to a catalog")
    .option("--current", "pin the most recent session")
    .action(async (sessionId: string | undefined, opts: {
      title?: string;
      tags?: string;
      to?: string;
      current?: boolean;
    }) => {
      // No session-id and no --current → show help
      if (!sessionId && !opts.current) {
        pin.help();
        return;
      }

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

      const { sessionId: resolvedSessionId, meta: existingMeta } = await resolveSessionOrSelect(targetSessionId);
      const meta = existingMeta;

      let resolvedCatalog: { id: string; name: string } | undefined;

      // Check if already pinned
      const existing = findBookmark(resolvedSessionId);
      if (existing) {
        // If --to specified, just add to space
        if (opts.to) {
          const space = resolveCatalogRef(opts.to);
          if (!existing.space_ids.includes(space.id)) {
            existing.space_ids.push(space.id);
            updateBookmark(existing.id, { space_ids: existing.space_ids });
            console.log(chalk.green(`Added ${existing.id} to catalog "${space.name}" (${space.id})`));
          } else {
            console.log(chalk.yellow(`Already in catalog "${space.name}".`));
          }
          return;
        }
        console.log(chalk.yellow(`Already pinned as: ${existing.id}`));
        return;
      }

      // Find session meta
      const now = new Date().toISOString();

      // Resolve --to space
      let spaceIds: string[] = [];
      if (opts.to) {
        const space = resolveCatalogRef(opts.to);
        spaceIds = [space.id];
        resolvedCatalog = { id: space.id, name: space.name };
      }

      const bookmark: Bookmark = {
        id: generateBookmarkId(listBookmarks()),
        provider: meta?.provider ?? "unknown",
        session_id: resolvedSessionId,
        title: opts.title ?? meta?.first_prompt?.slice(0, 60) ?? resolvedSessionId.slice(0, 16),
        category: "",
        tags: opts.tags ? opts.tags.split(",").map((t) => t.trim()) : [],
        project_path: meta?.project_path ?? "",
        first_prompt: meta?.first_prompt ?? "",
        notes: [],
        space_ids: spaceIds,
        created_at: now,
        updated_at: now,
      };

      addBookmark(bookmark);
      console.log(chalk.green(`Pinned: ${bookmark.id}`));
      console.log(`  Title:    ${bookmark.title}`);
      console.log(`  Tags:     ${bookmark.tags.join(", ") || "(none)"}`);
      if (spaceIds.length > 0) {
        console.log(
          `  Catalog:  ${resolvedCatalog?.name ?? "Unknown"} (${resolvedCatalog?.id ?? opts.to})`
        );
      }
    });

  program.addCommand(pin);
}

function resolveCatalogRef(ref: string): Space {
  const resolution = resolveCatalogReference(ref);
  if (resolution.kind === "found") return resolution.space;
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

async function resolveSessionOrSelect(input: string): Promise<{ sessionId: string; meta: SessionMeta | null }> {
  const candidates = await findSessionCandidates(input);
  if (candidates.length === 0) {
    console.error(chalk.red(`No session matches: ${input}`));
    process.exit(1);
  }

  if (candidates.length === 1) {
    return { sessionId: candidates[0].session_id, meta: candidates[0] };
  }

  if (!stdin.isTTY) {
    console.error(chalk.red(`Ambiguous session id: ${input}`));
    console.error(chalk.red("Please rerun with full session id."));
    process.exit(1);
  }

  console.log(chalk.yellow(`\nFound ${candidates.length} sessions for "${input}":`));
  candidates.forEach((candidate, index) => {
    const shortId = shortSessionId(candidate.session_id);
    const date = candidate.modified_at.slice(0, 16).replace("T", " ");
    const project = candidate.project_path
      ? candidate.project_path.length > 35
        ? "…" + candidate.project_path.slice(-34)
        : candidate.project_path
      : "-";
    const model = candidate.model || "-";
    const provider = candidate.provider === "codex" ? "codex" : "claude";
    console.log(
      `  ${index + 1}. ${chalk.cyan(shortId.padEnd(15))}  ${chalk.gray(provider.padEnd(7))}  ${model.padEnd(18)}  ${chalk.gray(project.padEnd(38))}  ${chalk.gray(date)}`
    );
  });
  const rl = createInterface({ input: stdin, output: stdout });
  const answer = await rl.question("Select one by number: ");
  rl.close();

  const choice = Number(answer.trim());
  if (!Number.isInteger(choice) || choice < 1 || choice > candidates.length) {
    console.error(chalk.red(`Invalid selection: ${answer.trim() || "(empty)"}`));
    process.exit(1);
  }

  return { sessionId: candidates[choice - 1].session_id, meta: candidates[choice - 1] };
}
