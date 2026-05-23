import { describe, it, expect } from 'vitest';
import { compareSemver, compatibilityResult, normalizeClientMetadata, CLIENT_PROTOCOL_VERSION, SERVER_PROTOCOL_VERSION, APP_VERSION } from '../../../src/shared/version.js';

describe('compareSemver', () => {
  it('returns 0 for equal versions', () => {
    expect(compareSemver('1.0.0', '1.0.0')).toBe(0);
  });

  it('returns -1 when a < b', () => {
    expect(compareSemver('1.0.0', '1.0.1')).toBe(-1);
    expect(compareSemver('1.0.0', '2.0.0')).toBe(-1);
  });

  it('returns 1 when a > b', () => {
    expect(compareSemver('1.0.1', '1.0.0')).toBe(1);
    expect(compareSemver('2.0.0', '1.0.0')).toBe(1);
  });

  it('compares major version first', () => {
    expect(compareSemver('2.0.0', '1.99.99')).toBe(1);
  });

  it('compares minor version', () => {
    expect(compareSemver('1.2.0', '1.1.9')).toBe(1);
  });
});

describe('compatibilityResult', () => {
  it('returns result with compatible field', () => {
    const result = compatibilityResult({
      clientAppVersion: APP_VERSION,
      clientProtocolVersion: CLIENT_PROTOCOL_VERSION,
    });
    expect(result.compatible).toBe(true);
    expect(result.status).toBeDefined();
  });

  it('handles undefined metadata', () => {
    const result = compatibilityResult(undefined);
    expect(result).toBeDefined();
    expect(result.status).toBeDefined();
  });
});

describe('normalizeClientMetadata', () => {
  it('returns object with expected fields', () => {
    const meta = normalizeClientMetadata();
    expect(meta).toHaveProperty('clientAppVersion');
    expect(meta).toHaveProperty('clientProtocolVersion');
    expect(meta).toHaveProperty('clientPlatform');
  });

  it('merges overrides', () => {
    const meta = normalizeClientMetadata({ clientAppVersion: '1.2.3' });
    expect(meta.clientAppVersion).toBe('1.2.3');
  });

  it('accepts legacy field names', () => {
    const meta = normalizeClientMetadata({ appVersion: '1.0.0', platform: 'darwin-arm64' });
    expect(meta.clientAppVersion).toBe('1.0.0');
    expect(meta.clientPlatform).toBe('darwin-arm64');
  });
});

describe('protocol constants', () => {
  it('CLIENT_PROTOCOL_VERSION is a number', () => {
    expect(typeof CLIENT_PROTOCOL_VERSION).toBe('number');
    expect(CLIENT_PROTOCOL_VERSION).toBeGreaterThan(0);
  });

  it('SERVER_PROTOCOL_VERSION is a number', () => {
    expect(typeof SERVER_PROTOCOL_VERSION).toBe('number');
    expect(SERVER_PROTOCOL_VERSION).toBeGreaterThan(0);
  });

  it('APP_VERSION is a string', () => {
    expect(typeof APP_VERSION).toBe('string');
    expect(APP_VERSION.length).toBeGreaterThan(0);
  });
});
