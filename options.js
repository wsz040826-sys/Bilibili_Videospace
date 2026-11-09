// 设置页：读取/保存所有工作台配置
const SETTINGS_KEY = 'biliWsSettings';

const DEFAULTS = {
  tabWidthMode: 'auto',
  tabWidthAutoMax: 220,
  tabWidthFixed: 140,
  brandText: '工作台',
  closeShortcut: 'Alt+W',
  restoreShortcut: 'Alt+T',
  nativeTabModifier: 'ctrl',
  newTabModifier: 'shift',
  hideInWebFullscreen: true,
  debug: false,
};

async function load() {
  const got = await chrome.storage.sync.get(SETTINGS_KEY);
  const s = { ...DEFAULTS, ...(got[SETTINGS_KEY] || {}) };
  document.getElementById('brandText').value = s.brandText;
  document.getElementById('mode').value = s.tabWidthMode;
  document.getElementById('autoMax').value = s.tabWidthAutoMax;
  document.getElementById('fixedW').value = s.tabWidthFixed;
  document.getElementById('hideInWebFullscreen').checked = !!s.hideInWebFullscreen;
  document.getElementById('closeShortcut').value = s.closeShortcut;
  document.getElementById('restoreShortcut').value = s.restoreShortcut;
  document.getElementById('nativeTabModifier').value = s.nativeTabModifier;
  document.getElementById('newTabModifier').value = s.newTabModifier;
  document.getElementById('debug').checked = !!s.debug;
}

function normalizeShortcut(v, fallback) {
  const s = String(v || '').trim();
  if (!s) return fallback;
  return s;
}

document.getElementById('save').addEventListener('click', async () => {
  const s = {
    brandText: String(document.getElementById('brandText').value || '').trim() || '工作台',
    tabWidthMode: document.getElementById('mode').value === 'fixed' ? 'fixed' : 'auto',
    tabWidthAutoMax: Math.min(600, Math.max(60, Number(document.getElementById('autoMax').value) || 220)),
    tabWidthFixed: Math.min(600, Math.max(60, Number(document.getElementById('fixedW').value) || 140)),
    hideInWebFullscreen: document.getElementById('hideInWebFullscreen').checked,
    closeShortcut: normalizeShortcut(document.getElementById('closeShortcut').value, 'Alt+W'),
    restoreShortcut: normalizeShortcut(document.getElementById('restoreShortcut').value, 'Alt+T'),
    nativeTabModifier: document.getElementById('nativeTabModifier').value,
    newTabModifier: document.getElementById('newTabModifier').value,
    debug: document.getElementById('debug').checked,
  };
  await chrome.storage.sync.set({ [SETTINGS_KEY]: s });
  const tip = document.getElementById('saved');
  tip.style.display = 'inline';
  setTimeout(() => { tip.style.display = 'none'; }, 1200);
});

load();
