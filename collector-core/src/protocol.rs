use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SidecarRequest {
    pub id: String,
    pub command: String,
    pub args: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SidecarResponse {
    pub id: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SidecarEvent {
    pub event: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Command {
    ConfigGet,
    ApiCheck,
    ConfigInit,
    ConfigUpdate,
    IdentityExportPrepare,
    IdentityImportApply,
    ConfigExportPrepare,
    ConfigImportApply,
    DiagnosticsExportPrepare,
    DiagnosticsStatus,
    DiagnosticsClearRuntimeLog,
    LocalBackupExportPrepare,
    LocalBackupStatus,
    LocalBackupCreate,
    LocalBackupClear,
    LocalBackupRunDueAuto,
    LocalBackupInspect,
    LocalBackupRestoreApply,
    ProvidersAddRoot,
    ConfigRemoveProviderRoot,
    CursorAddToken,
    CursorRemoveToken,
    CursorConnectStart,
    CursorConnectPoll,
    CursorConnectCancel,
    CursorDisconnect,
    ConfigIgnoreAutoSource,
    ConfigUnignoreAutoSource,
    BackgroundStatus,
    WorkdirsSetAlias,
    ProvidersHealth,
    PricingModelPrices,
    UsageScan,
    UsageScanStart,
    UsageScanStatus,
    UsageSummary,
    UsageTrend,
    UsageWorkdirs,
    UsageDetailPage,
    UsageDetailWindow,
    UsageSync,
    UsageSyncStart,
    UsageFullReconcileStart,
    UsageFullReconcileStatus,
    MyIdentity,
    AppVersion,
    UpdateDownloadInstaller,
    UpdateEnforcementStatus,
    AppResetLocalData,
    AppResetWithCloud,
    RuntimeLog,
    TrayCostState,
    TrayRebuildMenu,
    TrayMenuData,
    TrayRefreshNow,
    Ping,
}

impl Command {
    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "config:get" => Some(Self::ConfigGet),
            "api:check" => Some(Self::ApiCheck),
            "config:init" => Some(Self::ConfigInit),
            "config:update" => Some(Self::ConfigUpdate),
            "identity:export:prepare" => Some(Self::IdentityExportPrepare),
            "identity:import:apply" => Some(Self::IdentityImportApply),
            "config:export:prepare" => Some(Self::ConfigExportPrepare),
            "config:import:apply" => Some(Self::ConfigImportApply),
            "diagnostics:export:prepare" => Some(Self::DiagnosticsExportPrepare),
            "diagnostics:status" => Some(Self::DiagnosticsStatus),
            "diagnostics:clear-runtime-log" => Some(Self::DiagnosticsClearRuntimeLog),
            "local-backup:export:prepare" => Some(Self::LocalBackupExportPrepare),
            "local-backup:status" => Some(Self::LocalBackupStatus),
            "local-backup:create" => Some(Self::LocalBackupCreate),
            "local-backup:clear" => Some(Self::LocalBackupClear),
            "local-backup:run-due-auto" => Some(Self::LocalBackupRunDueAuto),
            "local-backup:inspect" => Some(Self::LocalBackupInspect),
            "local-backup:restore:apply" => Some(Self::LocalBackupRestoreApply),
            "providers:add-root" => Some(Self::ProvidersAddRoot),
            "config:remove-provider-root" => Some(Self::ConfigRemoveProviderRoot),
            "cursor:add-token" => Some(Self::CursorAddToken),
            "cursor:remove-token" => Some(Self::CursorRemoveToken),
            "cursor:connect:start" => Some(Self::CursorConnectStart),
            "cursor:connect:poll" => Some(Self::CursorConnectPoll),
            "cursor:connect:cancel" => Some(Self::CursorConnectCancel),
            "cursor:disconnect" => Some(Self::CursorDisconnect),
            "config:ignore-auto-source" => Some(Self::ConfigIgnoreAutoSource),
            "config:unignore-auto-source" => Some(Self::ConfigUnignoreAutoSource),
            "background:status" => Some(Self::BackgroundStatus),
            "workdirs:set-alias" => Some(Self::WorkdirsSetAlias),
            "providers:health" => Some(Self::ProvidersHealth),
            "pricing:model-prices" => Some(Self::PricingModelPrices),
            "usage:scan" => Some(Self::UsageScan),
            "usage:scan-start" => Some(Self::UsageScanStart),
            "usage:scan-status" => Some(Self::UsageScanStatus),
            "usage:summary" => Some(Self::UsageSummary),
            "usage:trend" => Some(Self::UsageTrend),
            "usage:workdirs" => Some(Self::UsageWorkdirs),
            "usage:detail-page" => Some(Self::UsageDetailPage),
            "usage:detail-window" => Some(Self::UsageDetailWindow),
            "usage:sync" => Some(Self::UsageSync),
            "usage:sync-start" => Some(Self::UsageSyncStart),
            "usage:full-reconcile-start" => Some(Self::UsageFullReconcileStart),
            "usage:full-reconcile-status" => Some(Self::UsageFullReconcileStatus),
            "my-identity" => Some(Self::MyIdentity),
            "app:version" => Some(Self::AppVersion),
            "update:download-installer" => Some(Self::UpdateDownloadInstaller),
            "update:enforcement-status" => Some(Self::UpdateEnforcementStatus),
            "app:reset-local-data" => Some(Self::AppResetLocalData),
            "app:reset-with-cloud" => Some(Self::AppResetWithCloud),
            "runtime:log" => Some(Self::RuntimeLog),
            "tray:cost-state" => Some(Self::TrayCostState),
            "tray:rebuild-menu" => Some(Self::TrayRebuildMenu),
            "tray:menu-data" => Some(Self::TrayMenuData),
            "tray:refresh-now" => Some(Self::TrayRefreshNow),
            "ping" => Some(Self::Ping),
            _ => None,
        }
    }
}

impl SidecarResponse {
    pub fn ok(id: String, data: serde_json::Value) -> Self {
        Self {
            id,
            ok: true,
            data: Some(data),
            error: None,
        }
    }

    pub fn error(id: String, msg: impl Into<String>) -> Self {
        Self {
            id,
            ok: false,
            data: None,
            error: Some(msg.into()),
        }
    }
}

impl SidecarEvent {
    pub fn new(event: impl Into<String>, data: serde_json::Value) -> Self {
        Self {
            event: event.into(),
            data: if data.is_null() { None } else { Some(data) },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_command_from_str_all_known_commands() {
        let commands = [
            ("config:get", Command::ConfigGet),
            ("api:check", Command::ApiCheck),
            ("config:init", Command::ConfigInit),
            ("config:update", Command::ConfigUpdate),
            ("identity:export:prepare", Command::IdentityExportPrepare),
            ("identity:import:apply", Command::IdentityImportApply),
            ("config:export:prepare", Command::ConfigExportPrepare),
            ("config:import:apply", Command::ConfigImportApply),
            (
                "diagnostics:export:prepare",
                Command::DiagnosticsExportPrepare,
            ),
            ("diagnostics:status", Command::DiagnosticsStatus),
            (
                "diagnostics:clear-runtime-log",
                Command::DiagnosticsClearRuntimeLog,
            ),
            (
                "local-backup:export:prepare",
                Command::LocalBackupExportPrepare,
            ),
            ("local-backup:status", Command::LocalBackupStatus),
            ("local-backup:create", Command::LocalBackupCreate),
            ("local-backup:clear", Command::LocalBackupClear),
            ("local-backup:run-due-auto", Command::LocalBackupRunDueAuto),
            ("local-backup:inspect", Command::LocalBackupInspect),
            (
                "local-backup:restore:apply",
                Command::LocalBackupRestoreApply,
            ),
            ("providers:add-root", Command::ProvidersAddRoot),
            (
                "config:remove-provider-root",
                Command::ConfigRemoveProviderRoot,
            ),
            ("cursor:add-token", Command::CursorAddToken),
            ("cursor:remove-token", Command::CursorRemoveToken),
            ("cursor:connect:start", Command::CursorConnectStart),
            ("cursor:connect:poll", Command::CursorConnectPoll),
            ("cursor:connect:cancel", Command::CursorConnectCancel),
            ("cursor:disconnect", Command::CursorDisconnect),
            ("config:ignore-auto-source", Command::ConfigIgnoreAutoSource),
            (
                "config:unignore-auto-source",
                Command::ConfigUnignoreAutoSource,
            ),
            ("background:status", Command::BackgroundStatus),
            ("workdirs:set-alias", Command::WorkdirsSetAlias),
            ("providers:health", Command::ProvidersHealth),
            ("pricing:model-prices", Command::PricingModelPrices),
            ("usage:scan", Command::UsageScan),
            ("usage:scan-start", Command::UsageScanStart),
            ("usage:scan-status", Command::UsageScanStatus),
            ("usage:summary", Command::UsageSummary),
            ("usage:trend", Command::UsageTrend),
            ("usage:workdirs", Command::UsageWorkdirs),
            ("usage:detail-page", Command::UsageDetailPage),
            ("usage:detail-window", Command::UsageDetailWindow),
            ("usage:sync", Command::UsageSync),
            ("usage:sync-start", Command::UsageSyncStart),
            (
                "usage:full-reconcile-start",
                Command::UsageFullReconcileStart,
            ),
            (
                "usage:full-reconcile-status",
                Command::UsageFullReconcileStatus,
            ),
            ("my-identity", Command::MyIdentity),
            ("app:version", Command::AppVersion),
            (
                "update:download-installer",
                Command::UpdateDownloadInstaller,
            ),
            (
                "update:enforcement-status",
                Command::UpdateEnforcementStatus,
            ),
            ("app:reset-local-data", Command::AppResetLocalData),
            ("app:reset-with-cloud", Command::AppResetWithCloud),
            ("runtime:log", Command::RuntimeLog),
            ("tray:cost-state", Command::TrayCostState),
            ("tray:rebuild-menu", Command::TrayRebuildMenu),
            ("tray:menu-data", Command::TrayMenuData),
            ("tray:refresh-now", Command::TrayRefreshNow),
            ("ping", Command::Ping),
        ];
        for (s, expected) in &commands {
            assert_eq!(
                Command::from_str(s),
                Some(expected.clone()),
                "failed for '{}'",
                s
            );
        }
    }

    #[test]
    fn test_command_from_str_unknown_returns_none() {
        assert!(Command::from_str("").is_none());
        assert!(Command::from_str("unknown:command").is_none());
        assert!(Command::from_str("config:get ").is_none()); // trailing space
        assert!(Command::from_str("CONFIG:GET").is_none()); // case-sensitive
    }

    #[test]
    fn test_sidecar_response_ok() {
        let resp = SidecarResponse::ok("req-1".into(), serde_json::json!({"count": 42}));
        assert_eq!(resp.id, "req-1");
        assert!(resp.ok);
        assert_eq!(resp.data.unwrap()["count"], 42);
        assert!(resp.error.is_none());
    }

    #[test]
    fn test_sidecar_response_error() {
        let resp = SidecarResponse::error("req-2".into(), "something failed");
        assert_eq!(resp.id, "req-2");
        assert!(!resp.ok);
        assert!(resp.data.is_none());
        assert_eq!(resp.error.unwrap(), "something failed");
    }

    #[test]
    fn test_sidecar_event_new_with_data() {
        let evt = SidecarEvent::new("scan-complete", serde_json::json!({"rows": 10}));
        assert_eq!(evt.event, "scan-complete");
        assert_eq!(evt.data.unwrap()["rows"], 10);
    }

    #[test]
    fn test_sidecar_event_new_with_null() {
        let evt = SidecarEvent::new("ping", serde_json::Value::Null);
        assert_eq!(evt.event, "ping");
        assert!(evt.data.is_none(), "null data should become None");
    }

    #[test]
    fn test_sidecar_response_serialization() {
        let ok_resp = SidecarResponse::ok("r1".into(), serde_json::json!(true));
        let json = serde_json::to_string(&ok_resp).unwrap();
        assert!(json.contains("\"ok\":true"));
        assert!(json.contains("\"id\":\"r1\""));

        let err_resp = SidecarResponse::error("r2".into(), "fail");
        let json = serde_json::to_string(&err_resp).unwrap();
        assert!(json.contains("\"ok\":false"));
        assert!(
            !json.contains("\"data\""),
            "data should be skipped when None"
        );
    }

    #[test]
    fn test_sidecar_request_deserialization() {
        let json = r#"{"id":"r3","command":"usage:scan","args":{"force":true}}"#;
        let req: SidecarRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.id, "r3");
        assert_eq!(req.command, "usage:scan");
        assert_eq!(req.args["force"], true);
    }
}
