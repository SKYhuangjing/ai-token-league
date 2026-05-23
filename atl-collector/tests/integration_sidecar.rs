//! Integration test: spawn the sidecar binary and send commands via stdin/stdout IPC.
//!
//! This simulates the real Tauri → sidecar communication flow.

use collector_core::protocol::{SidecarRequest, SidecarResponse};
use std::io::{BufRead, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

// ─── Helpers ───

static LOCK: Mutex<()> = Mutex::new(());

struct SidecarProcess {
    child: Child,
    stdin: ChildStdin,
    stdout: ChildStdout,
    home: std::path::PathBuf,
    _guard: MutexGuard<'static, ()>,
    prev_home: Option<String>,
}

impl SidecarProcess {
    fn new() -> Self {
        let guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let prev_home = std::env::var("HOME").ok();
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let home = std::env::temp_dir().join(format!("atl-sidecar-test-{}", suffix));
        std::fs::create_dir_all(&home).unwrap();
        std::env::set_var("HOME", &home);

        let mut child = Command::new(env!("CARGO_BIN_EXE_atl-collector"))
            .arg("--sidecar")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("failed to spawn sidecar");

        let stdin = child.stdin.take().expect("no stdin");
        let stdout = child.stdout.take().expect("no stdout");

        Self {
            child,
            stdin,
            stdout,
            home,
            _guard: guard,
            prev_home,
        }
    }

    fn send(&mut self, request: &SidecarRequest) -> SidecarResponse {
        let line = serde_json::to_string(request).unwrap();
        writeln!(self.stdin, "{}", line).unwrap();
        self.stdin.flush().unwrap();

        let mut buf = String::new();
        let mut reader = std::io::BufReader::new(&mut self.stdout);
        reader
            .read_line(&mut buf)
            .expect("failed to read response");
        let trimmed = buf.trim();
        assert!(!trimmed.is_empty(), "got empty response from sidecar");
        serde_json::from_str(trimmed).unwrap_or_else(|e| {
            panic!("failed to parse sidecar response: {}\nraw: {}", e, trimmed)
        })
    }

    fn req_id(&self) -> String {
        format!("req-{}", SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos())
    }

    fn send_command(&mut self, command: &str, args: serde_json::Value) -> SidecarResponse {
        let req = SidecarRequest {
            id: self.req_id(),
            command: command.to_string(),
            args,
        };
        self.send(&req)
    }
}

impl Drop for SidecarProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.home);
        if let Some(prev) = &self.prev_home {
            std::env::set_var("HOME", prev);
        } else {
            std::env::remove_var("HOME");
        }
    }
}

// ─── Test Scenarios ───

#[test]
fn sidecar_ping_pong() {
    let mut sidecar = SidecarProcess::new();

    let resp = sidecar.send_command("ping", serde_json::json!({}));
    assert!(resp.ok, "ping should succeed");
    assert_eq!(resp.data.unwrap()["ok"], true);

    println!("✓ sidecar ping/pong works");
}

#[test]
fn sidecar_config_init_and_get() {
    let mut sidecar = SidecarProcess::new();

    // Init config
    let resp = sidecar.send_command(
        "config:init",
        serde_json::json!({"nickname": "test-user", "apiBaseUrl": ""}),
    );
    assert!(resp.ok, "config:init should succeed: {:?}", resp.error);
    let data = resp.data.unwrap();
    assert_eq!(data["nickname"], "test-user");
    assert!(data["participantId"].is_string());
    let pid = data["participantId"].as_str().unwrap().to_string();

    // Get config back
    let resp2 = sidecar.send_command("config:get", serde_json::json!({}));
    assert!(resp2.ok, "config:get should succeed");
    let data2 = resp2.data.unwrap();
    assert_eq!(data2["participantId"], pid);

    // Private key should be present (not sanitized in this test env)
    // Actually, sidecar sanitizes config output — verify that
    // The sidecar sanitize_config_value strips private key
    assert!(data2.get("identityPrivateKey").is_none(), "config:get should strip private key");

    println!("✓ sidecar config init + get works");
}

#[test]
fn sidecar_app_version() {
    let mut sidecar = SidecarProcess::new();

    let resp = sidecar.send_command("app:version", serde_json::json!({}));
    assert!(resp.ok);
    let data = resp.data.unwrap();
    assert!(data["clientAppVersion"].is_string());
    assert!(data["clientPlatform"].is_string());
    assert!(data["runtime"].as_str().unwrap().starts_with("rust-"));

    println!("✓ sidecar app:version works");
}

