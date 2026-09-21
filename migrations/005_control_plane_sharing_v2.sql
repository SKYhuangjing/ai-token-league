-- 005: compute-sharing usability v2 (CS-06/CS-07).
-- The runtime applies these automatically via ensureMysqlSchema() when
-- DB_TYPE=mysql; this file documents the same DDL for manual/docker upgrades.

ALTER TABLE sharing_shares
  ADD COLUMN policyRev BIGINT NOT NULL DEFAULT 1 AFTER lastPluginVersion,
  ADD COLUMN policyAckedRev BIGINT NOT NULL DEFAULT 0 AFTER policyRev,
  ADD COLUMN lastProtocol INT NOT NULL DEFAULT 1 AFTER policyAckedRev;

ALTER TABLE sharing_claims
  ADD COLUMN lastSeq BIGINT NOT NULL DEFAULT 0 AFTER lastUsedAt,
  ADD COLUMN revokedBy VARCHAR(16) NOT NULL DEFAULT '' AFTER lastSeq,
  ADD COLUMN revokedAt BIGINT NOT NULL DEFAULT 0 AFTER revokedBy,
  ADD COLUMN revokeReason VARCHAR(80) NOT NULL DEFAULT '' AFTER revokedAt;
