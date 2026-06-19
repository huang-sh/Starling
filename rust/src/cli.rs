//! Clap command/arg definitions.

use clap::{Args, Parser, Subcommand};

#[derive(Parser)]
#[command(name = "starling", version, about = "Agent session manager — discover, pin, and organize AI coding sessions")]
pub struct Cli {
    #[command(subcommand)]
    pub command: Command,
}

#[derive(Subcommand)]
pub enum Command {
    /// Discover and manage agent sessions
    #[command(subcommand, alias = "s")]
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
    },

    /// Create, list, and organize catalogs of sessions
    #[command(subcommand, alias = "space", alias = "sp")]
    Catalog(CatalogCommand),

    /// List and inspect projects
    #[command(subcommand)]
    Project(ProjectCommand),

    /// Launch an agent session (Phase 6)
    #[command(subcommand)]
    Run(RunCommand),

    /// Manage model profiles (Phase 6)
    #[command(subcommand, alias = "models")]
    Model(ModelCommand),

    /// Manage Starling CLI settings
    #[command(subcommand)]
    Config(ConfigCommand),

    /// Benchmark agents against a task suite (Phase 7)
    /// Run a benchmark task against one or more agents and have a judge agent assess them
    Diagnose(#[command(flatten)] DiagnoseCommand),

    /// Show pinned sessions and their run status
    #[command(subcommand)]
    Status(StatusCommand),

    /// Live monitor of agent sessions
    Monitor(#[command(flatten)] MonitorCommand),

    /// Resume an agent session directly
    Resume { session_id: String },
}

#[derive(Subcommand)]
pub enum SessionCommand {
    /// List recent agent sessions
    #[command(alias = "ls")]
    List {
        /// Max sessions to show
        #[arg(short, long, default_value = "20")]
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
        session_id: String,
        #[arg(long)]
        json: bool,
    },

    /// Look up many sessions by id in one pass (read-only)
    Lookup {
        /// One or more session IDs
        session_ids: Vec<String>,
        #[arg(short, long)]
        agent: Option<String>,
        #[arg(long)]
        json: bool,
    },

    /// Resume an agent session
    Resume { session_id: String },

    /// Create or update session metadata
    Meta {
        session_id: String,
        #[arg(short, long)]
        title: Option<String>,
        #[arg(long)]
        tags: Option<String>,
        #[arg(long)]
        add_tags: Option<String>,
    },

    /// Add a note to a session
    Note {
        session_id: String,
        /// Note content (joined as a single string)
        content: Vec<String>,
    },

    /// Remove Starling metadata for a session without deleting the file
    Unpin { session_id: String },

    /// Delete a session file and remove Starling metadata
    Delete {
        session_id: String,
        /// Confirm deletion
        #[arg(short = 'y', long)]
        yes: bool,
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
        #[arg(long)]
        json: bool,
    },
    /// Rebuild ~/.starling/session-index.json
    Rebuild {
        #[arg(short, long)]
        agent: Option<String>,
        #[arg(long)]
        json: bool,
    },
    /// Remove ~/.starling/session-index.json
    Clear,
}

#[derive(Subcommand)]
pub enum SessionCatalogCommand {
    /// Add a session to a catalog
    Add {
        session_id: String,
        catalog: String,
        #[arg(short, long)]
        title: Option<String>,
        #[arg(long)]
        tags: Option<String>,
    },
    /// Remove a session from a catalog
    #[command(alias = "rm")]
    Remove {
        session_id: String,
        catalog: String,
    },
    /// Remove a session from all catalogs
    Clear {
        session_id: String,
    },
}

#[derive(Subcommand)]
pub enum CatalogCommand {
    /// Create a new catalog
    Create {
        name: String,
        #[arg(long)]
        description: Option<String>,
        #[arg(long)]
        parent: Option<String>,
    },
    /// List catalogs
    #[command(alias = "ls")]
    List {
        #[arg(long)]
        json: bool,
    },
    /// Show catalog tree
    Tree,
    /// Add a session to a catalog
    Add {
        catalog: String,
        session_id: String,
        #[arg(short, long)]
        title: Option<String>,
        #[arg(long)]
        tags: Option<String>,
    },
    /// Show catalog details
    Show { name: String },
    /// Detach a session from a catalog
    #[command(alias = "rm")]
    Detach {
        catalog: String,
        session_id: String,
    },
    /// Clear all sessions from a catalog
    Clear { catalog: String },
    /// Delete a catalog
    Delete {
        catalog: String,
        #[arg(short = 'y', long)]
        yes: bool,
    },
    /// Add tags to a catalog
    Tag {
        name: String,
        /// Tag list
        tags: Vec<String>,
    },
    /// Rename a catalog
    Rename {
        catalog: String,
        new_name: String,
    },
    /// Move a catalog under a new parent
    #[command(alias = "mv")]
    Move {
        catalog: String,
        #[arg(long)]
        parent: Option<String>,
    },
    /// Edit a catalog interactively (Phase 6)
    Edit { name: String },
}

#[derive(Subcommand)]
pub enum ProjectCommand {
    /// List known projects
    List {
        #[arg(short, long)]
        agent: Option<String>,
        #[arg(long)]
        json: bool,
    },
    /// Show project details
    Show { path: String },
}

#[derive(Subcommand)]
pub enum RunCommand {
    /// (Phase 6)
    Claude {
        args: Vec<String>,
    },
    /// (Phase 6)
    Codex {
        args: Vec<String>,
    },
    /// (Phase 6)
    Status {
        run_id: Option<String>,
    },
    /// (Phase 6)
    Stop {
        run_id: String,
    },
}

#[derive(Subcommand)]
pub enum ModelCommand {
    /// (Phase 6)
    List,
    /// (Phase 6)
    Add { name: String },
    /// (Phase 6)
    Delete { name: String },
    /// (Phase 6)
    Use { name: String },
}

#[derive(Subcommand)]
pub enum ConfigCommand {
    /// Show Starling CLI settings
    #[command(alias = "ls")]
    Show {
        #[arg(long)]
        json: bool,
    },
    /// Set a setting
    Set { key: String, value: String },
    /// Unset a setting
    Unset { key: String },
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

#[derive(Subcommand)]
pub enum StatusCommand {
    /// Show status
    #[command(name = "show", alias = "ls")]
    Show {
        #[arg(short = 'c', long)]
        catalog: Option<String>,
        #[arg(long)]
        live: bool,
        #[arg(long)]
        json: bool,
    },
    /// Mark running records with dead pids as crashed
    Prune,
    /// Clear all run records
    Clear {
        #[arg(short = 'y', long)]
        yes: bool,
    },
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

    /// Also show recent unpinned sessions
    #[arg(long)]
    pub recent: bool,

    /// Live monitoring mode (re-render every 3s)
    #[arg(long)]
    pub watch: bool,

    /// Output the current snapshot as JSON
    #[arg(long)]
    pub json: bool,
}

impl Cli {
    pub fn run(self) -> anyhow::Result<()> {
        crate::commands::dispatch(self.command)
    }
}
