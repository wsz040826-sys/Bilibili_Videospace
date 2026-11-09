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

async function loadSettings() {
  const got = await chrome.storage.sync.get(SETTINGS_KEY);
  settings = { ...DEFAULTS, ...(got[SETTINGS_KEY] || {}) };
  applyBarHeight();
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
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes[SETTINGS_KEY]) {
    settings = { ...DEFAULTS, ...(changes[SETTINGS_KEY].newValue || {}) };
    applyBarHeight();
    render();
  }
  if (area === 'local' && changes[STATE_KEY]) render();
});
