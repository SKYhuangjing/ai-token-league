import { describe, it, expect } from 'vitest';
import { canonicalJson, sha256Hex, hmacSha256Hex, newId, generateIdentity, signPayload, verifyPayload } from '../../../src/shared/crypto.js';

describe('canonicalJson', () => {
  it('produces deterministic output', () => {
    const obj = { b: 2, a: 1, c: { z: 3, y: 4 } };
    const j1 = canonicalJson(obj);
    const j2 = canonicalJson(obj);
    expect(j1).toBe(j2);
  });

  it('sorts keys recursively', () => {
    const j = canonicalJson({ b: 1, a: 2 });
    expect(j.indexOf('"a"')).toBeLessThan(j.indexOf('"b"'));
  });

  it('handles arrays', () => {
    const j = canonicalJson([3, 1, 2]);
    expect(j).toBe('[3,1,2]');
  });
});

describe('sha256Hex', () => {
  it('returns 64-char hex string', () => {
    const hash = sha256Hex('hello');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic', () => {
    expect(sha256Hex('test')).toBe(sha256Hex('test'));
  });

  it('differs for different inputs', () => {
    expect(sha256Hex('a')).not.toBe(sha256Hex('b'));
  });
});

describe('hmacSha256Hex', () => {
  it('returns 64-char hex string', () => {
    const hash = hmacSha256Hex('key', 'data');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic', () => {
    expect(hmacSha256Hex('k', 'd')).toBe(hmacSha256Hex('k', 'd'));
  });

  it('differs for different keys', () => {
    expect(hmacSha256Hex('k1', 'd')).not.toBe(hmacSha256Hex('k2', 'd'));
  });
});

describe('newId', () => {
  it('starts with prefix', () => {
    expect(newId('test')).toMatch(/^test_/);
  });

  it('generates unique ids', () => {
    const ids = new Set();
    for (let i = 0; i < 100; i++) ids.add(newId('x'));
    expect(ids.size).toBe(100);
  });
});

describe('generateIdentity', () => {
  it('generates valid identity', () => {
    const id = generateIdentity();
    expect(id.participantId).toMatch(/^p_/);
    expect(id.identityPublicKey).toContain('PUBLIC KEY');
    expect(id.identityPrivateKey).toContain('PRIVATE KEY');
  });

  it('generates unique identities', () => {
    const id1 = generateIdentity();
    const id2 = generateIdentity();
    expect(id1.participantId).not.toBe(id2.participantId);
  });
});

describe('signPayload / verifyPayload', () => {
  it('signs and verifies', () => {
    const id = generateIdentity();
    const payload = { hello: 'world', items: [{ tokens: 100 }] };
    const sig = signPayload(id.identityPrivateKey, payload);
    expect(typeof sig).toBe('string');
    expect(sig.length).toBeGreaterThan(0);
    expect(verifyPayload(id.identityPublicKey, payload, sig)).toBe(true);
  });

  it('rejects tampered payload', () => {
    const id = generateIdentity();
    const payload = { value: 100 };
    const sig = signPayload(id.identityPrivateKey, payload);
    const tampered = { value: 999 };
    expect(verifyPayload(id.identityPublicKey, tampered, sig)).toBe(false);
  });

  it('rejects wrong key', () => {
    const id1 = generateIdentity();
    const id2 = generateIdentity();
    const payload = { value: 100 };
    const sig = signPayload(id1.identityPrivateKey, payload);
    expect(verifyPayload(id2.identityPublicKey, payload, sig)).toBe(false);
  });

  it('rejects invalid signature', () => {
    const id = generateIdentity();
    expect(verifyPayload(id.identityPublicKey, { x: 1 }, 'not-a-sig')).toBe(false);
  });
});
