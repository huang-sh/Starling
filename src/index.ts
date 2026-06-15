import { tryFastRun } from "./commands/runFast.js";
import packageJson from "../package.json" with { type: "json" };

async function main(): Promise<void> {
  const fastRun = await tryFastRun(process.argv);
  if (fastRun.handled) {
    process.exit(fastRun.exitCode ?? 0);
  }

  const [
    { Command },
    { registerSessionCommand, resumeSession },
    { registerPinCommand },
    { registerSpaceCommand },
    { registerProjectCommand },
    { registerRunCommand },
    { registerModelCommand },
    { registerConfigCommand },
  ] = await Promise.all([
    import("commander"),
    import("./commands/session.js"),
    import("./commands/pin.js"),
    import("./commands/space.js"),
    import("./commands/project.js"),
    import("./commands/run.js"),
    import("./commands/model.js"),
    import("./commands/config.js"),
  ]);

  const program = new Command();
  program.enablePositionalOptions();

  program
    .name("starling")
    .description("Agent session manager — discover, pin, and organize AI coding sessions")
    .version(packageJson.version);

  registerSessionCommand(program);
  registerPinCommand(program);
  registerSpaceCommand(program);
  registerProjectCommand(program);
  registerRunCommand(program);
  registerModelCommand(program);
  registerConfigCommand(program);

  // Top-level: starling resume <session-id>
  program
    .command("resume <session-id>")
    .description("Resume an agent session directly")
    .action(async (sessionId: string) => {
      await resumeSession(sessionId);
    });

  program.parse();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
