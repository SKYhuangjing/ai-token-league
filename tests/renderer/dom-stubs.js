// Creates stub DOM elements for all IDs referenced by renderer.js.
// Used by update-dom.test.js to allow importing renderer.js in jsdom.

const ALL_IDS = [
  'add-claude-root','add-codex-root','add-cursor-token','apiBaseUrl',
  'app-confirm-cancel','app-confirm-message','app-confirm-modal','app-confirm-ok',
  'backup-message','backup-now','backup-schedule-copy','brand-refresh',
  'cancel-cursor-connect','cancel-cursor-token','check-update',
  'choose-backup-directory','clear-local-backups','clear-runtime-log',
  'close-share-card','close-trend-drawer','cloud-status-badge','cloud-status-text',
  'cloud-sync-details','cloud-sync-diagnostics','cloud-sync-primary-action',
  'cloud-sync-status-badge','cloud-sync-status-detail','connect-cursor','copy-share-card',
  'cursor-connect-modal','cursor-connect-status','cursor-token-error',
  'cursor-token-input','cursor-token-modal','cursor-token-summary',
  'diag-api-url','diag-background-sync','diag-connection','diag-last-attempt',
  'diag-last-error','diag-last-success','diag-queue-pending','diagnostics-message',
  'download-installer','download-update','enforcement-current-version',
  'enforcement-download-installer','enforcement-download-update',
  'enforcement-required-version','export','export-diagnostics','hideDockIcon',
  'import','import-mode-cancel','import-mode-join','import-mode-modal',
  'import-mode-restore','lang-switcher','lang-switcher-container','launchAtLogin',
  'localBackupDirectory','localBackupEnabled','localBackupRetention',
  'mandatory-update-overlay','model-list','my-identity-block','my-identity-name',
  'nickname','open-share-card','overview-cache-tokens','overview-input-tokens','overview-output-tokens',
  'overview-range','overview-trend','overview-trend-axis','overview-trend-summary',
  'polaroid-actions','polaroid-caption','polaroid-card','polaroid-flash','polaroid-loading',
  'provider-list','rail-cloud-status','rail-cloud-status-text','rail-brand-logo','rail-last-scan',
  'rail-next-scan','rail-restart-update','refresh-health','refreshIntervalMinutes',
  'reset-cancel','reset-confirm-error','reset-confirm-modal','reset-local-data',
  'reset-local-only','reset-with-cloud','restore-local-backup',
  'reveal-backup-directory','reveal-runtime-log-directory','runtimeLogRetentionDays',
  'save-cursor-token','save-share-card','settings-save-message',
  'share-card-modal','share-card-preview','share-card-status','settings-source-list','settings-tabs',
  'showEstimatedCost','showRawTokens','sources-tabs','sync-state','theme','toast',
  'today-cost','today-total','trend-chart-panel','trend-drawer',
  'trend-drawer-backdrop','trend-drawer-body','trend-drawer-copy','trend-drawer-title',
  'trend-heading','trend-rows','trend-selection-panel','trend-summary',
  'trend-table-panel','update-badge','update-message','update-status-text',
  'wizard-api-base-url','wizard-back-1','wizard-back-2','wizard-create-identity',
  'wizard-import','wizard-import-actions','wizard-import-join','wizard-import-restore',
  'wizard-join-status','wizard-next-0','wizard-next-1','wizard-nickname','wizard-overlay',
  'wizard-participant-id','wizard-skip','wizard-source-list','wizard-start',
  'wizard-summary-cloud','wizard-summary-nickname','wizard-summary-participant-id',
  'wizard-summary-sources','wizard-summary-sync-mode','workdir-alias-list',
  'workdir-list','workdirs-analysis-list','workdirs-range','workdirs-summary',
];

// IDs that should be checkbox input elements
const INPUT_IDS = new Set([
  'showRawTokens','showEstimatedCost','hideDockIcon','launchAtLogin',
  'localBackupEnabled',
]);

// IDs that should be text/number input elements (match real HTML <input> without type=checkbox)
const TEXT_INPUT_IDS = new Set([
  'nickname','wizard-nickname','apiBaseUrl','wizard-api-base-url',
  'cursor-token-input','wizard-participant-id',
  'localBackupRetention','runtimeLogRetentionDays','refreshIntervalMinutes',
]);

const SELECT_IDS = new Set(['overview-range','workdirs-range','theme']);

// IDs that should be button elements (disabled/click semantics)
const BUTTON_IDS = new Set([
  'rail-restart-update','check-update','download-update','download-installer',
  'enforcement-download-update','enforcement-download-installer',
  'refresh-health','brand-refresh','backup-now','choose-backup-directory',
  'clear-local-backups','clear-runtime-log','reveal-backup-directory',
  'reveal-runtime-log-directory','export-diagnostics','export','import',
  'save-cursor-token','add-cursor-token','cancel-cursor-token','connect-cursor',
  'cancel-cursor-connect','disconnect-cursor','add-claude-root','add-codex-root',
  'wizard-skip','wizard-next-0','wizard-next-1','wizard-back-1','wizard-back-2',
  'wizard-start','wizard-create-identity','wizard-import','wizard-import-join',
  'wizard-import-restore','wizard-import-actions','import-mode-cancel',
  'import-mode-join','import-mode-restore','reset-local-data','reset-local-only',
  'reset-with-cloud','reset-cancel','app-confirm-cancel','app-confirm-ok',
  'close-trend-drawer','trend-drawer-copy',
]);

export function createStubDOM() {
  const container = document.createElement('div');
  container.id = 'stub-root';

  for (const id of ALL_IDS) {
    if (document.getElementById(id)) continue;
    let el;
    if (INPUT_IDS.has(id)) {
      el = document.createElement('input');
      el.type = 'checkbox';
    } else if (TEXT_INPUT_IDS.has(id)) {
      el = document.createElement('input');
    } else if (BUTTON_IDS.has(id)) {
      el = document.createElement('button');
    } else if (SELECT_IDS.has(id)) {
      el = document.createElement('select');
      for (const val of id === 'theme' ? ['light', 'dark'] : ['today', '7d', '30d', 'all']) {
        const opt = document.createElement('option');
        opt.value = val;
        opt.textContent = val;
        el.appendChild(opt);
      }
    } else {
      el = document.createElement('div');
    }
    el.id = id;
    container.appendChild(el);
  }

  // Screen sections
  for (const sid of ['overview', 'settings', 'workdirs', 'sources']) {
    let el = document.getElementById(sid);
    if (!el) {
      el = document.createElement('section');
      el.id = sid;
      el.className = 'screen';
      container.appendChild(el);
    }
  }

  // Nav buttons
  for (const sid of ['overview', 'settings', 'workdirs', 'sources']) {
    const btn = document.createElement('button');
    btn.dataset.section = sid;
    container.appendChild(btn);
  }

  // Settings tabs
  const tabsContainer = document.getElementById('settings-tabs') || document.createElement('div');
  for (const tab of ['app', 'cloud', 'about']) {
    const btn = document.createElement('button');
    btn.dataset.settingsTab = tab;
    tabsContainer.appendChild(btn);
  }
  if (!tabsContainer.parentElement) container.appendChild(tabsContainer);

  // Settings panels
  for (const tab of ['app', 'cloud', 'about']) {
    const sec = document.createElement('section');
    sec.dataset.settingsPanel = tab;
    container.appendChild(sec);
  }

  if (!document.getElementById('stub-root')) {
    document.body.appendChild(container);
  }
}
