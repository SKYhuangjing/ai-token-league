//! Parse failures must obey the documented JSON contract, before any I/O.
use std::process::Command;

#[test]
fn usage_errors_are_json_when_requested() {
    for args in [
        vec!["share", "renew", "--json"],
        vec!["share", "owner", "--unexpected", "-j"],
        vec!["share", "unknown-action", "--json"],
    ] {
        let out = Command::new(env!("CARGO_BIN_EXE_atl-collector"))
            .args(&args)
            .output()
            .unwrap();
        assert_eq!(out.status.code(), Some(2), "{args:?}");
        assert!(
            out.stderr.is_empty(),
            "JSON mode must keep its error on stdout"
        );
        let value: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
        assert_eq!(value["ok"], false);
        assert!(!value["error"].as_str().unwrap().is_empty());
        assert!(value["hint"].as_str().unwrap().contains("help"));
        assert!(!out.stdout.contains(&0x1b));
    }
}

#[test]
fn explicit_help_remains_successful_text() {
    let out = Command::new(env!("CARGO_BIN_EXE_atl-collector"))
        .args(["share", "--help"])
        .output()
        .unwrap();
    assert!(out.status.success());
    assert!(String::from_utf8_lossy(&out.stdout).contains("Exit codes:"));
}
