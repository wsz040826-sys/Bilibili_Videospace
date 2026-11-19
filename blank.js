// 空白工作台页面：没有虚拟标签时显示，输入 BV/链接或从“最近关闭”恢复
// 设置弹窗与 Bilibili 页面内的设置弹窗保持一致（同样的字段、同样的样式/滚动条）。
const STATE_KEY = 'biliWsState';
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
  barTheme: 'page',
  barColor: '#18191c',
  debug: false,
  absorbSwitch: 'first',
  afterCloseAll: 'empty',
  autoRestoreTabs: false,
};

let settings = { ...DEFAULTS };

const $ = (id) => document.getElementById(id);
const bvidOf = (s) => {
  const m = String(s || '').match(/BV[0-9A-Za-z]+/);
  return m ? m[0] : null;
};

function applyBarHeight() {
  document.documentElement.style.setProperty('--bar-h', '30px');
}

// 空白工作台没有 B站 页面主题可跟随：'page' 退化为浏览器（系统）深浅色，'fixed' 按所选颜色。
function fixedColorRgb() {
  const m = String(settings.barColor || '').match(/^#?([0-9a-f]{6})$/i);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function blankPageDark() {
  if ((settings.barTheme || 'page') === 'fixed') {
    const c = fixedColorRgb();
    if (c) return (0.299 * c.r + 0.587 * c.g + 0.114 * c.b) < 128;
    return true;
  }
  try { return window.matchMedia('(prefers-color-scheme: dark)').matches; } catch (e) { return true; }
}

function applyTheme() {
  const dark = blankPageDark();
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  const root = document.documentElement;
  if ((settings.barTheme || 'page') === 'fixed') {
    const c = fixedColorRgb();
    if (c) {
      root.style.setProperty('--bar-bg', '#' + [c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, '0')).join(''));
      root.style.setProperty('--bar-fg', dark ? '#f2f3f5' : '#18191c');
      root.style.setProperty('--bar-muted', dark ? 'rgba(255,255,255,.65)' : 'rgba(0,0,0,.6)');
      return;
    }
  }
  root.style.removeProperty('--bar-bg');
  root.style.removeProperty('--bar-fg');
  root.style.removeProperty('--bar-muted');
}

async function loadSettings() {
  const got = await chrome.storage.sync.get(SETTINGS_KEY);
  settings = { ...DEFAULTS, ...(got[SETTINGS_KEY] || {}) };
  applyBarHeight();
  applyTheme();
}

async function render() {
  const got = await chrome.storage.local.get(STATE_KEY);
  const st = got[STATE_KEY] || {};
  const brand = String(settings.brandText || '').trim();
  $('brand').textContent = brand;
  $('brand').style.display = brand ? '' : 'none';
  const box = $('recent');
  box.textContent = '';
  const closed = Array.isArray(st.closed) ? st.closed : [];
  if (!closed.length) return;
  const h = document.createElement('div');
  h.className = 'hint';
  h.textContent = '最近关闭';
  box.appendChild(h);
  closed.slice().reverse().forEach((item) => {
    const row = document.createElement('div');
    row.className = 'item';
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = item.title || item.bvid;
    const b = document.createElement('span');
    b.textContent = '恢复';
    row.appendChild(t);
    row.appendChild(b);
    row.addEventListener('click', async () => {
      const resp = await chrome.runtime.sendMessage({ type: 'RESTORE_BVID', bvid: item.bvid }).catch(() => null);
      if (resp && resp.ok) location.href = `https://www.bilibili.com/video/${item.bvid}/`;
    });
    box.appendChild(row);
  });
}

function goVideo(bvid) {
  location.href = `https://www.bilibili.com/video/${bvid}/`;
}

function openInput() {
  const bvid = bvidOf($('input').value);
  if (!bvid) return;
  goVideo(bvid);
}

