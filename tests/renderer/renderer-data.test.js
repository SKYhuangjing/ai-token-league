// Tests for data transformation functions extracted from renderer.js
import { describe, it, expect } from 'vitest';
import {
  sourceName, sourceDescription, sourceSummary,
  daysForRange, usageForRange, rangeLabel, overviewTrendGrain,
  railCloudStatus, deriveRailSyncStatus,
  groupBy, groupProviders, groupByGrain, groupByHour,
  groupTrend, groupWorkdirs, groupWorkdirDetails, groupDailyRows,
  aggregateComposition, aggregatePeriodRow,
  normalizeUsageSummary, normalizeUsageTrend, normalizeUsageWorkdirs,
  normalizeUsageTotal, reconcileHealthWithConfig
} from '../../src/desktop/renderer-data.js';

function localDayOffset(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ── Source / Provider helpers ──

describe('sourceName', () => {
  const t = (k) => ({ 'source.codex': 'Codex', 'source.claude': 'Claude', 'source.cursor': 'Cursor', 'source.workbuddy': 'WorkBuddy', 'source.dsh': 'DeepSeek Harness' }[k] || k);
  it('returns Codex for codex_local', () => {
    expect(sourceName('codex_local', t)).toBe('Codex');
  });
  it('returns Claude for claude_code_local', () => {
    expect(sourceName('claude_code_local', t)).toBe('Claude');
  });
  it('returns Cursor for cursor_dashboard_usage', () => {
    expect(sourceName('cursor_dashboard_usage', t)).toBe('Cursor');
  });
  it('returns WorkBuddy for workbuddy_local', () => {
    expect(sourceName('workbuddy_local', t)).toBe('WorkBuddy');
  });
  it('returns DeepSeek Harness for dsh_local', () => {
    expect(sourceName('dsh_local', t)).toBe('DeepSeek Harness');
  });
  it('returns raw id for unknown', () => {
    expect(sourceName('unknown_provider', t)).toBe('unknown_provider');
  });
});

describe('sourceDescription', () => {
  const t = (k) => ({ 'desktop.sources.cursorDesc': 'Cursor desc', 'desktop.sources.localDesc': 'Local desc' }[k] || k);
  it('returns cursor desc for cursor', () => {
    expect(sourceDescription('cursor_dashboard_usage', t)).toBe('Cursor desc');
  });
  it('returns local desc for others', () => {
    expect(sourceDescription('codex_local', t)).toBe('Local desc');
  });
});

describe('sourceSummary', () => {
  const t = (k, params) => {
    const map = {
      'desktop.sources.noCursorAccountDetected': 'No account',
      'desktop.sources.accountSourceOne': '1 account',
      'desktop.sources.accountSources': `${params?.count} accounts`,
      'desktop.renderer.notFound': 'Not found',
      'desktop.sources.locationOne': '1 location',
      'desktop.sources.locations': `${params?.count} locations`,
    };
    return map[k] || k;
  };
  it('returns not found when not detected', () => {
    expect(sourceSummary({ detected: false, sources: [] }, t)).toBe('Not found');
  });
  it('returns location count', () => {
    expect(sourceSummary({ detected: true, sources: [{ kind: 'auto' }] }, t)).toBe('1 location');
  });
  it('returns multiple locations', () => {
    expect(sourceSummary({ detected: true, sources: [{ kind: 'auto' }, { kind: 'manual' }] }, t)).toBe('2 locations');
  });
  it('returns cursor account info', () => {
    expect(sourceSummary({ providerId: 'cursor_dashboard_usage', sources: [{ kind: 'auto' }] }, t)).toBe('1 account');
  });
  it('returns cursor no account', () => {
    expect(sourceSummary({ providerId: 'cursor_dashboard_usage', sources: [] }, t)).toBe('No account');
  });
  it('returns cursor multiple accounts', () => {
    expect(sourceSummary({ providerId: 'cursor_dashboard_usage', sources: [{ kind: 'auto' }, { kind: 'auto' }, { kind: 'manual' }] }, t)).toBe('3 accounts');
  });
});

// ── Range / Label ──

describe('daysForRange', () => {
  it('returns null for all', () => {
    expect(daysForRange('all')).toBeNull();
  });
  it('returns 7-day set for 7d', () => {
    const days = daysForRange('7d');
    expect(days.size).toBe(7);
  });
  it('returns 30-day set for 30d', () => {
    const days = daysForRange('30d');
    expect(days.size).toBe(30);
  });
  it('returns single-day set for today', () => {
    const days = daysForRange('today');
    expect(days.size).toBe(1);
  });
});

describe('usageForRange', () => {
  const allUsage = [
    { day: '2026-05-23', totalTokens: 100 },
    { day: '2026-05-22', totalTokens: 200 },
    { day: '2026-05-01', totalTokens: 300 }
  ];
  it('returns all for all range', () => {
    expect(usageForRange('all', allUsage)).toHaveLength(3);
  });
  it('filters by today', () => {
    const result = usageForRange('today', allUsage);
    expect(result.every(i => i.day === '2026-05-23')).toBe(true);
  });
});

describe('rangeLabel', () => {
  const t = (k) => ({ 'desktop.range.7d': '7d', 'desktop.range.30d': '30d', 'desktop.range.all': 'ALL', 'desktop.range.today': 'Today' }[k] || k);
  it('returns Today for today', () => {
    expect(rangeLabel('today', t)).toBe('Today');
  });
  it('returns 7d for 7d', () => {
    expect(rangeLabel('7d', t)).toBe('7d');
  });
  it('returns ALL for all', () => {
    expect(rangeLabel('all', t)).toBe('ALL');
  });
});

describe('overviewTrendGrain', () => {
  it('returns hour for today', () => {
    expect(overviewTrendGrain('today')).toBe('hour');
  });
  it('returns day for 7d', () => {
    expect(overviewTrendGrain('7d')).toBe('day');
  });
  it('returns week for 30d', () => {
    expect(overviewTrendGrain('30d')).toBe('week');
  });
  it('returns month for all', () => {
    expect(overviewTrendGrain('all')).toBe('month');
  });
});

// ── Cloud Status ──

describe('railCloudStatus', () => {
  const t = (k) => ({
    'desktop.rail.cloudLocal': 'Local',
    'desktop.rail.cloudChecking': 'Checking',
    'desktop.rail.cloudOnline': 'Online',
    'desktop.rail.cloudOffline': 'Offline',
    'desktop.rail.cloudUnavailable': 'Unavailable',
    'desktop.renderer.cloudNotConfigured': 'Not configured'
  }[k] || k);

  it('returns local when no apiBaseUrl', () => {
    const result = railCloudStatus({}, t);
    expect(result.state).toBe('local');
  });
  it('returns checking when no checkedAt', () => {
    const result = railCloudStatus({ apiBaseUrl: 'https://example.com', apiConnection: {} }, t);
    expect(result.state).toBe('checking');
  });
  it('returns online when reachable', () => {
    const config = { apiBaseUrl: 'https://example.com', apiConnection: { checkedAt: 'now', status: 'reachable', serverVersion: '1.0' } };
    const result = railCloudStatus(config, t);
    expect(result.state).toBe('online');
    expect(result.title).toContain('1.0');
  });
  it('returns online without serverVersion', () => {
    const config = { apiBaseUrl: 'https://example.com', apiConnection: { checkedAt: 'now', status: 'reachable' } };
    const result = railCloudStatus(config, t);
    expect(result.state).toBe('online');
    expect(result.title).toContain('example.com');
  });
  it('returns offline when not reachable', () => {
    const config = { apiBaseUrl: 'https://example.com', apiConnection: { checkedAt: 'now', status: 'error' } };
    const result = railCloudStatus(config, t);
    expect(result.state).toBe('offline');
  });
  it('returns offline with message', () => {
    const config = { apiBaseUrl: 'https://example.com', apiConnection: { checkedAt: 'now', status: 'error', message: 'timeout' } };
    const result = railCloudStatus(config, t);
    expect(result.state).toBe('offline');
    expect(result.title).toBe('timeout');
  });
  it('returns unavailable when incompatible', () => {
    const config = { apiBaseUrl: 'https://example.com', apiConnection: { checkedAt: 'now', status: 'reachable', compatibility: { compatible: false, reason: 'too old' } } };
    const result = railCloudStatus(config, t);
    expect(result.state).toBe('unavailable');
  });
  it('returns local when not_configured', () => {
    const config = { apiBaseUrl: 'https://example.com', apiConnection: { checkedAt: 'now', status: 'not_configured' } };
    const result = railCloudStatus(config, t);
    expect(result.state).toBe('local');
  });
  it('uses apiBaseUrl from connection when not in config', () => {
    const config = { apiConnection: { apiBaseUrl: 'https://from-conn.com' } };
    const result = railCloudStatus(config, t);
    expect(result.state).toBe('checking');
    expect(result.title).toBe('https://from-conn.com');
  });
});

// ── Sync Status Derivation ──

describe('deriveRailSyncStatus', () => {
  const t = (k, params) => {
    const map = {
      'desktop.syncStatus.localOnly': 'Local only',
      'desktop.syncStatus.localOnlyDetail': 'Cloud not configured',
      'desktop.syncStatus.syncing': 'Syncing',
      'desktop.syncStatus.syncingDetail.scanning': 'Refreshing local usage',
      'desktop.syncStatus.syncingDetail.uploading': 'Uploading to current cloud',
      'desktop.syncStatus.syncingDetail.retryingQueue': 'Retrying pending uploads',
      'desktop.syncStatus.syncingDetail.checkingConnection': 'Checking connection',
      'desktop.syncStatus.needsSync': 'Cloud update pending',
      'desktop.syncStatus.needsSyncDetail.neverSyncedCurrentServer': 'Current cloud has no data from this device',
      'desktop.syncStatus.needsSyncDetail.localChangedAfterSync': 'Local data changed; refresh to sync to cloud',
      'desktop.syncStatus.synced': 'Synced',
      'desktop.syncStatus.syncedDetail': params ? `Last sync ${params.time}` : 'Last sync',
      'desktop.syncStatus.attention': 'Needs attention',
      'desktop.syncStatus.attentionDetail.queuedRetry': 'Some data is pending retry',
      'desktop.syncStatus.attentionDetail.lastFailed': 'Last sync failed',
      'desktop.syncStatus.attentionDetail.cloudUnreachable': 'Cloud is unreachable',
      'desktop.syncStatus.attentionDetail.cloudIncompatible': 'Client or server version is incompatible',
      'desktop.syncStatus.action.configureCloud': 'Configure cloud',
      'desktop.syncStatus.action.syncNow': 'Sync now',
      'desktop.syncStatus.action.retrySync': 'Retry sync',
      'desktop.syncStatus.action.checkConnection': 'Check connection',
      'desktop.syncStatus.action.updateClient': 'Update client',
    };
    return map[k] || k;
  };
  const fmtDt = (v) => v || '-';

  function makeConfig(overrides = {}) {
    return {
      apiBaseUrl: 'https://api.example.com',
      apiConnection: { checkedAt: '2026-01-01T00:00:00Z', status: 'reachable', compatibility: { compatible: true } },
      syncStatus: {
        apiBaseUrl: 'https://api.example.com',
        lastAttemptAt: '2026-01-01T01:00:00Z',
        lastFinishedAt: '2026-01-01T01:00:00Z',
        lastSuccessAt: '2026-01-01T01:00:00Z',
        lastStatus: 'success',
        lastError: '',
        lastSuccessSourceFingerprint: 'fp-abc',
        lastResult: { queuePending: 0 },
      },
      ...overrides,
    };
  }

  it('returns local_only / no_api when no apiBaseUrl', () => {
    const result = deriveRailSyncStatus({ config: { apiBaseUrl: '' }, t, formatDateTime: fmtDt });
    expect(result.state).toBe('local_only');
    expect(result.reason).toBe('no_api');
    expect(result.action).toBe('configure_cloud');
    expect(result.actionLabel).toBe('Configure cloud');
  });

  it('returns syncing / scanning when usageScanStatus.running', () => {
    const result = deriveRailSyncStatus({
      config: makeConfig(),
      usageScanStatus: { running: true, syncRunning: false },
      t, formatDateTime: fmtDt,
    });
    expect(result.state).toBe('syncing');
    expect(result.reason).toBe('scanning');
    expect(result.action).toBeNull();
  });

  it('returns syncing / uploading when usageScanStatus.syncRunning', () => {
    const result = deriveRailSyncStatus({
      config: makeConfig(),
      usageScanStatus: { running: false, syncRunning: true },
      t, formatDateTime: fmtDt,
    });
    expect(result.state).toBe('syncing');
    expect(result.reason).toBe('uploading');
  });

  it('returns syncing / uploading when phase is uploading', () => {
    const result = deriveRailSyncStatus({
      config: makeConfig(),
      usageScanStatus: { running: true, syncRunning: false, phase: 'uploading' },
      t, formatDateTime: fmtDt,
    });
    expect(result.state).toBe('syncing');
    expect(result.reason).toBe('uploading');
  });

  it('returns syncing / retrying_queue when phase is retrying_queue', () => {
    const result = deriveRailSyncStatus({
      config: makeConfig(),
      usageScanStatus: { running: true, syncRunning: false, phase: 'retrying_queue' },
      t, formatDateTime: fmtDt,
    });
    expect(result.state).toBe('syncing');
    expect(result.reason).toBe('retrying_queue');
  });

  it('returns syncing when foregroundSyncRunning', () => {
    const result = deriveRailSyncStatus({
      config: makeConfig(),
      foregroundSyncRunning: true,
      t, formatDateTime: fmtDt,
    });
    expect(result.state).toBe('syncing');
  });

  it('returns needs_sync / never_synced_current_server when no sync record for current API', () => {
    const result = deriveRailSyncStatus({
      config: makeConfig({ syncStatus: {} }),
      t, formatDateTime: fmtDt,
    });
    expect(result.state).toBe('needs_sync');
    expect(result.reason).toBe('never_synced_current_server');
    expect(result.action).toBe('sync_now');
  });

  it('returns syncing / checking_connection when API has not been checked', () => {
    const result = deriveRailSyncStatus({
      config: makeConfig({ apiConnection: {} }),
      t, formatDateTime: fmtDt,
    });
    expect(result.state).toBe('syncing');
    expect(result.reason).toBe('checking_connection');
    expect(result.action).toBeNull();
  });

  it('returns needs_sync when old API has record but new API does not', () => {
    const result = deriveRailSyncStatus({
      config: makeConfig({
        apiBaseUrl: 'https://new-server.com',
        syncStatus: { apiBaseUrl: 'https://old-server.com', lastStatus: 'success', lastSuccessAt: '2026-01-01T01:00:00Z' },
      }),
      t, formatDateTime: fmtDt,
    });
    expect(result.state).toBe('needs_sync');
    expect(result.reason).toBe('never_synced_current_server');
  });

  it('returns needs_sync / local_changed_after_sync when fingerprint differs', () => {
    const result = deriveRailSyncStatus({
      config: makeConfig(),
      latestLocalSnapshot: { sourceFingerprint: 'fp-new', scannedAt: '2026-01-02T00:00:00Z' },
      t, formatDateTime: fmtDt,
    });
    expect(result.state).toBe('needs_sync');
    expect(result.reason).toBe('local_changed_after_sync');
    expect(result.action).toBe('sync_now');
  });

  it('returns synced when fingerprint matches and lastStatus is success', () => {
    const result = deriveRailSyncStatus({
      config: makeConfig(),
      latestLocalSnapshot: { sourceFingerprint: 'fp-abc', scannedAt: '2026-01-01T00:00:00Z' },
      t, formatDateTime: fmtDt,
    });
    expect(result.state).toBe('synced');
    expect(result.action).toBeNull();
    expect(result.detail).toContain('Last sync');
  });

  it('returns synced without fingerprint (no local snapshot)', () => {
    const result = deriveRailSyncStatus({
      config: makeConfig(),
      t, formatDateTime: fmtDt,
    });
    expect(result.state).toBe('synced');
  });

  it('returns attention / queued_retry when queuePending > 0', () => {
    const result = deriveRailSyncStatus({
      config: makeConfig({
        syncStatus: {
          apiBaseUrl: 'https://api.example.com',
          lastStatus: 'success',
          lastSuccessAt: '2026-01-01T01:00:00Z',
          lastSuccessSourceFingerprint: 'fp-abc',
          lastResult: { queuePending: 3 },
        },
      }),
      t, formatDateTime: fmtDt,
    });
    expect(result.state).toBe('attention');
    expect(result.reason).toBe('queued_retry');
    expect(result.action).toBe('retry_sync');
    expect(result.queuePending).toBe(3);
  });

  it('returns attention / last_failed when lastStatus is failed', () => {
    const result = deriveRailSyncStatus({
      config: makeConfig({
        syncStatus: {
          apiBaseUrl: 'https://api.example.com',
          lastStatus: 'failed',
          lastSuccessAt: '',
          lastSuccessSourceFingerprint: '',
          lastError: 'connection refused',
        },
      }),
      t, formatDateTime: fmtDt,
    });
    expect(result.state).toBe('attention');
    expect(result.reason).toBe('last_failed');
    expect(result.action).toBe('retry_sync');
  });

  it('returns attention / cloud_unreachable when API is not reachable', () => {
    const result = deriveRailSyncStatus({
      config: makeConfig({
        apiConnection: { checkedAt: '2026-01-01T00:00:00Z', status: 'error', message: 'timeout' },
      }),
      t, formatDateTime: fmtDt,
    });
    expect(result.state).toBe('attention');
    expect(result.reason).toBe('cloud_unreachable');
    expect(result.action).toBe('check_connection');
  });

  it('returns attention / cloud_incompatible when server is incompatible', () => {
    const result = deriveRailSyncStatus({
      config: makeConfig({
        apiConnection: { checkedAt: '2026-01-01T00:00:00Z', status: 'reachable', compatibility: { compatible: false, reason: 'version too old' } },
      }),
      t, formatDateTime: fmtDt,
    });
    expect(result.state).toBe('attention');
    expect(result.reason).toBe('cloud_incompatible');
    expect(result.action).toBe('update_client');
  });

  it('returns syncing / checking_connection when background is running but not scan', () => {
    const result = deriveRailSyncStatus({
      config: makeConfig(),
      backgroundStatus: { running: true },
      t, formatDateTime: fmtDt,
    });
    expect(result.state).toBe('syncing');
    expect(result.reason).toBe('checking_connection');
  });
});

// ── Grouping ──

describe('groupBy', () => {
  it('groups items by key', () => {
    const items = [
      { providerId: 'a', totalTokens: 100, estimatedCostUsd: 0, costQuality: '', pricingVersion: '' },
      { providerId: 'b', totalTokens: 200, estimatedCostUsd: 0, costQuality: '', pricingVersion: '' },
      { providerId: 'a', totalTokens: 50, estimatedCostUsd: 0, costQuality: '', pricingVersion: '' }
    ];
    const result = groupBy(items, 'providerId', {});
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('b'); // sorted by totalTokens desc
    expect(result[0].totalTokens).toBe(200);
    expect(result[1].totalTokens).toBe(150);
  });
  it('handles empty array', () => {
    expect(groupBy([], 'key', {})).toEqual([]);
  });
});

describe('groupProviders', () => {
  const t = (k) => ({ 'source.codex': 'Codex', 'source.claude': 'Claude' }[k] || k);
  it('maps provider ids to display names', () => {
    const items = [
      { providerId: 'codex_local', totalTokens: 100, estimatedCostUsd: 0, costQuality: '', pricingVersion: '' }
    ];
    const result = groupProviders(items, {}, t);
    expect(result[0].name).toBe('Codex');
  });
});

describe('groupWorkdirs', () => {
  it('groups by workdirHash', () => {
    const items = [
      { workdirHash: 'h1', workdirDisplayName: '/a', totalTokens: 100 },
      { workdirHash: 'h2', workdirDisplayName: '/b', totalTokens: 200 },
      { workdirHash: 'h1', workdirDisplayName: '/a', totalTokens: 50 }
    ];
    const result = groupWorkdirs(items);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('/b');
    expect(result[0].totalTokens).toBe(200);
    expect(result[1].totalTokens).toBe(150);
  });
});

describe('groupWorkdirDetails', () => {
  it('groups with model and daily breakdowns', () => {
    const items = [
      { workdirHash: 'h1', workdirDisplayName: '/a', model: 'gpt-4o', day: '2026-05-23', totalTokens: 100, inputTokens: 60, outputTokens: 40, estimatedCostUsd: 0, costQuality: '', pricingVersion: '' },
      { workdirHash: 'h1', workdirDisplayName: '/a', model: 'gpt-4o', day: '2026-05-22', totalTokens: 50, inputTokens: 30, outputTokens: 20, estimatedCostUsd: 0, costQuality: '', pricingVersion: '' }
    ];
    const result = groupWorkdirDetails(items, {});
    expect(result).toHaveLength(1);
    expect(result[0].totalTokens).toBe(150);
    expect(result[0].contributionRatio).toBe(1);
    expect(result[0].modelBreakdown.length).toBeGreaterThan(0);
    expect(result[0].dailyBreakdown.length).toBe(2);
  });
});

describe('groupDailyRows', () => {
  it('groups by day with model/workdir breakdowns', () => {
    const items = [
      { day: '2026-05-23', model: 'gpt-4o', workdirDisplayName: '/a', totalTokens: 100, inputTokens: 60, outputTokens: 40, estimatedCostUsd: 0, costQuality: '', pricingVersion: '' },
      { day: '2026-05-22', model: 'gpt-4o', workdirDisplayName: '/a', totalTokens: 50, inputTokens: 30, outputTokens: 20, estimatedCostUsd: 0, costQuality: '', pricingVersion: '' }
    ];
    const result = groupDailyRows(items, {});
    expect(result).toHaveLength(2);
    expect(result[0].periodStart).toBe('2026-05-22'); // sorted chronologically
    expect(result[0].modelBreakdown.length).toBeGreaterThan(0);
  });
});

describe('groupByGrain', () => {
  it('groups by day grain', () => {
    const items = [
      { day: '2026-05-23', totalTokens: 100, inputTokens: 60, outputTokens: 40, estimatedCostUsd: 0, costQuality: '', pricingVersion: '' },
      { day: '2026-05-23', totalTokens: 50, inputTokens: 30, outputTokens: 20, estimatedCostUsd: 0, costQuality: '', pricingVersion: '' }
    ];
    const result = groupByGrain(items, 'day', {});
    expect(result).toHaveLength(1);
    expect(result[0].totalTokens).toBe(150);
  });
  it('groups by week grain', () => {
    const items = [
      { day: '2026-05-18', totalTokens: 100, inputTokens: 60, outputTokens: 40, estimatedCostUsd: 0, costQuality: '', pricingVersion: '' },
      { day: '2026-05-20', totalTokens: 50, inputTokens: 30, outputTokens: 20, estimatedCostUsd: 0, costQuality: '', pricingVersion: '' }
    ];
    const result = groupByGrain(items, 'week', {});
    expect(result).toHaveLength(1); // same week
    expect(result[0].totalTokens).toBe(150);
  });
});

describe('groupByHour', () => {
  it('groups by hour within a day', () => {
    const items = [
      { day: '2026-05-23', hour: 10, totalTokens: 100, inputTokens: 60, outputTokens: 40, model: 'gpt-4o', workdirDisplayName: '/a', estimatedCostUsd: 0, costQuality: '', pricingVersion: '' },
      { day: '2026-05-23', hour: 10, totalTokens: 50, inputTokens: 30, outputTokens: 20, model: 'gpt-4o', workdirDisplayName: '/a', estimatedCostUsd: 0, costQuality: '', pricingVersion: '' },
      { day: '2026-05-23', hour: 14, totalTokens: 200, inputTokens: 120, outputTokens: 80, model: 'gpt-4o', workdirDisplayName: '/a', estimatedCostUsd: 0, costQuality: '', pricingVersion: '' }
    ];
    const result = groupByHour(items, {});
    expect(result).toHaveLength(2);
    expect(result[0].hour).toBe(10);
    expect(result[0].totalTokens).toBe(150);
    expect(result[1].hour).toBe(14);
  });
});

// ── Aggregation ──

describe('aggregateComposition', () => {
  it('sums token fields', () => {
    const items = [
      { inputTokens: 100, outputTokens: 50, cacheReadTokens: 20, cacheWriteTokens: 10, reasoningTokens: 5, totalTokens: 185 },
      { inputTokens: 200, outputTokens: 100, cacheReadTokens: 40, cacheWriteTokens: 20, reasoningTokens: 10, totalTokens: 370 }
    ];
    const result = aggregateComposition(items);
    expect(result.inputTokens).toBe(300);
    expect(result.outputTokens).toBe(150);
    expect(result.totalTokens).toBe(555);
  });
  it('handles empty array', () => {
    const result = aggregateComposition([]);
    expect(result.totalTokens).toBe(0);
  });
});

describe('aggregatePeriodRow', () => {
  it('aggregates items into a period row', () => {
    const items = [
      { model: 'gpt-4o', workdirDisplayName: '/a', totalTokens: 100, inputTokens: 60, outputTokens: 40, estimatedCostUsd: 0, costQuality: '', pricingVersion: '' },
      { model: 'gpt-4o', workdirDisplayName: '/a', totalTokens: 50, inputTokens: 30, outputTokens: 20, estimatedCostUsd: 0, costQuality: '', pricingVersion: '' }
    ];
    const result = aggregatePeriodRow(items, '2026-05-23', '2026-05-23', null, 'day', {});
    expect(result.periodStart).toBe('2026-05-23');
    expect(result.totalTokens).toBe(150);
    expect(result.modelBreakdown.length).toBeGreaterThan(0);
  });
  it('includes hour when provided', () => {
    const items = [{ model: 'gpt-4o', workdirDisplayName: '/a', totalTokens: 100, inputTokens: 60, outputTokens: 40, estimatedCostUsd: 0, costQuality: '', pricingVersion: '' }];
    const result = aggregatePeriodRow(items, '2026-05-23', '2026-05-23', 14, 'hour', {});
    expect(result.hour).toBe(14);
    expect(result.bucketLabel).toBe('14:00');
    expect(result.detailBreakdown).toEqual([]);
  });
  it('returns detail breakdown for week parentGrain', () => {
    const items = [
      { day: '2026-05-18', model: 'gpt-4o', workdirDisplayName: '/a', totalTokens: 100, inputTokens: 60, outputTokens: 40, estimatedCostUsd: 0, costQuality: '', pricingVersion: '' },
      { day: '2026-05-20', model: 'gpt-4o', workdirDisplayName: '/a', totalTokens: 50, inputTokens: 30, outputTokens: 20, estimatedCostUsd: 0, costQuality: '', pricingVersion: '' }
    ];
    const result = aggregatePeriodRow(items, '2026-05-18', '2026-05-24', null, 'week', {});
    expect(result.detailBreakdown.length).toBeGreaterThan(0);
    expect(result.detailBreakdownTitle).toBe('desktop.trend.dailyDetail');
  });
  it('returns detail breakdown for month parentGrain', () => {
    const items = [
      { day: '2026-05-05', model: 'gpt-4o', workdirDisplayName: '/a', totalTokens: 100, inputTokens: 60, outputTokens: 40, estimatedCostUsd: 0, costQuality: '', pricingVersion: '' },
      { day: '2026-05-15', model: 'gpt-4o', workdirDisplayName: '/a', totalTokens: 50, inputTokens: 30, outputTokens: 20, estimatedCostUsd: 0, costQuality: '', pricingVersion: '' }
    ];
    const result = aggregatePeriodRow(items, '2026-05-01', '2026-05-31', null, 'month', {});
    expect(result.detailBreakdown.length).toBeGreaterThan(0);
    expect(result.detailBreakdownTitle).toBe('desktop.trend.weeklyDetail');
  });
  it('returns detail breakdown for year parentGrain', () => {
    const items = [
      { day: '2026-03-15', model: 'gpt-4o', workdirDisplayName: '/a', totalTokens: 100, inputTokens: 60, outputTokens: 40, estimatedCostUsd: 0, costQuality: '', pricingVersion: '' },
      { day: '2026-05-20', model: 'gpt-4o', workdirDisplayName: '/a', totalTokens: 50, inputTokens: 30, outputTokens: 20, estimatedCostUsd: 0, costQuality: '', pricingVersion: '' }
    ];
    const result = aggregatePeriodRow(items, '2026-01-01', '2026-12-31', null, 'year', {});
    expect(result.detailBreakdown.length).toBeGreaterThan(0);
    expect(result.detailBreakdownTitle).toBe('desktop.trend.monthlyDetail');
  });
  it('returns empty breakdown for unknown parentGrain', () => {
    const items = [{ model: 'gpt-4o', workdirDisplayName: '/a', totalTokens: 100, inputTokens: 60, outputTokens: 40, estimatedCostUsd: 0, costQuality: '', pricingVersion: '' }];
    const result = aggregatePeriodRow(items, '2026-05-23', '2026-05-23', null, 'unknown', {});
    expect(result.detailBreakdown).toEqual([]);
    expect(result.detailBreakdownTitle).toBe('');
  });
});

// ── groupTrend ──

describe('groupTrend', () => {
  const makeItem = (day, model = 'gpt-4o', workdir = '/a', tokens = 100) => ({
    day, model, workdirDisplayName: workdir, totalTokens: tokens,
    inputTokens: Math.floor(tokens * 0.6), outputTokens: Math.ceil(tokens * 0.4),
    estimatedCostUsd: 0, costQuality: '', pricingVersion: ''
  });
  it('groups items into trend buckets', () => {
    const items = [makeItem(localDayOffset(0)), makeItem(localDayOffset(-1))];
    const result = groupTrend(items, { trendView: 'daily' });
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].modelBreakdown).toBeDefined();
    expect(result[0].workdirBreakdown).toBeDefined();
  });
  it('filters items outside allowed days', () => {
    const items = [makeItem('2020-01-01')];
    const result = groupTrend(items, { trendView: 'daily' });
    expect(result).toHaveLength(0);
  });
  it('groups by week with weekly view', () => {
    const items = [makeItem('2026-05-18'), makeItem('2026-05-20')];
    const result = groupTrend(items, { trendView: 'weekly' });
    expect(result.length).toBeGreaterThan(0);
  });
  it('groups by month with monthly view', () => {
    const items = [makeItem('2026-03-15'), makeItem('2026-05-20')];
    const result = groupTrend(items, { trendView: 'monthly' });
    expect(result.length).toBeGreaterThan(0);
  });
  it('includes modelDetails and models list', () => {
    const day = localDayOffset(0);
    const items = [makeItem(day, 'gpt-4o'), makeItem(day, 'claude-3.5')];
    const result = groupTrend(items, { trendView: 'daily' });
    expect(result[0].models).toContain('gpt-4o');
    expect(result[0].modelDetails.length).toBeGreaterThan(0);
  });
});

// ── Re-exported normalization ──

describe('re-exported normalization', () => {
  it('normalizeUsageSummary is available', () => {
    const result = normalizeUsageSummary({ totals: { inputTokens: 100 } });
    expect(result.totals.totalTokens).toBe(100);
  });
  it('normalizeUsageTrend is available', () => {
    const result = normalizeUsageTrend({ items: [{ day: '2026-05-23', inputTokens: 100 }] });
    expect(result.items).toHaveLength(1);
  });
  it('normalizeUsageWorkdirs is available', () => {
    const result = normalizeUsageWorkdirs({ items: [{ workdirHash: 'h1', totalTokens: 100 }] });
    expect(result.items).toHaveLength(1);
  });
  it('normalizeUsageTotal is available', () => {
    const result = normalizeUsageTotal({ inputTokens: 100, outputTokens: 50 });
    expect(result.totalTokens).toBe(150);
  });
  it('reconcileHealthWithConfig is available', () => {
    const result = reconcileHealthWithConfig([], {});
    expect(result).toEqual([]);
  });
});