#[test]
fn sidecar_add_provider_root_and_scan() {
    let mut sidecar = SidecarProcess::new();

    // Init config first
    sidecar.send_command("config:init", serde_json::json!({"nickname": "scanner"}));

    // Add provider roots
    let cwd = std::env::current_dir().unwrap();
    let samples = cwd.join("../samples");
    let codex_path = samples.join("codex").to_string_lossy().to_string();
    let claude_path = samples
        .join("claude/projects")
        .to_string_lossy()
        .to_string();

    let resp = sidecar.send_command(
        "providers:add-root",
        serde_json::json!({"providerId": "codex_local", "path": codex_path}),
    );
    assert!(resp.ok, "add codex root should succeed: {:?}", resp.error);

    let resp = sidecar.send_command(
        "providers:add-root",
        serde_json::json!({"providerId": "claude_code_local", "path": claude_path}),
    );
    assert!(resp.ok, "add claude root should succeed: {:?}", resp.error);

    // Scan
    let resp = sidecar.send_command("usage:scan", serde_json::json!({"force": true}));
    assert!(resp.ok, "scan should succeed: {:?}", resp.error);
    let data = resp.data.unwrap();
    let row_count = data["rowCount"].as_u64().unwrap_or(0);
    assert!(
        row_count >= 2,
        "scan should find at least 2 items, got {}",
        row_count
    );

    // Query summary
    let resp = sidecar.send_command("usage:summary", serde_json::json!({"range": "all"}));
    assert!(resp.ok, "summary should succeed: {:?}", resp.error);
    let summary = resp.data.unwrap();
    assert!(
        summary["totals"]["totalTokens"].as_i64().unwrap_or(0) > 0,
        "summary should have positive tokens"
    );

    // Query trend
    let resp = sidecar.send_command(
        "usage:trend",
        serde_json::json!({"range": "all", "grain": "day"}),
    );
    assert!(resp.ok, "trend should succeed: {:?}", resp.error);

    // Query workdirs
    let resp = sidecar.send_command("usage:workdirs", serde_json::json!({"range": "all", "limit": 10}));
    assert!(resp.ok, "workdirs should succeed: {:?}", resp.error);

    // Query detail window
    let resp = sidecar.send_command(
        "usage:detail-window",
        serde_json::json!({"range": "all", "offset": 0, "limit": 50}),
    );
    assert!(resp.ok, "detail window should succeed: {:?}", resp.error);
    let detail = resp.data.unwrap();
    assert!(
        detail["totalRows"].as_i64().unwrap_or(0) >= 2,
        "detail should have rows"
    );

    println!("✓ sidecar full scan → query flow works");
}

#[test]
fn sidecar_workdir_alias() {
    let mut sidecar = SidecarProcess::new();
    sidecar.send_command("config:init", serde_json::json!({"nickname": "alias-test"}));

    // Set alias
    let resp = sidecar.send_command(
        "workdirs:set-alias",
        serde_json::json!({"workdirHash": "test_hash_123", "alias": "my-cool-project"}),
    );
    assert!(resp.ok, "set alias should succeed: {:?}", resp.error);

    // Get config back — alias should be persisted
    let resp = sidecar.send_command("config:get", serde_json::json!({}));
    let data = resp.data.unwrap();
    let aliases = &data["workdirAliases"];
    assert_eq!(aliases["test_hash_123"], "my-cool-project");

    println!("✓ sidecar workdir alias works");
}

#[test]
fn sidecar_unknown_command_returns_error() {
    let mut sidecar = SidecarProcess::new();

    let resp = sidecar.send_command("nonexistent:command", serde_json::json!({}));
    assert!(!resp.ok, "unknown command should fail");
    assert!(resp.error.unwrap().contains("unknown command"));

    println!("✓ sidecar unknown command rejection works");
}

#[test]
fn sidecar_multiple_commands_sequence() {
    let mut sidecar = SidecarProcess::new();

    // Simulate a full user session: init → get → add roots → scan → query
    let commands = vec![
        ("config:init", serde_json::json!({"nickname": "session-test"})),
        ("config:get", serde_json::json!({})),
        ("app:version", serde_json::json!({})),
        ("ping", serde_json::json!({})),
    ];

    for (cmd, args) in commands {
        let resp = sidecar.send_command(cmd, args);
        assert!(resp.ok, "command '{}' should succeed: {:?}", cmd, resp.error);
    }

    println!("✓ sidecar multi-command session works");
}

#[test]
fn sidecar_providers_health() {
    let mut sidecar = SidecarProcess::new();
    sidecar.send_command("config:init", serde_json::json!({"nickname": "health-test"}));

    let resp = sidecar.send_command("providers:health", serde_json::json!({}));
    assert!(resp.ok, "providers:health should succeed: {:?}", resp.error);
    let data = resp.data.unwrap();
    assert!(data.is_array(), "health should return array");
    // At least detect local providers
    assert!(data.as_array().unwrap().len() >= 1, "should have at least 1 provider");

    println!("✓ sidecar providers:health works");
}

#[test]
fn sidecar_sync_without_api_url_fails_gracefully() {
    let mut sidecar = SidecarProcess::new();
    sidecar.send_command("config:init", serde_json::json!({"nickname": "no-api", "apiBaseUrl": ""}));

    let resp = sidecar.send_command("usage:sync", serde_json::json!({}));
    assert!(!resp.ok, "sync without API URL should fail");
    assert!(resp.error.unwrap().contains("API base URL"));

    println!("✓ sidecar sync without API URL fails gracefully");
}
