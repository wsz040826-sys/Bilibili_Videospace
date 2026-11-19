// 设置页：读取/保存所有工作台配置
const SETTINGS_KEY = 'biliWsSettings';

const DEFAULTS = {
  tabWidthMode: 'auto',
  tabWidthAutoMax: 220,
  tabWidthFixed: 140,
  brandText: '工作台',
  closeShortcut: 'Alt+W',
  restoreShortcut: 'Alt+T',
  drawerShortcut: 'Alt+Q',
  drawerCover: true,
  nativeTabModifier: 'ctrl',
  newTabModifier: 'shift',
  hideInWebFullscreen: true,
  barTheme: 'page',
  barColor: '#18191c',
  debug: false,
};

async function load() {
  const got = await chrome.storage.sync.get(SETTINGS_KEY);
  const s = { ...DEFAULTS, ...(got[SETTINGS_KEY] || {}) };
  document.getElementById('brandText').value = s.brandText;
  document.getElementById('mode').value = s.tabWidthMode;
  document.getElementById('autoMax').value = s.tabWidthAutoMax;
  document.getElementById('fixedW').value = s.tabWidthFixed;
  document.getElementById('barTheme').value = s.barTheme || 'page';
  document.getElementById('barColor').value = s.barColor || '#18191c';
  syncColorEnabled();
  document.getElementById('hideInWebFullscreen').checked = !!s.hideInWebFullscreen;
  document.getElementById('closeShortcut').value = s.closeShortcut;
  document.getElementById('restoreShortcut').value = s.restoreShortcut;
  document.getElementById('drawerShortcut').value = s.drawerShortcut;
  document.getElementById('drawerCover').checked = s.drawerCover !== false;
  document.getElementById('nativeTabModifier').value = s.nativeTabModifier;
  document.getElementById('newTabModifier').value = s.newTabModifier;
  document.getElementById('debug').checked = !!s.debug;
}

function normalizeShortcut(v, fallback) {
  const s = String(v || '').trim();
  if (!s) return fallback;
  return s;
}

function syncColorEnabled() {
  document.getElementById('barColor').disabled = document.getElementById('barTheme').value !== 'fixed';
}
document.getElementById('barTheme').addEventListener('change', syncColorEnabled);

document.getElementById('save').addEventListener('click', async () => {
  // 这个设置页只维护部分字段（其余在页内设置弹窗里），保存时保留已有字段，避免把它们清掉
  const got = await chrome.storage.sync.get(SETTINGS_KEY);
  const s = {
    ...(got[SETTINGS_KEY] || {}),
    brandText: String(document.getElementById('brandText').value || '').trim() || '工作台',
    tabWidthMode: document.getElementById('mode').value === 'fixed' ? 'fixed' : 'auto',
    tabWidthAutoMax: Math.min(600, Math.max(60, Number(document.getElementById('autoMax').value) || 220)),
    tabWidthFixed: Math.min(600, Math.max(60, Number(document.getElementById('fixedW').value) || 140)),
    hideInWebFullscreen: document.getElementById('hideInWebFullscreen').checked,
    barTheme: document.getElementById('barTheme').value,
    barColor: /^#[0-9a-f]{6}$/i.test(document.getElementById('barColor').value) ? document.getElementById('barColor').value : '#18191c',
    closeShortcut: normalizeShortcut(document.getElementById('closeShortcut').value, 'Alt+W'),
    restoreShortcut: normalizeShortcut(document.getElementById('restoreShortcut').value, 'Alt+T'),
    drawerShortcut: normalizeShortcut(document.getElementById('drawerShortcut').value, 'Alt+Q'),
    drawerCover: document.getElementById('drawerCover').checked,
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
