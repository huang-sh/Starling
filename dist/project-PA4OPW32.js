#!/usr/bin/env node
import {
  shortSessionId
} from "./chunk-N3NDNKER.js";
import {
  aggregateProjectsFromSessions,
  loadSessionIndexWithNewFiles,
  rebuildSessionIndex
} from "./chunk-EBT5CKYR.js";
import {
  streamSessions
} from "./chunk-FBJPGCDT.js";
import "./chunk-RWHPIOVN.js";

// src/commands/project.ts
import { Command } from "commander";
import chalk from "chalk";
import Table from "cli-table3";
async function aggregateByProject(providerFilter, limit, useIndex = true, refreshIndex = false) {
  if (useIndex) {
    const index = refreshIndex ? await rebuildSessionIndex(providerFilter) : await loadSessionIndexWithNewFiles(providerFilter);
    if (index) {
      if (!providerFilter && index.projects) {
        return index.projects.map(projectSummaryToStats);
      }
      return aggregateProjectsFromSessions(index.sessions, providerFilter);
    }
  }
  const map = /* @__PURE__ */ new Map();
  let count = 0;
  for await (const meta of streamSessions(providerFilter)) {
    if (limit && ++count > limit) break;
    if (!meta.project_path) continue;
    const key = meta.project_path;
    let stats = map.get(key);
    if (!stats) {
      stats = {
        project_path: key,
        session_count: 0,
        agents: {},
        models: {},
        first_active: meta.modified_at,
        last_active: meta.modified_at,
        sessions: []
      };
      map.set(key, stats);
    }
    stats.session_count++;
    stats.agents[meta.provider] = (stats.agents[meta.provider] || 0) + 1;
    const model = meta.model || "-";
    stats.models[model] = (stats.models[model] || 0) + 1;
    if (meta.modified_at < stats.first_active) stats.first_active = meta.modified_at;
    if (meta.modified_at > stats.last_active) stats.last_active = meta.modified_at;
    stats.sessions.push(meta);
  }
  const projects = [...map.values()];
  projects.sort((a, b) => b.last_active.localeCompare(a.last_active));
  return projects;
}
async function findProjectStats(path, providerFilter, useIndex = true, refreshIndex = false) {
  if (useIndex) {
    const index = refreshIndex ? await rebuildSessionIndex(providerFilter) : await loadSessionIndexWithNewFiles(providerFilter);
    const projectSessions2 = index.sessions.filter((session) => {
      if (providerFilter && session.provider !== providerFilter) return false;
      return Boolean(session.project_path && matchesProjectPath(session.project_path, path));
    });
    return pickProjectMatch(aggregateProjectsFromSessions(projectSessions2, providerFilter), path);
  }
  const projectSessions = [];
  for await (const meta of streamSessions(providerFilter)) {
    if (meta.project_path && matchesProjectPath(meta.project_path, path)) {
      projectSessions.push(meta);
    }
  }
  return pickProjectMatch(aggregateProjectsFromSessions(projectSessions, providerFilter), path);
}
function projectSummaryToStats(summary) {
  return {
    ...summary,
    sessions: []
  };
}
function matchesProjectPath(projectPath, input) {
  return projectPath === input || projectPath.endsWith(input) || projectPath.endsWith("/" + input);
}
function pickProjectMatch(projects, input) {
  const exact = projects.find((project) => project.project_path === input);
  return exact ?? projects[0] ?? null;
}
function shortPath(p, maxLen) {
  if (p.length <= maxLen) return p;
  return "\u2026" + p.slice(-(maxLen - 1));
}
function formatAgentModelSummary(counts) {
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}(${v})`).join(", ");
}
function topModel(models) {
  const entries = Object.entries(models).sort((a, b) => b[1] - a[1]);
  return entries[0]?.[0] || "-";
}
function parseLimit(value) {
  return parseInt(value || "100", 10) || 100;
}
function registerProjectCommand(program) {
  const project = new Command("project").alias("prj").description("Manage projects \u2014 aggregate sessions by project directory");
  project.command("list").alias("ls").description("List all projects with session statistics").option("-a, --agent <agent>", "filter by agent: claude | codex").option("-n, --limit <number>", "max projects to show", "100").option("--all", "show all projects").option("--refresh-index", "rebuild ~/.starling/session-index.json before listing").option("--no-index", "scan session files instead of using ~/.starling/session-index.json").option("--json", "output as JSON").action(
    async (opts) => {
      const provider = opts.agent;
      const projectLimit = opts.all ? void 0 : parseLimit(opts.limit);
      const scanLimit = opts.index === false ? projectLimit : void 0;
      const allProjects = await aggregateByProject(provider, scanLimit, opts.index !== false, Boolean(opts.refreshIndex));
      const projects = projectLimit ? allProjects.slice(0, projectLimit) : allProjects;
      if (projects.length === 0) {
        if (opts.json) {
          console.log("[]");
          return;
        }
        console.log(chalk.yellow("No projects found."));
        return;
      }
      if (opts.json) {
        console.log(
          JSON.stringify(
            projects.map(({ sessions, ...rest }) => rest),
            null,
            2
          )
        );
        return;
      }
      const table = new Table({
        head: [
          chalk.gray("PROJECT"),
          chalk.gray("SESSIONS"),
          chalk.gray("AGENTS"),
          chalk.gray("TOP MODEL"),
          chalk.gray("LAST ACTIVE")
        ],
        colWidths: [42, 10, 18, 22, 20],
        style: { head: [], border: ["gray"] },
        chars: {
          mid: "",
          "left-mid": "",
          "mid-mid": "",
          "right-mid": ""
        }
      });
      for (const p of projects) {
        table.push([
          shortPath(p.project_path, 40),
          String(p.session_count),
          formatAgentModelSummary(p.agents),
          topModel(p.models),
          p.last_active.slice(0, 16).replace("T", " ")
        ]);
      }
      console.log(table.toString());
    }
  );
  project.command("show <path>").description("Show project details and session list").option("-a, --agent <agent>", "filter by agent: claude | codex").option("--refresh-index", "rebuild ~/.starling/session-index.json before showing").option("--no-index", "scan session files instead of using ~/.starling/session-index.json").option("--json", "output as JSON").action(
    async (path, opts) => {
      const provider = opts.agent;
      const p = await findProjectStats(path, provider, opts.index !== false, Boolean(opts.refreshIndex));
      if (!p) {
        console.error(chalk.red(`Project not found: ${path}`));
        process.exit(1);
      }
      if (opts.json) {
        console.log(JSON.stringify(p, null, 2));
        return;
      }
      console.log(chalk.bold(`Project: ${p.project_path}`));
      console.log(`  Sessions: ${p.session_count}`);
      console.log(`  Agents:   ${formatAgentModelSummary(p.agents)}`);
      console.log(`  Models:   ${formatAgentModelSummary(p.models)}`);
      console.log(
        `  First session: ${p.first_active.slice(0, 10)}`
      );
      console.log(
        `  Last active:   ${p.last_active.slice(0, 16).replace("T", " ")}`
      );
      console.log("");
      console.log(chalk.bold("Recent sessions:"));
      const sorted = [...p.sessions].sort(
        (a, b) => b.modified_at.localeCompare(a.modified_at)
      );
      for (const s of sorted.slice(0, 20)) {
        const short = shortSessionId(s.session_id);
        const agent = s.provider === "codex" ? "codex" : "claude";
        const date = s.modified_at.slice(0, 16).replace("T", " ");
        const prompt = s.first_prompt ? s.first_prompt.length > 40 ? s.first_prompt.slice(0, 37) + "\u2026" : s.first_prompt : "";
        console.log(
          `  ${chalk.cyan(short)}  ${chalk.gray(agent.padEnd(7))}  ${(s.model || "-").padEnd(22)}  ${chalk.gray(date)}  ${chalk.gray(prompt)}`
        );
      }
    }
  );
  program.addCommand(project);
}
export {
  registerProjectCommand
};
