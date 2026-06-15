#!/usr/bin/env node
import {
  shortSessionId
} from "./chunk-N3NDNKER.js";
import {
  addBookmark,
  catalogPath,
  findBookmark,
  generateBookmarkId,
  listBookmarks,
  listSpaces,
  resolveCatalogReference,
  updateBookmark
} from "./chunk-L7RS3LU7.js";
import {
  findSessionCandidates,
  findSessions
} from "./chunk-FBJPGCDT.js";
import "./chunk-RWHPIOVN.js";

// src/commands/pin.ts
import { Command } from "commander";
import chalk from "chalk";
import { createInterface } from "readline/promises";
import { stdin, stdout } from "process";
function registerPinCommand(program) {
  const pin = new Command("pin").description("Pin and annotate agent sessions").argument("[session-id]", "session ID to pin").option("-t, --title <title>", "pin title").option("--tags <tags>", "comma-separated tags").option("--to <catalog>", "add pin to a catalog").option("--current", "pin the most recent session").action(async (sessionId, opts) => {
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
    let resolvedCatalog;
    const existing = findBookmark(resolvedSessionId);
    if (existing) {
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
    const now = (/* @__PURE__ */ new Date()).toISOString();
    let spaceIds = [];
    if (opts.to) {
      const space = resolveCatalogRef(opts.to);
      spaceIds = [space.id];
      resolvedCatalog = { id: space.id, name: space.name };
    }
    const bookmark = {
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
      updated_at: now
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
function resolveCatalogRef(ref) {
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
async function resolveSessionOrSelect(input) {
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
  console.log(chalk.yellow(`
Found ${candidates.length} sessions for "${input}":`));
  candidates.forEach((candidate, index) => {
    const shortId = shortSessionId(candidate.session_id);
    const date = candidate.modified_at.slice(0, 16).replace("T", " ");
    const project = candidate.project_path ? candidate.project_path.length > 35 ? "\u2026" + candidate.project_path.slice(-34) : candidate.project_path : "-";
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
export {
  registerPinCommand
};
