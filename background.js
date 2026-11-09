// 后台：维护“工作台”状态（虚拟标签列表 + 宿主标签页），自动归并新开的 Bilibili 视频标签页。
//
// 工作原理：
// - 宿主标签页是一个真实的 bilibili.com/video 页面（所以 Bilibili 原有界面和功能都在，其它基于 Bilibili 的扩展也能正常工作）；
// - 其它 Bilibili 视频标签页一旦出现，就把它的 BV 号记进虚拟标签列表，然后关掉原标签，并让宿主页切到该视频；
// - 宿主页里的 content.js 负责画顶部标签栏，main-world.js 负责调用 Bilibili 页面自己的站内切换逻辑。

const STATE_KEY = 'biliWsState';
const SETTINGS_KEY = 'biliWsSettings';
const VIDEO_RE = /^https:\/\/www\.bilibili\.com\/video\/(BV[0-9A-Za-z]+)/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bvidFromUrl = (url) => {
  const m = String(url || '').match(VIDEO_RE);
  return m ? m[1] : null;
};

async function readSettings() {
  const got = await chrome.storage.sync.get(SETTINGS_KEY);
  return got[SETTINGS_KEY] || {};
}

async function readState() {
  const got = await chrome.storage.local.get(STATE_KEY);
  const s = got[STATE_KEY];
  return s && Array.isArray(s.tabs) ? { closed: [], ...s } : { tabs: [], active: null, hostTabId: null, closed: [] };
}
async function writeState(s) {
  await chrome.storage.local.set({ [STATE_KEY]: s });
}

const infoCache = new Map();
async function fetchVideoInfo(bvid) {
  if (infoCache.has(bvid)) return infoCache.get(bvid);
  try {
    const r = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`, { credentials: 'include' });
    const j = await r.json();
    if (j && j.code === 0 && j.data) {
      const info = { title: j.data.title, cover: j.data.pic };
      infoCache.set(bvid, info);
      return info;
    }
  } catch (e) { /* 忽略：标题可以稍后再补 */ }
  return null;
}

function upsertTab(state, bvid, info) {
  let t = state.tabs.find((x) => x.bvid === bvid);
  if (!t) {
    t = { bvid, title: (info && info.title) || bvid, cover: (info && info.cover) || '' };
    state.tabs.push(t);
  } else if (info) {
    t.title = info.title || t.title;
    t.cover = info.cover || t.cover;
  }
  return t;
}

let queue = Promise.resolve();
function serial(fn) {
  queue = queue.then(fn, fn);
  return queue;
}

// Ctrl/Cmd+点击 Bilibili 视频链接时，浏览器会开一个原生新标签页；这个标记用来告诉后台“别归并这个标签页”
let nativeTabUntil = 0;
const nativeTabIds = new Set();
let lastAbsorbAt = 0;
const handledAbsorb = new Set(); // 已在某一处被归并处理的 tabId（onCreated / onBeforeNavigate 去重）
function markHandled(tabId) {
  handledAbsorb.add(tabId);
  setTimeout(() => handledAbsorb.delete(tabId), 30000);
}          // 用来判断“一批同时打开的视频”
let suppressHostRecreate = false; // CLOSE_WORKSPACE 时不要后台重建
let backgroundHostCreating = false; // 正在后台创建宿主

function settingsOrDefault(s) {
  return Object.assign({ absorbSwitch: 'last', afterCloseAll: 'empty', autoRestoreTabs: true }, s || {});
}

async function getHostTab(state) {
  if (!state.hostTabId) return null;
  try {
    return await chrome.tabs.get(state.hostTabId);
  } catch (e) {
    return null;
  }
}

async function switchHostTo(bvid, activate = true) {
  const state = await readState();
  const host = await getHostTab(state);
  if (!host) return false;
  if (activate) {
    try {
      await chrome.tabs.update(host.id, { active: true });
      await chrome.windows.update(host.windowId, { focused: true });
    } catch (e) { /* 窗口可能已关闭 */ }
  }
  const isVideoPage = !!bvidFromUrl(host.pendingUrl || host.url);
  if (!isVideoPage) {
    try { await chrome.tabs.update(host.id, { url: `https://www.bilibili.com/video/${bvid}/` }); } catch (e) {}
    return true;
  }
  for (let i = 0; i < 20; i++) {
    try {
      await chrome.tabs.sendMessage(host.id, { type: 'SWITCH', bvid });
      return true;
    } catch (e) {
      await sleep(250);
    }
  }
  try { await chrome.tabs.update(host.id, { url: `https://www.bilibili.com/video/${bvid}/` }); } catch (e) {}
  return false;
}

