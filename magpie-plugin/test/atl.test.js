import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  canonicalJson,
  sha256Hex,
  signPayload,
  verifyPayload,
  computeBucketFingerprint,
  localDayAndHour,
  buildPublicUsageItem,
  assertNoForbiddenUploadFields,
  virtualWorkdirHash,
  generateIdentity
} from "../lib/atl.js";

// Golden vector generated once with the AI Token League repo's own
// src/shared/crypto.js + src/shared/schema.js (Node). The identity below is a
// throwaway test identity, never registered anywhere.
const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/golden-signature.json", import.meta.url)), "utf8")
);

describe("golden cross-implementation vector (vs ATL src/shared)", () => {
  test("canonicalJson round-trips the official canonical form", () => {
    const payload = JSON.parse(fixture.canonical);
    expect(canonicalJson(payload)).toBe(fixture.canonical);
  });

  test("signPayload reproduces the official Ed25519 signature byte-for-byte", () => {
    const payload = JSON.parse(fixture.canonical);
    expect(signPayload(fixture.privateKey, payload)).toBe(fixture.signature);
  });

  test("verifyPayload accepts the official signature", () => {
    const payload = JSON.parse(fixture.canonical);
    expect(verifyPayload(fixture.publicKey, payload, fixture.signature)).toBe(true);
  });

  test("signature breaks when payload is tampered", () => {
    const payload = JSON.parse(fixture.canonical);
    payload.items[0].inputTokens = 999;
    expect(verifyPayload(fixture.publicKey, payload, fixture.signature)).toBe(false);
  });

  test("computeBucketFingerprint matches the official value and is order-independent", () => {
    const items = JSON.parse(fixture.canonical).items;
    expect(computeBucketFingerprint(items)).toBe(fixture.expectedFingerprint);
    expect(computeBucketFingerprint([...items].reverse())).toBe(fixture.expectedFingerprint);
  });
});

describe("date bucketing (local timezone semantics)", () => {
  test("ledger +08:00 timestamps land in the local day/hour", () => {
    const { day, hour } = localDayAndHour(new Date("2026-10-31T23:58:38+08:00"), "Asia/Shanghai");
    expect(day).toBe("2026-10-31");
    expect(hour).toBe(23);
  });

  test("same instant in UTC tz lands in UTC day/hour", () => {
    const { day, hour } = localDayAndHour(new Date("2026-10-31T23:58:38+08:00"), "UTC");
    expect(day).toBe("2026-10-31");
    expect(hour).toBe(15);
  });

  test("day rollover across midnight", () => {
    const { day, hour } = localDayAndHour(new Date("2026-11-01T00:00:07+08:00"), "Asia/Shanghai");
    expect(day).toBe("2026-11-01");
    expect(hour).toBe(0);
  });
});

describe("usage item whitelist", () => {
  const base = {
    day: "2026-10-31",
    hour: 23,
    toolCode: "codex",
    providerId: "codex_local",
    workdirHash: virtualWorkdirHash("magpie", "p_test"),
    workdirDisplayName: "Magpie",
    model: "gpt-5.6-terra",
    inputTokens: 100.4,
    outputTokens: 20,
    cacheReadTokens: 30,
    cacheWriteTokens: 0,
    reasoningTokens: 5,
    sourceQuality: "exact"
  };

  test("buildPublicUsageItem recomputes totalTokens from the four components", () => {
    const item = buildPublicUsageItem(base);
    expect(item.totalTokens).toBe(150); // 100(rounded)+20+30+0, server recomputes the same way
    expect(item.hour).toBe(23);
    expect(Object.keys(item).length).toBe(18);
  });

  test("whitelist drops any extra field an attacker-ish caller tried to sneak in", () => {
    const item = buildPublicUsageItem({ ...base, providerAccount: "someone@example.com", host: "evil", session: "s" });
    expect(item.providerAccount).toBeUndefined();
    expect(item.host).toBeUndefined();
    expect(JSON.stringify(item)).not.toContain("example.com");
  });

  test("forbidden top-level field throws", () => {
    expect(() => assertNoForbiddenUploadFields({ prompt: "x" })).toThrow(/forbidden upload field/);
    expect(() => assertNoForbiddenUploadFields({ nested: { identityPrivateKey: "y" } })).toThrow(/forbidden upload field/);
  });

  test("missing required field throws", () => {
    const { model, ...noModel } = base;
    void model;
    expect(() => buildPublicUsageItem(noModel)).toThrow(/missing model/);
  });
});

describe("identity generation", () => {
  test("generates ATL-shaped ids and PEMs", () => {
    const identity = generateIdentity();
    expect(identity.participantId).toMatch(/^p_[0-9a-f]{24}$/);
    expect(identity.identityPublicKey).toMatch(/^-----BEGIN PUBLIC KEY-----/);
    expect(identity.identityPrivateKey).toMatch(/^-----BEGIN PRIVATE KEY-----/);
    const payload = { hello: "world" };
    const sig = signPayload(identity.identityPrivateKey, payload);
    expect(verifyPayload(identity.identityPublicKey, payload, sig)).toBe(true);
  });

  test("virtual workdir hash is stable and participant-salted", () => {
    const a = virtualWorkdirHash("magpie", "p_a");
    const b = virtualWorkdirHash("magpie", "p_b");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
    expect(a).toBe(sha256Hex("virtual:magpie:p_a"));
  });
});
