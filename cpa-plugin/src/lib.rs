// AI Token League compute-sharing plugin for CLIProxyAPI (CPA) — R23.
//
// Execution layer for compute sharing, formally moved INTO CPA (validated on
// CPA 7.2.157, see doc/compute-sharing-handoff.md R22/R23):
//   - frontend_auth: temp keys (`atl_sk_*`) are ONLY authenticated here.
//     Unconfigured / backend stale / share stopped / key unknown, expired or
//     exhausted => NotHandled => CPA's builtin chain rejects with 401.
//     Fail-closed is constructive: disable this plugin (hot reload) and every
//     temp key dies instantly while the owner's builtin keys pass through.
//   - interceptor: defense in depth for window budget / per-key cap /
//     per-key concurrency (Terminate 429). Interceptor errors are host
//     semantics fail-open, so the auth layer stays the real boundary.
//   - usage: usage.handle settles by Principal (`atl:<keyId>`); deltas ride
//     the heartbeat to the ATL backend, which is the single source of truth.
//     The plugin's ledger is a mirror restored from heartbeat responses, so
//     a CPA restart never resets accounting.
//
// Owner onboarding: the desktop app registers the share with the backend and
// writes <data dir>/cpa-plugin/config.json; this plugin picks it up within one
// sync interval and starts heartbeating. No CPA config payload is required.

use std::collections::HashMap;
use std::ffi::{c_char, c_int, c_void, CStr};
use std::ptr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};

mod bootstrap;
mod core_state;
mod sync;

use core_state::{
    decide_auth, merge_delta, roll_window, AuthDecision, Gate, Ledger, SyncState, UsageDelta,
};

const PLUGIN_ID: &str = "atl-share";
const PLUGIN_VERSION: &str = env!("CARGO_PKG_VERSION");
const SYNC_INTERVAL_MS: u64 = 8_000;

// ───────────────────────── C ABI (validated by the R22 probe) ─────────────────────────

type PluginCallFn = unsafe extern "C" fn(*const c_char, *const u8, usize, *mut Buffer) -> c_int;
type PluginFreeFn = unsafe extern "C" fn(*mut c_void, usize);
type PluginShutdownFn = unsafe extern "C" fn();
type HostCallFn = unsafe extern "C" fn(*mut c_void, *const c_char, *const u8, usize, *mut Buffer) -> c_int;
type HostFreeFn = unsafe extern "C" fn(*mut c_void, usize);

#[repr(C)]
pub struct Buffer {
    pub ptr: *mut c_void,
    pub len: usize,
}

#[repr(C)]
pub struct HostApi {
    pub abi_version: u32,
    pub host_ctx: *mut c_void,
    pub call: Option<HostCallFn>,
    pub free_buffer: Option<HostFreeFn>,
}

#[repr(C)]
pub struct PluginApi {
    pub abi_version: u32,
    pub call: Option<PluginCallFn>,
    pub free_buffer: Option<PluginFreeFn>,
    pub shutdown: Option<PluginShutdownFn>,
}

// ───────────────────────── runtime state ─────────────────────────

pub(crate) struct Runtime {
    /// Backend-shaped snapshot: keys/policy/state, refreshed by the sync thread.
    pub(crate) sync: SyncState,
    /// Local mirror ledger (settled restored from heartbeat responses).
    pub(crate) ledger: Ledger,
    /// caller_scope -> keyId for principals this plugin authenticated.
    scopes: HashMap<String, String>,
    /// In-flight request bookkeeping: request_id -> keyId (intercept -> complete).
    inflight_requests: HashMap<String, String>,
    /// Accumulated usage deltas not yet acknowledged by the backend.
    pub(crate) pending_usage: Vec<UsageDelta>,
    /// Owner-side failed requests observed since the last heartbeat (the
    /// wall signal: advisory input for the owner card, not auto-actioned).
    pub(crate) owner_failures: u64,
}

impl Runtime {
    fn new() -> Self {
        Runtime {
            sync: SyncState::default(),
            ledger: Ledger::default(),
            scopes: HashMap::new(),
            inflight_requests: HashMap::new(),
            pending_usage: Vec::new(),
            owner_failures: 0,
        }
    }
}

static RUNTIME: Mutex<Option<Runtime>> = Mutex::new(None);
static SHUTDOWN: AtomicBool = AtomicBool::new(false);

fn with_runtime<T>(f: impl FnOnce(&mut Runtime) -> T) -> Option<T> {
    let mut guard = RUNTIME.lock().unwrap_or_else(|e| e.into_inner());
    match guard.as_mut() {
        Some(rt) => Some(f(rt)),
        None => None,
    }
}

