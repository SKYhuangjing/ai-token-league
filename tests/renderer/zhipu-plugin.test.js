// Tests for the zhipu plugin's pure render helpers. The plugin is a fully
// remote plugin (R28c: plugins/zhipu-plan/index.js on OSS) — the helpers are
// named exports so they stay unit-testable without a DOM or host stand-in.
import { describe, it, expect } from 'vitest';
import {
  renderResult, windowLabel, resetCountdown, compactReset, maskApiKey, usageLevel, planTier,
} from '../../plugins/zhipu-plan/index.js';

const t = (key, params = {}) => {
  const table = {
    'desktop.modules.zhipu.window5h': '5h',
    'desktop.modules.zhipu.windowWeekly': 'weekly',
    'desktop.modules.zhipu.windowNumbered': `window ${params.unit}`,
    'desktop.modules.zhipu.windowFallback': 'window',
    'desktop.modules.zhipu.resetsInMinutes': `${params.m}m`,
    'desktop.modules.zhipu.resetsInHm': `${params.h}h ${params.m}m`,
    'desktop.modules.zhipu.resetsInDays': `${params.d}d`,
    'desktop.modules.zhipu.keyFallback': `Zhipu key ${params.n}`,
    'desktop.modules.zhipu.noKeys': 'No Zhipu API key yet',
  };
  return table[key] || key;
};

describe('zhipu plugin card: renderResult', () => {
  it('renders one ledger line per window, without a meter', () => {
    const html = renderResult({
      results: [{
        label: 'GLM 5.3 -Harry', ok: true,
        quota: { tier: 'pro', windows: [
          { window: 'five_hour', unit: 3, pct: 51, resetMs: Date.now() + 3 * 3600 * 1000, resetIso: new Date(Date.now() + 3 * 3600 * 1000).toISOString(), details: { 'glm-4.6': 1234 } },
          { window: 'weekly', unit: 6, pct: 81, resetIso: '2026-09-18T00:00:00Z' },
        ] },
      }],
    }, t);
    expect(html).toContain('GLM 5.3 -Harry');
    expect(html).toContain('data-tier="pro"');
    expect(html).toContain('>pro<');
    expect(html).toContain('5h:');
    expect(html).toContain('weekly:');
    expect(html).toContain('class="zhipu-windows"');
    expect(html).toContain('zhipu-clock');
    expect(html).toContain('51%');
    expect(html).toContain('81%');
    expect(html).toContain('data-level="ok"');
    expect(html).toContain('data-level="warn"');
    expect(html).not.toContain('data-hot');
    expect(html).toMatch(/data-reset-ms="\d+"/);
    expect(html).not.toContain('module-meter');
    expect(html).not.toContain('zhipu-chip');
  });

  it('omits the weekly slot when the payload has no weekly window', () => {
    const html = renderResult({
      results: [{
        label: 'lite', ok: true,
        quota: { tier: 'lite', windows: [{ window: 'five_hour', pct: 70, resetMs: Date.now() + 60_000 }] },
      }],
    }, t);
    expect(html).toContain('5h:');
    expect(html).not.toContain('weekly:');
    expect(html).not.toContain('is-empty');
  });

  it('falls back to numbered labels and shows per-key errors', () => {
    const html = renderResult({
      results: [
        { label: '', ok: false, error: 'HTTP 401' },
        { label: '', ok: true, quota: { tier: null, windows: [] } },
      ],
    }, t);
    expect(html).toContain('Zhipu key 1');
    expect(html).toContain('HTTP 401');
    expect(html).toContain('Zhipu key 2');
  });

  it('renders the empty hint without results', () => {
    expect(renderResult(null, t)).toContain('No Zhipu API key yet');
    expect(renderResult({ results: [] }, t)).toContain('No Zhipu API key yet');
  });
});

describe('zhipu plugin card: usageLevel', () => {
  it('uses the cc-switch bands: green <70, orange 70–89, red ≥90', () => {
    expect(usageLevel(2)).toBe('ok');
    expect(usageLevel(69)).toBe('ok');
    expect(usageLevel(70)).toBe('warn');
    expect(usageLevel(89)).toBe('warn');
    expect(usageLevel(90)).toBe('crit');
    expect(usageLevel(null)).toBe(null);
  });
});

describe('zhipu plugin card: windowLabel', () => {
  it('prefers the semantic window name, then unit, then fallback', () => {
    expect(windowLabel({ window: 'five_hour' }, t)).toBe('5h');
    expect(windowLabel({ window: 'weekly' }, t)).toBe('weekly');
    expect(windowLabel({ unit: 3 }, t)).toBe('5h');
    expect(windowLabel({ unit: 6 }, t)).toBe('weekly');
    expect(windowLabel({ unit: 9 }, t)).toBe('window 9');
    expect(windowLabel({}, t)).toBe('window');
  });
});

describe('zhipu plugin card: resetCountdown', () => {
  const MIN = 60_000;
  it('formats minutes, hours+minutes, and days bands', () => {
    const now = 1_000_000_000_000;
    expect(resetCountdown(now + 30 * MIN, now, t)).toBe('30m');
    expect(resetCountdown(now + 133 * MIN, now, t)).toBe('2h 13m');
    expect(resetCountdown(now + 5 * 24 * 60 * MIN, now, t)).toBe('5d');
  });

  it('returns null for past or invalid resets (absolute fallback)', () => {
    expect(resetCountdown(0, 1_000, t)).toBeNull();
    expect(resetCountdown(Number.NaN, 1_000, t)).toBeNull();
  });
});

describe('zhipu plugin card: maskApiKey', () => {
  it('keeps a short head and tail, never the middle', () => {
    expect(maskApiKey('abcdef1234567890wxyz')).toBe('abcd••••wxyz');
  });

  it('fully masks short keys and tolerates junk input', () => {
    expect(maskApiKey('12345678')).toBe('12••••');
    expect(maskApiKey('')).toBe('');
    expect(maskApiKey(null)).toBe('');
  });
});

describe('zhipu plugin card: compactReset', () => {
  const MIN = 60_000;
  it('uses a short remainder, not a sentence', () => {
    const now = 1_000_000_000_000;
    expect(compactReset(now + 55 * MIN, now)).toBe('55m');
    expect(compactReset(now + 95 * MIN, now)).toBe('1h35m');
    expect(compactReset(now + 2 * 24 * 60 * MIN, now)).toBe('2d');
  });

  it('returns null once the window has reset', () => {
    expect(compactReset(0, 1_000)).toBeNull();
  });
});

describe('zhipu plugin card: planTier', () => {
  it('maps the three coding-plan ranks and keeps unknown levels', () => {
    expect(planTier('lite')).toEqual({ key: 'lite', label: 'lite' });
    expect(planTier('Pro')).toEqual({ key: 'pro', label: 'pro' });
    expect(planTier('MAX')).toEqual({ key: 'max', label: 'max' });
    expect(planTier('LitePro')).toEqual({ key: 'other', label: 'litepro' });
    expect(planTier('')).toBeNull();
  });
});