// 把窗口里其它已存在的 Bilibili 视频标签页合并进工作台
async function absorbExistingTabs() {
  const state = await readState();
  const host = await getHostTab(state);
  if (!host) return;
  let others = [];
  try {
    others = await chrome.tabs.query({ windowId: host.windowId, url: 'https://www.bilibili.com/video/*' });
  } catch (e) {
    return;
  }
  let changed = false;
  for (const t of others) {
    if (t.id === host.id) continue;
    if (nativeTabIds.has(t.id)) continue;
    const bvid = bvidFromUrl(t.url);
    if (!bvid) continue;
    const info = await fetchVideoInfo(bvid);
    upsertTab(state, bvid, info);
    changed = true;
    try { await chrome.tabs.remove(t.id); } catch (e) {}
  }
  if (changed) await writeState(state);
}

// 新标签页出现：如果是 Bilibili 视频页就归并
chrome.tabs.onCreated.addListener((tab) => serial(async () => {
  const bvid = bvidFromUrl(tab.pendingUrl || tab.url);
  if (!bvid) return;
  if (handledAbsorb.has(tab.id)) return;
  if (backgroundHostCreating) {
    backgroundHostCreating = false;
    const st = await readState();
    st.hostTabId = tab.id;
    upsertTab(st, bvid);
    if (!st.active) st.active = bvid;
    await writeState(st);
    return;
  }
  // Ctrl/Cmd+点击打开的原生标签页：不归并，保留为普通 Bilibili 页面
  if (Date.now() < nativeTabUntil) {
    nativeTabUntil = 0;
    nativeTabIds.add(tab.id);
    return;
  }
  const state = await readState();
  if (state.hostTabId === tab.id) {
    upsertTab(state, bvid);
    state.active = bvid;
    await writeState(state);
    return;
  }
  const host = await getHostTab(state);
  if (!host) {
    state.hostTabId = tab.id;
    upsertTab(state, bvid);
    state.active = bvid;
    await writeState(state);
    await absorbExistingTabs();
    return;
  }
  markHandled(tab.id);
  const info = await fetchVideoInfo(bvid);
  upsertTab(state, bvid, info);
  const st = settingsOrDefault(await readSettings());
  const now = Date.now();
  const burst = now - lastAbsorbAt < 4000;
  lastAbsorbAt = now;
  const shouldSwitch = st.absorbSwitch !== 'first';
  if (shouldSwitch) state.active = bvid;
  await writeState(state);
  try { await chrome.tabs.remove(tab.id); } catch (e) {}
  if (shouldSwitch) await switchHostTo(bvid, tab.active === true);
}));

// 宿主标签页关闭：清空宿主标记（虚拟标签列表保留）
chrome.tabs.onRemoved.addListener((tabId) => serial(async () => {
  nativeTabIds.delete(tabId);
  if (backgroundHostCreating) return; // 我们自己创建后台宿主的回调
  const state = await readState();
  if (state.hostTabId !== tabId) return;
  state.hostTabId = null;
  const st = settingsOrDefault(await readSettings());
  if (st.autoRestoreTabs === false) {
    // 不自动恢复：把标签页全部移入“最近关闭”，下次启动是空工作台，Alt+T 可批量唤回
    state.closed = Array.isArray(state.closed) ? state.closed.slice(-30) : [];
    for (const t of state.tabs) state.closed.push({ bvid: t.bvid, title: t.title, cover: t.cover, index: 0 });
    state.tabs = [];
    state.active = null;
  }
  await writeState(state);
}));

async function openPopup(url, width, height) {
  try {
    await chrome.windows.create({ url, type: 'popup', width, height });
  } catch (e) {
    await chrome.tabs.create({ url });
  }
}

