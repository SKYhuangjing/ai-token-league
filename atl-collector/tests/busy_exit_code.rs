// cli-dev-standard §4/§5 verification: a write command that hits a store
// lock held by another process must exit 3 (busy — retry, not a failure) and,
// in --json mode, print the structured error document instead of plain text.
// Reads must keep working under the lock.
//
// One #[test] on purpose: both phases mutate the process-global ATL_HOME env
// var, so they must not run in parallel.

use std::process::Command;

fn run_atl(home: &std::path::Path, args: &[&str]) -> (i32, String) {
    let output = Command::new(env!("CARGO_BIN_EXE_atl-collector"))
        .args(args)
        .env("ATL_HOME", home)
        .output()
        .expect("spawn atl-collector");
    (
        output.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&output.stdout).to_string(),
    )
}

#[test]
fn store_lock_busy_contract() {
    let home = std::env::temp_dir().join(format!("atl-busy-test-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&home);
    std::fs::create_dir_all(&home).unwrap();
    let previous = std::env::var("ATL_HOME").ok();
    std::env::set_var("ATL_HOME", &home);

    // hold the modules store lock the way a concurrent writer would
    let guard = collector_core::store_lock::acquire("modules", std::time::Duration::ZERO)
        .expect("test acquires the store lock");

    // write command under lock → exit 3 + structured error JSON on stdout
    let (code, stdout) = run_atl(&home, &["zhipu", "key", "add", "sk-busy-test-key", "--label", "t", "-j"]);
    assert_eq!(code, 3, "busy must exit 3, got {} (stdout: {})", code, stdout);
    let parsed: serde_json::Value = serde_json::from_str(&stdout)
        .unwrap_or_else(|e| panic!("stdout must be one parseable JSON doc: {} ({})", e, stdout));
    assert_eq!(parsed["ok"], serde_json::json!(false));
    assert!(
        parsed["error"].as_str().unwrap_or("").contains("modules store"),
        "error names the contended store: {}",
        parsed
    );
    assert!(
        parsed["hint"].as_str().unwrap_or("").contains("retry"),
        "hint carries the retry guidance: {}",
        parsed
    );

    // read command under the same lock → succeeds with the success envelope
    let (code, stdout) = run_atl(&home, &["plugin", "list", "-j"]);
    assert_eq!(code, 0, "read must succeed under lock, got {} ({})", code, stdout);
    let parsed: serde_json::Value = serde_json::from_str(&stdout).expect("envelope parses");
    assert_eq!(parsed["ok"], serde_json::json!(true));

    // after release the write goes through
    drop(guard);
    let (code, stdout) = run_atl(&home, &["zhipu", "key", "add", "sk-busy-test-key", "--label", "t", "-j"]);
    assert_eq!(code, 0, "write must succeed after release ({} {})", code, stdout);
    let parsed: serde_json::Value = serde_json::from_str(&stdout).expect("envelope parses");
    assert_eq!(parsed["ok"], serde_json::json!(true));
    assert_eq!(parsed["changed"], serde_json::json!(true));

    match previous {
        Some(value) => std::env::set_var("ATL_HOME", value),
        None => std::env::remove_var("ATL_HOME"),
    }
    let _ = std::fs::remove_dir_all(&home);
}
