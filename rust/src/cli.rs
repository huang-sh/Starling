//! Clap command/arg definitions.

use clap::{ArgAction, Args, Parser, Subcommand};

#[derive(Parser)]
#[command(
    name = "starling",
    version,
    disable_version_flag = true,
    about = "Agent session manager — discover, pin, and organize AI coding sessions"
)]
pub struct Cli {
    #[arg(short = 'v', long = "version", action = ArgAction::Version, help = "Print version")]
    pub version: Option<bool>,

    #[command(subcommand)]
    pub command: Command,
}

#[derive(Subcommand)]
pub enum Command {
    /// Discover and manage agent sessions
    #[command(subcommand, alias = "s", alias = "ses")]
    Session(SessionCommand),

    /// Pin and annotate agent sessions
    #[command(alias = "p")]
    Pin {
        /// Session ID to pin (omit with --current to pin the most recent)
        session_id: Option<String>,

        /// Pin title
        #[arg(short, long)]
        title: Option<String>,

        /// Comma-separated tags
        #[arg(long)]
        tags: Option<String>,

        /// Catalog to add the pin to
        #[arg(long)]
        to: Option<String>,

        /// Pin the most recent session
        #[arg(long)]
        current: bool,
        /// Output as JSON
        #[arg(long)]
        json: bool,
    },

    /// Create, list, and organize catalogs of sessions
    #[command(subcommand, alias = "space", alias = "sp", alias = "cat")]
    Catalog(CatalogCommand),

    /// List and inspect projects
    #[command(subcommand, alias = "prj")]
    Project(ProjectCommand),

