export const RAIL_SYNC_STATE = Object.freeze({
  LOCAL_ONLY: "local_only",
  SYNCING: "syncing",
  NEEDS_SYNC: "needs_sync",
  SYNCED: "synced",
  ATTENTION: "attention",
});

export const RAIL_SYNC_REASON = Object.freeze({
  NO_API: "no_api",
  CHECKING_CONNECTION: "checking_connection",
  SCANNING: "scanning",
  UPLOADING: "uploading",
  RETRYING_QUEUE: "retrying_queue",
  NEVER_SYNCED_CURRENT_SERVER: "never_synced_current_server",
  LOCAL_CHANGED_AFTER_SYNC: "local_changed_after_sync",
  QUEUED_RETRY: "queued_retry",
  LAST_FAILED: "last_failed",
  CLOUD_UNREACHABLE: "cloud_unreachable",
  CLOUD_INCOMPATIBLE: "cloud_incompatible",
});
