import chalk from "chalk";
import Table from "cli-table3";
import type { Bookmark, Nest, SessionMeta } from "../types.js";

export function formatSessionTable(sessions: SessionMeta[]): string {
  const table = new Table({
    head: [chalk.cyan("Session ID"), chalk.cyan("Model"), chalk.cyan("Project"), chalk.cyan("Modified")],
    colWidths: [40, 25, 40, 22],
    style: { head: [] },
  });
  for (const s of sessions) {
    const shortId = s.session_id.length > 36 ? s.session_id.slice(0, 36) + "…" : s.session_id;
    const shortProject = s.project_path ? (s.project_path.length > 38 ? "…" + s.project_path.slice(-37) : s.project_path) : "-";
    const shortDate = s.modified_at.slice(0, 19).replace("T", " ");
    table.push([shortId, s.model || "-", shortProject, shortDate]);
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
    chalk.bold.green(`Bookmark: ${b.id}`),
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

export function formatNestTree(nests: Nest[], bookmarks: Bookmark[]): string {
  if (nests.length === 0) return chalk.yellow("No nests created yet.");

  // Build lookup maps
  const childrenMap = new Map<string | null, Nest[]>();
  for (const n of nests) {
    const parent = n.parent_id ?? null;
    if (!childrenMap.has(parent)) childrenMap.set(parent, []);
    childrenMap.get(parent)!.push(n);
  }

  const bookmarkByNest = new Map<string, string[]>();
  for (const b of bookmarks) {
    for (const nid of b.nest_ids) {
      if (!bookmarkByNest.has(nid)) bookmarkByNest.set(nid, []);
      bookmarkByNest.get(nid)!.push(b.title);
    }
  }

  function renderNode(nest: Nest, prefix: string, isLast: boolean): string[] {
    const connector = isLast ? "└── " : "├── ";
    const lines: string[] = [];
    const tagStr = nest.tags.length > 0 ? chalk.gray(` [${nest.tags.join(", ")}]`) : "";
    lines.push(`${prefix}${connector}${chalk.bold(nest.name)}${tagStr}`);

    const childPrefix = prefix + (isLast ? "    " : "│   ");

    // Show bookmarks in this nest
    const bk = bookmarkByNest.get(nest.id) || [];
    for (let i = 0; i < bk.length; i++) {
      const bIsLast = i === bk.length - 1 && !childrenMap.has(nest.id);
      const bConn = bIsLast ? "└── " : "├── ";
      lines.push(`${childPrefix}${bConn}${chalk.cyan(bk[i])}`);
    }

    // Show child nests
    const children = childrenMap.get(nest.id) || [];
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
