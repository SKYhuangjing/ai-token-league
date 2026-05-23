import { describe, it, expect } from 'vitest';
import { formatTokenCompact, formatTokenRaw, formatUsd } from '../../../src/shared/display.js';

describe('formatTokenCompact', () => {
  it('formats zero', () => {
    const result = formatTokenCompact(0, 'en');
    expect(result).toBeDefined();
    expect(typeof result).toBe('string');
  });

  it('formats small numbers', () => {
    const result = formatTokenCompact(999, 'en');
    expect(result).toContain('999');
  });

  it('formats thousands', () => {
    const result = formatTokenCompact(12345, 'en');
    expect(result).toBeDefined();
    expect(result.length).toBeLessThan(10);
  });

  it('formats large numbers', () => {
    const result = formatTokenCompact(1234567, 'en');
    expect(result).toBeDefined();
    expect(result.length).toBeLessThan(10);
  });

  it('handles negative numbers', () => {
    const result = formatTokenCompact(-1000, 'en');
    expect(result).toBeDefined();
  });
});

describe('formatTokenRaw', () => {
  it('formats number with suffix', () => {
    const result = formatTokenRaw(12345, 'en');
    expect(result).toContain('12,345');
  });

  it('formats zero', () => {
    const result = formatTokenRaw(0, 'en');
    expect(result).toBeDefined();
  });
});

describe('formatUsd', () => {
  it('formats valid amount', () => {
    const result = formatUsd(1.23);
    expect(result).toContain('1.23');
  });

  it('returns "-" for null', () => {
    expect(formatUsd(null)).toBe('-');
  });

  it('returns "-" for NaN', () => {
    expect(formatUsd(NaN)).toBe('-');
  });

  it('formats tiny amounts', () => {
    const result = formatUsd(0.001);
    expect(result).toBeDefined();
    expect(result).not.toBe('-');
  });

  it('formats zero', () => {
    const result = formatUsd(0);
    expect(result).toBeDefined();
  });
});
