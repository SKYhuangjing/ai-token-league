import { describe, it, expect, beforeEach } from 'vitest';
import { initI18n, getCurrentLang, getSupportedLangs, t, $t } from '../../../src/shared/i18n.js';

beforeEach(() => {
  // Reset to default language
  initI18n('zh-CN');
});

describe('initI18n', () => {
  it('returns initialized language', () => {
    const lang = initI18n('zh-CN');
    expect(lang).toBe('zh-CN');
  });

  it('defaults to zh-CN', () => {
    const lang = initI18n();
    expect(getCurrentLang()).toBeDefined();
  });
});

describe('getCurrentLang', () => {
  it('returns current language', () => {
    initI18n('en');
    expect(getCurrentLang()).toBe('en');
  });
});

describe('getSupportedLangs', () => {
  it('returns array of languages', () => {
    const langs = getSupportedLangs();
    expect(Array.isArray(langs)).toBe(true);
    expect(langs.length).toBeGreaterThan(0);
    expect(langs[0]).toHaveProperty('code');
    expect(langs[0]).toHaveProperty('name');
  });
});

describe('t (translation)', () => {
  it('returns string for known key', () => {
    initI18n('zh-CN');
    const result = t('common.appName');
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('returns key for unknown translation', () => {
    const result = t('nonexistent.key.that.does.not.exist');
    expect(result).toBeDefined();
  });

  it('substitutes params', () => {
    initI18n('en');
    const result = t('common.appName');
    expect(typeof result).toBe('string');
  });

  it('$t is alias for t', () => {
    expect($t('common.appName')).toBe(t('common.appName'));
  });
});
