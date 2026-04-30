CREATE TABLE IF NOT EXISTS participants (
  id VARCHAR(96) PRIMARY KEY,
  nickname VARCHAR(128) NOT NULL,
  avatarColor VARCHAR(32) NOT NULL,
  identityPublicKey TEXT NOT NULL,
  createdAt VARCHAR(40) NOT NULL,
  updatedAt VARCHAR(40) NOT NULL,
  lastSeenAt VARCHAR(40) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS devices (
  id VARCHAR(96) PRIMARY KEY,
  participantId VARCHAR(96) NOT NULL,
  os VARCHAR(64) NOT NULL,
  appVersion VARCHAR(64) NOT NULL,
  createdAt VARCHAR(40) NOT NULL,
  lastSeenAt VARCHAR(40) NOT NULL,
  revokedAt VARCHAR(40) NULL,
  INDEX idx_devices_participant (participantId),
  CONSTRAINT fk_devices_participant FOREIGN KEY (participantId) REFERENCES participants(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS workdirs (
  id VARCHAR(180) PRIMARY KEY,
  participantId VARCHAR(96) NOT NULL,
  workdirHash VARCHAR(128) NOT NULL,
  alias VARCHAR(255) NOT NULL,
  detectedName VARCHAR(255) NOT NULL,
  displayName VARCHAR(255) NOT NULL,
  sourceProvider VARCHAR(96) NOT NULL,
  createdAt VARCHAR(40) NOT NULL,
  updatedAt VARCHAR(40) NOT NULL,
  lastSeenAt VARCHAR(40) NOT NULL,
  UNIQUE KEY uq_workdirs_participant_hash (participantId, workdirHash),
  INDEX idx_workdirs_display (displayName),
  CONSTRAINT fk_workdirs_participant FOREIGN KEY (participantId) REFERENCES participants(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS model_prices (
  model VARCHAR(190) PRIMARY KEY,
  inputCostPerMTok DECIMAL(18,8) NOT NULL DEFAULT 0,
  outputCostPerMTok DECIMAL(18,8) NOT NULL DEFAULT 0,
  cacheReadCostPerMTok DECIMAL(18,8) NOT NULL DEFAULT 0,
  cacheWriteCostPerMTok DECIMAL(18,8) NOT NULL DEFAULT 0,
  reasoningCostPerMTok DECIMAL(18,8) NOT NULL DEFAULT 0,
  source VARCHAR(64) NOT NULL DEFAULT 'custom',
  notes TEXT,
  updatedAt VARCHAR(40) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS model_price_cache (
  model VARCHAR(190) PRIMARY KEY,
  inputCostPerToken DECIMAL(24,18) NOT NULL DEFAULT 0,
  outputCostPerToken DECIMAL(24,18) NOT NULL DEFAULT 0,
  cacheReadCostPerToken DECIMAL(24,18) NOT NULL DEFAULT 0,
  cacheWriteCostPerToken DECIMAL(24,18) NOT NULL DEFAULT 0,
  reasoningCostPerToken DECIMAL(24,18) NOT NULL DEFAULT 0,
  maxInputTokens BIGINT NOT NULL DEFAULT 0,
  maxOutputTokens BIGINT NOT NULL DEFAULT 0,
  source VARCHAR(64) NOT NULL DEFAULT 'openrouter',
  pricingVersion VARCHAR(128) NOT NULL DEFAULT '',
  updatedAt VARCHAR(40) NOT NULL,
  rawJson JSON NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS model_price_cache_meta (
  source VARCHAR(64) PRIMARY KEY,
  url TEXT,
  status VARCHAR(32) NOT NULL DEFAULT 'empty',
  fetchedAt VARCHAR(40) NOT NULL DEFAULT '',
  expiresAt VARCHAR(40) NOT NULL DEFAULT '',
  pricingVersion VARCHAR(128) NOT NULL DEFAULT '',
  modelCount INT NOT NULL DEFAULT 0,
  skipped INT NOT NULL DEFAULT 0,
  lastError TEXT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS usage_daily (
  usageKey VARCHAR(512) PRIMARY KEY,
  day DATE NOT NULL,
  participantId VARCHAR(96) NOT NULL,
  deviceId VARCHAR(96) NOT NULL,
  toolCode VARCHAR(96) NOT NULL,
  providerId VARCHAR(96) NOT NULL,
  workdirId VARCHAR(180) NOT NULL,
  workdirHash VARCHAR(128) NOT NULL,
  workdirDisplayName VARCHAR(255) NOT NULL,
  model VARCHAR(190) NOT NULL,
  inputTokens BIGINT NOT NULL DEFAULT 0,
  outputTokens BIGINT NOT NULL DEFAULT 0,
  cacheReadTokens BIGINT NOT NULL DEFAULT 0,
  cacheWriteTokens BIGINT NOT NULL DEFAULT 0,
  reasoningTokens BIGINT NOT NULL DEFAULT 0,
  totalTokens BIGINT NOT NULL DEFAULT 0,
  estimatedCostUsd DECIMAL(18,8) NULL,
  costQuality VARCHAR(32) NOT NULL DEFAULT '',
  pricingVersion VARCHAR(128) NOT NULL DEFAULT '',
  pricingModel VARCHAR(190) NOT NULL DEFAULT '',
  pricingSource VARCHAR(64) NOT NULL DEFAULT '',
  sourceQuality VARCHAR(32) NOT NULL DEFAULT 'unknown',
  rawSourceRef VARCHAR(255) NOT NULL DEFAULT '',
  providerVersion VARCHAR(64) NOT NULL DEFAULT '',
  parserVersion VARCHAR(64) NOT NULL DEFAULT '',
  sourceFingerprint VARCHAR(128) NOT NULL DEFAULT '',
  uploadedAt VARCHAR(40) NULL,
  INDEX idx_usage_day_tokens (day, totalTokens),
  INDEX idx_usage_participant_day (participantId, day),
  INDEX idx_usage_model_day (model, day),
  INDEX idx_usage_provider_day (providerId, day),
  INDEX idx_usage_workdir_day (workdirHash, day),
  CONSTRAINT fk_usage_participant FOREIGN KEY (participantId) REFERENCES participants(id),
  CONSTRAINT fk_usage_device FOREIGN KEY (deviceId) REFERENCES devices(id),
  CONSTRAINT fk_usage_workdir FOREIGN KEY (workdirId) REFERENCES workdirs(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS upload_batches (
  id VARCHAR(96) PRIMARY KEY,
  participantId VARCHAR(96) NOT NULL,
  deviceId VARCHAR(96) NOT NULL,
  payloadHash VARCHAR(128) NOT NULL UNIQUE,
  clientGeneratedAt VARCHAR(40) NOT NULL,
  receivedAt VARCHAR(40) NOT NULL,
  status VARCHAR(32) NOT NULL,
  accepted INT NOT NULL DEFAULT 0,
  rejected INT NOT NULL DEFAULT 0,
  errorReason TEXT,
  INDEX idx_upload_batches_participant (participantId, receivedAt),
  CONSTRAINT fk_upload_batches_participant FOREIGN KEY (participantId) REFERENCES participants(id),
  CONSTRAINT fk_upload_batches_device FOREIGN KEY (deviceId) REFERENCES devices(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
