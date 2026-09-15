-- 004: plugin catalog listing + compute-sharing control plane.
-- The runtime also applies this via ensureMysqlSchema() when DB_TYPE=mysql.
CREATE TABLE IF NOT EXISTS module_listings (
  id VARCHAR(96) PRIMARY KEY,
  listed TINYINT(1) NOT NULL,
  updatedAt VARCHAR(40) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sharing_shares (
  shareId VARCHAR(96) PRIMARY KEY,
  shareSecret VARCHAR(128) NOT NULL,
  state VARCHAR(32) NOT NULL,
  title VARCHAR(80) NOT NULL,
  baseURL VARCHAR(200) NOT NULL,
  modelsJson TEXT NOT NULL,
  policyJson TEXT NOT NULL,
  settledJson TEXT NOT NULL,
  lanesJson TEXT NULL,
  laneSettledJson TEXT NULL,
  wallSignalJson TEXT NULL,
  lifetimeSettled BIGINT NOT NULL DEFAULT 0,
  claimsIssued INT NOT NULL DEFAULT 0,
  participantId VARCHAR(96) NOT NULL DEFAULT '',
  ownerDisplayId VARCHAR(96) NOT NULL DEFAULT '',
  ownerNickname VARCHAR(80) NOT NULL DEFAULT '',
  windowDay VARCHAR(16) NOT NULL DEFAULT '',
  lastHeartbeatAt BIGINT NOT NULL DEFAULT 0,
  lastPluginVersion VARCHAR(64) NOT NULL DEFAULT '',
  createdAt BIGINT NOT NULL,
  updatedAt BIGINT NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sharing_claims (
  keyId VARCHAR(96) PRIMARY KEY,
  shareId VARCHAR(96) NOT NULL,
  laneId VARCHAR(96) NOT NULL DEFAULT '',
  shareTitle VARCHAR(80) NOT NULL DEFAULT '',
  token VARCHAR(128) NOT NULL,
  borrower VARCHAR(80) NOT NULL DEFAULT '',
  participantId VARCHAR(96) NOT NULL DEFAULT '',
  displayId VARCHAR(96) NOT NULL DEFAULT '',
  state VARCHAR(32) NOT NULL,
  usedTokens BIGINT NOT NULL DEFAULT 0,
  requests INT NOT NULL DEFAULT 0,
  failedRequests INT NOT NULL DEFAULT 0,
  createdAt BIGINT NOT NULL,
  expiresAt BIGINT NOT NULL,
  lastUsedAt BIGINT NOT NULL DEFAULT 0,
  INDEX idx_sharing_claims_share (shareId)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- lanes upgrade for existing installs (the runtime applies these automatically
-- via ensureMysqlSchema() when DB_TYPE=mysql):
-- ALTER TABLE sharing_shares
--   ADD COLUMN lanesJson TEXT NULL AFTER settledJson,
--   ADD COLUMN laneSettledJson TEXT NULL AFTER lanesJson,
--   ADD COLUMN wallSignalJson TEXT NULL AFTER laneSettledJson;
-- ALTER TABLE sharing_claims ADD COLUMN laneId VARCHAR(96) NOT NULL DEFAULT '' AFTER shareId;
