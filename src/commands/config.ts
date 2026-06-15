import { copyFileSync, cpSync, existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";
import { Command } from "commander";
import chalk from "chalk";
import {
  CLI_CONFIG_PATH,
  DEFAULT_STARLING_HOME,
  DEFAULT_STORE_PATH,
  DEFAULT_STARLING_SETTINGS_DIR,
  STARLING_HOME_SOURCE,
} from "../constants.js";
import { atomicWriteJSON, ensureDir } from "../utils/fs.js";

interface StarlingCliConfig {
  homePath?: string;
}

export function registerConfigCommand(program: Command): void {
  const config = new Command("config").description("Manage Starling CLI settings");

  config
    .command("show")
    .alias("ls")
    .description("Show Starling CLI settings")
    .option("--json", "output JSON")
    .action((opts: { json?: boolean }) => {
      const fileConfig = readCliConfig();
      const payload = {
        configPath: CLI_CONFIG_PATH,
        configuredHomePath: fileConfig.homePath ?? null,
        effectiveHomePath: DEFAULT_STARLING_HOME,
        homeSource: STARLING_HOME_SOURCE,
        storePath: DEFAULT_STORE_PATH,
        settingsPath: DEFAULT_STARLING_SETTINGS_DIR,
      };

      if (opts.json) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }

      console.log(chalk.green("Starling config"));
      console.log(`  Config:   ${payload.configPath}`);
      console.log(`  Home:     ${payload.effectiveHomePath}`);
      console.log(`  Source:   ${payload.homeSource}`);
      if (payload.configuredHomePath) {
        console.log(`  Saved:    ${payload.configuredHomePath}`);
      }
      console.log(`  Store:    ${payload.storePath}`);
      console.log(`  Settings: ${payload.settingsPath}`);
    });

  config
    .command("set <key> <value>")
    .description("Set a Starling CLI setting")
    .option("--migrate", "copy existing Starling metadata into the new home when target files do not exist")
    .action((key: string, value: string, opts: { migrate?: boolean }) => {
      if (key !== "home") {
        console.error(chalk.red(`Unknown config key: ${key}`));
        console.error(chalk.gray("Allowed keys: home"));
        process.exit(1);
      }

      const homePath = normalizeHomePath(value);
      const migrated = opts.migrate ? migrateStarlingData(homePath) : [];
      const fileConfig = readCliConfig();
      fileConfig.homePath = homePath;
      atomicWriteJSON(CLI_CONFIG_PATH, fileConfig);

      console.log(chalk.green("Updated Starling config"));
      console.log(`  Home:   ${homePath}`);
      console.log(`  Config: ${CLI_CONFIG_PATH}`);
      for (const entry of migrated) {
        console.log(chalk.gray(`  Migrated: ${entry}`));
      }
      if (process.env.STARLING_HOME?.trim()) {
        console.log(chalk.yellow("  Note: STARLING_HOME is currently set and overrides this saved value for this process."));
      }
    });

  config
    .command("unset <key>")
    .description("Unset a Starling CLI setting")
    .action((key: string) => {
      if (key !== "home") {
        console.error(chalk.red(`Unknown config key: ${key}`));
        console.error(chalk.gray("Allowed keys: home"));
        process.exit(1);
      }

      const fileConfig = readCliConfig();
      delete fileConfig.homePath;
      atomicWriteJSON(CLI_CONFIG_PATH, fileConfig);

      console.log(chalk.green("Updated Starling config"));
      console.log("  Home:   default");
      console.log(`  Config: ${CLI_CONFIG_PATH}`);
    });

  program.addCommand(config);
}

function readCliConfig(): StarlingCliConfig {
  if (!existsSync(CLI_CONFIG_PATH)) return {};
  try {
    const parsed = JSON.parse(readFileSync(CLI_CONFIG_PATH, "utf-8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const homePath = (parsed as { homePath?: unknown }).homePath;
    return typeof homePath === "string" && homePath.trim() ? { homePath: homePath.trim() } : {};
  } catch {
    return {};
  }
}

function normalizeHomePath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    console.error(chalk.red("Home path cannot be empty."));
    process.exit(1);
  }
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return resolve(homedir(), trimmed.slice(2));
  return resolve(trimmed);
}

function migrateStarlingData(targetHome: string): string[] {
  const migrated: string[] = [];
  const targetStore = join(targetHome, "store.json");
  if (existsSync(DEFAULT_STORE_PATH) && !existsSync(targetStore)) {
    ensureDir(targetStore);
    copyFileSync(DEFAULT_STORE_PATH, targetStore);
    migrated.push(targetStore);
  }

  const targetSettings = join(targetHome, "settings");
  if (existsSync(DEFAULT_STARLING_SETTINGS_DIR) && !existsSync(targetSettings)) {
    ensureDir(targetSettings);
    cpSync(DEFAULT_STARLING_SETTINGS_DIR, targetSettings, { recursive: true });
    migrated.push(targetSettings);
  }

  for (const name of ["session-index.json", "project-session-index.json", "codex-provider.json"]) {
    const source = join(DEFAULT_STARLING_HOME, name);
    const target = join(targetHome, name);
    if (existsSync(source) && !existsSync(target)) {
      ensureDir(target);
      copyFileSync(source, target);
      migrated.push(target);
    }
  }

  return migrated;
}
