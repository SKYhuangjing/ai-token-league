use clap::{Parser, Subcommand};

mod cli;
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
    /// Show collector status
    Status,
    /// Scan local usage sources
    Scan {
        #[arg(long)]
        full: bool,
    },
    /// Sync usage data to server
    Sync {
        #[arg(long)]
        full_resync: bool,
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
            eprintln!("Error: {}", e);
            std::process::exit(1);
        }
    } else {
        println!("atl-collector {} -- use --help for usage", env!("CARGO_PKG_VERSION"));
    }
}
