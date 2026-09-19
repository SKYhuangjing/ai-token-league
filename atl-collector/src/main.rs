use clap::{Parser, Subcommand};

mod board;
mod cli;
mod plugin_cli;
mod plugins;
mod pricing;
mod share_cli;
mod sidecar;
mod term;
mod zhipu_cli;

/// Exit-code table + key environment variables for the plugin command
/// families (cli-dev-standard: --help is the AI-facing self-description).
const EXIT_CODE_TABLE: &str = "Exit codes:\n  0  success (including no-change)\n  1  business failure\n  2  usage error\n  3  busy: another process holds the store lock — retry shortly\n  10 not initialized\n  12 network / backend unreachable\n\nJSON contract: -j / --json prints {\"ok\":true,\"changed\":bool,\"data\":{...}} on success\nand {\"ok\":false,\"error\":...,\"hint\":...} on failure (exit codes still apply).\n\nEnvironment:\n  ATL_HOME  overrides the data directory (default ~/.ai-token-league)";

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
        #[arg(short = 'j', long)]
        json: bool,
    },
    /// Scan local usage sources and refresh the local usage database
    Scan {
        /// Ignore the incremental source cache and re-read every source
        #[arg(long)]
        full: bool,
        /// Output machine-readable JSON
        #[arg(short = 'j', long)]
        json: bool,
    },
    /// Sync usage data to server
    Sync {
        #[arg(long)]
        full_resync: bool,
        /// Output machine-readable JSON
        #[arg(short = 'j', long)]
        json: bool,
    },
    /// Query locally collected usage data (same store as the desktop app)
    #[command(after_help = "Examples:\n  atl-collector usage              today, summary\n  atl-collector usage 7d trend     last 7 days, daily trend\n  atl-collector usage detail --provider codex --limit 50")]
    Usage {
        /// Range and/or view shorthand: e.g. "7d", "trend", "7d trend"
        #[arg(value_name = "RANGE|VIEW", num_args = 0..=2)]
        words: Vec<String>,
        /// Range: today, 7d, 30d, all, or YYYY-MM-DD..YYYY-MM-DD (default today)
        #[arg(short = 'r', long)]
        range: Option<String>,
        /// View: summary, trend, workdirs, detail (default summary)
        #[arg(short = 'v', long)]
        view: Option<String>,
        /// Trend grain: day, week, month, hour (default hour for today, else day)
        #[arg(short = 'g', long)]
        grain: Option<String>,
        /// Row limit for workdirs and detail views (1-500)
        #[arg(short = 'n', long, default_value = "20")]
        limit: usize,
        /// Row offset for detail view pagination
        #[arg(short = 'o', long, default_value = "0")]
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
        #[arg(short = 'c', long)]
        cost: bool,
        /// Output machine-readable JSON
        #[arg(short = 'j', long)]
        json: bool,
    },
    /// Show the server leaderboard top entries
    Top {
        /// Range: today, yesterday, 7d, 30d, all, or YYYY-MM-DD..YYYY-MM-DD (default 7d)
        #[arg(value_name = "RANGE")]
        range_word: Option<String>,
        /// Same range as the positional shorthand
        #[arg(short = 'r', long)]
        range: Option<String>,
        /// How many entries to show
        #[arg(short = 'n', long, default_value = "10")]
        limit: usize,
        /// Output machine-readable JSON
        #[arg(short = 'j', long)]
        json: bool,
    },
    /// Show my rank on the server leaderboard
    Rank {
        /// Range: today, yesterday, 7d, 30d, all, or YYYY-MM-DD..YYYY-MM-DD (default 7d)
        #[arg(value_name = "RANGE")]
        range_word: Option<String>,
        /// Same range as the positional shorthand
        #[arg(short = 'r', long)]
        range: Option<String>,
        /// Output machine-readable JSON
        #[arg(short = 'j', long)]
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
    /// Manage desktop plugins (same install state the desktop app uses)
    #[command(after_help = EXIT_CODE_TABLE)]
    Plugin {
        #[command(subcommand)]
        action: PluginAction,
    },
    /// Zhipu GLM Coding Plan usage (zhipu-plan plugin, terminal surface)
    #[command(after_help = EXIT_CODE_TABLE)]
    Zhipu {
        #[command(subcommand)]
        action: ZhipuAction,
    },
    /// Compute sharing: borrow shared endpoints, manage your own share
    #[command(after_help = EXIT_CODE_TABLE)]
    Share {
        #[command(subcommand)]
        action: ShareAction,
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

#[derive(Subcommand)]
enum PluginAction {
    /// List installed plugins (config values are never printed)
    List {
        /// Output machine-readable JSON
        #[arg(short = 'j', long)]
        json: bool,
    },
    /// Install a plugin from the online catalog (no plugin code runs)
    Install {
        /// Plugin id from the catalog (e.g. zhipu-plan)
        id: String,
        /// Version to install (default: catalog's current version)
        #[arg(long)]
        version: Option<String>,
        /// Output machine-readable JSON
        #[arg(short = 'j', long)]
        json: bool,
    },
    /// Uninstall a plugin (local package removed, config kept)
    Remove {
        /// Plugin id
        id: String,
        /// Output machine-readable JSON
        #[arg(short = 'j', long)]
        json: bool,
    },
}

#[derive(Subcommand)]
enum ZhipuAction {
    /// Show 5h/weekly window usage for your configured keys (60s cache)
    Usage {
        /// Bypass the 60s cache and re-query the quota API
        #[arg(long)]
        force: bool,
        /// Output machine-readable JSON
        #[arg(short = 'j', long)]
        json: bool,
    },
    /// Manage the keys the plugin queries (stored like the desktop card)
    Key {
        #[command(subcommand)]
        action: ZhipuKeyAction,
    },
}

#[derive(Subcommand)]
enum ZhipuKeyAction {
    /// List keys (masked — full keys never print)
    List {
        /// Output machine-readable JSON
        #[arg(short = 'j', long)]
        json: bool,
    },
    /// Add a key
    Add {
        /// The Zhipu API key
        api_key: String,
        /// Optional display label
        #[arg(long)]
        label: Option<String>,
        /// Output machine-readable JSON
        #[arg(short = 'j', long)]
        json: bool,
    },
    /// Remove a key by 1-based index or label
    Remove {
        /// Index from 'key list' or the exact label
        key: String,
        /// Output machine-readable JSON
        #[arg(short = 'j', long)]
        json: bool,
    },
}

#[derive(Subcommand)]
enum ShareAction {
    /// List online share nodes and their claimable lanes
    Dir {
        /// Filter lanes by model family (e.g. gemini-*, glm-*)
        #[arg(long)]
        family: Option<String>,
        /// Output machine-readable JSON
        #[arg(short = 'j', long)]
        json: bool,
    },
    /// Show my claims with live usage and export lines
    Claims {
        /// Output machine-readable JSON
        #[arg(short = 'j', long)]
        json: bool,
    },
    /// Claim a lane on a share and print its env export lines
    Claim {
        /// Share id from 'share dir'
        share_id: String,
        /// Lane id (required when the share has lanes)
        lane_id: Option<String>,
        /// Output machine-readable JSON
        #[arg(short = 'j', long)]
        json: bool,
    },
    /// Renew a claim (same key, extended expiry)
    Renew {
        /// Claim key id from 'share claims'
        key_id: String,
        /// Output machine-readable JSON
        #[arg(short = 'j', long)]
        json: bool,
    },
    /// Release a claim
    Revoke {
        /// Claim key id from 'share claims'
        key_id: String,
        /// Output machine-readable JSON
        #[arg(short = 'j', long)]
        json: bool,
    },
    /// Send one minimal generation through a claimed endpoint
    Test {
        /// Claim key id from 'share claims'
        key_id: String,
        /// Model to test with (default: the lane's exact model)
        #[arg(long)]
        model: Option<String>,
        /// Output machine-readable JSON
        #[arg(short = 'j', long)]
        json: bool,
    },
    /// Show my sharing node: lanes, claimers, plugin status
    Owner {
        /// Output machine-readable JSON
        #[arg(short = 'j', long)]
        json: bool,
    },
    /// Suggested lanes from my own usage families
    Suggest {
        /// Output machine-readable JSON
        #[arg(short = 'j', long)]
        json: bool,
    },
    /// Stop sharing (revokes every borrower key; record kept)
    Stop {
        /// Confirm the destructive stop
        #[arg(long)]
        yes: bool,
        /// Output machine-readable JSON
        #[arg(short = 'j', long)]
        json: bool,
    },
    /// Reopen a stopped share
    Resume {
        /// Output machine-readable JSON
        #[arg(short = 'j', long)]
        json: bool,
    },
}

/// Whether the invoked command asked for `--json` — decided once here, so
/// the error path can honor it without every handler plumbing the flag
/// (cli-dev-standard §3: in JSON mode failures are structured documents too).
fn wants_json(cmd: &Commands) -> bool {
    match cmd {
        Commands::Status { json }
        | Commands::Scan { json, .. }
        | Commands::Sync { json, .. }
        | Commands::Usage { json, .. }
        | Commands::Top { json, .. }
        | Commands::Rank { json, .. } => *json,
        Commands::Plugin { action } => match action {
            PluginAction::List { json }
            | PluginAction::Install { json, .. }
            | PluginAction::Remove { json, .. } => *json,
        },
        Commands::Zhipu { action } => match action {
            ZhipuAction::Usage { json, .. } => *json,
            ZhipuAction::Key { action } => match action {
                ZhipuKeyAction::List { json }
                | ZhipuKeyAction::Add { json, .. }
                | ZhipuKeyAction::Remove { json, .. } => *json,
            },
        },
        Commands::Share { action } => match action {
            ShareAction::Dir { json, .. }
            | ShareAction::Claims { json }
            | ShareAction::Claim { json, .. }
            | ShareAction::Renew { json, .. }
            | ShareAction::Revoke { json, .. }
            | ShareAction::Test { json, .. }
            | ShareAction::Owner { json }
            | ShareAction::Suggest { json }
            | ShareAction::Stop { json, .. }
            | ShareAction::Resume { json } => *json,
        },
        _ => false,
    }
}

/// Split an error message into (error, hint): the fix command rides either
/// on the lines after the first (multi-line errors) or after an em-dash
/// separator — that tail becomes the hint.
fn split_hint(message: &str) -> (String, Option<String>) {
    let split = message.split_once('\n').or_else(|| message.split_once(" — "));
    match split {
        Some((head, tail)) => (
            head.trim().to_string(),
            Some(tail.trim().to_string()).filter(|s| !s.is_empty()),
        ),
        None => (message.to_string(), None),
    }
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
        let json_mode = wants_json(&cmd);
        if let Err(e) = cli::run(cmd).await {
            let e = cli::classify_busy(e);
            if json_mode {
                let (error, hint) = split_hint(&e.message());
                println!(
                    "{}",
                    serde_json::to_string_pretty(&serde_json::json!({
                        "ok": false,
                        "error": error,
                        "hint": hint,
                    }))
                    .unwrap_or_default()
                );
            } else {
                eprintln!("Error: {}", e.message());
            }
            std::process::exit(e.exit_code());
        }
    } else {
        println!(
            "atl-collector {} -- use --help for usage",
            env!("CARGO_PKG_VERSION")
        );
    }
}
