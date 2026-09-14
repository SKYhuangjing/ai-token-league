// Tests for the optional-plugin registry helpers (feat/compute-sharing R9;
// R24: nothing ships built-in — zhipu-plan became pluggable, installed/
// uninstalled via the online catalog; compute-sharing exists only as a
// remote catalog plugin, covered by its own specs).
import { describe, it, expect } from 'vitest';
import { MODULE_REGISTRY, findModule, normalizeModulesState, moduleEnabled, installedOrderFromState, sortModulesByOrder, moveInstalledOrder } from '../../src/shared/modules.js';
import { invokeAllowed, createGuardedInvoke, PLATFORM_INVOKE_COMMANDS, loadInstalledModuleSource, isUnreachableModuleFetch, buildModuleContext } from '../../src/shared/module-loader.js';

describe('plugin registry', () => {
  it('ships no built-in plugins (pluggable model, R24)', () => {
    expect(MODULE_REGISTRY).toEqual([]);
    expect(findModule('zhipu-plan')).toBeNull();
  });

  it('compute-sharing exists only as a remote catalog plugin, never built-in', () => {
    expect(findModule('compute-sharing')).toBeNull();
    expect(MODULE_REGISTRY.some((m) => m.id === 'compute-sharing')).toBe(false);
  });

  it('returns null for unknown ids', () => {
    expect(findModule('nope')).toBeNull();
  });

  it('treats absent state as disabled (nothing is pre-enabled)', () => {
    for (const garbage of [null, undefined, {}, 'x', 42]) {
      const state = normalizeModulesState(garbage);
      expect(moduleEnabled(state, 'zhipu-plan')).toBe(false);
      expect(moduleEnabled(state, 'compute-sharing')).toBe(false);
    }
  });

  it('preserves explicit enables/disables and unknown persisted ids', () => {
    const state = normalizeModulesState({
      'zhipu-plan': { enabled: false, config: { keys: [{ label: 'a', apiKey: 'k' }] }, installedVersion: '1.0.3' },
      'future-module': { enabled: true },
    });
    expect(moduleEnabled(state, 'zhipu-plan')).toBe(false);
    expect(state['zhipu-plan'].config.keys).toEqual([{ label: 'a', apiKey: 'k' }]);
    expect(state['zhipu-plan'].installedVersion).toBe('1.0.3');
    expect(moduleEnabled(state, 'future-module')).toBe(true);
    expect(moduleEnabled(state, 'never-registered')).toBe(false);
  });
});

describe('installed plugin order', () => {
  const mods = [
    { id: 'zhipu-plan' },
    { id: 'compute-sharing' },
    { id: 'other' },
  ];

  it('keeps the incoming order when nothing has been saved', () => {
    expect(sortModulesByOrder(mods, []).map((mod) => mod.id)).toEqual(['zhipu-plan', 'compute-sharing', 'other']);
    expect(installedOrderFromState(null)).toEqual([]);
    expect(installedOrderFromState({ __order: { config: { ids: 'nope' } } })).toEqual([]);
  });

  it('applies a saved order and leaves unknown plugins at the end', () => {
    expect(sortModulesByOrder(mods, ['other', 'zhipu-plan']).map((mod) => mod.id))
      .toEqual(['other', 'zhipu-plan', 'compute-sharing']);
    expect(installedOrderFromState({
      __order: { config: { ids: ['other', 'other', '__order', '', 'zhipu-plan'] } },
    })).toEqual(['other', 'zhipu-plan']);
  });

  it('moves a plugin to either side of the drop target', () => {
    expect(moveInstalledOrder(['zhipu-plan', 'compute-sharing', 'other'], 'other', 'zhipu-plan', false))
      .toEqual(['other', 'zhipu-plan', 'compute-sharing']);
    expect(moveInstalledOrder(['zhipu-plan', 'compute-sharing', 'other'], 'zhipu-plan', 'other', true))
      .toEqual(['compute-sharing', 'other', 'zhipu-plan']);
    expect(moveInstalledOrder(['zhipu-plan'], 'zhipu-plan', 'zhipu-plan', true)).toEqual(['zhipu-plan']);
  });
});

describe('module context', () => {
  it('passes the five platform capabilities through, notify included', () => {
    const notify = () => {};
    const ctx = buildModuleContext({ t: String, invoke: () => {}, escapeHtml: String, apiBase: () => 'https://x', notify });
    expect(ctx.notify).toBe(notify);
    expect(Object.keys(ctx).sort()).toEqual(['apiBase', 'escapeHtml', 'invoke', 'notify', 't']);
    expect(buildModuleContext({}).notify).toBeUndefined();
  });
});

