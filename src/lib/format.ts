import chalk from "chalk";
import Table from "cli-table3";
import type { Bookmark, Space, SessionMeta } from "../types.js";
import { shortSessionId } from "./sessionDisplay.js";

export function formatSessionTable(sessions: SessionMeta[]): string {
  const formatToken = (value: number | undefined): string => {
    return value === undefined ? "-" : String(value);
  };

  const table = new Table({
    head: [
      chalk.cyan("Session ID"),
      chalk.cyan("Agent"),
      chalk.cyan("Model"),
      chalk.cyan("Project"),
      chalk.cyan("Modified"),
      chalk.cyan("Input"),
      chalk.cyan("Output"),
      chalk.cyan("Total"),
      chalk.cyan("Cache"),
    ],
    colWidths: [15, 8, 16, 30, 20, 10, 10, 10, 10],
    style: { head: [] },
  });
  for (const s of sessions) {
    const shortId = shortSessionId(s.session_id);
    const agent = s.provider === "codex" ? "codex" : "claude";
    const shortProject = s.project_path ? (s.project_path.length > 36 ? "…" + s.project_path.slice(-35) : s.project_path) : "-";
    const shortDate = s.modified_at.slice(0, 19).replace("T", " ");
    table.push([
      shortId,
      agent,
      s.model || "-",
      shortProject,
      shortDate,
      formatToken(s.token_usage?.input_tokens),
      formatToken(s.token_usage?.output_tokens),
      formatToken(s.token_usage?.total_tokens),
      formatToken(s.token_usage?.cache_tokens),
    ]);
  }
  return table.toString();
}

export function formatBookmarkTable(bookmarks: Bookmark[]): string {
  const table = new Table({
    head: [chalk.green("ID"), chalk.green("Title"), chalk.green("Category"), chalk.green("Tags"), chalk.green("Created")],
    colWidths: [16, 30, 15, 20, 22],
    style: { head: [] },
  });
  for (const b of bookmarks) {
    const title = b.title.length > 28 ? b.title.slice(0, 28) + "…" : b.title;
    const tags = b.tags.join(", ") || "-";
    const date = b.created_at.slice(0, 19).replace("T", " ");
    table.push([b.id, title, b.category || "-", tags, date]);
  }
  return table.toString();
}

export function formatBookmarkDetail(b: Bookmark): string {
  const lines: string[] = [
    chalk.bold.green(`Pin: ${b.id}`),
    `  Title:       ${b.title}`,
    `  Provider:    ${b.provider}`,
    `  Session:     ${b.session_id}`,
    `  Category:    ${b.category || "(none)"}`,
    `  Tags:        ${b.tags.join(", ") || "(none)"}`,
    `  Project:     ${b.project_path}`,
    `  First Prompt:${b.first_prompt ? "\n" + wrapText(b.first_prompt, 60, "    ") : " (none)"}`,
    `  Created:     ${b.created_at}`,
    `  Updated:     ${b.updated_at}`,
  ];

  if (b.space_ids.length > 0) {
    lines.push(`  Catalogs:    ${b.space_ids.join(", ")}`);
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

export function formatSpaceTree(spaces: Space[], bookmarks: Bookmark[]): string {
  if (spaces.length === 0) return chalk.yellow("No catalogs created yet.");

  const childrenMap = new Map<string | null, Space[]>();
  for (const s of spaces) {
    const parent = s.parent_id ?? null;
    if (!childrenMap.has(parent)) childrenMap.set(parent, []);
    childrenMap.get(parent)!.push(s);
  }

  const bookmarkBySpace = new Map<string, Bookmark[]>();
  for (const b of bookmarks) {
    for (const sid of b.space_ids) {
      if (!bookmarkBySpace.has(sid)) bookmarkBySpace.set(sid, []);
      bookmarkBySpace.get(sid)!.push(b);
    }
  }

  function renderNode(space: Space, prefix: string, isLast: boolean): string[] {
    const connector = isLast ? "└── " : "├── ";
    const lines: string[] = [];
    const tagStr = space.tags.length > 0 ? chalk.gray(` [${space.tags.join(", ")}]`) : "";
    lines.push(`${prefix}${connector}${chalk.bold(space.name)}${tagStr}`);

    const childPrefix = prefix + (isLast ? "    " : "│   ");

    const bk = bookmarkBySpace.get(space.id) || [];
    for (let i = 0; i < bk.length; i++) {
      const bIsLast = i === bk.length - 1 && !childrenMap.has(space.id);
      const bConn = bIsLast ? "└── " : "├── ";
      lines.push(`${childPrefix}${bConn}${chalk.cyan(bk[i]!.title)} ${chalk.gray(`[${bk[i]!.session_id}]`)}`);
    }

    const children = childrenMap.get(space.id) || [];
    for (let i = 0; i < children.length; i++) {
      lines.push(...renderNode(children[i], childPrefix, i === children.length - 1 && bk.length === 0));
    }

    return lines;
  }

  const roots = childrenMap.get(null) || [];
  const lines: string[] = [chalk.bold("starling")];
  for (let i = 0; i < roots.length; i++) {
    lines.push(...renderNode(roots[i], "", i === roots.length - 1));
  }
  return lines.join("\n");
}

function wrapText(text: string, width: number, indent: string): string {
  const words = text.split(" ");
  const lines: string[] = [];
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
