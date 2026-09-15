use clap::{Parser, Subcommand};

mod board;
mod cli;
mod plugins;
mod pricing;
mod sidecar;

#[derive(Parser)]
#[command(name = "atl-collector", version, about = "AI Token League Collector")]
struct Cli {
    #[command(subcommand)]
    command: Option<Commands>,

    /// Run in sidecar mode (NDJSON IPC on stdin/stdout)
    #[arg(long)]
    sidecar: bool,
}

#[derive(Subcommand)]
enum Commands {
    /// Initialize collector identity and config
    Init {
        #[arg(long)]
        nickname: Option<String>,
        #[arg(long)]
        api: Option<String>,
    },
    /// Check collector health
    Health,
    /// Show collector identity, sync state, and local data summary
    Status {
        /// Output machine-readable JSON
        #[arg(long)]
        json: bool,
    },
    /// Scan local usage sources and refresh the local usage database
    Scan {
        /// Ignore the incremental source cache and re-read every source
        #[arg(long)]
        full: bool,
        /// Output machine-readable JSON
        #[arg(long)]
        json: bool,
    },
    /// Sync usage data to server
    Sync {
        #[arg(long)]
        full_resync: bool,
        /// Output machine-readable JSON
        #[arg(long)]
        json: bool,
    },
    /// Query locally collected usage data (same store as the desktop app)
    Usage {
        /// Range: today, 7d, 30d, all, or YYYY-MM-DD..YYYY-MM-DD
        #[arg(long, default_value = "7d")]
        range: String,
        /// View: summary, trend, workdirs, detail
        #[arg(long, default_value = "summary")]
        view: String,
        /// Trend grain: day, week, month, hour
        #[arg(long, default_value = "day")]
        grain: String,
        /// Row limit for workdirs and detail views (1-500)
        #[arg(long, default_value = "20")]
        limit: usize,
        /// Row offset for detail view pagination
        #[arg(long, default_value = "0")]
        offset: usize,
        /// Filter by provider id (case-insensitive substring)
        #[arg(long)]
        provider: Option<String>,
        /// Filter by model name (case-insensitive substring)
        #[arg(long)]
        model: Option<String>,
        /// Filter by workdir display name (case-insensitive substring)
        #[arg(long)]
        workdir: Option<String>,
        /// Estimate cost with server model prices (summary view only)
        #[arg(long)]
        cost: bool,
        /// Output machine-readable JSON
        #[arg(long)]
        json: bool,
    },
    /// Show the server leaderboard top entries
    Top {
        /// Range: today, yesterday, 7d, 30d, all, or YYYY-MM-DD..YYYY-MM-DD
        #[arg(long, default_value = "7d")]
        range: String,
        /// How many entries to show
        #[arg(long, default_value = "10")]
        limit: usize,
        /// Output machine-readable JSON
        #[arg(long)]
        json: bool,
    },
    /// Show my rank on the server leaderboard
    Rank {
        /// Range: today, yesterday, 7d, 30d, all, or YYYY-MM-DD..YYYY-MM-DD
        #[arg(long, default_value = "7d")]
        range: String,
        /// Output machine-readable JSON
        #[arg(long)]
        json: bool,
    },
    /// Inspect or change collector settings (same keys as the desktop settings page)
    Config {
        #[command(subcommand)]
        action: ConfigAction,
    },
    /// Manage extra scan roots for a provider
    Roots {
        #[command(subcommand)]
        action: RootsAction,
    },
    /// Run full reconcile against server (diagnostic)
    Reconcile {
        #[arg(long)]
        full: bool,
    },
    /// Register device with server
    Register,
    /// Export identity to file
    ExportIdentity,
    /// Import identity from file
    ImportIdentity {
        #[arg(long)]
        file: String,
    },
}

#[derive(Subcommand)]
enum ConfigAction {
    /// Print all settings as JSON with secrets redacted
    List,
    /// Print one setting; dot notation for nested keys (e.g. providerEnabled.zcode_local)
    Get { key: String },
    /// Change one setting; booleans and numbers are parsed from the value
    Set { key: String, value: String },
}

#[derive(Subcommand)]
enum RootsAction {
    /// List configured extra scan roots per provider
    List,
    /// Add an extra scan root for a provider
    Add { provider: String, path: String },
    /// Remove an extra scan root from a provider
    Remove { provider: String, path: String },
}

#[tokio::main]
async fn main() {
    let cli = Cli::parse();

    if cli.sidecar {
        if let Err(e) = sidecar::run().await {
            eprintln!("sidecar error: {}", e);
        }
        return;
    }

    if let Some(cmd) = cli.command {
        if let Err(e) = cli::run(cmd).await {
            eprintln!("Error: {}", e.message());
            std::process::exit(e.exit_code());
        }
    } else {
        println!(
            "atl-collector {} -- use --help for usage",
            env!("CARGO_PKG_VERSION")
        );
    }
}