/// The ATL data dir, mirroring the collector's app_dir(): ATL_HOME overrides
/// the whole directory so sandboxed instances keep their own share state.
fn data_dir() -> std::path::PathBuf {
    std::env::var("ATL_HOME")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| {
            dirs_fallback().join(".ai-token-league")
        })
        .join("cpa-plugin")
}

fn dirs_fallback() -> std::path::PathBuf {
    std::env::var("HOME")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from("."))
}

/// caller_scope = sha256("cli-proxy-api:caller-scope:v1\0" + Principal) — the
/// only identity signal the interceptor layer can see (validated in R22).
fn caller_scope_of(principal: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(b"cli-proxy-api:caller-scope:v1\x00");
    hasher.update(principal.as_bytes());
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect()
}

fn bearer_of(headers: &Value) -> Option<String> {
    let auth = headers
        .get("Authorization")
        .and_then(|v| v.as_array())
        .and_then(|a| a.first())
        .and_then(|v| v.as_str())?;
    let token = auth.strip_prefix("Bearer ").unwrap_or(auth);
    Some(token.trim().to_string())
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ───────────────────────── method handlers ─────────────────────────

fn registration() -> Value {
    json!({
        "schema_version": 2,
        "metadata": {
            "Name": PLUGIN_ID,
            "Version": PLUGIN_VERSION,
            "Author": "ai-token-league",
            "GitHubRepository": "https://github.com/SKYhuangjing/ai-token-league",
            "ConfigFields": [
                { "Name": "api", "Type": "string", "Description": "AI Token League backend base URL (e.g. https://atl.example.com). Required — sharing stays off until set." },
                { "Name": "title", "Type": "string", "Description": "Share title shown to borrowers (optional)." },
                { "Name": "budget", "Type": "integer", "Description": "Daily window token pool lent to borrowers (default 1000000)." },
                { "Name": "maxClaims", "Type": "integer", "Description": "Concurrently valid claim keys (default 5)." },
                { "Name": "keyMaxTokens", "Type": "integer", "Description": "Per-key window token cap; default = budget / maxClaims." },
                { "Name": "keyConcurrency", "Type": "integer", "Description": "Per-key concurrent request cap (default 3)." }
            ]
        },
        "capabilities": {
            "frontend_auth_provider": true,
            "request_interceptor": true,
            "request_lifecycle_plugin": true,
            "usage_plugin": true
        }
    })
}

/// plugin.register / plugin.reconfigure: the host delivers this plugin's
/// config subtree as base64 `config_yaml` (Go []byte JSON). Hot-reload on
/// reconfigure means editing the CPA config IS the owner's policy console.
fn handle_lifecycle(req: &Value) -> Value {
    use base64::Engine;
    let decoded = req
        .get("config_yaml")
        .and_then(|v| v.as_str())
        .and_then(|text| base64::engine::general_purpose::STANDARD.decode(text).ok())
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .unwrap_or_default();
    *bootstrap::HOST_CONFIG.lock().unwrap_or_else(|e| e.into_inner()) = decoded;
    registration()
}

fn handle_authenticate(req: &Value) -> Value {
    let token = bearer_of(req.get("Headers").unwrap_or(&Value::Null)).unwrap_or_default();
    let decision = with_runtime(|rt| {
        roll_window(&mut rt.ledger, &rt.sync.window_day.clone());
        decide_auth(&rt.sync, &token, now_ms())
    })
    .unwrap_or(AuthDecision::NotHandled);
    match decision {
        AuthDecision::Allow { principal, key_id } => {
            let scope = caller_scope_of(&principal);
            with_runtime(|rt| {
                rt.scopes.insert(scope.clone(), key_id.clone());
            });
            json!({ "Authenticated": true, "Principal": principal, "Metadata": { "atl_share": "1", "atl_key_id": key_id } })
        }
        // NotHandled keeps the auth chain moving (builtin keys stay live);
        // temp keys are in no builtin list, so CPA answers 401. Fail-closed.
        AuthDecision::NotHandled => json!({ "Authenticated": false, "Principal": "", "Metadata": {} }),
    }
}

/// Go `[]byte` fields (ResponseBody) travel as base64 inside the JSON envelope.
fn b64(data: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(data)
}

fn budget_exceeded_response(reason: &str, detail: &str, retry_after_secs: u64) -> Value {
    let mut body = json!({
        "error": {
            "type": "atl_budget_exceeded",
            "message": format!("compute-sharing limit reached: {} ({})", reason, detail),
        }
    });
    if retry_after_secs > 0 {
        body["error"]["retryAfterSecs"] = json!(retry_after_secs);
    }
    let body = body.to_string();
    let mut headers = json!({ "content-type": ["application/json"], "x-atl-share": [reason] });
    if retry_after_secs > 0 {
        headers["retry-after"] = json!([retry_after_secs.to_string()]);
    }
    json!({
        "Terminate": true,
        "StatusCode": 429,
        "ResponseHeaders": headers,
        "ResponseBody": b64(body.as_bytes()),
    })
}

/// Minute-of-day in the owner's local timezone (schedule windows are local).
fn local_minute_of_day() -> u32 {
    use chrono::{Local, Timelike};
    let now = Local::now();
    now.hour() * 60 + now.minute()
}

/// Owner tz offset, minutes east of UTC (DST-aware). Reported per heartbeat;
/// the backend anchors schedule/day/week windows to it so the directory and
/// these gates (which run on the owner machine) never disagree.
pub(crate) fn tz_offset_minutes() -> i64 {
    use chrono::{Local, Offset};
    (Local::now().offset().fix().local_minus_utc() / 60) as i64
}

/// Debug facility (file-gated, off unless the flag file exists): append the
/// raw intercept payload to <data_dir>/intercept-dump.jsonl, capped at 20
/// entries — used to answer "does the intercept ABI carry the request model?"
/// without touching the CPA host.
fn dump_intercept_payload(req: &Value) {
    use std::io::Write;
    let flag = data_dir().join("DUMP_INTERCEPT");
    if !flag.exists() {
        return;
    }
    let path = data_dir().join("intercept-dump.jsonl");
    let mut line = req.to_string();
    // truncate at a UTF-8 char boundary — String::truncate mid-codepoint panics
    let cap = 64 * 1024;
    if line.len() > cap {
        let mut end = cap;
        while end > 0 && !line.is_char_boundary(end) {
            end -= 1;
        }
        line.truncate(end);
    }
    let _ = std::fs::OpenOptions::new().create(true).append(true).open(&path)
        .and_then(|mut file| writeln!(file, "{}", line));
    // hard cap: keep the file bounded even if the flag lingers
    if let Ok(meta) = std::fs::metadata(&path) {
        if meta.len() > 1024 * 1024 {
            let _ = std::fs::remove_file(&path);
        }
    }
}

fn handle_intercept_before(req: &Value) -> Value {
    dump_intercept_payload(req);
    let request_id = req.get("RequestID").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let scope = req
        .get("Metadata")
        .and_then(|m| m.get("caller_scope"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let key_id = with_runtime(|rt| rt.scopes.get(&scope).cloned()).flatten();
    let Some(key_id) = key_id else { return json!({}) };
    let now = now_ms();
    let minute = local_minute_of_day();
    // CPA 7.2.147+ carries the requested model on the intercept payload
    // (probed live: "Model" + Metadata.requested_model). Older hosts omit
    // it — the gate then degrades to advisory model scoping.
    let requested_model = req
        .get("Model")
        .and_then(|v| v.as_str())
        .or_else(|| req.get("Metadata").and_then(|m| m.get("requested_model")).and_then(|v| v.as_str()))
        .map(String::from);
    let gate = with_runtime(|rt| {
        roll_window(&mut rt.ledger, &rt.sync.window_day.clone());
        let key_cap = rt
            .sync
            .keys
            .iter()
            .find(|k| k.key_id == key_id)
            .map(|k| k.key_max_tokens)
            .unwrap_or(0);
        // Gate first, then reserve only admitted requests: a terminated request
        // gets no complete event to release its slot, and comparing the
        // pre-reservation count means `key_concurrency` admits exactly that
        // many in-flight requests.
        let gate = core_state::gate_request(&rt.ledger, &rt.sync, &key_id, key_cap, now, minute, requested_model.as_deref());
        if matches!(gate, Gate::Pass) && !request_id.is_empty() {
            rt.inflight_requests.insert(request_id.clone(), key_id.clone());
            *rt.ledger.inflight_by_key.entry(key_id.clone()).or_insert(0) += 1;
            if rt.inflight_requests.len() > 10_000 {
                // complete-event leak guard: evict an arbitrary half (HashMap
                // order) and rebuild the per-key inflight view from survivors
                let mut ids: Vec<String> = rt.inflight_requests.keys().cloned().collect();
                ids.truncate(rt.inflight_requests.len() / 2);
                for id in ids {
                    rt.inflight_requests.remove(&id);
                }
                rt.ledger.inflight_by_key = rt
                    .inflight_requests
                    .values()
                    .fold(HashMap::new(), |mut acc, kid| {
                        *acc.entry(kid.clone()).or_insert(0) += 1;
                        acc
                    });
            }
        }
        gate
    });
    match gate {
        Some(Gate::Pass) => json!({}),
        Some(Gate::TerminateBudget(reason)) => budget_exceeded_response("window_budget", &reason, 0),
        Some(Gate::TerminateKeyCap) => budget_exceeded_response("key_cap", "per-key token cap reached", 0),
        Some(Gate::TerminateConcurrency) => {
            budget_exceeded_response("key_concurrency", "too many concurrent requests for this key", 0)
        }
        Some(Gate::TerminateLane { reason, retry_after_secs }) => {
            budget_exceeded_response(&reason, &format!("sharing lane {}", reason), retry_after_secs)
        }
        None => json!({}),
    }
}

fn handle_complete(req: &Value) -> Value {
    let request_id = req.get("RequestID").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if request_id.is_empty() {
        return json!({});
    }
    with_runtime(|rt| {
        if let Some(key_id) = rt.inflight_requests.remove(&request_id) {
            if let Some(count) = rt.ledger.inflight_by_key.get_mut(&key_id) {
                *count = count.saturating_sub(1);
            }
        }
    });
    json!({})
}

/// usage.handle: settle by Principal (`atl:<keyId>`). APIKey carries the
/// Principal verbatim (validated in R22); TotalTokens is the CPA-native total.
/// Non-atl principals are the owner's own traffic: failures feed the wall
/// signal (advisory quota-pressure input for the owner card).
fn handle_usage(req: &Value) -> Value {
    let principal = req.get("APIKey").and_then(|v| v.as_str()).unwrap_or("");
    let failed = req.get("Failed").and_then(|v| v.as_bool()).unwrap_or(false);
    let Some(key_id) = principal.strip_prefix("atl:") else {
        if failed {
            with_runtime(|rt| rt.owner_failures += 1);
        }
        return json!({});
    };
    let key_id = key_id.to_string();
    let detail = req.get("Detail").cloned().unwrap_or(Value::Null);
    let tokens = detail.get("TotalTokens").and_then(|v| v.as_i64()).unwrap_or(0).max(0) as u64;
    let now = now_ms();
    let minute = local_minute_of_day();
    with_runtime(|rt| {
        roll_window(&mut rt.ledger, &rt.sync.window_day.clone());
        let mut delta = core_state::apply_usage(&mut rt.ledger.settled_by_key, &key_id, tokens);
        if failed {
            delta.failed = 1;
        }
        // Lane settlement (peak multiplier applies at the event minute)
        if let Some(entry) = rt.sync.keys.iter().find(|k| k.key_id == key_id) {
            if let Some(lane) = rt.sync.lanes.iter().find(|l| l.id == entry.lane_id) {
                core_state::settle_lane_usage(lane, &mut rt.ledger.lane_settled, tokens, now, minute);
            }
        }
        merge_delta(&mut rt.pending_usage, delta);
    });
    json!({})
}

fn handle(method: &str, request: &[u8]) -> Result<Value, String> {
    let req: Value = if request.is_empty() {
        json!({})
    } else {
        serde_json::from_slice(request).map_err(|e| format!("bad request json: {}", e))?
    };
    match method {
        "plugin.register" | "plugin.reconfigure" => Ok(handle_lifecycle(&req)),
        "plugin.quiesce" => Ok(registration()),
        "frontend_auth.identifier" => Ok(json!({ "Identifier": PLUGIN_ID })),
        "frontend_auth.authenticate" => Ok(handle_authenticate(&req)),
        "request.intercept_before" => Ok(handle_intercept_before(&req)),
        "request.intercept_after" => Ok(json!({})),
        "request.complete" => Ok(handle_complete(&req)),
        "usage.handle" => Ok(handle_usage(&req)),
        "plugin.shutdown" => Ok(json!({})),
        other => Err(format!("unknown method: {}", other)),
    }
}

// ───────────────────────── sync thread ─────────────────────────

fn spawn_sync_thread() {
    // Spawn failure is non-fatal: the plugin still serves auth from the last
    // snapshot and goes fail-closed via BACKEND_STALE_MS once it goes stale.
    let _ = std::thread::Builder::new()
        .name("atl-share-sync".into())
        .spawn(|| {
            loop {
                for _ in 0..(SYNC_INTERVAL_MS / 500) {
                    if SHUTDOWN.load(Ordering::Relaxed) {
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(500));
                }
                if SHUTDOWN.load(Ordering::Relaxed) {
                    return;
                }
                // The whole tick is panic-contained: a broken round must never
                // take down the CPA host process.
                let _ = std::panic::catch_unwind(sync::tick);
            }
        });
}

// ───────────────────────── ABI surface ─────────────────────────

unsafe extern "C" fn plugin_call(method: *const c_char, request: *const u8, request_len: usize, response: *mut Buffer) -> c_int {
    if !response.is_null() {
        (*response).ptr = ptr::null_mut();
        (*response).len = 0;
    }
    if method.is_null() {
        return 1;
    }
    let method = CStr::from_ptr(method).to_string_lossy().into_owned();
    let req_bytes: Vec<u8> = if request.is_null() || request_len == 0 {
        Vec::new()
    } else {
        std::slice::from_raw_parts(request, request_len).to_vec()
    };
    // Panic boundary: we are a guest in the host process — any handler panic
    // degrades to a plugin-error envelope, never aborts CPA.
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| handle(&method, &req_bytes)));
    let body = match outcome {
        Ok(Ok(result)) => json!({ "ok": true, "result": result }).to_string(),
        Ok(Err(message)) => {
            json!({ "ok": false, "error": { "code": "plugin_error", "message": message } }).to_string()
        }
        Err(_) => json!({ "ok": false, "error": { "code": "plugin_panicked", "message": "atl-share handler panicked" } }).to_string(),
    };
    if !response.is_null() && !body.is_empty() {
        let buf = libc::malloc(body.len()) as *mut c_void;
        if !buf.is_null() {
            ptr::copy_nonoverlapping(body.as_ptr(), buf as *mut u8, body.len());
            (*response).ptr = buf;
            (*response).len = body.len();
        }
    }
    0
}

unsafe extern "C" fn plugin_free(ptr_value: *mut c_void, _len: usize) {
    if !ptr_value.is_null() {
        libc::free(ptr_value);
    }
}

unsafe extern "C" fn plugin_shutdown() {
    SHUTDOWN.store(true, Ordering::Relaxed);
}

#[no_mangle]
pub unsafe extern "C" fn cliproxy_plugin_init(_host: *const HostApi, plugin: *mut PluginApi) -> c_int {
    if plugin.is_null() {
        return 1;
    }
    let _ = std::fs::create_dir_all(data_dir());
    {
        let mut guard = RUNTIME.lock().unwrap_or_else(|e| e.into_inner());
        if guard.is_none() {
            *guard = Some(Runtime::new());
        }
    }
    (*plugin).abi_version = 1;
    (*plugin).call = Some(plugin_call);
    (*plugin).free_buffer = Some(plugin_free);
    (*plugin).shutdown = Some(plugin_shutdown);
    // A shutdown → re-init cycle in the same process must revive the loop —
    // the flag is only meant to stop the thread running at shutdown time.
    SHUTDOWN.store(false, Ordering::Relaxed);
    spawn_sync_thread();
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn install_test_runtime(key_concurrency: u32) {
        let mut rt = Runtime::new();
        rt.sync = crate::core_state::SyncState {
            state: "active".into(),
            key_concurrency,
            configured: true,
            keys: vec![crate::bootstrap::KeyEntry {
                key_id: "k1".into(),
                token: "atl_sk_test".into(),
                key_max_tokens: 0,
                expires_at_ms: 0,
                lane_id: "default".into(),
            }],
            ..Default::default()
        };
        rt.scopes.insert("scope-1".into(), "k1".into());
        let mut guard = RUNTIME.lock().unwrap_or_else(|e| e.into_inner());
        *guard = Some(rt);
    }

    fn intercept(request_id: &str) -> Value {
        handle_intercept_before(&json!({
            "RequestID": request_id,
            "Metadata": { "caller_scope": "scope-1" }
        }))
    }

    fn inflight_for_key() -> Option<u32> {
        with_runtime(|rt| rt.ledger.inflight_by_key.get("k1").copied()).flatten()
    }

    #[test]
    fn concurrency_gate_admits_exactly_the_cap_and_terminated_requests_leak_no_slot() {
        install_test_runtime(2);
        // the cap compares the pre-reservation count: 2 admitted, 3rd terminated
        assert!(intercept("r1").get("Terminate").is_none());
        assert!(intercept("r2").get("Terminate").is_none());
        assert!(intercept("r3").get("Terminate").is_some());
        // the terminated request reserved nothing — no leaked slot
        assert_eq!(inflight_for_key(), Some(2));
        // completing an admitted request frees its slot for the next caller
        handle_complete(&json!({ "RequestID": "r1" }));
        assert!(intercept("r4").get("Terminate").is_none());
        // a stray complete for the terminated id is a harmless no-op
        handle_complete(&json!({ "RequestID": "r3" }));
        assert_eq!(inflight_for_key(), Some(2));
    }
}
