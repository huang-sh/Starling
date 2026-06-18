import { Command } from "commander";
import chalk from "chalk";
import Table from "cli-table3";
import { listBookmarks, listSpaces } from "../lib/store.js";
import { catalogPath, resolveCatalogReference } from "../lib/catalogResolver.js";
import {
  clearRuns,
  detectRunningSessions,
  findRun,
  getLatestRunForSession,
  reconcileStaleRuns,
  removeRun,
  statusBadge,
  type DetectedSession,
} from "../lib/runs.js";
import { shortSessionId } from "../lib/sessionDisplay.js";
import type { Bookmark, RunStatus } from "../types.js";

interface StatusRow {
  catalog: string;
  session_id: string;
  title: string;
  status: RunStatus;
  started_at?: string;
  ended_at?: string;
  exit_code?: number;
  pid?: number;
  source?: string;
}

function resolveStatus(
  sessionId: string,
  latest: ReturnType<typeof getLatestRunForSession>,
  detected: Map<string, DetectedSession>
): RunStatus {
  if (detected.has(sessionId)) return "running";
  if (latest && latest.status === "running") return "running"; // reconciled live pid
  return latest?.status ?? "unknown";
}

async function collectCatalogBookmarks(catalogFilter?: string): Promise<{ bookmarks: Bookmark[]; catalogError?: string }> {
  const all = listBookmarks().filter((b) => b.space_ids.length > 0);
  if (!catalogFilter) return { bookmarks: all };
  const resolution = resolveCatalogReference(catalogFilter);
  if (resolution.kind !== "found") {
    return {
      bookmarks: [],
      catalogError:
        resolution.kind === "ambiguous"
          ? `Ambiguous catalog "${catalogFilter}": ${resolution.matches.map((m) => m.name).join(", ")}`
          : `Catalog not found: ${catalogFilter}`,
    };
  }
  const catalogId = resolution.space.id;
  return { bookmarks: all.filter((b) => b.space_ids.includes(catalogId)) };
}

async function buildSnapshot(catalogFilter?: string, withDetection = false): Promise<{ rows: StatusRow[]; error?: string }> {
  reconcileStaleRuns();
  const { bookmarks, catalogError } = await collectCatalogBookmarks(catalogFilter);
  if (catalogError) return { rows: [], error: catalogError };

  const detected = withDetection ? await detectRunningSessions() : new Map<string, DetectedSession>();
  const spaces = listSpaces();
  const rows: StatusRow[] = bookmarks.map((b) => {
    const latest = getLatestRunForSession(b.session_id);
    const firstSpaceId = b.space_ids[0];
    const space = firstSpaceId ? spaces.find((s) => s.id === firstSpaceId) : undefined;
    const catalog = space ? catalogPath(space, spaces) : b.space_ids.join(",") || "-";
    return {
      catalog,
      session_id: b.session_id,
      title: b.title,
      status: resolveStatus(b.session_id, latest, detected),
      started_at: latest?.started_at,
      ended_at: latest?.ended_at,
      exit_code: latest?.exit_code,
      pid: latest?.pid,
      source: latest?.source,
    };
  });
  // Sort: running first, then by most recent started_at.
  rows.sort((a, b) => {
    if (a.status === "running" && b.status !== "running") return -1;
    if (b.status === "running" && a.status !== "running") return 1;
    return (b.started_at ?? "").localeCompare(a.started_at ?? "");
  });
  return { rows };
}

function fmtDate(value?: string): string {
  if (!value) return "-";
  return value.slice(0, 19).replace("T", " ");
}

function renderTable(rows: StatusRow[]): string {
  if (rows.length === 0) return chalk.yellow("No catalog-archived sessions.");
  const table = new Table({
    head: [
      chalk.cyan("Catalog"),
      chalk.cyan("Session"),
      chalk.cyan("Title"),
      chalk.cyan("Status"),
      chalk.cyan("Started"),
      chalk.cyan("Ended"),
      chalk.cyan("Exit"),
      chalk.cyan("PID"),
    ],
    colWidths: [18, 14, 24, 14, 20, 20, 7, 9],
    style: { head: [] },
  });
  for (const r of rows) {
    const title = r.title.length > 22 ? r.title.slice(0, 22) + "…" : r.title;
    table.push([
      r.catalog.length > 16 ? "…" + r.catalog.slice(-15) : r.catalog,
      shortSessionId(r.session_id),
      title,
      `${statusBadge(r.status)} ${r.status}`,
      fmtDate(r.started_at),
      fmtDate(r.ended_at),
      r.exit_code === undefined ? "-" : String(r.exit_code),
      r.pid === undefined ? "-" : String(r.pid),
    ]);
  }
  return table.toString();
}

