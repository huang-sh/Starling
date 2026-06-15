#!/usr/bin/env node
import {
  shortSessionId
} from "./chunk-N3NDNKER.js";

// src/lib/format.ts
import chalk from "chalk";
import Table from "cli-table3";
function formatSessionTable(sessions) {
  const formatToken = (value) => {
    return value === void 0 ? "-" : String(value);
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
      chalk.cyan("Cache")
    ],
    colWidths: [15, 8, 16, 30, 20, 10, 10, 10, 10],
    style: { head: [] }
  });
  for (const s of sessions) {
    const shortId = shortSessionId(s.session_id);
    const agent = s.provider === "codex" ? "codex" : "claude";
    const shortProject = s.project_path ? s.project_path.length > 36 ? "\u2026" + s.project_path.slice(-35) : s.project_path : "-";
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
      formatToken(s.token_usage?.cache_tokens)
    ]);
  }
  return table.toString();
}
function formatSpaceTree(spaces, bookmarks) {
  if (spaces.length === 0) return chalk.yellow("No catalogs created yet.");
  const childrenMap = /* @__PURE__ */ new Map();
  for (const s of spaces) {
    const parent = s.parent_id ?? null;
    if (!childrenMap.has(parent)) childrenMap.set(parent, []);
    childrenMap.get(parent).push(s);
  }
  const bookmarkBySpace = /* @__PURE__ */ new Map();
  for (const b of bookmarks) {
    for (const sid of b.space_ids) {
      if (!bookmarkBySpace.has(sid)) bookmarkBySpace.set(sid, []);
      bookmarkBySpace.get(sid).push(b);
    }
  }
  function renderNode(space, prefix, isLast) {
    const connector = isLast ? "\u2514\u2500\u2500 " : "\u251C\u2500\u2500 ";
    const lines2 = [];
    const tagStr = space.tags.length > 0 ? chalk.gray(` [${space.tags.join(", ")}]`) : "";
    lines2.push(`${prefix}${connector}${chalk.bold(space.name)}${tagStr}`);
    const childPrefix = prefix + (isLast ? "    " : "\u2502   ");
    const bk = bookmarkBySpace.get(space.id) || [];
    for (let i = 0; i < bk.length; i++) {
      const bIsLast = i === bk.length - 1 && !childrenMap.has(space.id);
      const bConn = bIsLast ? "\u2514\u2500\u2500 " : "\u251C\u2500\u2500 ";
      lines2.push(`${childPrefix}${bConn}${chalk.cyan(bk[i].title)} ${chalk.gray(`[${bk[i].session_id}]`)}`);
    }
    const children = childrenMap.get(space.id) || [];
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

export {
  formatSessionTable,
  formatSpaceTree
};
