import { Command } from "commander";
import chalk from "chalk";
import { findSessions, findSessionById } from "../lib/discovery.js";
import { formatSessionTable } from "../lib/format.js";

export function registerSessionCommand(program: Command): void {
  const session = new Command("session")
    .description("Discover and manage agent sessions");

  session
    .command("list")
    .alias("ls")
    .description("List recent agent sessions")
    .option("-n, --limit <number>", "max sessions to show", "20")
    .option("--json", "output as JSON")
    .action(async (opts: { limit: string; json?: boolean }) => {
      const limit = parseInt(opts.limit, 10) || 20;
      const sessions = await findSessions(limit);
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

  session
    .command("show <session-id>")
    .description("Show session details")
    .option("--json", "output as JSON")
    .action(async (sessionId: string, opts: { json?: boolean }) => {
      const meta = await findSessionById(sessionId);
      if (!meta) {
        console.error(chalk.red(`Session not found: ${sessionId}`));
        process.exit(1);
      }
      if (opts.json) {
        console.log(JSON.stringify(meta, null, 2));
        return;
      }
      console.log(chalk.bold.cyan(`Session: ${meta.session_id}`));
      console.log(`  Provider:    ${meta.provider}`);
      console.log(`  Model:       ${meta.model || "-"}`);
      console.log(`  Project:     ${meta.project_path || "-"}`);
      console.log(`  File:        ${meta.file_path}`);
      console.log(`  Modified:    ${meta.modified_at}`);
      if (meta.first_prompt) {
        console.log(`  First Prompt:`);
        console.log(`    ${meta.first_prompt}`);
      }
    });

  session
    .command("resume <session-id>")
    .description("Resume an agent session")
    .action(async (sessionId: string) => {
      const meta = await findSessionById(sessionId);
      if (!meta) {
        console.error(chalk.red(`Session not found: ${sessionId}`));
        process.exit(1);
      }
      console.log(chalk.green(`Resuming session: ${sessionId}`));
      console.log(chalk.gray(`Provider: ${meta.provider}`));
      console.log(chalk.gray(`Project:  ${meta.project_path}`));

      // Build resume command based on provider
      const args = ["--resume", meta.session_id];
      if (meta.provider === "claude") {
        console.log(chalk.cyan(`\nRun: claude ${args.join(" ")}`));
        if (meta.project_path) {
          console.log(chalk.gray(`  cd ${meta.project_path} && claude --resume ${meta.session_id}`));
        }
      }
    });

  program.addCommand(session);
}
