import { Command } from "commander";
import { registerSessionCommand } from "./commands/session.js";
import { registerMarkCommand } from "./commands/mark.js";
import { registerNestCommand } from "./commands/nest.js";

const program = new Command();

program
  .name("starling")
  .description("Agent session manager — discover, bookmark, and organize AI coding sessions")
  .version("0.1.0");

registerSessionCommand(program);
registerMarkCommand(program);
registerNestCommand(program);

program.parse();
