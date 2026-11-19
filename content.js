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
    drawerShortcut: 'Alt+Q',   // 打开/关闭垂直标签页抽屉
    drawerWidth: 260,          // 抽屉宽度（px），拖拽调宽后写回
    drawerCover: true,         // 抽屉里是否显示封面缩略图
    nativeTabModifier: 'ctrl', // 浏览器原生打开、工作台不拦截
    newTabModifier: 'shift',     // 在工作台新开虚拟标签（不切过去）
    hideInWebFullscreen: true, // B站“网页全屏”时隐藏工作台标签栏
    barTheme: 'page',          // 标签栏配色：'page' 跟随当前页面 / 'system' 跟随浏览器深浅色 / 'fixed' 固定颜色
    barColor: '#18191c',       // 'fixed' 模式下使用的颜色
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
        background: var(--ws-bar-bg, #18191c); color: var(--ws-fg, #e5e6e8);
        border-bottom: 1px solid var(--ws-bar-border, transparent);
        font: 12px/1.4 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
      }
      .brand { color: var(--ws-muted, #9499a0); font-size: 11px; padding-right: 6px; flex: 0 0 auto; max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .tabs-wrap { position: relative; display: flex; align-items: center; flex: 1 1 auto; min-width: 0; }
      .tabs { display: flex; align-items: center; gap: 4px; flex: 1 1 auto; min-width: 0;
        overflow-x: auto; overflow-y: hidden; scrollbar-width: none; }
      .tabs::-webkit-scrollbar { display: none; }
      /* 左右边缘的渐隐与“还有几个”：只提示可滚动，不占位、不挡点击 */
      .grad { position: absolute; top: 0; bottom: 0; width: 30px; pointer-events: none; opacity: 0; transition: opacity .12s; z-index: 1; }
      .grad.l { left: 0; background: linear-gradient(to right, var(--ws-bar-bg, #18191c) 20%, transparent); }
      .grad.r { right: 0; background: linear-gradient(to left, var(--ws-bar-bg, #18191c) 20%, transparent); }
      .grad.on { opacity: 1; }
      .cnt { position: absolute; top: 50%; transform: translateY(-50%); z-index: 2; display: none;
        font-size: 10px; line-height: 15px; padding: 0 5px; border-radius: 8px; cursor: pointer;
        color: var(--ws-fg, #e5e6e8); background: var(--ws-tab-bg, #23262b); border: 1px solid var(--ws-bar-border, #3a3f46); }
      .cnt.on { display: block; }
      .cnt.l { left: 0; }
      .cnt.r { right: 0; }
      .cnt:hover { background: var(--ws-tab-hover, #2c3036); }
      .tab {
        display: inline-flex; align-items: center; gap: 6px;
        height: 24px; padding: 0 8px; border-radius: 5px;
        background: var(--ws-tab-bg, #23262b); color: var(--ws-fg, #e5e6e8); cursor: pointer;
        flex: 0 1 auto; min-width: 44px; border: 1px solid transparent;
        overflow: hidden;
      }
      .tab:hover { background: var(--ws-tab-hover, #2c3036); }
      .tab.active { border-color: var(--ws-accent, #fb7299); background: var(--ws-tab-active-bg, #33232a); }
      .tab .title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1 1 auto; min-width: 0; }
      .tab .close { color: var(--ws-close, #7d838c); font-size: 14px; line-height: 1; padding: 0 1px; flex: 0 0 auto; }
      .tab .close:hover { color: var(--ws-accent, #fb7299); }
      .empty { color: var(--ws-empty, #6b7078); font-size: 11px; white-space: nowrap; }
      .tool {
        flex: 0 0 auto; color: var(--ws-muted, #9499a0); cursor: pointer;
        padding: 2px 6px; border-radius: 4px; font-size: 11px;
      }
      .tool:hover { background: var(--ws-tab-hover, #2c3036); color: var(--ws-fg, #e5e6e8); }

      /* 垂直标签页（覆盖式抽屉）：不推挤 B站 页面，宽度可拖拽并记忆 */
      .drawer-back { position: fixed; inset: 0; display: none; z-index: 2147483647; }
      .drawer-back.show { display: block; }
      .drawer {
        position: absolute; left: 0; top: 0; bottom: 0; width: 260px; box-sizing: border-box;
        display: flex; flex-direction: column;
        background: var(--ws-bar-bg, #18191c); color: var(--ws-fg, #e5e6e8);
        border-right: 1px solid var(--ws-bar-border, #2c3036); box-shadow: 8px 0 28px #0006;
        font: 12px/1.4 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
      }
      .drawer-head { display: flex; align-items: center; justify-content: space-between; gap: 8px;
        padding: 9px 10px 6px; color: var(--ws-muted, #9499a0); font-size: 11px; }
      .drawer-head b { color: var(--ws-fg, #e5e6e8); font-weight: 600; font-size: 12px; }
      .drawer-close { cursor: pointer; font-size: 16px; line-height: 1; padding: 0 4px; color: var(--ws-close, #7d838c); }
      .drawer-close:hover { color: var(--ws-accent, #fb7299); }
      .drawer-search { padding: 0 10px 8px; }
      .drawer-search input { width: 100%; box-sizing: border-box; padding: 5px 8px; border-radius: 6px;
        border: 1px solid var(--ws-bar-border, #3a3f46); background: var(--ws-tab-bg, #23262b); color: inherit; outline: none; }
      .drawer-search input:focus { border-color: var(--ws-accent, #fb7299); }
      .drawer-list { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 0 6px 8px; }
      .drawer-list::-webkit-scrollbar { width: 8px; }
      .drawer-list::-webkit-scrollbar-thumb { background: rgba(128,128,128,.35); border-radius: 4px; }
      .ditem { display: flex; align-items: center; gap: 8px; padding: 5px 6px; border-radius: 6px; cursor: pointer; }
      .ditem:hover, .ditem.cursor { background: var(--ws-tab-hover, #2c3036); }
      .ditem.active { background: var(--ws-tab-active-bg, #33232a); box-shadow: inset 2px 0 0 var(--ws-accent, #fb7299); }
      .dcover { width: 40px; height: 24px; border-radius: 4px; object-fit: cover; flex: 0 0 auto; background: var(--ws-tab-bg, #23262b); }
      .drawer-list.no-cover .dcover { display: none; }
      .dtitle { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .dclose { flex: 0 0 auto; color: var(--ws-close, #7d838c); font-size: 14px; line-height: 1; padding: 0 2px; }
      .dclose:hover { color: var(--ws-accent, #fb7299); }
      .dtip { color: var(--ws-muted, #9499a0); padding: 10px 6px; font-size: 11px; }
      .drawer-resize { position: absolute; right: -3px; top: 0; bottom: 0; width: 6px; cursor: col-resize; }
      .drawer-modes { display: flex; gap: 4px; padding: 0 10px 8px; }
      .dmode { flex: 1 1 0; text-align: center; padding: 3px 0; border-radius: 6px; font-size: 11px;
        color: var(--ws-muted, #9499a0); background: var(--ws-tab-bg, #23262b); border: 1px solid transparent; cursor: pointer; }
      .dmode:hover { color: var(--ws-fg, #e5e6e8); }
      .dmode.on { color: var(--ws-accent, #fb7299); border-color: var(--ws-accent, #fb7299); background: var(--ws-tab-active-bg, #33232a); }
      /* 分组头吸附在列表顶部，滚动时始终能知道当前在哪个分组 */
      .dgroup { display: flex; align-items: center; gap: 6px; padding: 5px 6px 3px; margin-top: 2px;
        position: sticky; top: 0; z-index: 1; background: var(--ws-bar-bg, #18191c);
        font-size: 11px; color: var(--ws-muted, #9499a0); cursor: pointer; }
      .dgroup:hover { color: var(--ws-fg, #e5e6e8); }
      .dgroup .dgtoggle { width: 10px; font-size: 9px; }
      .dgroup .dgcount { margin-left: auto; opacity: .75; }
      .dnote { color: var(--ws-muted, #9499a0); font-size: 11px; padding: 2px 8px 8px; }
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
      .modal input[type="color"] { width: 46px; height: 30px; padding: 0; border: 1px solid #c9cdd4; border-radius: 6px; background: none; flex: 0 0 auto; cursor: pointer; }
      .modal input[type="color"]:disabled { opacity: .45; cursor: default; }
      .modal .row-inline { display: flex; gap: 8px; align-items: center; }
      .modal.dark input[type="color"] { border-color: #3a3f46; }
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
      <span class="tool" id="drawerBtn" title="垂直标签页（Alt+Q）">≡</span>
      <span class="brand" id="brand">工作台</span>
      <span class="tabs-wrap">
        <span class="grad l" id="gradL"></span>
        <span class="cnt l" id="cntL"></span>
        <span class="tabs" id="tabs"></span>
        <span class="cnt r" id="cntR"></span>
        <span class="grad r" id="gradR"></span>
      </span>
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
          <div class="field"><label>标签栏颜色</label><div class="row-inline"><select id="mBarTheme"><option value="page">跟随当前页面设置</option><option value="system">跟随浏览器深浅色</option><option value="fixed">固定颜色</option></select><input type="color" id="mBarColor" title="固定颜色（仅“固定颜色”模式生效）"></div></div>
          <div class="field"><label>关闭当前虚拟标签（快捷键）</label><input type="text" id="mCloseShortcut" placeholder="Alt+W"></div>
          <div class="field"><label>恢复刚关闭的虚拟标签（快捷键）</label><input type="text" id="mRestoreShortcut" placeholder="Alt+T"></div>
          <div class="field"><label>垂直标签页（快捷键）</label><input type="text" id="mDrawerShortcut" placeholder="Alt+Q"></div>
          <div class="field"><label><input type="checkbox" id="mDrawerCover"> 垂直标签页显示封面缩略图</label><div class="hint">用 B 站 CDN 的 160×96 缩略图，几十个标签也只占几 MB。</div></div>
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
    </div>
    <div class="drawer-back" id="drawerBack">
      <aside class="drawer" id="drawer">
        <div class="drawer-head">
          <span>工作台 · <b id="drawerCount">0</b> 个标签</span>
          <span class="drawer-close" id="drawerClose" title="关闭（Esc）">×</span>
        </div>
        <div class="drawer-search"><input id="drawerSearch" type="text" placeholder="搜索标题 / UP 主 / BV 号" autocomplete="off"></div>
        <div class="drawer-modes" id="drawerModes">
          <span class="dmode on" data-mode="time">打开时间</span>
          <span class="dmode" data-mode="follow">关注分组</span>
          <span class="dmode" data-mode="up">UP 主</span>
        </div>
        <div class="drawer-list" id="drawerList"></div>
        <div class="drawer-resize" id="drawerResize" title="拖动调整宽度"></div>
      </aside>
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

  // ---------- 标签栏配色 ----------
  // 三档：跟随当前页面（B站 / BewlyBewly 的深浅色）/ 跟随浏览器深浅色 / 固定颜色（可自选，默认黑）。
  // 注意：Chromium 没有读取浏览器“外观颜色/主题色”的 API，网页和扩展都拿不到用户选的强调色，
  // 只能拿到 prefers-color-scheme（深/浅）。想要跟浏览器主题色一致，用“固定颜色”手选同色。
  const THEME_COLORS = {
    dark: {
      '--ws-bar-bg': '#18191c',
      '--ws-fg': '#e5e6e8',
      '--ws-muted': '#9499a0',
      '--ws-tab-bg': '#23262b',
      '--ws-tab-hover': '#2c3036',
      '--ws-tab-active-bg': '#33232a',
      '--ws-close': '#7d838c',
      '--ws-empty': '#6b7078',
      '--ws-bar-border': 'transparent',
    },
    light: {
      '--ws-bar-bg': '#ffffff',
      '--ws-fg': '#18191c',
      '--ws-muted': '#61666d',
      '--ws-tab-bg': '#f1f2f3',
      '--ws-tab-hover': '#e3e5e7',
      '--ws-tab-active-bg': '#fff0f4',
      '--ws-close': '#9499a0',
      '--ws-empty': '#9499a0',
      '--ws-bar-border': '#e3e5e7',
    },
  };

  function systemPrefersDark() {
    try { return window.matchMedia('(prefers-color-scheme: dark)').matches; } catch (e) { return true; }
  }

  function parseRgba(str) {
    const m = String(str || '').match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    if (p.length < 3 || p.some((n) => Number.isNaN(n))) return null;
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  }

  const colorLuminance = (c) => 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;

  function hexToRgb(hex) {
    const m = String(hex || '').match(/^#?([0-9a-f]{6})$/i);
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  const rgbToHex = (c) => '#' + [c.r, c.g, c.b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
  const mixColor = (a, b, t) => ({ r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t });
  const WHITE = { r: 255, g: 255, b: 255 };
  const BLACK = { r: 0, g: 0, b: 0 };

  // 固定颜色模式下，从用户选的颜色推导出一整套（正文、标签、悬停）颜色
  function paletteFromColor(hex) {
    const base = hexToRgb(hex) || { r: 24, g: 25, b: 28 };
    const barBg = rgbToHex(base);
    const dark = colorLuminance(base) < 128;
    const toward = dark ? WHITE : BLACK;
    return {
      dark: true, // 只用来标记“非浅色默认调色板”，实际颜色都在下面
      colors: {
        '--ws-bar-bg': barBg,
        '--ws-fg': dark ? '#f2f3f5' : '#18191c',
        '--ws-muted': rgbToHex(mixColor(base, toward, dark ? 0.55 : 0.45)),
        '--ws-tab-bg': rgbToHex(mixColor(base, toward, dark ? 0.10 : 0.06)),
        '--ws-tab-hover': rgbToHex(mixColor(base, toward, dark ? 0.18 : 0.12)),
        '--ws-tab-active-bg': rgbToHex(mixColor(base, toward, dark ? 0.24 : 0.16)),
        '--ws-close': rgbToHex(mixColor(base, toward, dark ? 0.45 : 0.40)),
        '--ws-empty': rgbToHex(mixColor(base, toward, dark ? 0.45 : 0.40)),
        '--ws-bar-border': dark ? 'transparent' : 'rgba(0,0,0,.12)',
      },
    };
  }

  // 当前页面是不是暗色：B站暗色模式会给 html 加 bili_dark（BewlyBewly 切换主题也用这个 class），
  // 取不到时用页面实际背景色的亮度兜底；全都透明时退化为系统设置。
  function pageLooksDark() {
    const de = document.documentElement;
    const cls = (' ' + ((de && de.className) || '') + ' ' + ((document.body && document.body.className) || '') + ' ').toLowerCase();
    if (/\s(bili_dark|dark|darkmode|dark-mode|night)\s/.test(cls)) return true;
    for (const el of [document.body, de, document.getElementById('app')]) {
      if (!el) continue;
      let cs;
      try { cs = getComputedStyle(el); } catch (e) { continue; }
      const c = parseRgba(cs.backgroundColor);
      if (!c || c.a < 0.5) continue;
      return colorLuminance(c) < 128;
    }
    return systemPrefersDark();
  }

  function resolveBarPalette() {
    const mode = settings.barTheme || 'page';
    if (mode === 'fixed') return paletteFromColor(settings.barColor || '#18191c');
    const dark = mode === 'system' ? systemPrefersDark() : pageLooksDark();
    return { dark, colors: dark ? THEME_COLORS.dark : THEME_COLORS.light };
  }

  function applyBarTheme() {
    const { dark, colors } = resolveBarPalette();
    for (const k of Object.keys(colors)) hostEl.style.setProperty(k, colors[k]);
    hostEl.dataset.theme = dark ? 'dark' : 'light';
    // 多盖 1px 的底色要和标签栏一致，否则高分屏取整时会露出 1px 异色缝
    hostEl.style.background = colors['--ws-bar-bg'];
    hostEl.dataset.palette = (settings.barTheme === 'fixed') ? 'custom' : (dark ? 'dark' : 'light');
  }

  // ---------- 图片查看器 / 全屏浮层 ----------
  // B站（评论区、动态等）打开大图时是一个铺满视口的 fixed 浮层，标签栏会压住图片顶部。
  // 浮层的实现随 B站 改版会变（PhotoSwipe 的 .pswp、bili-photoswipe 组件、或其它带 shadow DOM 的组件），
  // 所以既认已知实现，也做通用判断：视口中央命中一个铺满视口的 fixed 浮层，且浮层里有一张够大的图。
  // 视口尺寸用文档客户区的宽高：Windows 上经典滚动条会让 innerWidth 比 100% 宽 15px 左右，
  // 用 innerWidth 比较会把“宽度 100% 的全屏浮层”判成没铺满。
  function viewportSize() {
    const de = document.documentElement;
    return { w: (de && de.clientWidth) || innerWidth, h: (de && de.clientHeight) || innerHeight };
  }

  function fillsViewport(el) {
    if (!el || !el.isConnected) return false;
    let r;
    try { r = el.getBoundingClientRect(); } catch (e) { return false; }
    const v = viewportSize();
    return r.width >= v.w - 4 && r.height >= v.h - 4 && r.top <= 1 && r.left <= 1;
  }

  // 自定义元素自身可能没有布局盒（fixed 浮层在 shadow 里），所以要连它 shadow DOM 里的元素一起看；
  // 查看器组件自己的 DOM 很小，这里遍历它的 shadow 树不会带来性能问题。
  function elementFillsViewportDeep(el) {
    if (fillsViewport(el)) return true;
    const sr = el && el.shadowRoot;
    if (!sr) return false;
    for (const child of sr.querySelectorAll('*')) if (fillsViewport(child)) return true;
    return false;
  }

  function viewerCandidates() {
    const cands = [...document.querySelectorAll('.pswp, bili-photoswipe')];
    // 评论区的查看器也可能建在评论组件的 shadow DOM 里
    const comments = document.querySelector('bili-comments');
    if (comments && comments.shadowRoot) cands.push(...comments.shadowRoot.querySelectorAll('.pswp, bili-photoswipe'));
    return cands;
  }

  // 跨 shadow DOM（open）向上遍历祖先
  function someAncestor(el, fn) {
    let n = el;
    for (let i = 0; n && i < 60; i++) {
      if (fn(n) === true) return true;
      if (n.parentElement) { n = n.parentElement; continue; }
      let root = null;
      try { root = n.getRootNode ? n.getRootNode() : null; } catch (e) {}
      n = root && root.host ? root.host : null;
    }
    return false;
  }

  // 逐层（含 open shadow DOM）做命中测试，返回该点命中的所有元素
  function hitStackAt(x, y) {
    const stack = [];
    let root = document;
    for (let depth = 0; depth < 8 && root; depth++) {
      let els = [];
      try { els = root.elementsFromPoint ? root.elementsFromPoint(x, y) : []; } catch (e) { break; }
      if (!els.length) break;
      stack.push(...els);
      const top = els[0];
      root = top && top.shadowRoot ? top.shadowRoot : null;
    }
    return stack;
  }

  // 浮层里有没有一张“够大”的图（查看器会把图片缩放到接近视口）
  function containsBigPicture(el, depth = 0) {
    if (!el) return false;
    const v = viewportSize();
    const min = Math.min(v.w, v.h) * 0.18;
    let imgs = [];
    try { imgs = el.querySelectorAll('img'); } catch (e) {}
    for (const img of imgs) {
      const r = img.getBoundingClientRect();
      if (r.width >= min && r.height >= min) return true;
    }
    if (depth < 2 && el.shadowRoot) {
      for (const child of el.shadowRoot.children) if (containsBigPicture(child, depth + 1)) return true;
    }
    return false;
  }

  function isPhotoViewerOpen() {
    // 1) 已知实现：查看器首次打开时才挂到 body 上，关闭后 display 回到 none（宽高归零）
    for (const el of viewerCandidates()) if (elementFillsViewportDeep(el)) return true;
    // 2) 通用兜底：从视口中央往上找铺满视口的 fixed 浮层，且浮层里有一张大图
    const v = viewportSize();
    const pts = [
      [Math.round(v.w / 2), Math.round(v.h / 2)],
      [Math.round(v.w / 2), Math.round(v.h * 0.35)],
    ];
    for (const [x, y] of pts) {
      for (const hit of hitStackAt(x, y)) {
        if (hit === hostEl) continue;
        let overlay = null;
        someAncestor(hit, (a) => {
          if (a === hostEl || !fillsViewport(a)) return false;
          let cs;
          try { cs = getComputedStyle(a); } catch (e) { return false; }
          if (cs.position !== 'fixed') return false;
          overlay = a;
          return true;
        });
        if (overlay && containsBigPicture(overlay)) return true;
      }
    }
    return false;
  }

  // 标签栏要让位的情况：B站“网页全屏”（播放器铺满）时整体收起；图片查看器打开时只收起标签栏。
  function applyLayout() {
    if (disabled) return;
    applyBarTheme();
    if (settings.hideInWebFullscreen && isWebFullscreen()) {
      hostEl.style.display = 'none';
      closeDrawer();
      resetShift();
      return;
    }
    if (isPhotoViewerOpen()) {
      // 只收起标签栏、保留页面下移：查看器是固定定位的全屏浮层，
      // 这样关闭图片时页面不会先跳 30px 再回来。
      hostEl.style.display = 'none';
      closeDrawer();
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
    // 多盖 1px，避免高分屏取整导致标签栏与页面之间露出 1px 缝隙
    hostEl.style.height = (h + 1) + 'px';
    applyBarTheme();
    hostEl.style.setProperty('--bili-ws-bar-h', h + 'px');
    document.documentElement.style.setProperty('--bili-ws-bar-h', h + 'px');
    shiftStyle.textContent = `html { scroll-padding-top: ${BAR_HEIGHT}px !important; } html body { margin-top: ${BAR_HEIGHT}px !important; }`;
    if (!disabled) {
      try { ensureShift(); shiftShadowTopBars(); } catch (e) {}
    }
  }

  // 标签显示名：有 UP 主时接在标题后面（“标题 - UP主”），没有就退回 BV 号
  function tabLabel(t) {
    const title = t.title || t.bvid;
    return t.up ? `${title} - ${t.up}` : title;
  }

  function render() {
    const brand = String(settings.brandText || '').trim();
    brandEl.textContent = brand;
    brandEl.style.display = brand ? '' : 'none';
    shadow.getElementById('logs').style.display = settings.debug ? '' : 'none';
    shadow.getElementById('drawerBtn').textContent = state.tabs.length ? `≡ ${state.tabs.length}` : '≡';
    tabsEl.textContent = '';
    if (!state.tabs.length) {
      const e = document.createElement('span');
      e.className = 'empty';
      e.textContent = '新开 B站 视频标签页会自动收进这里';
      tabsEl.appendChild(e);
      updateOverflowHints();
      if (drawerOpen) renderDrawer();
      return;
    }
    for (const t of state.tabs) {
      const el = document.createElement('span');
      el.className = 'tab' + (t.bvid === state.active ? ' active' : '');
      el.title = tabLabel(t);
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
    ensureActiveVisible();
    updateOverflowHints();
    if (drawerOpen) renderDrawer();
  }

  // ---------- 标签栏横向滚动 ----------
  // 标签挤到窄于 62px 后不再压缩，改为横向滚动（Shift+滚轮是 Chromium 原生行为，
  // 这里只负责：把当前标签滚进视野、两端渐隐、提示两端各藏了几个）。
  function updateOverflowHints() {
    const sl = tabsEl.scrollLeft;
    const max = Math.max(0, tabsEl.scrollWidth - tabsEl.clientWidth);
    let left = 0;
    let right = 0;
    const kids = [...tabsEl.children];
    if (!(kids.length === 1 && kids[0].classList.contains('empty'))) {
      for (const el of kids) {
        const l = el.offsetLeft - tabsEl.offsetLeft;
        const r = l + el.offsetWidth;
        if (r <= sl + 1) left++;
        else if (l >= sl + tabsEl.clientWidth - 1) right++;
      }
    }
    shadow.getElementById('gradL').classList.toggle('on', sl > 1);
    shadow.getElementById('gradR').classList.toggle('on', max - sl > 1);
    const cL = shadow.getElementById('cntL');
    const cR = shadow.getElementById('cntR');
    cL.classList.toggle('on', left > 0);
    cR.classList.toggle('on', right > 0);
    cL.textContent = `« ${left}`;
    cR.textContent = `${right} »`;
    cL.title = `左边还有 ${left} 个标签（Shift+滚轮）`;
    cR.title = `右边还有 ${right} 个标签（Shift+滚轮）`;
  }

  function ensureActiveVisible() {
    const el = tabsEl.querySelector('.tab.active');
    if (!el) return;
    const l = el.offsetLeft - tabsEl.offsetLeft;
    const r = l + el.offsetWidth;
    const sl = tabsEl.scrollLeft;
    const w = tabsEl.clientWidth;
    if (l < sl) tabsEl.scrollLeft = Math.max(0, l - 8);
    else if (r > sl + w) tabsEl.scrollLeft = r - w + 8;
  }

  // ---------- 垂直标签页（覆盖式抽屉） ----------
  let drawerOpen = false;
  let drawerCursor = -1;
  let drawerDownOnBack = false; // 按下时指针是否在抽屉外：只有按下和抬起都在外面才关闭
  // 排序方式只存在这个页面会话里、不写进设置：刷新或新开页面时回到「打开时间」
  let drawerSort = 'time'; // 'time' 打开时间 | 'follow' 关注分组 | 'up' UP 主
  let followData = { state: 'idle', tags: [], map: {}, loggedIn: true, midsKey: '' };
  const foldedGroups = new Set();

  // B站 封面 CDN 支持 @<宽>w_<高>h_<裁切>c.<格式>，必须缩到 160×96 再用：
  // 一张 1146×716 的原图解压后约 3 MB，70 个标签能吃掉几百 MB，缩略图只要 0.06 MB。
  function coverThumb(url) {
    const raw = String(url || '').trim();
    if (!raw) return '';
    const base = raw.replace(/^http:/, 'https:').replace(/@[^/]*$/, '');
    return `${base}@160w_96h_1c.webp`;
  }

  // 抽屉最宽到视口的一半：标题长时可以拉宽，同时保证页面还看得见另一半
  function drawerMaxWidth() {
    return Math.max(320, Math.round(innerWidth * 0.5));
  }

  function clampDrawerWidth(w) {
    return Math.min(drawerMaxWidth(), Math.max(200, Math.round(Number(w) || 260)));
  }

  function applyDrawerWidth() {
    shadow.getElementById('drawer').style.width = `${clampDrawerWidth(settings.drawerWidth)}px`;
  }

  function saveDrawerWidth(w) {
    settings = { ...settings, drawerWidth: clampDrawerWidth(w) };
    chrome.storage.sync.set({ [SETTINGS_KEY]: settings }).catch(() => {});
    dlog('drawer width', settings.drawerWidth);
  }

  function scrollRowIntoView(list, row) {
    const lr = list.getBoundingClientRect();
    const rr = row.getBoundingClientRect();
    if (rr.top < lr.top) list.scrollTop -= lr.top - rr.top + 4;
    else if (rr.bottom > lr.bottom) list.scrollTop += rr.bottom - lr.bottom + 4;
  }

  function markCursor(list) {
    [...list.querySelectorAll('.ditem')].forEach((r, i) => {
      r.classList.toggle('cursor', i === drawerCursor);
    });
  }

  function makeDrawerRow(t) {
    const row = document.createElement('div');
    row.className = 'ditem' + (t.bvid === state.active ? ' active' : '');
    row.dataset.bvid = t.bvid;
    const img = document.createElement('img');
    img.className = 'dcover';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.alt = '';
    const src = coverThumb(t.cover);
    if (src) img.src = src;
    else img.style.visibility = 'hidden';
    img.addEventListener('error', () => { img.style.visibility = 'hidden'; });
    const title = document.createElement('div');
    title.className = 'dtitle';
    title.textContent = tabLabel(t);
    title.title = tabLabel(t);
    const close = document.createElement('span');
    close.className = 'dclose';
    close.textContent = '×';
    close.title = '从工作台移除';
    row.appendChild(img);
    row.appendChild(title);
    row.appendChild(close);
    row.addEventListener('click', (ev) => {
      if (ev.target === close) {
        ev.stopPropagation();
        removeTab(t.bvid);
        return;
      }
      switchTo(t.bvid);
      closeDrawer();
    });
    return row;
  }

  // 关注分组：-10 是 B站 的虚拟「特别关注」，排在所有自定义分组前面
  function tagIndex() {
    const idx = new Map([[-10, { name: '特别关注', order: -1 }]]);
    let i = 0;
    for (const t of followData.tags || []) {
      if (t.tagid === -10) continue;
      idx.set(t.tagid, { name: t.name || `分组 ${t.tagid}`, order: i++ });
    }
    return idx;
  }

  // 一个 UP 可能在多个分组里：只归到排序最靠前的那个，避免同一个标签在列表里出现两次
  function followGroups(items) {
    const idx = tagIndex();
    const groups = new Map();
    for (const t of items) {
      const ids = (followData.map && followData.map[t.upMid]) || [];
      let best = null;
      for (const id of ids) {
        const info = idx.get(id);
        if (info && (!best || info.order < best.order)) best = { id, name: info.name, order: info.order };
      }
      const key = best ? `tag:${best.id}` : 'tag:none';
      if (!groups.has(key)) {
        groups.set(key, { key, name: best ? best.name : '未分组', order: best ? best.order : 1e9, tabs: [] });
      }
      groups.get(key).tabs.push(t);
    }
    return [...groups.values()].sort((a, b) => a.order - b.order);
  }

  function upGroups(items) {
    const map = new Map();
    for (const t of items) {
      const name = t.up || '未知 UP 主';
      if (!map.has(name)) map.set(name, { key: `up:${name}`, name, order: 0, tabs: [] });
      map.get(name).tabs.push(t);
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
  }

  function appendGroup(list, g) {
    const folded = foldedGroups.has(g.key);
    const head = document.createElement('div');
    head.className = 'dgroup' + (folded ? ' folded' : '');
    const toggle = document.createElement('span');
    toggle.className = 'dgtoggle';
    toggle.textContent = folded ? '▸' : '▾';
    const name = document.createElement('span');
    name.className = 'dgname';
    name.textContent = g.name;
    const count = document.createElement('span');
    count.className = 'dgcount';
    count.textContent = String(g.tabs.length);
    head.appendChild(toggle);
    head.appendChild(name);
    head.appendChild(count);
    head.title = folded ? '展开' : '折叠';
    head.addEventListener('click', () => {
      if (folded) foldedGroups.delete(g.key);
      else foldedGroups.add(g.key);
      drawerCursor = -1;
      renderDrawer();
    });
    list.appendChild(head);
    if (folded) return;
    for (const t of g.tabs) list.appendChild(makeDrawerRow(t));
  }

  function renderDrawer() {
    const list = shadow.getElementById('drawerList');
    const q = String(shadow.getElementById('drawerSearch').value || '').trim().toLowerCase();
    shadow.getElementById('drawerCount').textContent = state.tabs.length;
    list.textContent = '';
    list.classList.toggle('no-cover', settings.drawerCover === false);
    const items = state.tabs.filter((t) => {
      if (!q) return true;
      return [t.title, t.up, t.bvid].join(' ').toLowerCase().includes(q);
    });
    if (!items.length) {
      const tip = document.createElement('div');
      tip.className = 'dtip';
      tip.textContent = state.tabs.length ? '没有匹配的标签' : '还没有视频标签';
      list.appendChild(tip);
      drawerCursor = -1;
      return;
    }
    if (drawerSort === 'time') {
      items.forEach((t) => list.appendChild(makeDrawerRow(t)));
    } else {
      if (drawerSort === 'follow' && followData.state !== 'ready') {
        const note = document.createElement('div');
        note.className = 'dnote';
        note.textContent = followData.state === 'loading' ? '正在读取关注分组…' : '尚未读取关注分组';
        list.appendChild(note);
      } else if (drawerSort === 'follow' && !followData.loggedIn) {
        const note = document.createElement('div');
        note.className = 'dnote';
        note.textContent = '未登录 B站，读不到关注分组，全部归入「未分组」';
        list.appendChild(note);
      }
      const groups = drawerSort === 'follow' ? followGroups(items) : upGroups(items);
      for (const g of groups) appendGroup(list, g);
    }
    markCursor(list);
    const activeRow = list.querySelector('.ditem.active');
    if (activeRow) scrollRowIntoView(list, activeRow);
  }

  async function ensureTabInfo() {
    // 旧标签可能只存了 BV 号：标题、封面、UP 主（upMid 用于关注分组）都在这里补齐
    const missing = state.tabs.filter((t) => !t.up || !t.cover || !t.upMid).map((t) => t.bvid);
    if (!missing.length) return;
    const resp = await sendBg({ type: 'ENSURE_INFO', bvids: missing });
    if (resp && resp.state && drawerOpen) {
      state = { closed: [], ...resp.state };
      render();
    }
  }

  async function loadFollowIndex() {
    const mids = [...new Set(state.tabs.map((t) => t.upMid).filter((m) => Number.isFinite(m) && m > 0))];
    const key = mids.slice().sort((a, b) => a - b).join(',');
    if (followData.state === 'loading') return;
    if (followData.state === 'ready' && followData.midsKey === key) return;
    followData = { ...followData, state: 'loading', midsKey: key };
    renderDrawer();
    const resp = await sendBg({ type: 'FOLLOW_INDEX', mids });
    followData = {
      state: 'ready',
      tags: resp && Array.isArray(resp.tags) ? resp.tags : [],
      map: (resp && resp.map) || {},
      loggedIn: !(resp && resp.loggedIn === false),
      midsKey: key,
    };
    if (drawerOpen) renderDrawer();
  }

  async function openDrawer() {
    if (drawerOpen) return;
    drawerOpen = true;
    drawerCursor = -1;
    shadow.getElementById('drawerBack').classList.add('show');
    applyDrawerWidth();
    renderDrawer();
    dlog('drawer open', state.tabs.length, drawerSort);
    await ensureTabInfo();
    if (drawerSort === 'follow') await loadFollowIndex();
    try { shadow.getElementById('drawerSearch').focus(); } catch (e) {}
  }

  function closeDrawer() {
    if (!drawerOpen) return;
    drawerOpen = false;
    drawerDownOnBack = false;
    shadow.getElementById('drawerBack').classList.remove('show');
    try { shadow.getElementById('drawerSearch').blur(); } catch (e) {}
  }

  function toggleDrawer() {
    if (drawerOpen) closeDrawer();
    else openDrawer();
  }

  // 抽屉内键盘操作：上下选、回车切换、Esc 关闭（搜索框聚焦时也生效）
  function drawerKeydown(e) {
    if (!drawerOpen) return false;
    const list = shadow.getElementById('drawerList');
    const rows = [...list.querySelectorAll('.ditem')];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!rows.length) return false;
      e.preventDefault();
      e.stopPropagation();
      drawerCursor = e.key === 'ArrowDown'
        ? Math.min(rows.length - 1, drawerCursor + 1)
        : Math.max(0, drawerCursor - 1);
      markCursor(list);
      scrollRowIntoView(list, rows[drawerCursor]);
      return true;
    }
    if (e.key === 'Enter' && drawerCursor >= 0) {
      const row = rows[drawerCursor];
      if (row) {
        e.preventDefault();
        e.stopPropagation();
        switchTo(row.dataset.bvid);
        closeDrawer();
        return true;
      }
    }
    return false;
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
    applyDrawerWidth();
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
      if (drawerOpen) { e.preventDefault(); e.stopPropagation(); closeDrawer(); return; }
    }
    if (drawerOpen && drawerKeydown(e)) return;
    if (matchCombo(settings.drawerShortcut, e)) {
      e.preventDefault(); e.stopPropagation();
      toggleDrawer();
      return;
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
      applyDrawerWidth();
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
  function openSettings() {
    const m = shadow.getElementById('modal');
    m.classList.toggle('dark', pageLooksDark());
    shadow.getElementById('mBrand').value = settings.brandText || '';
    shadow.getElementById('mMode').value = settings.tabWidthMode;
    shadow.getElementById('mAutoMax').value = settings.tabWidthAutoMax;
    shadow.getElementById('mFixedW').value = settings.tabWidthFixed;
    shadow.getElementById('mBarTheme').value = settings.barTheme || 'page';
    shadow.getElementById('mBarColor').value = settings.barColor || '#18191c';
    shadow.getElementById('mBarColor').disabled = (settings.barTheme || 'page') !== 'fixed';
    shadow.getElementById('mCloseShortcut').value = settings.closeShortcut;
    shadow.getElementById('mRestoreShortcut').value = settings.restoreShortcut;
    shadow.getElementById('mDrawerShortcut').value = settings.drawerShortcut;
    shadow.getElementById('mDrawerCover').checked = settings.drawerCover !== false;
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
      barTheme: ['page', 'system', 'fixed'].includes(shadow.getElementById('mBarTheme').value) ? shadow.getElementById('mBarTheme').value : 'page',
      barColor: /^#[0-9a-f]{6}$/i.test(shadow.getElementById('mBarColor').value) ? shadow.getElementById('mBarColor').value : '#18191c',
      closeShortcut: String(shadow.getElementById('mCloseShortcut').value || '').trim() || 'Alt+W',
      restoreShortcut: String(shadow.getElementById('mRestoreShortcut').value || '').trim() || 'Alt+T',
      drawerShortcut: String(shadow.getElementById('mDrawerShortcut').value || '').trim() || 'Alt+Q',
      drawerWidth: Math.round(Number(settings.drawerWidth) || 260),
      drawerCover: shadow.getElementById('mDrawerCover').checked,
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
  // 只有“固定颜色”模式才需要选颜色
  shadow.getElementById('mBarTheme').addEventListener('change', () => {
    shadow.getElementById('mBarColor').disabled = shadow.getElementById('mBarTheme').value !== 'fixed';
  });
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

  // ---------- 垂直标签页：事件 ----------
  shadow.getElementById('drawerBtn').addEventListener('click', () => toggleDrawer());
  shadow.getElementById('drawerClose').addEventListener('click', () => closeDrawer());
  // 只有按下和抬起都发生在抽屉外才关闭：拖右边缘调宽、在抽屉外松手时不该关掉抽屉
  shadow.getElementById('drawerBack').addEventListener('mousedown', (e) => {
    drawerDownOnBack = e.target === shadow.getElementById('drawerBack');
  });
  shadow.getElementById('drawerBack').addEventListener('mouseup', (e) => {
    const hitOutside = drawerDownOnBack && e.target === shadow.getElementById('drawerBack');
    drawerDownOnBack = false;
    if (hitOutside) closeDrawer();
  });
  shadow.getElementById('drawerSearch').addEventListener('input', () => {
    drawerCursor = -1;
    renderDrawer();
  });
  shadow.querySelectorAll('.dmode').forEach((el) => {
    el.addEventListener('click', () => {
      const mode = el.dataset.mode;
      if (mode === drawerSort) return;
      drawerSort = mode;
      drawerCursor = -1;
      shadow.querySelectorAll('.dmode').forEach((x) => x.classList.toggle('on', x.dataset.mode === mode));
      if (mode === 'follow') loadFollowIndex();
      renderDrawer();
    });
  });
  shadow.getElementById('cntL').addEventListener('click', () => openDrawer());
  shadow.getElementById('cntR').addEventListener('click', () => openDrawer());
  tabsEl.addEventListener('scroll', () => updateOverflowHints(), { passive: true });
  // Shift+滚轮：Chromium 一般会在浏览器进程里把纵向滚轮转成横向 deltaX（那时 deltaX 非 0，
  // 交给原生滚动）；少数环境转不过来，这里补一条兜底，两条路径不会重复滚动。
  tabsEl.addEventListener('wheel', (e) => {
    if (!e.shiftKey || e.deltaX || !e.deltaY) return;
    const max = tabsEl.scrollWidth - tabsEl.clientWidth;
    if (max <= 0) return;
    e.preventDefault();
    tabsEl.scrollLeft = Math.max(0, Math.min(max, tabsEl.scrollLeft + e.deltaY));
    updateOverflowHints();
  }, { passive: false });
  window.addEventListener('resize', () => {
    applyDrawerWidth(); // 窗口变窄时，过宽的抽屉要收回到「一半视口」的上限之内
    updateOverflowHints();
  });

  // 拖拽右边缘调宽；松手才写回设置，避免拖动过程里频繁写 storage
  (() => {
    const handle = shadow.getElementById('drawerResize');
    let dragging = false;
    let startX = 0;
    let startW = 0;
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dragging = true;
      startX = e.clientX;
      startW = shadow.getElementById('drawer').getBoundingClientRect().width;
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const w = clampDrawerWidth(startW + e.clientX - startX);
      shadow.getElementById('drawer').style.width = `${w}px`;
    });
    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      saveDrawerWidth(Math.round(shadow.getElementById('drawer').getBoundingClientRect().width));
    });
  })();

  // ---------- 布局监听 ----------
  let mo = null;
  let layoutTimer = null;
  let shadowScanTick = 0;
  const layoutTick = () => {
    try { applyLayout(); } catch (e) {}
    shadowScanTick += 1;
    if (shadowScanTick % 5 === 0) { try { shiftShadowTopBars(); } catch (e) {} }
  };

  // 图片查看器（PhotoSwipe）是打开时才动态挂到 body 上的：这里只监听 body 的直接子节点增删
  // （不递归，避免评论区大量 DOM 变化时频繁触发）；挂上之后单独观察它自身的 class/style。
  function watchPhotoViewer(node) {
    if (!node || node.nodeType !== 1) return;
    let pswp = null;
    if (node.matches && node.matches('.pswp')) pswp = node;
    else if (node.querySelector) pswp = node.querySelector('.pswp');
    if (!pswp || !mo) return;
    try { mo.observe(pswp, { attributes: true, attributeFilter: ['class', 'style', 'aria-hidden'] }); } catch (e) {}
  }

  mo = new MutationObserver((records) => {
    layoutTick();
    for (const rec of records) {
      if (rec.type !== 'childList') continue;
      for (const n of rec.addedNodes) watchPhotoViewer(n);
    }
  });
  mo.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'], childList: true });
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
