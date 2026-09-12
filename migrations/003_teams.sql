-- 003: admin team labels for the team analysis board.
-- The runtime also applies this via ensureMysqlSchema(); this file documents
-- the change for manual/Docker deployments (see doc/test-deployment.md).
CREATE TABLE IF NOT EXISTS teams (
  id VARCHAR(96) PRIMARY KEY,
  name VARCHAR(128) NOT NULL,
  createdAt VARCHAR(40) NOT NULL,
  updatedAt VARCHAR(40) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE participants ADD COLUMN teamId VARCHAR(96) NOT NULL DEFAULT '' AFTER lastSeenAt;

CREATE INDEX idx_participants_team ON participants (teamId);