// 扩展图标：打开/聚焦工作台
chrome.action.onClicked.addListener(() => serial(async () => {
  const state = await readState();
  const host = await getHostTab(state);
  if (host) {
    await chrome.tabs.update(host.id, { active: true });
    await chrome.windows.update(host.windowId, { focused: true });
    await absorbExistingTabs();
    return;
  }
  const url = state.active ? `https://www.bilibili.com/video/${state.active}/` : chrome.runtime.getURL('blank.html');
  const tab = await chrome.tabs.create({ url, active: true });
  if (!state.active) {
    state.hostTabId = tab.id;
    await writeState(state);
  }
}));

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return false;
  if (msg.type === 'INJECT_MAIN' && sender.tab && sender.tab.id) {
    chrome.scripting.executeScript({
      target: { tabId: sender.tab.id },
      world: 'MAIN',
      files: ['main-world.js'],
    }).then(() => sendResponse({ ok: true })).catch((e) => sendResponse({ ok: false, err: String(e) }));
    return true;
  }
  if (msg.type === 'CLOSE_WORKSPACE') {
    serial(async () => {
      const state = await readState();
      const host = await getHostTab(state);
      suppressHostRecreate = true;
      if (host) { try { await chrome.tabs.remove(host.id); } catch (e) {} }
      sendResponse({ ok: true });
    });
    return true;
  }
  if (msg.type === 'RESTORE_BVID' && typeof msg.bvid === 'string') {
    serial(async () => {
      const state = await readState();
      const closed = Array.isArray(state.closed) ? state.closed : [];
      const idx = closed.findIndex((t) => t.bvid === msg.bvid);
      if (idx < 0) return sendResponse({ ok: false, state });
      const item = closed.splice(idx, 1)[0];
      if (!state.tabs.some((t) => t.bvid === item.bvid)) {
        const at = Math.min(Number.isFinite(item.index) ? item.index : state.tabs.length, state.tabs.length);
        state.tabs.splice(at, 0, { bvid: item.bvid, title: item.title || item.bvid, cover: item.cover || '' });
      }
      state.active = item.bvid;
      await writeState(state);
      sendResponse({ ok: true, state, bvid: item.bvid });
    });
    return true;
  }
  if (msg.type === 'OPEN_OPTIONS') {
    openPopup(chrome.runtime.getURL('options.html'), 620, 720);
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'OPEN_DEBUG') {
    openPopup(chrome.runtime.getURL('debug.html'), 900, 640);
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'ARM_NATIVE_TAB') {
    // content script 在 Ctrl/Cmd+点击链接时提前通知：下一个新标签页保持原生
    nativeTabUntil = Math.max(nativeTabUntil, Number(msg.until) || Date.now() + 4000);
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'ADD_TAB' && typeof msg.bvid === 'string') {
    serial(async () => {
      const state = await readState();
      const info = await fetchVideoInfo(msg.bvid);
      upsertTab(state, msg.bvid, info);
      if (msg.switchTo) state.active = msg.bvid;
      await writeState(state);
      sendResponse({ ok: true });
      if (msg.switchTo) await switchHostTo(msg.bvid);
    });
    return true;
  }
  if (msg.type === 'CLAIM_HOST' && sender.tab && sender.tab.id) {
    serial(async () => {
      const tabId = sender.tab.id;
      // 属于“Ctrl+点击原生打开”的标签页：不归并、也不显示工作台
      if (nativeTabIds.has(tabId)) {
        nativeTabIds.delete(tabId);
        sendResponse({ isHost: false, keep: true });
        return;
      }
      if (handledAbsorb.has(tabId)) {
        sendResponse({ isHost: false, keep: true });
        return;
      }
      const state = await readState();
      const bvid = bvidFromUrl(sender.tab.url || '');
      let selfTab = null;
      try { selfTab = await chrome.tabs.get(tabId); } catch (e) {}
      const isActive = !!(selfTab && selfTab.active);

      if (state.hostTabId === tabId) {
        sendResponse({ isHost: true, state });
        return;
      }
      if (!state.hostTabId) {
        state.hostTabId = tabId;
        if (bvid) {
          const info = await fetchVideoInfo(bvid);
          upsertTab(state, bvid, info);
          state.active = bvid;
        }
        await writeState(state);
        sendResponse({ isHost: true, state });
        await absorbExistingTabs();
        return;
      }
      const other = await getHostTab(state);
      // 宿主标签页已经不在了（扩展重载/关闭后常见）：当前标签接管
      if (!other) {
        state.hostTabId = tabId;
        if (bvid) {
          const info = await fetchVideoInfo(bvid);
          upsertTab(state, bvid, info);
          state.active = bvid;
        }
        await writeState(state);
        sendResponse({ isHost: true, state });
        await absorbExistingTabs();
        return;
      }
      // 当前标签是激活标签：优先让它当宿主，旧宿主让位（不关闭，避免误关用户标签）
      if (isActive) {
        state.hostTabId = tabId;
        if (bvid) {
          const info = await fetchVideoInfo(bvid);
          upsertTab(state, bvid, info);
          state.active = bvid;
        }
        await writeState(state);
        sendResponse({ isHost: true, state });
        // 旧宿主让位后关闭，避免同时存在两个 Bilibili 页面（它的 BV 号已经在虚拟标签列表里）
        try { await chrome.tabs.remove(other.id); } catch (e) {}
        return;
      }
      // 非激活的重复 Bilibili 页面：并入工作台后关闭
      if (!bvid) { sendResponse({ isHost: false, state }); return; }
      const info = await fetchVideoInfo(bvid);
      upsertTab(state, bvid, info);
      await writeState(state);
      sendResponse({ isHost: false, state });
      try { await chrome.tabs.remove(tabId); } catch (e) {}
    });
    return true;
  }
  if (msg.type === 'SET_DIAG' && msg.info) {
    chrome.storage.local.set({ biliWsDiag: msg.info }).then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (msg.type === 'SET_ACTIVE' && typeof msg.bvid === 'string') {
    serial(async () => {
      const state = await readState();
      if (!sender.tab || state.hostTabId !== sender.tab.id) return sendResponse({ ok: false });
      if (state.tabs.some((t) => t.bvid === msg.bvid)) state.active = msg.bvid;
      await writeState(state);
      sendResponse({ ok: true, state });
    });
    return true;
  }
  if (msg.type === 'CLOSE_TAB' && typeof msg.bvid === 'string') {
    serial(async () => {
      const state = await readState();
      const idx = state.tabs.findIndex((t) => t.bvid === msg.bvid);
      if (idx < 0) return sendResponse({ ok: false, state });
      const [removed] = state.tabs.splice(idx, 1);
      state.closed = Array.isArray(state.closed) ? state.closed.slice(-19) : [];
      state.closed.push({ ...removed, index: idx });
      let switchTo = null;
      if (state.active === msg.bvid) {
        const next = state.tabs[Math.min(idx, state.tabs.length - 1)];
        state.active = next ? next.bvid : null;
        switchTo = next ? next.bvid : null;
      }
      await writeState(state);
      sendResponse({ ok: true, state, switchTo });
      if (!state.tabs.length) {
        const st = settingsOrDefault(await readSettings());
        const hostNow = await getHostTab(state);
        if (hostNow && st.afterCloseAll === 'empty') {
          try { await chrome.tabs.update(hostNow.id, { url: chrome.runtime.getURL('blank.html') }); } catch (e) {}
        }
      }
    });
    return true;
  }
  if (msg.type === 'RESTORE_TAB') {
    serial(async () => {
      const state = await readState();
      const closed = Array.isArray(state.closed) ? state.closed : [];
      if (!closed.length) return sendResponse({ ok: false, state });
      if (!state.tabs.length) {
        // 空工作台：把“最近关闭”的全部恢复
        for (const item of closed.splice(0)) {
          if (!state.tabs.some((t) => t.bvid === item.bvid)) state.tabs.push({ bvid: item.bvid, title: item.title || item.bvid, cover: item.cover || '' });
        }
        const last = state.tabs[state.tabs.length - 1];
        state.active = last ? last.bvid : null;
        await writeState(state);
        return sendResponse({ ok: true, state, bvid: state.active });
      }
      const item = closed.pop();
      const tab = { bvid: item.bvid, title: item.title || item.bvid, cover: item.cover || '' };
      if (!state.tabs.some((t) => t.bvid === tab.bvid)) {
        const at = Math.min(Number.isFinite(item.index) ? item.index : state.tabs.length, state.tabs.length);
        state.tabs.splice(at, 0, tab);
      }
      state.active = tab.bvid;
      await writeState(state);
      sendResponse({ ok: true, state, bvid: tab.bvid });
    });
    return true;
  }
  if (msg.type === 'USER_NAVIGATED' && typeof msg.bvid === 'string') {
    serial(async () => {
      const state = await readState();
      if (!sender.tab || state.hostTabId !== sender.tab.id) return sendResponse({ ok: false });
      const bvid = msg.bvid;
      if (msg.ctrlHeld) {
        if (!state.tabs.some((t) => t.bvid === bvid)) state.tabs.push({ bvid, title: bvid, cover: '' });
        const info = await fetchVideoInfo(bvid);
        upsertTab(state, bvid, info);
      } else {
        const idx = state.tabs.findIndex((t) => t.bvid === state.active);
        if (idx >= 0) state.tabs[idx] = { bvid, title: bvid, cover: '' };
        else state.tabs.push({ bvid, title: bvid, cover: '' });
      }
      state.active = bvid;
      await writeState(state);
      sendResponse({ ok: true, state });
    });
    return true;
  }
  if (msg.type === 'REGISTER_VIDEO' && sender.tab && sender.tab.id) {
    serial(async () => {
      const state = await readState();
      if (state.hostTabId !== sender.tab.id) return sendResponse({ ok: false });
      const info = await fetchVideoInfo(msg.bvid);
      upsertTab(state, msg.bvid, info);
      state.active = msg.bvid;
      await writeState(state);
      sendResponse({ ok: true });
    });
    return true;
  }
  return false;
});