    /// Launch a Claude Code or Codex session under Starling tracking
    ///
    /// Records the run, maps the spawned process to its session, and optionally
    /// assigns it to a catalog. Use --setting to launch with a model profile.
    Run(#[command(flatten)] RunCommand),

    /// Manage model profiles used to launch agents with non-default providers
    #[command(subcommand, alias = "models")]
    Model(ModelCommand),

    /// Manage Starling CLI settings
    #[command(subcommand)]
    Config(ConfigCommand),

    /// Benchmark agents against a task suite
    ///
    /// Run a benchmark task against one or more agents and have a judge agent assess them
    #[command(alias = "diag")]
    Diagnose(#[command(flatten)] DiagnoseCommand),

    /// Live top-style view of agent sessions
    #[command(alias = "monitor")]
    Top(#[command(flatten)] TopCommand),

    /// Resume an agent session directly
    Resume {
        /// Session ID to resume
        session_id: String,
    },
}

#[derive(Subcommand)]
pub enum SessionCommand {
    /// List recent agent sessions
    #[command(alias = "ls")]
    List {
        /// Max sessions to show
        #[arg(short = 'n', visible_short_alias = 'l', long, default_value = "20")]
        limit: usize,

        /// Filter by agent: claude | codex
        #[arg(short, long)]
        agent: Option<String>,

        /// Only show sessions assigned to any catalog
        #[arg(long)]
        cataloged: bool,

        /// Only show sessions assigned to a catalog
        #[arg(short = 'c', long)]
        catalog: Option<String>,

        /// List all sessions (no limit)
        #[arg(long)]
        all: bool,

        /// Output as JSON
        #[arg(long)]
        json: bool,
    },

    /// Show session details
    Show {
        /// Session ID to inspect
        session_id: String,
        /// Output as JSON
        #[arg(long)]
        json: bool,
    },

    /// Look up many sessions by id in one pass (read-only)
    Lookup {
        /// One or more session IDs
        session_ids: Vec<String>,
        /// Filter by agent: claude | codex
        #[arg(short, long)]
        agent: Option<String>,
        /// Output as JSON
        #[arg(long)]
        json: bool,
    },

    /// Resume an agent session
    Resume {
        /// Session ID to resume
        session_id: String,
    },

    /// Create or update session metadata
    Meta {
        /// Session ID to annotate
        session_id: String,
        /// Set the session title
        #[arg(short, long)]
        title: Option<String>,
        /// Replace tags entirely (comma-separated)
        #[arg(long)]
        tags: Option<String>,
        /// Append tags to the existing set (comma-separated)
        #[arg(long)]
        add_tags: Option<String>,
        /// Output as JSON
        #[arg(long)]
        json: bool,
    },

    /// Add a note to a session
    Note {
        /// Session ID to annotate
        session_id: String,
        /// Note content (joined as a single string)
        content: Vec<String>,
        /// Output as JSON
        #[arg(long)]
        json: bool,
    },

    /// Remove Starling metadata for a session without deleting the file
    Unpin {
        /// Session ID to unpin
        session_id: String,
        /// Output as JSON
        #[arg(long)]
        json: bool,
    },

    /// Delete a session file and remove Starling metadata
    Delete {
        /// Session ID to delete
        session_id: String,
        /// Confirm deletion
        #[arg(short = 'y', long)]
        yes: bool,
        /// Output as JSON
        #[arg(long)]
        json: bool,
    },

    /// Manage the local session index
    #[command(subcommand)]
    Index(IndexCommand),

    /// Manage session catalog assignments
    #[command(subcommand)]
    Catalog(SessionCatalogCommand),
}

#[derive(Subcommand)]
pub enum IndexCommand {
    /// Show session index status
    Status {
        /// Output as JSON
        #[arg(long)]
        json: bool,
    },
    /// Rebuild ~/.starling/session-index.json
    Rebuild {
        /// Filter by agent: claude | codex
        #[arg(short, long)]
        agent: Option<String>,
        /// Output as JSON
        #[arg(long)]
        json: bool,
    },
    /// Remove ~/.starling/session-index.json
    Clear {
        /// Output as JSON
        #[arg(long)]
        json: bool,
    },
}

#[derive(Subcommand)]
pub enum SessionCatalogCommand {
    /// Add a session to a catalog
    Add {
        /// Session ID to assign
        session_id: String,
        /// Catalog to add to (name, path, or id)
        catalog: String,
        /// Set the session title
        #[arg(short, long)]
        title: Option<String>,
        /// Comma-separated tags
        #[arg(long)]
        tags: Option<String>,
        /// Output as JSON
        #[arg(long)]
        json: bool,
    },
    /// Remove a session from a catalog
    #[command(alias = "rm")]
    Remove {
        /// Session ID to remove
        session_id: String,
        /// Catalog to remove from (name, path, or id)
        catalog: String,
        /// Output as JSON
        #[arg(long)]
        json: bool,
    },
    /// Remove a session from all catalogs
    Clear {
        /// Session ID to clear catalog assignments for
        session_id: String,
        /// Output as JSON
        #[arg(long)]
        json: bool,
    },
}

#[derive(Subcommand)]
pub enum CatalogCommand {
    /// Create a new catalog
    Create {
        /// Name for the new catalog (must be unique among siblings)
        name: String,
        /// Short description of the catalog
        #[arg(short = 'd', long)]
        description: Option<String>,
        /// Comma-separated tags
        #[arg(long)]
        tags: Option<String>,
        /// Parent catalog (name, path, or id); omit for top level
        #[arg(long)]
        parent: Option<String>,
        /// Output as JSON
        #[arg(long)]
        json: bool,
    },
    /// List catalogs
    #[command(alias = "ls")]
    List {
        /// Output as JSON
        #[arg(long)]
        json: bool,
        /// Include pinned sessions under each catalog
        #[arg(long)]
        pins: bool,
    },
    /// Show catalog tree
    Tree {
        /// Include pinned sessions in the catalog tree
        #[arg(long)]
        sessions: bool,
    },
    /// Add a session to a catalog
    Add {
        /// Catalog to add to (name, path, or id)
        catalog: String,
        /// Session ID to assign
        session_id: String,
        /// Set the session title
        #[arg(short, long)]
        title: Option<String>,
        /// Comma-separated tags
        #[arg(long)]
        tags: Option<String>,
        /// Output as JSON
        #[arg(long)]
        json: bool,
    },
    /// Show catalog details
    Show {
        /// Catalog to show (name, path, or id)
        name: String,
    },
    /// Detach a session from a catalog
    #[command(alias = "rm")]
    Detach {
        /// Catalog to detach from (name, path, or id)
        catalog: String,
        /// Session ID to detach
        session_id: String,
        /// Output as JSON
        #[arg(long)]
        json: bool,
    },
    /// Clear all sessions from a catalog
    Clear {
        /// Catalog to clear (name, path, or id)
        catalog: String,
        /// Output as JSON
        #[arg(long)]
        json: bool,
    },
    /// Delete a catalog
    Delete {
        /// Catalog to delete (name, path, or id)
        catalog: String,
        /// Confirm deletion
        #[arg(short = 'y', long)]
        yes: bool,
        /// Output as JSON
        #[arg(long)]
        json: bool,
    },
    /// Add tags to a catalog
    Tag {
        /// Catalog to tag (name, path, or id)
        name: String,
        /// Tag list
        tags: Vec<String>,
        /// Output as JSON
        #[arg(long)]
        json: bool,
    },
    /// Rename a catalog
    Rename {
        /// Catalog to rename (name, path, or id)
        catalog: String,
        /// New name (must be unique among siblings)
        new_name: String,
        /// Output as JSON
        #[arg(long)]
        json: bool,
    },
    /// Move a catalog under a new parent
    #[command(alias = "mv")]
    Move {
        /// Catalog to move (name, path, or id)
        catalog: String,
        /// New parent (name, path, or id); omit, or use `root` / `/` for top level
        #[arg(long)]
        parent: Option<String>,
        /// Output as JSON
        #[arg(long)]
        json: bool,
    },
    /// Edit a catalog's description, name, or parent in one call
    Edit {
        /// Catalog to edit (name, path, or id)
        name: String,
        /// New description
        #[arg(short = 'd', long)]
        description: Option<String>,
        /// New name (must be unique among siblings)
        #[arg(long)]
        rename: Option<String>,
        /// New parent (name, path, or id); use `root` / `/` / empty for top level
        #[arg(long)]
        parent: Option<String>,
        /// Output as JSON
        #[arg(long)]
        json: bool,
    },
}

#[derive(Subcommand)]
pub enum ProjectCommand {
    /// List known projects
    #[command(alias = "ls")]
    List {
        /// Filter by agent: claude | codex
        #[arg(short, long)]
        agent: Option<String>,
        /// Max projects to show
        #[arg(short = 'n', visible_short_alias = 'l', long)]
        limit: Option<usize>,
        /// List all projects
        #[arg(long)]
        all: bool,
        /// Rebuild/read without cached index when available (accepted for extension compatibility)
        #[arg(long)]
        refresh_index: bool,
        /// Bypass cached index when available (accepted for extension compatibility)
        #[arg(long)]
        no_index: bool,
        /// Output as JSON
        #[arg(long)]
        json: bool,
    },
    /// Show project details
    Show {
        /// Project path to inspect
        path: String,
        /// Filter by agent: claude | codex
        #[arg(short, long)]
        agent: Option<String>,
        /// Output as JSON
        #[arg(long)]
        json: bool,
    },
}

#[derive(Args)]
pub struct RunCommand {
    /// Starling model/profile setting name to use for this run
    #[arg(short = 's', long = "setting", alias = "config")]
    pub setting: Option<String>,

    /// Catalog to associate with the launched run
    #[arg(short = 'c', long)]
    pub catalog: Option<String>,

    /// Optional run/session title
    #[arg(long)]
    pub title: Option<String>,

    /// Working directory for the launched agent
    #[arg(long)]
    pub cwd: Option<String>,

    #[command(subcommand)]
    pub command: RunSubcommand,
}

#[derive(Subcommand)]
pub enum RunSubcommand {
    /// Launch Claude Code
    Claude {
        /// Arguments passed through to Claude
        #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
        args: Vec<String>,
    },
    /// Launch Codex
    Codex {
        /// Arguments passed through to Codex
        #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
        args: Vec<String>,
    },
    /// Show recorded Starling runs
    Status {
        /// Run ID to inspect; omit to list recent runs
        run_id: Option<String>,
        /// Output as JSON
        #[arg(long)]
        json: bool,
    },
    /// Stop a recorded Starling run
    Stop {
        /// Run ID to stop
        run_id: String,
        /// Output as JSON
        #[arg(long)]
        json: bool,
    },
}

#[derive(Subcommand)]
pub enum ModelCommand {
    /// List model profiles and current agent configs
    ///
    /// Scans the active configs (~/.claude/settings.json, ~/.codex/config.toml)
    /// and any saved profiles under ~/.starling/settings/{claude,codex}/,
    /// showing the model, auth/provider, scope, and source file for each.
    #[command(alias = "ls")]
    List {
        /// Output as JSON
        #[arg(long)]
        json: bool,
        /// Filter by agent: claude | codex
        #[arg(long)]
        agent: Option<String>,
    },
    /// Create a new model profile
    ///
    /// Not yet implemented in the Rust CLI. Create the profile file directly
    /// under ~/.starling/settings/{claude,codex}/, or use the VS Code extension.
    Add {
        /// Name for the new profile
        name: String,
    },
    /// Delete a model profile
    ///
    /// Removes a profile file from ~/.starling/settings/{claude,codex}/.
    /// If the name exists for both agents, disambiguate with --agent.
    /// The agent's default 'current' config cannot be deleted here.
    Delete {
        /// Name of the profile to delete
        name: String,
        /// Disambiguate by agent: claude | codex
        #[arg(long)]
        agent: Option<String>,
        /// Output as JSON
        #[arg(long)]
        json: bool,
    },
    /// Set a model profile as the active default
    ///
    /// Not yet implemented in the Rust CLI. Select a profile per-run with:
    /// starling run --setting <name> <agent>
    Use {
        /// Name of the profile to activate
        name: String,
    },
}

#[derive(Subcommand)]
pub enum ConfigCommand {
    /// Show Starling CLI settings
    #[command(alias = "ls")]
    Show {
        /// Output as JSON
        #[arg(long)]
        json: bool,
    },
    /// Set a setting
    Set {
        /// Setting key (currently only `home` / `home_path`)
        key: String,
        /// Setting value
        value: String,
        /// Output as JSON
        #[arg(long)]
        json: bool,
    },
    /// Unset a setting
    Unset {
        /// Setting key (currently only `home` / `home_path`)
        key: String,
        /// Output as JSON
        #[arg(long)]
        json: bool,
    },
}

#[derive(Args)]
pub struct DiagnoseCommand {
    /// Benchmark task id
    #[arg(long, default_value = "personality")]
    pub task: String,

    /// Judge/launcher agent, e.g. claude:sonnet / codex:gpt5 / claude (bare provider = default config)
    #[arg(long)]
    pub judge: Option<String>,

    /// Evaluatee agent (repeatable)
    #[arg(long, num_args = 1..)]
    pub agent: Vec<String>,

    /// Per-call timeout in ms
    #[arg(long, default_value = "120000")]
    pub timeout: String,

    /// Max evaluatees to run in parallel; 0 = all at once
    #[arg(long, default_value = "0")]
    pub concurrency: String,

    /// Emit full report as JSON on stdout
    #[arg(long)]
    pub json: bool,

    /// Write the JSON report to a file
    #[arg(long)]
    pub out: Option<String>,
}

#[derive(Args)]
pub struct TopCommand {
    #[command(subcommand)]
    pub action: Option<TopAction>,

    #[command(flatten)]
    pub monitor: MonitorCommand,
}

#[derive(Args)]
pub struct MonitorCommand {
    /// Filter to a catalog's pinned sessions (name, path, or id)
    #[arg(num_args = 0..=1)]
    pub catalog: Option<String>,

    /// Filter to a catalog (name, path, or id)
    #[arg(short, long)]
    pub catalog_filter: Option<String>,

    /// Max pinned sessions to display
    #[arg(short, long)]
    pub limit: Option<usize>,

    /// Also show unpinned sessions
    #[arg(long, visible_alias = "unpin", visible_alias = "unpinned")]
    pub recent: bool,

    /// Live monitoring mode (re-render every 1s)
    #[arg(long)]
    pub watch: bool,

    /// Output the current snapshot as JSON
    #[arg(long)]
    pub json: bool,
}

#[derive(Subcommand)]
pub enum TopAction {
    /// Record runtime terminal state for a session
    Record {
        /// Session ID to update
        session_id: String,
        /// Status: waiting | idle | running | stopped
        #[arg(long)]
        status: Option<String>,
        /// Parse an OSC 0/2 title payload
        #[arg(long)]
        title: Option<String>,
        /// Parse a raw OSC escape sequence payload or full escape sequence
        #[arg(long)]
        sequence: Option<String>,
        /// Parse an OSC 9;4 progress level
        #[arg(long)]
        progress: Option<u8>,
        /// Live agent process pid
        #[arg(long)]
        pid: Option<u32>,
        /// Starling run id, when known
        #[arg(long)]
        run_id: Option<String>,
        /// Human-readable message or notification body
        #[arg(long)]
        message: Option<String>,
        /// State source label
        #[arg(long, default_value = "manual")]
        source: String,
        /// Output as JSON
        #[arg(long)]
        json: bool,
    },

    /// Clear cached runtime terminal state for a session
    Clear {
        /// Session ID to clear
        session_id: String,
        /// Only clear this pid
        #[arg(long)]
        pid: Option<u32>,
        /// Output as JSON
        #[arg(long)]
        json: bool,
    },

    /// Record a Claude Code hook event from stdin
    #[command(hide = true)]
    Hook {
        /// Starling run id, when known
        #[arg(long)]
        run_id: Option<String>,
        /// Append the raw hook event to this JSONL file
        #[arg(long)]
        hook_file: Option<String>,
        /// Live agent process pid
        #[arg(long)]
        pid: Option<u32>,
        /// Output as JSON
        #[arg(long)]
        json: bool,
    },
}

impl Cli {
    pub fn run(self) -> anyhow::Result<()> {
        crate::commands::dispatch(self.command)
    }
}