// ---------- 设置弹窗（与内容脚本里的弹窗一致） ----------
function openSettings() {
  $('mBrand').value = settings.brandText || '';
  $('mMode').value = settings.tabWidthMode;
  $('mAutoMax').value = settings.tabWidthAutoMax;
  $('mFixedW').value = settings.tabWidthFixed;
  $('mBarTheme').value = settings.barTheme || 'page';
  $('mBarColor').value = settings.barColor || '#18191c';
  $('mBarColor').disabled = (settings.barTheme || 'page') !== 'fixed';
  $('mCloseShortcut').value = settings.closeShortcut;
  $('mRestoreShortcut').value = settings.restoreShortcut;
  $('mNativeMod').value = settings.nativeTabModifier;
  $('mNewMod').value = settings.newTabModifier;
  $('mAbsorb').value = settings.absorbSwitch;
  $('mAfterCloseAll').value = settings.afterCloseAll;
  $('mAutoRestore').checked = !!settings.autoRestoreTabs;
  $('mHideFs').checked = !!settings.hideInWebFullscreen;
  $('mDebug').checked = !!settings.debug;
  $('saved').style.display = 'none';
  $('modalBack').classList.add('show');
}
function closeSettings() { $('modalBack').classList.remove('show'); }
async function saveSettings() {
  const next = {
    brandText: String($('mBrand').value || '').trim(),
    tabWidthMode: $('mMode').value === 'fixed' ? 'fixed' : 'auto',
    tabWidthAutoMax: Math.min(600, Math.max(60, Number($('mAutoMax').value) || 220)),
    tabWidthFixed: Math.min(600, Math.max(60, Number($('mFixedW').value) || 140)),
    barTheme: ['page', 'system', 'fixed'].includes($('mBarTheme').value) ? $('mBarTheme').value : 'page',
    barColor: /^#[0-9a-f]{6}$/i.test($('mBarColor').value) ? $('mBarColor').value : '#18191c',
    closeShortcut: String($('mCloseShortcut').value || '').trim() || 'Alt+W',
    restoreShortcut: String($('mRestoreShortcut').value || '').trim() || 'Alt+T',
    nativeTabModifier: $('mNativeMod').value,
    newTabModifier: $('mNewMod').value,
    absorbSwitch: $('mAbsorb').value,
    afterCloseAll: $('mAfterCloseAll').value,
    autoRestoreTabs: $('mAutoRestore').checked,
    hideInWebFullscreen: $('mHideFs').checked,
    debug: $('mDebug').checked,
  };
  settings = { ...settings, ...next };
  await chrome.storage.sync.set({ [SETTINGS_KEY]: next });
  applyBarHeight();
  applyTheme();
  const brand = String(settings.brandText || '').trim();
  $('brand').textContent = brand;
  $('brand').style.display = brand ? '' : 'none';
  $('saved').style.display = 'inline';
  setTimeout(() => { $('saved').style.display = 'none'; }, 1500);
}

// ---------- 事件 ----------
$('open').addEventListener('click', openInput);
$('input').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); openInput(); } });
$('opts').addEventListener('click', openSettings);
$('modalClose').addEventListener('click', closeSettings);
$('mCancel').addEventListener('click', closeSettings);
$('mSave').addEventListener('click', saveSettings);
// 只有“固定颜色”模式才需要选颜色
$('mBarTheme').addEventListener('change', () => {
  $('mBarColor').disabled = $('mBarTheme').value !== 'fixed';
});
let modalDownOnBack = false;
$('modalBack').addEventListener('mousedown', (e) => { modalDownOnBack = e.target === $('modalBack'); });
$('modalBack').addEventListener('mouseup', (e) => {
  if (modalDownOnBack && e.target === $('modalBack')) closeSettings();
  modalDownOnBack = false;
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('modalBack').classList.contains('show')) { e.preventDefault(); closeSettings(); }
});

(async () => {
  await loadSettings();
  await render();
})();
// 浏览器重启后空白工作台标签页可能被会话恢复出来：重新登记成宿主，
// 否则之后打开的视频会另开一个工作台标签，旧空白页变成没人管的游离标签。
chrome.runtime.sendMessage({ type: 'CLAIM_BLANK_HOST' }).catch(() => {});
// 系统深浅色变化时，“跟随浏览器设置”（以及空白页上的“跟随当前页面设置”）要实时生效
try {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
} catch (e) { /* 老内核没有 addEventListener */ }
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes[SETTINGS_KEY]) {
    settings = { ...DEFAULTS, ...(changes[SETTINGS_KEY].newValue || {}) };
    applyBarHeight();
    applyTheme();
    render();
  }
  if (area === 'local' && changes[STATE_KEY]) render();
});
