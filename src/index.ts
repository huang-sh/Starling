import { Command } from "commander";
import { registerSessionCommand, resumeSession } from "./commands/session.js";
import { registerPinCommand } from "./commands/pin.js";
import { registerSpaceCommand } from "./commands/space.js";
import { registerProjectCommand } from "./commands/project.js";
import { registerRunCommand } from "./commands/run.js";
import { registerModelCommand } from "./commands/model.js";

const program = new Command();
program.enablePositionalOptions();

program
  .name("starling")
  .description("Agent session manager — discover, pin, and organize AI coding sessions")
  .version("0.0.4");

registerSessionCommand(program);
registerPinCommand(program);
registerSpaceCommand(program);
registerProjectCommand(program);
registerRunCommand(program);
registerModelCommand(program);

// Top-level: starling resume <session-id>
program
  .command("resume <session-id>")
  .description("Resume an agent session directly")
  .action(async (sessionId: string) => {
    await resumeSession(sessionId);
  });

program.parse();