function clearScreen(): void {
  process.stdout.write("\x1Bc");
}

export function registerStatusCommand(program: Command): void {
  const status = new Command("status")
    .description("Monitor the run status of catalog-archived sessions")
    .argument("[catalog]", "filter to a catalog (name, path, or id)")
    .option("-c, --catalog <catalog>", "filter to a catalog (name, path, or id)")
    .option("--watch", "live monitoring mode (re-render every few seconds)")
    .option("--json", "output current snapshot as JSON")
    .action(async (arg: string | undefined, opts: { catalog?: string; watch?: boolean; json?: boolean }) => {
      const catalogFilter = opts.catalog ?? arg;

      if (opts.json) {
        const { rows, error } = await buildSnapshot(catalogFilter, true);
        if (error) {
          console.error(chalk.red(error));
          process.exit(1);
        }
        console.log(JSON.stringify(rows, null, 2));
        return;
      }

      if (!opts.watch) {
        const { rows, error } = await buildSnapshot(catalogFilter, true);
        if (error) {
          console.error(chalk.red(error));
          process.exit(1);
        }
        console.log(renderTable(rows));
        return;
      }

      // Watch mode.
      let previous = new Map<string, RunStatus>();
      let tick = 0;
      let stopped = false;
      const stop = () => {
        if (stopped) return;
        stopped = true;
        clearScreen();
        process.exit(0);
      };
      process.on("SIGINT", stop);

      const renderOnce = async () => {
        tick++;
        const withDetection = tick % 2 === 1; // detect every other tick (~6s)
        const { rows } = await buildSnapshot(catalogFilter, withDetection);
        const current = new Map<string, RunStatus>(rows.map((r) => [r.session_id, r.status]));

        const events: string[] = [];
        for (const [sid, status] of current) {
          const prev = previous.get(sid);
          if (prev === undefined) continue;
          if (prev !== status) {
            events.push(`[${new Date().toISOString().slice(11, 19)}] session ${shortSessionId(sid)} ${prev} → ${status}`);
          }
        }
        previous = current;

        clearScreen();
        const filterLine = catalogFilter ? chalk.gray(`catalog: ${catalogFilter}\n`) : "";
        process.stdout.write(filterLine + renderTable(rows) + "\n");
        if (events.length > 0) {
          process.stdout.write(chalk.gray("\n— transitions —\n") + events.map((e) => chalk.gray(e)).join("\n") + "\n");
        }
        process.stdout.write(chalk.gray(`\nrefreshing… (Ctrl-C to exit, tick ${tick})\n`));
      };

      await renderOnce();
      const interval = setInterval(() => {
        renderOnce().catch(() => undefined);
      }, 3000);
      interval.unref?.();
    });

  status
    .command("prune")
    .description("Remove crashed and stale run records")
    .action(() => {
      const crashed = clearRuns({ status: "crashed" });
      const stale = clearRuns({ status: "stale" });
      console.log(chalk.green(`Pruned ${crashed + stale} run record(s) (crashed: ${crashed}, stale: ${stale}).`));
    });

  status
    .command("clear <run-or-session>")
    .description("Remove a run record by run_id or all records for a session_id")
    .action((target: string) => {
      const run = findRun(target);
      if (run) {
        removeRun(target);
        console.log(chalk.green(`Removed run ${target}.`));
        return;
      }
      const removed = clearRuns({ session_id: target });
      if (removed > 0) {
        console.log(chalk.green(`Removed ${removed} run record(s) for session ${target}.`));
      } else {
        console.log(chalk.yellow(`No run records matched "${target}".`));
      }
    });

  program.addCommand(status);
}
