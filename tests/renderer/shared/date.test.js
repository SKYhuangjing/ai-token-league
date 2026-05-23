import { describe, it, expect } from 'vitest';
import { localDay, dayToUtcDate, utcDateToDay, addDays, daysBetween } from '../../../src/shared/date.js';

describe('localDay', () => {
  it('returns YYYY-MM-DD format', () => {
    const day = localDay(new Date('2026-05-15T12:00:00Z'), 'UTC');
    expect(day).toBe('2026-05-15');
  });

  it('handles string input', () => {
    const day = localDay('2026-05-15T00:00:00Z', 'UTC');
    expect(day).toBe('2026-05-15');
  });

  it('uses today when no args', () => {
    const day = localDay();
    expect(day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('dayToUtcDate', () => {
  it('parses day string', () => {
    const date = dayToUtcDate('2026-05-15');
    expect(date.getUTCFullYear()).toBe(2026);
    expect(date.getUTCMonth()).toBe(4); // 0-indexed
    expect(date.getUTCDate()).toBe(15);
  });
});

describe('utcDateToDay', () => {
  it('formats date to day string', () => {
    const date = new Date(Date.UTC(2026, 4, 15));
    expect(utcDateToDay(date)).toBe('2026-05-15');
  });
});

describe('addDays', () => {
  it('adds positive days', () => {
    expect(addDays('2026-05-15', 1)).toBe('2026-05-16');
  });

  it('adds negative days', () => {
    expect(addDays('2026-05-15', -1)).toBe('2026-05-14');
  });

  it('handles month boundary', () => {
    expect(addDays('2026-05-31', 1)).toBe('2026-06-01');
  });

  it('handles year boundary', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });
});

describe('daysBetween', () => {
  it('returns single day for same start/end', () => {
    const days = daysBetween('2026-05-15', '2026-05-15');
    expect(days).toEqual(['2026-05-15']);
  });

  it('returns correct range', () => {
    const days = daysBetween('2026-05-13', '2026-05-15');
    expect(days).toEqual(['2026-05-13', '2026-05-14', '2026-05-15']);
  });

  it('handles cross-month', () => {
    const days = daysBetween('2026-05-30', '2026-06-02');
    expect(days).toHaveLength(4);
    expect(days[0]).toBe('2026-05-30');
    expect(days[3]).toBe('2026-06-02');
  });

  it('handles cross-year', () => {
    const days = daysBetween('2026-12-30', '2027-01-02');
    expect(days).toHaveLength(4);
    expect(days[0]).toBe('2026-12-30');
    expect(days[3]).toBe('2027-01-02');
  });
});
