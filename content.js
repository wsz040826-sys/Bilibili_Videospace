// 内容脚本（隔离世界）：顶部工作台标签栏、虚拟标签状态、快捷键、与后台/主世界通信。
//
// 宿主页是真实的 Bilibili 视频页：除顶部多了这条标签栏外，其余界面和功能都仍然是 Bilibili 自己的。
// 切换标签时通过 main-world.js 调用 Bilibili 页面自己的站内切换（pathTo → RELOAD_VIDEO），不整页刷新。

(() => {
  if (document.getElementById('__bili_ws_host')) return;

  const STATE_KEY = 'biliWsState';
  const SETTINGS_KEY = 'biliWsSettings';
  const LOG_KEY = 'biliWsLogs';
  let BAR_HEIGHT = 30; // 标签栏高度（先固定 30，保留变量方便以后加回自定义）
  const VIDEO_RE = /\/video\/(BV[0-9A-Za-z]+)/;

  const DEFAULT_SETTINGS = {
    tabWidthMode: 'auto',
    tabWidthAutoMax: 220,
    tabWidthFixed: 140,
    brandText: '工作台',
    closeShortcut: 'Alt+W',
    restoreShortcut: 'Alt+T',
    nativeTabModifier: 'ctrl', // 浏览器原生打开、工作台不拦截
    newTabModifier: 'shift',     // 在工作台新开虚拟标签（不切过去）
    hideInWebFullscreen: true, // B站“网页全屏”时隐藏工作台标签栏
    debug: false,
    absorbSwitch: 'first',     // 同时收进多个视频：'last' 切到最后一个 / 'first' 保持第一个
    afterCloseAll: 'empty',    // 关完所有虚拟标签后：'empty' 显示空工作台 / 'closeTab' 关闭本页
    autoRestoreTabs: false,    // 下次启动工作台时是否自动恢复上次未关闭的虚拟标签页
  };

  let state = { tabs: [], active: null, hostTabId: null, closed: [] };
  let settings = { ...DEFAULT_SETTINGS };
  let mainReady = false;
  let pendingSwitch = null;
  let expectedSwitch = null;
  let lastSwitchResult = null;
  let disabled = false; // 本标签页不是宿主（原生标签页）时，关闭所有工作台逻辑

  const log = (...args) => console.log('[Bilibili工作台]', ...args);
  const extVersion = () => {
    try { return chrome.runtime.getManifest().version; } catch (e) { return '?'; }
  };
  function dlog(...args) {
    log(...args);
    if (!settings.debug) return;
    const line = {
      t: Date.now(),
      s: 'content',
      m: args.map((x) => {
        try { return typeof x === 'string' ? x : JSON.stringify(x); } catch (e) { return String(x); }
      }).join(' '),
    };
    chrome.storage.local.get(LOG_KEY).then((got) => {
      const arr = Array.isArray(got[LOG_KEY]) ? got[LOG_KEY].slice(-499) : [];
      arr.push(line);
      chrome.storage.local.set({ [LOG_KEY]: arr });
    }).catch(() => {});
  }

  // ---------- 顶部标签栏（Shadow DOM） ----------
  const hostEl = document.createElement('div');
  hostEl.id = '__bili_ws_host';
  hostEl.style.cssText = 'all:initial;position:fixed;left:0;top:0;right:0;height:' + BAR_HEIGHT + 'px;z-index:2147483647;';
  const shadow = hostEl.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      .bar {
        display: flex; align-items: center; gap: 6px;
        height: var(--bili-ws-bar-h, 36px); box-sizing: border-box; padding: 0 10px;
        background: #18191c; color: #e5e6e8;
        font: 12px/1.4 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
      }
      .brand { color: #9499a0; font-size: 11px; padding-right: 6px; flex: 0 0 auto; max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .tabs { display: flex; gap: 6px; flex: 1 1 auto; min-width: 0; overflow: hidden; }
      .tab {
        display: inline-flex; align-items: center; gap: 6px;
        height: 24px; padding: 0 8px; border-radius: 5px;
        background: #23262b; color: #e5e6e8; cursor: pointer;
        flex: 0 1 auto; min-width: 44px; border: 1px solid transparent;
        overflow: hidden;
      }
      .tab:hover { background: #2c3036; }
      .tab.active { border-color: #fb7299; background: #33232a; }
      .tab .title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1 1 auto; min-width: 0; }
      .tab .close { color: #7d838c; font-size: 14px; line-height: 1; padding: 0 1px; flex: 0 0 auto; }
      .tab .close:hover { color: #fb7299; }
      .empty { color: #6b7078; font-size: 11px; white-space: nowrap; }
      .tool {
        flex: 0 0 auto; color: #9499a0; cursor: pointer;
        padding: 2px 6px; border-radius: 4px; font-size: 11px;
      }
      .tool:hover { background: #2c3036; color: #e5e6e8; }
      .panel {
        position: fixed; top: 44px; right: 12px; width: 420px; max-height: 70vh;
        overflow: auto; background: #0f1115; color: #d7dae0;
        border: 1px solid #fb7299; border-radius: 8px; padding: 10px 12px;
        font: 11px/1.5 Consolas, "Courier New", monospace; white-space: pre-wrap;
        z-index: 2147483647; box-shadow: 0 6px 24px #000a;
      }
      .panel .close { float: right; cursor: pointer; color: #9499a0; }

      .modal-back { position: fixed; inset: 0; display: none; align-items: center; justify-content: center; background: rgba(0,0,0,.45); z-index: 2147483647; }
      .modal-back.show { display: flex; }
      .modal { width: 560px; max-width: calc(100vw - 40px); max-height: 80vh; display: flex; flex-direction: column; overflow: hidden; border-radius: 12px; background: #fff; color: #1f2329; box-shadow: 0 10px 40px #0008; font-size: 13px; }
      .modal.dark { background: #23262b; color: #e5e6e8; }
      .modal-head { display: flex; justify-content: space-between; align-items: center; padding: 14px 18px; font-size: 16px; font-weight: 600; border-bottom: 1px solid rgba(128,128,128,.25); }
      .modal-close { cursor: pointer; color: #9499a0; font-size: 20px; line-height: 1; }
      .modal-body { padding: 12px 18px; overflow-y: auto; flex: 1 1 auto; min-height: 0; }
      .field { margin: 12px 0; }
      .field label { display: block; margin-bottom: 4px; }
      .field .hint { color: #9499a0; font-size: 11px; margin-top: 2px; }
      .modal input[type="text"], .modal input[type="number"], .modal select { width: 100%; box-sizing: border-box; padding: 5px 8px; border-radius: 6px; border: 1px solid #c9cdd4; background: #fff; color: inherit; font: inherit; }
      .modal.dark input[type="text"], .modal.dark input[type="number"], .modal.dark select { background: #18191c; border-color: #3a3f46; color: #e5e6e8; }
      .modal-foot { display: flex; align-items: center; gap: 10px; padding: 12px 18px; border-top: 1px solid rgba(128,128,128,.25); }
      .modal-foot button { padding: 6px 16px; border-radius: 6px; border: 1px solid #c9cdd4; background: #f2f3f5; color: #1f2329; cursor: pointer; }
      .modal.dark .modal-foot button { background: #2c3036; color: #e5e6e8; border-color: #3a3f46; }
      .modal-body::-webkit-scrollbar { width: 8px; }
      .modal-body::-webkit-scrollbar-track { background: transparent; }
      .modal-body::-webkit-scrollbar-thumb { background: rgba(128,128,128,.35); border-radius: 4px; }
      .modal-body::-webkit-scrollbar-thumb:hover { background: rgba(128,128,128,.55); }
      .modal-foot button.primary { background: #fb7299; border-color: #fb7299; color: #fff; }
    </style>
    <div class="bar">
      <span class="brand" id="brand">工作台</span>
      <span class="tabs" id="tabs"></span>
      <span class="tool" id="logs">日志</span>
      <span class="tool" id="opts" title="工作台设置">⚙</span>
    </div>
    <div class="modal-back" id="modalBack">
      <div class="modal" id="modal">
        <div class="modal-head"><span>工作台设置</span><span class="modal-close" id="modalClose">×</span></div>
        <div class="modal-body">
          <div class="field"><label>左侧文字</label><input type="text" id="mBrand" maxlength="24"></div>
          <div class="field"><label>标签宽度模式</label><select id="mMode"><option value="auto">按标题自适应（有最大宽度）</option><option value="fixed">固定宽度</option></select></div>
          <div class="field"><label>按标题自适应模式：单个标签最大宽度（px）</label><input type="number" id="mAutoMax" min="60" max="600" step="10"></div>
          <div class="field"><label>固定宽度模式：每个标签宽度（px）</label><input type="number" id="mFixedW" min="60" max="600" step="10"></div>
          <div class="field"><label>关闭当前虚拟标签（快捷键）</label><input type="text" id="mCloseShortcut" placeholder="Alt+W"></div>
          <div class="field"><label>恢复刚关闭的虚拟标签（快捷键）</label><input type="text" id="mRestoreShortcut" placeholder="Alt+T"></div>
          <div class="field"><label>浏览器原生打开（工作台不拦截）</label><select id="mNativeMod"><option value="ctrl">Ctrl / Cmd + 点击</option><option value="shift">Shift + 点击</option><option value="alt">Alt + 点击（Chrome 会吞掉）</option><option value="none">不设置</option></select></div>
          <div class="field"><label>在工作台新开虚拟标签（不切过去）</label><select id="mNewMod"><option value="shift">Shift + 点击</option><option value="ctrl">Ctrl / Cmd + 点击</option><option value="alt">Alt + 点击（Chrome 会吞掉）</option><option value="none">不设置</option></select></div>
          <div class="field"><label>同时收进多个视频时</label><select id="mAbsorb"><option value="last">切换到最后一个打开的视频</option><option value="first">保持第一个打开的视频</option></select></div>
          <div class="field"><label>关闭全部虚拟标签后</label><select id="mAfterCloseAll"><option value="empty">显示空工作台界面</option><option value="closeTab">关闭本标签页</option></select></div>
          <div class="field"><label><input type="checkbox" id="mAutoRestore"> 下次启动工作台时自动恢复上次未关闭的虚拟标签页</label></div>
          <div class="field"><label><input type="checkbox" id="mHideFs"> B站“网页全屏”时隐藏工作台标签栏</label></div>
          <div class="field"><label><input type="checkbox" id="mDebug"> debug 模式（标签栏出现“日志”）</label></div>
        </div>
        <div class="modal-foot">
          <button class="primary" id="mSave">保存</button>
          <button id="mCancel">取消</button>
          <span id="mSaved" style="color:#2e9e44;display:none">已保存</span>
        </div>
      </div>
    </div>`;
  const tabsEl = shadow.getElementById('tabs');
  const brandEl = shadow.getElementById('brand');

  // ---------- 页面顶部空间（把 Bilibili 页面下移） ----------
  const shiftStyle = document.createElement('style');
  shiftStyle.id = '__bili_ws_shift';
  shiftStyle.textContent = `html { scroll-padding-top: ${BAR_HEIGHT}px !important; } html body { margin-top: ${BAR_HEIGHT}px !important; }`;
  document.documentElement.appendChild(shiftStyle);
  document.documentElement.appendChild(hostEl);

  const fixedHeaderTops = new Map(); // headerEl -> 原始 top



  // 有些扩展（比如 BewlyBewly）把自己的顶栏渲染在 open shadow DOM 里，
  // document.elementsFromPoint 只能命中 shadow host，拿不到里面的 header。
  // 这里扫描 open shadow root，若其中有固定在视口顶部的 header，就往它所在的 shadow root
  // 注入一条 CSS（adoptedStyleSheets），把 header 下移 BAR_HEIGHT。
  const shiftedShadowRoots = [];

  function ensureShadowShift(sr) {
    if (!sr || sr.__biliWsShifted) return;
    let header = null;
    try { header = sr.querySelector('header'); } catch (e) { return; }
    if (!header) return;
    let cs, r;
    try { cs = getComputedStyle(header); r = header.getBoundingClientRect(); } catch (e) { return; }
    if (cs.position !== 'fixed' && cs.position !== 'sticky') return;
    if (r.top > 5 || r.height < 20 || r.height > 130 || r.width < 300) return;
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync('header { top: var(--bili-ws-bar-h, ' + BAR_HEIGHT + 'px) !important; }');
      sr.adoptedStyleSheets = [...(sr.adoptedStyleSheets || []), sheet];
      sr.__biliWsShifted = true;
      shiftedShadowRoots.push({ sr, sheet });
    } catch (e) { /* ignore */ }
  }

  function scanShadowRoots(root) {
    const node = root || document;
    let all;
    try { all = node.querySelectorAll('*'); } catch (e) { return; }
    for (const el of all) {
      if (el.shadowRoot) ensureShadowShift(el.shadowRoot);
    }
    if (node.body) ensureShadowShift(node.body.shadowRoot);
  }

  function shiftShadowTopBars() {
    scanShadowRoots(document);
  }

  function unshiftShadowTopBars() {
    for (const { sr, sheet } of shiftedShadowRoots) {
      try {
        sr.adoptedStyleSheets = (sr.adoptedStyleSheets || []).filter((x) => x !== sheet);
        sr.__biliWsShifted = false;
      } catch (e) { /* ignore */ }
    }
    shiftedShadowRoots.length = 0;
  }

  // 一些页面布局会把 header 做成 fixed/sticky（滚动后才出现），body margin 推不动它们。
  // 用命中测试在标签栏下方找这种元素，把它们也往下挪 BAR_HEIGHT。
  function shiftFixedTopElements() {
    const w = innerWidth;
    const seen = new Set();
    for (const y of [BAR_HEIGHT + 6, BAR_HEIGHT + 26]) {
      let els = [];
      try { els = document.elementsFromPoint(Math.round(w / 2), Math.round(y)); } catch (e) { continue; }
      for (const el of els) {
        if (seen.has(el) || el === hostEl) continue;
        seen.add(el);
        let cs;
        try { cs = getComputedStyle(el); } catch (e) { continue; }
        if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
        const r = el.getBoundingClientRect();
        if (r.top > 1 || r.height < 16 || r.height > 220 || r.width < 200) continue;
        el.style.setProperty('top', BAR_HEIGHT + 'px', 'important');
      }
    }
  }

  function ensureShift() {
    if (disabled) return;
    document.body.style.setProperty('margin-top', BAR_HEIGHT + 'px', 'important');
    // Bilibili 顶部导航的实际元素（.bili-header__bar 等）常是 position: fixed，直接处理最稳
    for (const sel of ['.bili-header__bar', '.bili-header__menu', '.bili-header__banner', '.fixed-header', '#biliMainHeader']) {
      document.querySelectorAll(sel).forEach((el) => {
        let cs;
        try { cs = getComputedStyle(el); } catch (e) { return; }
        if (cs.position === 'fixed' || cs.position === 'sticky') el.style.setProperty('top', BAR_HEIGHT + 'px', 'important');
      });
    }
    // Bilibili header 若变成 fixed/sticky，会被固定标签栏盖住，这里把它也往下挪
    const headers = document.querySelectorAll('.bili-header, .fixed-header, #biliMainHeader');
    headers.forEach((h) => {
      const cs = getComputedStyle(h);
      if (cs.position === 'fixed' || cs.position === 'sticky') {
        const top = parseFloat(cs.top);
        if (!(top >= BAR_HEIGHT - 0.5)) h.style.setProperty('top', BAR_HEIGHT + 'px', 'important');
      }
    });
    shiftFixedTopElements();
    // 某些布局下整个应用容器是 fixed/absolute 的，body margin 推不动它
    const app = document.getElementById('app');
    if (app) {
      const cs = getComputedStyle(app);
      const top = app.getBoundingClientRect().top;
      if ((cs.position === 'fixed' || cs.position === 'absolute') && top < BAR_HEIGHT - 1) {
        app.style.setProperty('margin-top', BAR_HEIGHT + 'px', 'important');
      }
    }
  }

  function resetShift() {
    unshiftShadowTopBars();
    document.body.style.setProperty('margin-top', '0px', 'important');
    document.querySelectorAll('.bili-header, .bili-header__bar, .bili-header__menu, .bili-header__banner, .fixed-header, #biliMainHeader').forEach((h) => h.style.removeProperty('top'));
    const app = document.getElementById('app');
    if (app) app.style.removeProperty('margin-top');
  }

  function isWebFullscreen() {
    const c = document.querySelector('.bpx-player-container');
    if (c && c.getAttribute('data-screen') === 'web') return true;
    return String(document.body.className || '').includes('webscreen-fix');
  }

  function applyLayout() {
    if (disabled) return;
    if (settings.hideInWebFullscreen && isWebFullscreen()) {
      hostEl.style.display = 'none';
      resetShift();
      return;
    }
    hostEl.style.display = '';
    ensureShift();
    try { shiftShadowTopBars(); } catch (e) {}
  }

  function applyTabWidthStyle() {
    const max = Math.max(60, Number(settings.tabWidthAutoMax) || 220);
    const fixed = Math.max(60, Number(settings.tabWidthFixed) || 140);
    shadow.querySelectorAll('.tab').forEach((el) => {
      if (settings.tabWidthMode === 'fixed') {
        el.style.width = fixed + 'px';
        el.style.maxWidth = fixed + 'px';
      } else {
        el.style.width = 'auto';
        el.style.maxWidth = max + 'px';
      }
    });
  }

  function applyBarHeight() {
    const h = BAR_HEIGHT;
    // 多盖 1px，避免高分屏取整导致标签栏与页面之间露出 1px 黑色缝隙
    hostEl.style.height = (h + 1) + 'px';
    hostEl.style.background = '#18191c';
    hostEl.style.setProperty('--bili-ws-bar-h', h + 'px');
    document.documentElement.style.setProperty('--bili-ws-bar-h', h + 'px');
    shiftStyle.textContent = `html { scroll-padding-top: ${BAR_HEIGHT}px !important; } html body { margin-top: ${BAR_HEIGHT}px !important; }`;
    if (!disabled) {
      try { ensureShift(); shiftShadowTopBars(); } catch (e) {}
    }
  }

  function render() {
    const brand = String(settings.brandText || '').trim();
    brandEl.textContent = brand;
    brandEl.style.display = brand ? '' : 'none';
    shadow.getElementById('logs').style.display = settings.debug ? '' : 'none';
    tabsEl.textContent = '';
    if (!state.tabs.length) {
      const e = document.createElement('span');
      e.className = 'empty';
      e.textContent = '新开 B站 视频标签页会自动收进这里';
      tabsEl.appendChild(e);
      return;
    }
    for (const t of state.tabs) {
      const el = document.createElement('span');
      el.className = 'tab' + (t.bvid === state.active ? ' active' : '');
      el.title = t.title || t.bvid;
      const name = document.createElement('span');
      name.className = 'title';
      name.textContent = t.title || t.bvid;
      const close = document.createElement('span');
      close.className = 'close';
      close.textContent = '×';
      close.title = '从工作台移除';
      el.appendChild(name);
      el.appendChild(close);
      el.addEventListener('click', (ev) => {
        if (ev.target === close) {
          ev.stopPropagation();
          removeTab(t.bvid);
          return;
        }
        switchTo(t.bvid);
      });
      tabsEl.appendChild(el);
    }
    applyTabWidthStyle();
  }

  // ---------- 状态 ----------
  const sendBg = (msg) => chrome.runtime.sendMessage(msg).catch(() => null);
  async function loadState() {
    const got = await chrome.storage.local.get(STATE_KEY);
    if (got[STATE_KEY] && Array.isArray(got[STATE_KEY].tabs)) state = { closed: [], ...got[STATE_KEY] };
    render();
  }
  async function loadSettings() {
    const got = await chrome.storage.sync.get(SETTINGS_KEY);
    settings = { ...DEFAULT_SETTINGS, ...(got[SETTINGS_KEY] || {}) };
    applyBarHeight();
    render();
    applyLayout();
  }

  // ---------- 切换 / 关闭 / 恢复 ----------
  function postSwitch(bvid) {
    if (mainReady) window.postMessage({ source: 'bili-ws-content', type: 'switch', bvid }, '*');
    else pendingSwitch = bvid;
  }

  async function switchTo(bvid) {
    if (!bvid) return;
    const onPage = (location.pathname.match(VIDEO_RE) || [])[1];
    state.active = bvid;
    render();
    sendBg({ type: 'SET_ACTIVE', bvid });
    if (bvid === onPage) return;
    expectedSwitch = { bvid, until: Date.now() + 15000 };
    postSwitch(bvid);
  }

  async function removeTab(bvid) {
    const resp = await sendBg({ type: 'CLOSE_TAB', bvid });
    if (resp && resp.state) { state = { closed: [], ...resp.state }; render(); }
    if (resp && resp.switchTo) switchTo(resp.switchTo);
    if (!state.tabs.length && settings.afterCloseAll === 'closeTab') {
      sendBg({ type: 'CLOSE_WORKSPACE' });
    }
    dlog('remove tab', bvid);
  }

  async function restoreClosed() {
    const resp = await sendBg({ type: 'RESTORE_TAB' });
    if (resp && resp.state) { state = { closed: [], ...resp.state }; render(); }
    if (resp && resp.bvid) switchTo(resp.bvid);
    dlog('restore tab', resp && resp.bvid);
    return !!(resp && resp.bvid);
  }

  // ---------- 快捷键 ----------
  function matchCombo(combo, e) {
    if (!combo || !e) return false;
    const parts = String(combo).toLowerCase().split('+').map((s) => s.trim()).filter(Boolean);
    if (!parts.length) return false;
    const key = parts[parts.length - 1];
    const needCtrl = parts.includes('ctrl');
    const needAlt = parts.includes('alt');
    const needShift = parts.includes('shift');
    const needMeta = parts.includes('meta') || parts.includes('cmd');
    if (!!e.ctrlKey !== needCtrl) return false;
    if (!!e.altKey !== needAlt) return false;
    if (!!e.shiftKey !== needShift) return false;
    if (!!e.metaKey !== needMeta) return false;
    const k = String(e.key || '').toLowerCase();
    return k === key;
  }

  function isTypingTarget(target) {
    if (!target) return false;
    const tag = target.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
  }

  window.addEventListener('keydown', (e) => {
    if (disabled) return;
    if (e.key === 'Escape') {
      const back = shadow.getElementById('modalBack');
      if (back && back.classList.contains('show')) { e.preventDefault(); e.stopPropagation(); closeSettings(); return; }
    }
    if (isTypingTarget(e.target)) return;
    if (matchCombo(settings.closeShortcut, e)) {
      e.preventDefault(); e.stopPropagation();
      if (state.active) removeTab(state.active);
      return;
    }
    if (matchCombo(settings.restoreShortcut, e)) {
      e.preventDefault(); e.stopPropagation();
      restoreClosed();
    }
  }, true);

  // ---------- 页面内点击视频链接：修饰键行为 ----------
  function modifierMatches(mod, e) {
    if (mod === 'ctrl') return !!(e.ctrlKey || e.metaKey);
    if (mod === 'alt') return !!e.altKey;
    if (mod === 'shift') return !!e.shiftKey;
    return false;
  }
  function bvidOfLink(a) {
    const m = String(a.href || '').match(/\/video\/(BV[0-9A-Za-z]+)/);
    return m ? m[1] : null;
  }

  window.addEventListener('mousedown', (e) => {
    if (disabled) return;
    const a = e.target && e.target.closest && e.target.closest('a[href*="/video/BV"]');
    if (!a) return;
    if (modifierMatches(settings.nativeTabModifier, e)) {
      chrome.runtime.sendMessage({ type: 'ARM_NATIVE_TAB', until: Date.now() + 4000 }).catch(() => {});
    }
  }, true);

  window.addEventListener('click', (e) => {
    if (disabled) return;
    const a = e.target && e.target.closest && e.target.closest('a[href*="/video/BV"]');
    if (!a) return;
    const bvid = bvidOfLink(a);
    if (!bvid) return;
    if (modifierMatches(settings.newTabModifier, e)) {
      e.preventDefault(); e.stopImmediatePropagation(); e.stopPropagation();
      chrome.runtime.sendMessage({ type: 'ADD_TAB', bvid, switchTo: false }).catch(() => {});
      dlog('new-tab modifier add tab', bvid);
      return;
    }
    if (modifierMatches(settings.nativeTabModifier, e)) {
      // 让浏览器原生打开（Ctrl+点击 = 新浏览器标签）。
      // 这里只截断事件传播、不 preventDefault：Bilibili 自己的站内跳转处理会被跳过，
      // 但浏览器的“新标签页打开”默认行为保留。
      e.stopImmediatePropagation();
      e.stopPropagation();
      return;
    }
  }, true);

  // ---------- 主世界消息 ----------
  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.source !== 'bili-ws-main') return;
    if (d.type === 'ready') {
      mainReady = true;
      if (pendingSwitch) {
        const b = pendingSwitch;
        pendingSwitch = null;
        postSwitch(b);
      }
    } else if (d.type === 'urlchange' && d.bvid) {
      onUrlChanged(d.bvid);
    } else if (d.type === 'switchResult') {
      lastSwitchResult = d;
      dlog('switch result', d);
    } else if (d.type === 'log') {
      dlog('[main]', d.m);
    }
  });

  let titleTimer = null;
  function refreshTitle(bvid) {
    // 只让后台通过 Bilibili 接口取标题，避免页面切换瞬间读到上一个视频的标题
    clearTimeout(titleTimer);
    titleTimer = setTimeout(() => {
      chrome.runtime.sendMessage({ type: 'REGISTER_VIDEO', bvid }).catch(() => {});
    }, 300);
  }

  let ctrlHeld = false;
  document.addEventListener('keydown', (e) => { if (e.ctrlKey || e.metaKey) ctrlHeld = true; }, true);
  document.addEventListener('keyup', (e) => { if (!e.ctrlKey && !e.metaKey) ctrlHeld = false; }, true);
  document.addEventListener('mousedown', (e) => { ctrlHeld = !!(e.ctrlKey || e.metaKey); }, true);

  async function onUrlChanged(bvid) {
    if (disabled) return;
    const isExpected = expectedSwitch && expectedSwitch.bvid === bvid && Date.now() < expectedSwitch.until;
    if (isExpected) {
      expectedSwitch = null;
      state.active = bvid;
      render();
      sendBg({ type: 'SET_ACTIVE', bvid });
      refreshTitle(bvid);
      return;
    }
    const resp = await sendBg({ type: 'USER_NAVIGATED', bvid, ctrlHeld });
    if (resp && resp.state) { state = { closed: [], ...resp.state }; render(); }
    else { state.active = bvid; render(); }
    refreshTitle(bvid);
    dlog('urlchange', bvid, 'ctrlHeld', ctrlHeld);
  }

  function stepDown() {
    if (disabled) return;
    disabled = true;
    hostEl.remove();
    shiftStyle.remove();
    resetShift();
    if (layoutTimer) clearInterval(layoutTimer);
    if (mo) mo.disconnect();
    dlog('step down (不再是宿主)');
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === 'SWITCH' && msg.bvid) switchTo(msg.bvid);
    else if (msg.type === 'STEP_DOWN') stepDown();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[STATE_KEY]) {
      const s = changes[STATE_KEY].newValue;
      if (s && Array.isArray(s.tabs)) { state = { closed: [], ...s }; render(); }
    }
    if (area === 'sync' && changes[SETTINGS_KEY]) {
      settings = { ...DEFAULT_SETTINGS, ...(changes[SETTINGS_KEY].newValue || {}) };
      applyBarHeight();
      render();
      applyLayout();
    }
  });

  // ---------- 诊断面板 ----------
  function collectDiag() {
    const app = document.getElementById('app');
    const header = document.querySelector('.bili-header');
    const appCs = app ? getComputedStyle(app) : null;
    const headerCs = header ? getComputedStyle(header) : null;
    return {
      version: extVersion(),
      url: location.href,
      webFullscreen: isWebFullscreen(),
      mainReady,
      bodyMarginTop: getComputedStyle(document.body).marginTop,
      bodyTop: Math.round(document.body.getBoundingClientRect().top),
      appTop: app ? Math.round(app.getBoundingClientRect().top) : null,
      appPosition: appCs ? appCs.position : null,
      headerPosition: headerCs ? headerCs.position : null,
      headerTop: headerCs ? headerCs.top : null,
      headerRect: header ? (() => { const r = header.getBoundingClientRect(); return { top: Math.round(r.top), h: Math.round(r.height) }; })() : null,
      headerBar: (() => { const b = document.querySelector('.bili-header__bar'); if (!b) return null; const r = b.getBoundingClientRect(); return { pos: getComputedStyle(b).position, top: Math.round(r.top), h: Math.round(r.height), inlineTop: b.style.top }; })(),
      htmlBg: (() => { const c = getComputedStyle(document.documentElement); return { color: c.backgroundColor, image: (c.backgroundImage || '').slice(0, 80) }; })(),
      bodyBg: (() => { const c = getComputedStyle(document.body); return { color: c.backgroundColor, image: (c.backgroundImage || '').slice(0, 80) }; })(),
      appBg: (() => { const a = document.getElementById('app'); if (!a) return null; const c = getComputedStyle(a); return { color: c.backgroundColor, image: (c.backgroundImage || '').slice(0, 80) }; })(),
      shadowRoots: (() => {
        const out = [];
        for (const el of document.querySelectorAll('*')) {
          if (!el.shadowRoot) continue;
          if (out.length >= 8) break;
          let header = null;
          try { header = el.shadowRoot.querySelector('header'); } catch (e) {}
          const r = header ? header.getBoundingClientRect() : null;
          out.push({
            host: (el.tagName + (el.id ? '#' + el.id : '') + (el.className ? '.' + String(el.className).split(' ')[0] : '')).slice(0, 50),
            hasHeader: !!header,
            headerTop: r ? Math.round(r.top) : null,
            headerH: r ? Math.round(r.height) : null,
            shifted: !!el.shadowRoot.__biliWsShifted,
            adopted: (el.shadowRoot.adoptedStyleSheets || []).length,
          });
        }
        return out;
      })(),
      atY: [5, 20, 38, 55, 75].map((y) => {
        let els = [];
        try { els = document.elementsFromPoint(Math.round(innerWidth / 2), y) || []; } catch (e) {}
        return { y, els: els.slice(0, 3).map((el) => { let cs; try { cs = getComputedStyle(el); } catch (e) { return null; } const r = el.getBoundingClientRect(); return { tag: el.tagName, cls: String(el.className).slice(0, 36), pos: cs.position, top: Math.round(r.top), h: Math.round(r.height), bg: cs.backgroundColor, img: (cs.backgroundImage || '').slice(0, 60) }; }).filter(Boolean) };
      }),
      fixedTop: (() => {
        const out = [];
        const w = innerWidth;
        for (const y of [BAR_HEIGHT + 4, 60]) {
          let els = [];
          try { els = document.elementsFromPoint(Math.round(w / 2), y); } catch (e) { break; }
          for (const el of els) {
            if (out.some((o) => o.el === el)) continue;
            let cs; try { cs = getComputedStyle(el); } catch (e) { continue; }
            if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
            const r = el.getBoundingClientRect();
            out.push({ el, cls: String(el.className).slice(0, 50), tag: el.tagName, pos: cs.position, top: Math.round(r.top), h: Math.round(r.height) });
          }
        }
        return out.slice(0, 6).map(({ el, ...rest }) => rest);
      })(),
      scrollY: Math.round(scrollY),
      innerHeight,
      devicePixelRatio,
      tabCount: state.tabs.length,
      active: state.active,
      lastSwitch: lastSwitchResult,
      settings,
    };
  }

  let panelEl = null;
  function showPanel(text) {
    if (!panelEl) {
      panelEl = document.createElement('div');
      panelEl.className = 'panel';
      shadow.appendChild(panelEl);
    }
    panelEl.textContent = '';
    const close = document.createElement('span');
    close.className = 'close';
    close.textContent = '× 关闭';
    close.addEventListener('click', () => { panelEl.remove(); panelEl = null; });
    const pre = document.createElement('div');
    pre.textContent = text;
    panelEl.appendChild(close);
    panelEl.appendChild(pre);
  }


  // ---------- 设置弹窗 ----------
  function isDarkPage() {
    try {
      const c = getComputedStyle(document.body).backgroundColor.match(/\d+/g);
      if (c && c.length >= 3) {
        const lum = 0.299 * +c[0] + 0.587 * +c[1] + 0.114 * +c[2];
        return lum < 128;
      }
    } catch (e) { /* ignore */ }
    return true;
  }
  function openSettings() {
    const m = shadow.getElementById('modal');
    m.classList.toggle('dark', isDarkPage());
    shadow.getElementById('mBrand').value = settings.brandText || '';
    shadow.getElementById('mMode').value = settings.tabWidthMode;
    shadow.getElementById('mAutoMax').value = settings.tabWidthAutoMax;
    shadow.getElementById('mFixedW').value = settings.tabWidthFixed;
    shadow.getElementById('mCloseShortcut').value = settings.closeShortcut;
    shadow.getElementById('mRestoreShortcut').value = settings.restoreShortcut;
    shadow.getElementById('mNativeMod').value = settings.nativeTabModifier;
    shadow.getElementById('mNewMod').value = settings.newTabModifier;
    shadow.getElementById('mAbsorb').value = settings.absorbSwitch;
    shadow.getElementById('mAfterCloseAll').value = settings.afterCloseAll;
    shadow.getElementById('mAutoRestore').checked = !!settings.autoRestoreTabs;
    shadow.getElementById('mHideFs').checked = !!settings.hideInWebFullscreen;
    shadow.getElementById('mDebug').checked = !!settings.debug;
    shadow.getElementById('mSaved').style.display = 'none';
    shadow.getElementById('modalBack').classList.add('show');
  }
  function closeSettings() {
    shadow.getElementById('modalBack').classList.remove('show');
  }
  async function saveSettings() {
    const next = {
      brandText: String(shadow.getElementById('mBrand').value || '').trim(),
      tabWidthMode: shadow.getElementById('mMode').value === 'fixed' ? 'fixed' : 'auto',
      tabWidthAutoMax: Math.min(600, Math.max(60, Number(shadow.getElementById('mAutoMax').value) || 220)),
      tabWidthFixed: Math.min(600, Math.max(60, Number(shadow.getElementById('mFixedW').value) || 140)),
      closeShortcut: String(shadow.getElementById('mCloseShortcut').value || '').trim() || 'Alt+W',
      restoreShortcut: String(shadow.getElementById('mRestoreShortcut').value || '').trim() || 'Alt+T',
      nativeTabModifier: shadow.getElementById('mNativeMod').value,
      newTabModifier: shadow.getElementById('mNewMod').value,
      hideInWebFullscreen: shadow.getElementById('mHideFs').checked,
      debug: shadow.getElementById('mDebug').checked,
      absorbSwitch: shadow.getElementById('mAbsorb').value,
      afterCloseAll: shadow.getElementById('mAfterCloseAll').value,
      autoRestoreTabs: shadow.getElementById('mAutoRestore').checked,
    };
    settings = { ...settings, ...next };
    await chrome.storage.sync.set({ [SETTINGS_KEY]: next });
    render();
    applyLayout();
    shadow.getElementById('mSaved').style.display = 'inline';
    setTimeout(() => { shadow.getElementById('mSaved').style.display = 'none'; }, 1500);
    dlog('settings saved', next);
  }
  shadow.getElementById('modalClose').addEventListener('click', closeSettings);
  shadow.getElementById('mCancel').addEventListener('click', closeSettings);
  shadow.getElementById('mSave').addEventListener('click', saveSettings);
  let modalDownOnBack = false;
  shadow.getElementById('modalBack').addEventListener('mousedown', (e) => { modalDownOnBack = e.target === shadow.getElementById('modalBack'); });
  shadow.getElementById('modalBack').addEventListener('mouseup', (e) => {
    if (modalDownOnBack && e.target === shadow.getElementById('modalBack')) closeSettings();
    modalDownOnBack = false;
  });
  shadow.getElementById('modalBack').addEventListener('click', (e) => e.stopPropagation());

  shadow.getElementById('opts').addEventListener('click', () => openSettings());
  shadow.getElementById('logs').addEventListener('click', () => {
    const info = collectDiag();
    dlog('diagnose', info);
    chrome.runtime.sendMessage({ type: 'SET_DIAG', info }).catch(() => {});
    chrome.runtime.sendMessage({ type: 'OPEN_DEBUG' }).catch(() => {});
  });

  // ---------- 布局监听 ----------
  let mo = null;
  let layoutTimer = null;
  let shadowScanTick = 0;
  const layoutTick = () => {
    try { applyLayout(); } catch (e) {}
    shadowScanTick += 1;
    if (shadowScanTick % 5 === 0) { try { shiftShadowTopBars(); } catch (e) {} }
  };
  mo = new MutationObserver(layoutTick);
  mo.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });
  const player = document.querySelector('.bpx-player-container');
  if (player) mo.observe(player, { attributes: true, attributeFilter: ['data-screen', 'class'] });
  layoutTimer = setInterval(layoutTick, 1000);

  // ---------- 启动 ----------
  (async () => {
    await Promise.all([loadState(), loadSettings()]);
    applyLayout();
    chrome.runtime.sendMessage({ type: 'INJECT_MAIN' }).catch(() => {});
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'CLAIM_HOST' });
      if (resp && resp.isHost === false) {
        stepDown();
        return;
      }
      if (resp && resp.state) { state = { closed: [], ...resp.state }; render(); }
    } catch (e) { /* 后台暂时不可用，仍然显示标签栏 */ }

    const m = location.pathname.match(VIDEO_RE);
    if (m) {
      chrome.runtime.sendMessage({ type: 'REGISTER_VIDEO', bvid: m[1] }).catch(() => {});
    }
    setTimeout(() => { try { shiftShadowTopBars(); } catch (e) {} }, 1500);
    setTimeout(() => { try { shiftShadowTopBars(); } catch (e) {} }, 5000);
    dlog('content ready', { version: extVersion(), url: location.href });
  })();
})();
