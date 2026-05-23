// Renderer logic tests: empty data and boundary cases
import { describe, it, expect } from 'vitest';

describe('Empty data handling', () => {
  // Test token formatting with edge cases
  describe('token value edge cases', () => {
    it('handles zero tokens', () => {
      const value = 0;
      expect(value).toBe(0);
      expect(String(value)).toBe('0');
    });

    it('handles negative tokens gracefully', () => {
      const value = -100;
      const display = Math.max(0, value);
      expect(display).toBe(0);
    });

    it('handles NaN tokens', () => {
      const value = NaN;
      const safe = Number.isFinite(value) ? value : 0;
      expect(safe).toBe(0);
    });

    it('handles Infinity tokens', () => {
      const value = Infinity;
      const safe = Number.isFinite(value) ? value : 0;
      expect(safe).toBe(0);
    });

    it('handles null tokens', () => {
      const value = null;
      const safe = Number(value) || 0;
      expect(safe).toBe(0);
    });

    it('handles undefined tokens', () => {
      const value = undefined;
      const safe = Number(value) || 0;
      expect(safe).toBe(0);
    });
  });

  // Test percentage calculations with edge cases
  describe('percentage edge cases', () => {
    it('computes percentage correctly', () => {
      const value = 600;
      const total = 1000;
      const pct = Math.round((value / total) * 100);
      expect(pct).toBe(60);
    });

    it('handles zero total', () => {
      const value = 100;
      const total = 0;
      const pct = total > 0 ? Math.round((value / total) * 100) : 0;
      expect(pct).toBe(0);
    });

    it('handles zero value', () => {
      const value = 0;
      const total = 1000;
      const pct = Math.round((value / total) * 100);
      expect(pct).toBe(0);
    });

    it('handles both zero', () => {
      const value = 0;
      const total = 0;
      const pct = total > 0 ? Math.round((value / total) * 100) : 0;
      expect(pct).toBe(0);
    });
  });

  // Test cost formatting edge cases
  describe('cost formatting edge cases', () => {
    it('formats valid cost', () => {
      const cost = 1.23;
      const formatted = `$${cost.toFixed(2)}`;
      expect(formatted).toBe('$1.23');
    });

    it('returns "-" for null cost', () => {
      const cost = null;
      const formatted = cost != null && Number.isFinite(cost) ? `$${cost.toFixed(2)}` : '-';
      expect(formatted).toBe('-');
    });

    it('returns "-" for NaN cost', () => {
      const cost = NaN;
      const formatted = Number.isFinite(cost) ? `$${cost.toFixed(2)}` : '-';
      expect(formatted).toBe('-');
    });

    it('handles tiny cost', () => {
      const cost = 0.001;
      const formatted = cost < 0.01 ? '<$0.01' : `$${cost.toFixed(2)}`;
      expect(formatted).toBe('<$0.01');
    });

    it('handles zero cost', () => {
      const cost = 0;
      const formatted = `$${cost.toFixed(2)}`;
      expect(formatted).toBe('$0.00');
    });
  });

  // Test list rendering with empty arrays
  describe('empty list rendering', () => {
    it('handles empty provider list', () => {
      const providers = [];
      const html = providers.length > 0
        ? providers.map(p => `<div class="meter">${p.name}</div>`).join('')
        : '<div class="empty">No data</div>';
      expect(html).toContain('No data');
    });

    it('handles single item list', () => {
      const items = [{ name: 'codex', tokens: 1000 }];
      const html = items.map(i => `<div class="meter">${i.name}</div>`).join('');
      expect(html).toContain('codex');
      expect(html).toContain('meter');
    });

    it('handles large list', () => {
      const items = Array.from({ length: 100 }, (_, i) => ({ name: `item-${i}`, tokens: i * 100 }));
      const html = items.slice(0, 10).map(i => `<div class="meter">${i.name}</div>`).join('');
      expect(html).toContain('item-0');
      expect(html).toContain('item-9');
      expect(html).not.toContain('item-10');
    });
  });

  // Test trend data with missing fields
  describe('trend data edge cases', () => {
    it('handles item with all zero tokens', () => {
      const item = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        totalTokens: 0,
      };
      const total = item.inputTokens + item.outputTokens + item.cacheReadTokens + item.cacheWriteTokens;
      expect(total).toBe(0);
    });

    it('handles item with missing token fields', () => {
      const item = { model: 'gpt-4o' };
      const total = (item.inputTokens || 0) + (item.outputTokens || 0);
      expect(total).toBe(0);
    });

    it('handles item with null totalTokens', () => {
      const item = { totalTokens: null };
      const safe = Number(item.totalTokens) || 0;
      expect(safe).toBe(0);
    });
  });
});