describe('invoke permission guard (A.3)', () => {
  const permissions = ['sidecar:sharing:claim-sign', 'sidecar:zhipu-plan:*'];

  it('always allows the platform self-state commands', () => {
    expect(invokeAllowed('modules:get', [])).toBe(true);
    expect(invokeAllowed('modules:set', [])).toBe(true);
    expect(invokeAllowed('modules:package-put', ['sidecar:modules:package-put'])).toBe(false);
    expect(invokeAllowed('modules:package-get', ['sidecar:modules:package-get'])).toBe(false);
    expect([...PLATFORM_INVOKE_COMMANDS]).toEqual(['modules:get', 'modules:set']);
  });

  it('allows exact and namespace-wildcard declarations, denies the rest', () => {
    expect(invokeAllowed('sharing:claim-sign', permissions)).toBe(true);
    expect(invokeAllowed('zhipu-plan:usage', permissions)).toBe(true);
    expect(invokeAllowed('zhipu-plan:anything', permissions)).toBe(true);
    expect(invokeAllowed('sharing:borrow-get', permissions)).toBe(false);
    expect(invokeAllowed('config:get', permissions)).toBe(false);
    expect(invokeAllowed('sharing:claim-sign', [])).toBe(false);
    expect(invokeAllowed('sharing:claim-sign', undefined)).toBe(false);
  });

  it('guarded invoke rejects before reaching the channel', async () => {
    const calls = [];
    const guarded = createGuardedInvoke(['sidecar:sharing:borrow-get'], (command, args) => {
      calls.push(command);
      return Promise.resolve({ ok: true });
    });
    await expect(guarded('config:get')).rejects.toThrow('permission_denied:config:get');
    await expect(guarded('modules:set', { id: 'x' })).resolves.toEqual({ ok: true });
    await expect(guarded('sharing:borrow-get')).resolves.toEqual({ ok: true });
    expect(calls).toEqual(['modules:set', 'sharing:borrow-get']);
  });

  it('platform commands are scoped to the calling plugin (self-state)', async () => {
    const calls = [];
    const base = (command, args) => {
      calls.push([command, args]);
      return Promise.resolve({ modules: {
        'zhipu-plan': { enabled: true, config: { keys: [{ apiKey: 'own-key' }] } },
        'other-mod': { enabled: true, config: { keys: [{ apiKey: 'other-key' }] } },
      } });
    };
    const guarded = createGuardedInvoke([], base, 'zhipu-plan');
    // modules:get is filtered to the caller's own record
    await expect(guarded('modules:get')).resolves.toEqual({
      modules: { 'zhipu-plan': { enabled: true, config: { keys: [{ apiKey: 'own-key' }] } } },
    });
    // modules:set is forced onto the caller's own id
    await guarded('modules:set', { id: 'other-mod', config: { enabled: false } });
    expect(calls.at(-1)).toEqual(['modules:set', { id: 'zhipu-plan', config: { enabled: false } }]);
    // without a selfId the host keeps the historical unscoped behavior
    const unscoped = createGuardedInvoke([], base);
    await expect(unscoped('modules:get')).resolves.toEqual({
      modules: {
        'zhipu-plan': { enabled: true, config: { keys: [{ apiKey: 'own-key' }] } },
        'other-mod': { enabled: true, config: { keys: [{ apiKey: 'other-key' }] } },
      },
    });
  });
});

describe('installed module package', () => {
  it('uses the downloaded copy and does not call the network', async () => {
    const loaded = await loadInstalledModuleSource({
      readCache: async () => 'export default {}',
      fetchSource: async () => { throw new Error('should not fetch'); },
    });
    expect(loaded).toEqual({ source: 'export default {}', origin: 'cache' });
  });

  it('downloads and saves a version that was never cached', async () => {
    let saved = '';
    const loaded = await loadInstalledModuleSource({
      readCache: async () => { throw new Error('not_found'); },
      fetchSource: async () => 'fresh',
      writeCache: async (source) => { saved = source; },
    });
    expect(loaded).toEqual({ source: 'fresh', origin: 'network' });
    expect(saved).toBe('fresh');
  });

  it('still returns the download when saving the local copy fails', async () => {
    const loaded = await loadInstalledModuleSource({
      readCache: async () => '',
      fetchSource: async () => 'fresh',
      writeCache: async () => { throw new Error('disk full'); },
    });
    expect(loaded.origin).toBe('network');
    expect(loaded.source).toBe('fresh');
  });

  it('rejects with not_cached when there is neither a copy nor a cloud base', async () => {
    await expect(loadInstalledModuleSource({ readCache: async () => '' })).rejects.toMatchObject({
      code: 'not_cached',
    });
  });

  it('marks an unreachable fetch as offline and leaves HTTP failures alone', async () => {
    expect(isUnreachableModuleFetch(new TypeError('Failed to fetch'))).toBe(true);
    expect(isUnreachableModuleFetch(new TypeError('Load failed'))).toBe(true);
    expect(isUnreachableModuleFetch({ name: 'TimeoutError', message: 'timeout' })).toBe(true);
    expect(isUnreachableModuleFetch(new Error('module source fetch failed: HTTP 404'))).toBe(false);

    await expect(loadInstalledModuleSource({
      readCache: async () => '',
      fetchSource: async () => { throw new TypeError('Failed to fetch'); },
    })).rejects.toMatchObject({ code: 'offline' });

    await expect(loadInstalledModuleSource({
      readCache: async () => '',
      fetchSource: async () => { throw new Error('module source fetch failed: HTTP 404'); },
    })).rejects.toThrow('HTTP 404');
  });
});
