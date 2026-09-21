//! Process-isolated production heartbeat regression tests. Production HTTP tick, accounting and persistence
//! run against loopback fixtures and a disposable ATL_HOME. No CPA host touched.
use super::*;
use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::mpsc,
    thread,
    time::Duration,
};

// Each production-runtime test runs alone in a child test process. Environment
// overrides and RUNTIME cannot race other tests or touch the user's data.
fn isolated(name: &str) -> bool {
    if std::env::var("ATL_CPA_PROBE_CHILD").as_deref() == Ok(name) {
        return false;
    }
    let result = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", &format!("sync_tests::{name}"), "--nocapture"])
        .env("ATL_CPA_PROBE_CHILD", name)
        .output()
        .unwrap();
    println!("{}", String::from_utf8_lossy(&result.stdout));
    assert!(
        result.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
    true
}

struct Sandbox(std::path::PathBuf);
impl Sandbox {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("atl-cpa-r2-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("cpa-plugin")).unwrap();
        std::fs::write(dir.join("cpa.yaml"), "host: 127.0.0.1\nport: 8317\n").unwrap();
        std::env::set_var("ATL_HOME", &dir);
        std::env::set_var("ATL_CPA_CONFIG", dir.join("cpa.yaml"));
        Self(dir)
    }
}
impl Drop for Sandbox {
    fn drop(&mut self) {
        *RUNTIME.lock().unwrap_or_else(|e| e.into_inner()) = None;
        bootstrap::HOST_CONFIG.lock().unwrap().clear();
        std::env::remove_var("ATL_HOME");
        std::env::remove_var("ATL_CPA_CONFIG");
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
struct Server {
    url: String,
    requests: mpsc::Receiver<Value>,
    replies: mpsc::Sender<(u16, Value)>,
}
fn server(rounds: usize) -> Server {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let (tx, requests) = mpsc::channel();
    let (replies, rx) = mpsc::channel::<(u16, Value)>();
    thread::spawn(move || {
        for _ in 0..rounds {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut data = Vec::new();
            let header_end;
            loop {
                let mut buf = [0u8; 4096];
                let n = stream.read(&mut buf).unwrap();
                assert!(n > 0);
                data.extend_from_slice(&buf[..n]);
                if let Some(p) = data.windows(4).position(|s| s == b"\r\n\r\n") {
                    header_end = p + 4;
                    break;
                }
            }
            let headers = String::from_utf8_lossy(&data[..header_end]);
            let len: usize = headers
                .lines()
                .find_map(|l| {
                    l.to_lowercase()
                        .strip_prefix("content-length:")
                        .map(|v| v.trim().parse().unwrap())
                })
                .unwrap();
            while data.len() < header_end + len {
                let mut buf = [0u8; 4096];
                let n = stream.read(&mut buf).unwrap();
                assert!(n > 0);
                data.extend_from_slice(&buf[..n]);
            }
            tx.send(serde_json::from_slice(&data[header_end..header_end + len]).unwrap())
                .unwrap();
            let (status, body) = rx.recv_timeout(Duration::from_secs(5)).unwrap();
            let body = body.to_string();
            write!(stream,"HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
        }
    });
    Server {
        url,
        requests,
        replies,
    }
}
fn snapshot(v2: bool, charged: u64) -> Value {
    let start = now_ms().div_euclid(18_000_000) * 18_000_000;
    let key = format!("h5:{start}");
    let mut v = json!({"state":"active","windowDay":"2026-09-20","policyRev":1,
        "policy":{"budget":10000,"keyConcurrency":5},
        "keys":[{"keyId":"key","token":"synthetic-r2-key","keyMaxTokens":100,"laneId":"lane","expiresAtMs":9000000000000i64}],
        "lanes":[{"id":"lane","state":"active","models":["*"],"window":{"unit":"hour","n":5},"windowKey":key,"windowEndMs":start+18_000_000,"budgetTokens":10000,"settledTokens":charged}],
        "settledByKey":{"key":charged}});
    if v2 {
        v["protocol"] = json!(2);
        v["keyLedger"] = json!({"key":{"windowKey":key,"charged":charged}});
        v["lastSeqByKey"] = json!({"key":0});
    }
    v
}
fn setup(s: &Server, v2: bool) {
    *bootstrap::HOST_CONFIG.lock().unwrap() =
        format!("api: {}\nbaseURL: http://127.0.0.1:8317\n", s.url);
    bootstrap::save_identity("synthetic-share", "synthetic-secret");
    let mut rt = Runtime::new();
    rt.sync = sync::parse_sync_response(&snapshot(v2, 0), now_ms());
    rt.usage_seq.insert("key".into(), 0);
    *RUNTIME.lock().unwrap() = Some(rt);
}
fn charge(n: u64) {
    handle_usage(&json!({"APIKey":"atl:key","Detail":{"TotalTokens":n}}));
}
fn key_charged() -> u64 {
    with_runtime(|rt| {
        core_state::key_charged_now(
            &rt.ledger,
            &rt.sync.lanes[0],
            "key",
            now_ms(),
            rt.sync.tz_offset_minutes,
        )
    })
    .unwrap()
}
fn round(s: &Server, status: u16, response: Value) -> Value {
    let task = thread::spawn(sync::tick);
    let request = s.requests.recv_timeout(Duration::from_secs(5)).unwrap();
    s.replies.send((status, response)).unwrap();
    task.join().unwrap();
    request
}

#[test]
fn v2_inflight_40_plus_70_remains_110() {
    if isolated("v2_inflight_40_plus_70_remains_110") {
        return;
    }
    let _home = Sandbox::new();
    let s = server(1);
    setup(&s, true);
    charge(40);
    let task = thread::spawn(sync::tick);
    let request = s.requests.recv_timeout(Duration::from_secs(5)).unwrap();
    charge(70);
    let mut body = snapshot(true, 40);
    body["lastSeqByKey"] = json!({"key":1});
    s.replies.send((200, body)).unwrap();
    task.join().unwrap();
    println!(
        "v2 sent={} local_after_ack={}",
        request["usage"][0]["rawTokens"],
        key_charged()
    );
    assert_eq!(key_charged(), 110);
}

#[test]
fn unchanged_legacy_heartbeat_never_readds_the_same_baseline() {
    if isolated("unchanged_legacy_heartbeat_never_readds_the_same_baseline") {
        return;
    }
    let _home = Sandbox::new();
    let s = server(4);
    setup(&s, false);
    let mut readings = vec![];
    for _ in 0..4 {
        let request = round(&s, 200, snapshot(false, 30));
        assert_eq!(request["usage"], json!([]));
        readings.push(key_charged());
    }
    println!("no new requests, legacy backend fixed at 30; local readings={readings:?}");
    assert_eq!(readings, vec![30, 30, 30, 30]);
}

#[test]
fn stale_window_response_does_not_double_current_pending() {
    if isolated("stale_window_response_does_not_double_current_pending") {
        return;
    }
    let _home = Sandbox::new();
    let s = server(1);
    setup(&s, true);
    let task = thread::spawn(sync::tick);
    s.requests.recv_timeout(Duration::from_secs(5)).unwrap();
    charge(30);
    let mut body = snapshot(true, 80);
    let old = format!(
        "h5:{}",
        now_ms().div_euclid(18_000_000) * 18_000_000 - 18_000_000
    );
    body["lanes"][0]["windowKey"] = json!(old);
    body["lanes"][0]["windowEndMs"] = json!(now_ms().div_euclid(18_000_000) * 18_000_000);
    body["keyLedger"]["key"]["windowKey"] = json!(old);
    s.replies.send((200, body)).unwrap();
    task.join().unwrap();
    let lane = with_runtime(|rt| {
        core_state::lane_settled_now(
            &rt.sync.lanes[0],
            &rt.ledger.lane_settled,
            now_ms(),
            rt.sync.tz_offset_minutes,
        )
    })
    .unwrap();
    println!(
        "old-window response, current pending 30: key={} lane={lane}",
        key_charged()
    );
    assert_eq!(key_charged(), 30);
}

#[test]
fn drained_unacked_batch_survives_a_new_process_restore() {
    if isolated("drained_unacked_batch_survives_a_new_process_restore") {
        return;
    }
    let _home = Sandbox::new();
    let s = server(2);
    setup(&s, true);
    charge(40);
    // First transport failure persists the unacked batch via production requeue.
    round(&s, 500, json!({"error":"fixture_retry"}));
    let saved: Value =
        serde_json::from_str(&std::fs::read_to_string(pending_state_path()).unwrap()).unwrap();
    assert_eq!(saved["buckets"][0]["raw_tokens"], 40);
    // The retry drains it. Crash/reload before its response must still see it.
    let task = thread::spawn(sync::tick);
    let request = s.requests.recv_timeout(Duration::from_secs(5)).unwrap();
    let child = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "sync_tests::restart_reader",
            "--ignored",
            "--nocapture",
        ])
        .env("ACCEPTANCE_EXPECT_TOKENS", "40")
        .output()
        .unwrap();
    s.replies.send((200, snapshot(true, 40))).unwrap();
    task.join().unwrap();
    println!(
        "retry wire raw={} child output={}",
        request["usage"][0]["rawTokens"],
        String::from_utf8_lossy(&child.stdout)
    );
    assert!(
        child.status.success(),
        "child restore must retain the in-flight, unacknowledged 40-token batch"
    );
}

#[test]
#[ignore]
fn restart_reader() {
    let mut rt = Runtime::new();
    load_pending_state(&mut rt);
    let tokens: u64 = rt.pending_buckets.iter().map(|b| b.raw_tokens).sum();
    println!("child process loaded pending raw={tokens}");
    assert_eq!(
        tokens,
        std::env::var("ACCEPTANCE_EXPECT_TOKENS")
            .unwrap()
            .parse::<u64>()
            .unwrap()
    );
}

#[test]
fn windows_match_live_js_authority_for_keys_and_endpoints() {
    if isolated("windows_match_live_js_authority_for_keys_and_endpoints") {
        return;
    }
    let rows: Value = serde_json::from_str(include_str!("test_windows.json")).unwrap();
    for row in rows.as_array().unwrap() {
        let lane = core_state::LaneEntry {
            window_unit: row["unit"].as_str().unwrap().into(),
            window_n: row["n"].as_u64().unwrap() as u32,
            ..Default::default()
        };
        let (key, end) = core_state::effective_lane_window(
            &lane,
            row["ts"].as_i64().unwrap(),
            row["tz"].as_i64().unwrap(),
        );
        assert_eq!(key, row["key"].as_str().unwrap(), "{row}");
        assert_eq!(end, row["end"].as_i64().unwrap(), "{row}");
    }
    println!(
        "JS/Rust boundary comparison: {} rows, keys AND endMs matched",
        rows.as_array().unwrap().len()
    );
}

#[test]
fn fresh_v2_key_first_usage_has_a_sequence_and_window() {
    if isolated("fresh_v2_key_first_usage_has_a_sequence_and_window") {
        return;
    }
    let _home = Sandbox::new();
    let s = server(2);
    setup(&s, true);
    with_runtime(|rt| rt.usage_seq.clear());
    // Current backend reports the authoritative zero for every newly claimed key.
    let mut first = snapshot(true, 0);
    first["lastSeqByKey"] = json!({"key":0});
    round(&s, 200, first.clone());
    charge(40);
    let request = round(&s, 200, first);
    let bucket = &request["usage"][0];
    println!("fresh protocol-2 key first usage wire={bucket}");
    assert!(
        bucket["seq"].as_u64().unwrap_or(0) > 0,
        "the first v2 bucket needs a durable positive sequence"
    );
    assert!(bucket["windowKey"].as_str().is_some());
}

#[test]
fn legacy_growth_restores_absolute_confirmed_usage() {
    if isolated("legacy_growth_restores_absolute_confirmed_usage") {
        return;
    }
    let _home = Sandbox::new();
    let s = server(3);
    setup(&s, false);
    let mut readings = vec![];
    for total in [30, 50, 50] {
        round(&s, 200, snapshot(false, total));
        readings.push(key_charged());
    }
    println!("legacy totals 30,50,50: local={readings:?}");
    assert_eq!(readings, vec![30, 50, 50]);
}

#[test]
fn pending_from_two_windows_keeps_the_current_key_charge() {
    if isolated("pending_from_two_windows_keeps_the_current_key_charge") {
        return;
    }
    let _home = Sandbox::new();
    let s = server(1);
    setup(&s, true);
    let task = thread::spawn(sync::tick);
    s.requests.recv_timeout(Duration::from_secs(5)).unwrap();
    // Both windows can accumulate during a heartbeat crossing a boundary.
    // Supply the completed previous-window event; current usage goes through
    // the actual CPA callback while its response is held by the HTTP fixture.
    with_runtime(|rt| {
        rt.pending_buckets.push(UsageBucket {
            key_id: "key".into(),
            lane_id: "lane".into(),
            window_key: format!(
                "h5:{}",
                now_ms().div_euclid(18_000_000) * 18_000_000 - 18_000_000
            ),
            multiplier: 1,
            raw_tokens: 40,
            charged_tokens: 40,
            requests: 1,
            failed: 0,
            seq: 0,
        })
    });
    charge(30);
    s.replies.send((200, snapshot(true, 0))).unwrap();
    task.join().unwrap();
    let lane = with_runtime(|rt| {
        core_state::lane_settled_now(
            &rt.sync.lanes[0],
            &rt.ledger.lane_settled,
            now_ms(),
            rt.sync.tz_offset_minutes,
        )
    })
    .unwrap();
    println!(
        "two-window pending: current key={} lane={lane}",
        key_charged()
    );
    assert_eq!(key_charged(), 30);
    assert_eq!(lane, 30);
}

#[test]
fn callbacks_and_ack_keep_the_disk_queue_current() {
    if isolated("callbacks_and_ack_keep_the_disk_queue_current") {
        return;
    }
    let _home = Sandbox::new();
    let s = server(1);
    setup(&s, true);
    charge(40);
    let before = load_pending_snapshot(&pending_state_path())
        .0
        .iter()
        .map(|b| b.raw_tokens)
        .sum::<u64>();
    let task = thread::spawn(sync::tick);
    s.requests.recv_timeout(Duration::from_secs(5)).unwrap();
    charge(70);
    let during = load_pending_snapshot(&pending_state_path())
        .0
        .iter()
        .map(|b| b.raw_tokens)
        .sum::<u64>();
    s.replies.send((200, snapshot(true, 40))).unwrap();
    task.join().unwrap();
    let after = load_pending_snapshot(&pending_state_path())
        .0
        .iter()
        .map(|b| b.raw_tokens)
        .sum::<u64>();
    println!("durable queue before send / in flight / after ack = {before}/{during}/{after}");
    assert_eq!((before, during, after), (40, 110, 70));
}

#[test]
fn legacy_inflight_and_ack_are_durable_too() {
    if isolated("legacy_inflight_and_ack_are_durable_too") {
        return;
    }
    let _home = Sandbox::new();
    let s = server(1);
    setup(&s, false);
    with_runtime(|rt| rt.sync.lanes.clear());
    charge(40);
    let task = thread::spawn(sync::tick);
    s.requests.recv_timeout(Duration::from_secs(5)).unwrap();
    charge(70);
    let during = load_pending_snapshot(&pending_state_path())
        .2
        .iter()
        .map(|b| b.tokens)
        .sum::<u64>();
    let mut response = snapshot(false, 40);
    response["lanes"] = json!([]);
    s.replies.send((200, response)).unwrap();
    task.join().unwrap();
    let after = load_pending_snapshot(&pending_state_path())
        .2
        .iter()
        .map(|b| b.tokens)
        .sum::<u64>();
    println!("legacy durable queue in flight / after ack = {during}/{after}");
    assert_eq!((during, after), (110, 70));
}

#[test]
fn failed_journal_write_blocks_shared_auth_until_recovered() {
    if isolated("failed_journal_write_blocks_shared_auth_until_recovered") {
        return;
    }
    let _home = Sandbox::new();
    let s = server(0);
    setup(&s, true);
    let request = json!({"Headers":{"Authorization":["Bearer synthetic-r2-key"]}});
    assert_eq!(handle_authenticate(&request)["Authenticated"], true);
    // A directory in place of the journal deterministically rejects rename.
    std::fs::create_dir(pending_state_path()).unwrap();
    charge(40);
    assert_eq!(handle_authenticate(&request)["Authenticated"], false);
    assert!(with_runtime(|rt| rt.storage_error.is_some()).unwrap());
    std::fs::remove_dir(pending_state_path()).unwrap();
    with_runtime(save_pending_state).unwrap().unwrap();
    assert_eq!(handle_authenticate(&request)["Authenticated"], true);
    assert_eq!(
        load_pending_snapshot(&pending_state_path()).0[0].raw_tokens,
        40
    );
}

#[test]
#[ignore = "local journal latency benchmark; run explicitly"]
fn journal_callback_latency() {
    // Run alone: all writes are confined to Sandbox and no HTTP is sent.
    let _home = Sandbox::new();
    let s = server(0);
    setup(&s, true);
    let mut samples = Vec::new();
    for _ in 0..200 {
        let started = std::time::Instant::now();
        charge(1);
        samples.push(started.elapsed().as_secs_f64() * 1000.0);
    }
    samples.sort_by(f64::total_cmp);
    println!(
        "durable callback n=200 p50_ms={:.3} p95_ms={:.3} max_ms={:.3}",
        samples[100], samples[189], samples[199]
    );
    assert!(samples[189] < 20.0, "local p95 journal budget is 20 ms");
    assert_eq!(
        load_pending_snapshot(&pending_state_path())
            .0
            .iter()
            .map(|b| b.raw_tokens)
            .sum::<u64>(),
        200
    );
}
