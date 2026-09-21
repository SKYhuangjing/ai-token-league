// Invoke the shipped CLI entry point in a child-only ATL_HOME. No shared
// process environment changes, network services, or real CPA files.
use serde_json::{json, Value};
use std::process::Command;

#[test]
fn doctor_is_read_only_and_unregistered_owner_has_next_step() {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap();
    let home = std::env::temp_dir().join(format!("atl-share-doctor-{}-{}", std::process::id(), now.as_nanos()));
    std::fs::create_dir_all(home.join("cpa-plugin")).unwrap();
    let config = json!({
        "participantId": "fixture", "deviceId": "fixture", "identityPublicKey": "", "identityPrivateKey": "",
        "apiBaseUrl": "http://127.0.0.1:1",
    }).to_string();
    std::fs::write(home.join("config.json"), &config).unwrap();
    std::fs::write(home.join("modules.json"), r#"{"version":1,"modules":{"compute-sharing":{"enabled":true,"installedVersion":"0.1.2"}}}"#).unwrap();
    std::fs::write(home.join("cpa-plugin/status.json"), json!({
        "phase": "beating", "api": "http://127.0.0.1:1", "lastSuccessAt": now.as_millis() as i64,
    }).to_string()).unwrap();
    let run = |args: &[&str]| Command::new(env!("CARGO_BIN_EXE_atl-collector"))
        .args(args).env("ATL_HOME", &home).output().unwrap();
    let doctor = run(&["share", "doctor", "--json"]);
    assert!(doctor.status.success(), "{}", String::from_utf8_lossy(&doctor.stderr));
    let report: Value = serde_json::from_slice(&doctor.stdout).expect("one JSON envelope");
    assert_eq!(report["ok"], true);
    assert_eq!(report["changed"], false);
    assert_eq!(report["data"]["ready"], false, "identity is absent");
    assert_eq!(report["data"]["items"][0]["code"], "identity_missing");
    assert_eq!(report["data"]["items"][2]["ok"], true);
    assert_eq!(std::fs::read_to_string(home.join("config.json")).unwrap(), config);
    assert!(!home.join("cpa-plugin/identity.json").exists());

    let owner = run(&["share", "owner", "--json"]);
    assert_eq!(owner.status.code(), Some(1));
    let error: Value = serde_json::from_slice(&owner.stdout).expect("one error envelope");
    assert_eq!(error["ok"], false);
    assert!(error["hint"].as_str().unwrap().contains("share doctor"), "{error}");
    assert!(error["hint"].as_str().unwrap().contains("start CPA"));
    assert!(!home.join("cpa-plugin/identity.json").exists());
    std::fs::remove_dir_all(home).unwrap();
}
