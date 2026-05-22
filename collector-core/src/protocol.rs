use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize)]
pub struct SidecarRequest {
    pub id: String,
    pub command: String,
    pub args: serde_json::Value,
}

#[derive(Debug, Clone, Serialize)]
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
