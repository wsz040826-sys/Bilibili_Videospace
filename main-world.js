// 运行在页面主世界（MAIN world）。
//
// 作用：借用 Bilibili 视频页自己的“站内切换”逻辑。
// 视频页的推荐卡组件（VideoPageCard）有一个 pathTo() 方法，内部会触发 $emit('RELOAD_VIDEO', {...})，
// 视频页监听到这个事件后会用 SPA 的方式换视频（播放器/评论/推荐/标题全部更新，页面不刷新）。
// 我们把这个组件实例的 item 改成目标视频的数据，再调用 pathTo()，就能让页面切到任意视频。
(() => {
  if (window.__BILI_WS_MAIN__) return;
  window.__BILI_WS_MAIN__ = true;

  const VIDEO_RE = /\/video\/(BV[0-9A-Za-z]+)/;
  const log = (...args) => {
    console.log('[Bilibili工作台:main]', ...args);
    try {
      window.postMessage({
        source: 'bili-ws-main',
        type: 'log',
        m: args.map((x) => {
          try { return typeof x === 'string' ? x : JSON.stringify(x); } catch (e) { return String(x); }
        }).join(' '),
      }, '*');
    } catch (e) { /* ignore */ }
  };

  function searchVueTree(rootVm, maxDepth = 20) {
    const queue = [{ vm: rootVm, depth: 0 }];
    const seen = new Set();
    let visited = 0;
    while (queue.length && visited < 8000) {
      const { vm, depth } = queue.shift();
      if (!vm || typeof vm !== 'object' || seen.has(vm)) continue;
      seen.add(vm);
      visited++;
      if (typeof vm.pathTo === 'function' && vm.item && vm.item.bvid) return vm;
      if (depth >= maxDepth) continue;
      const children = vm.$children;
      if (Array.isArray(children)) {
        for (const child of children) queue.push({ vm: child, depth: depth + 1 });
      }
    }
    return null;
  }

  function findCardVM() {
    // 1) 已知类名（正常情况）
    for (const el of document.querySelectorAll('.video-page-card-small')) {
      const vm = el.__vue__;
      if (vm && typeof vm.pathTo === 'function') return vm;
    }
    // 2) 从页面的 Vue 根实例里遍历组件树（Bilibili 改版换了类名也能找到）
    const rootSelectors = ['#app', '#playerWrap', '#viewbox_report', '#biliMainHeader'];
    for (const sel of rootSelectors) {
      const el = document.querySelector(sel);
      const vm = el && el.__vue__;
      if (vm) {
        const found = searchVueTree(vm);
        if (found) return found;
      }
    }
    // 3) 兜底：扫描所有带 __vue__ 的元素
    for (const el of document.querySelectorAll('*')) {
      const vm = el.__vue__;
      if (vm && typeof vm.pathTo === 'function' && vm.item && vm.item.bvid) return vm;
    }
    return null;
  }

  async function fetchInfo(bvid) {
    // 注意：必须用 api.bilibili.com 的绝对地址；www.bilibili.com/x/... 会 404
    const r = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`, { credentials: 'include' });
    const j = await r.json();
    return j && j.code === 0 ? j.data : null;
  }

  function currentBvid() {
    const m = location.pathname.match(VIDEO_RE);
    return m ? m[1] : null;
  }

  async function switchTo(bvid) {
    let info = null;
    try {
      info = await fetchInfo(bvid);
      if (!info) log('view API 返回为空', bvid);
    } catch (e) {
      log('view API 请求失败', String(e));
    }
    const vm = findCardVM();
    log('switch:', bvid, 'card:', !!vm, 'info:', !!info);
    if (!vm || !info) {
      if (currentBvid() !== bvid) location.href = `https://www.bilibili.com/video/${bvid}/`;
      return { ok: false, mode: 'reload', hasCard: !!vm, hasInfo: !!info };
    }
    vm.item = Object.assign({}, vm.item, {
      bvid: info.bvid,
      aid: info.aid,
      cid: info.cid,
      redirect_url: '',
    });
    try {
      vm.pathTo();
      return { ok: true, mode: 'spa' };
    } catch (e) {
      log('pathTo 调用失败', String(e));
      location.href = `https://www.bilibili.com/video/${bvid}/`;
      return { ok: false, mode: 'reload', err: String(e) };
    }
  }

  // 通知 content script：页面 URL 变了（含 Bilibili 自己的站内跳转）
  let lastUrl = location.href;
  function notifyUrlChange() {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    window.postMessage({ source: 'bili-ws-main', type: 'urlchange', url: location.href, bvid: currentBvid() }, '*');
  }
  for (const fn of ['pushState', 'replaceState']) {
    const orig = history[fn];
    if (typeof orig === 'function') {
      history[fn] = function (...args) {
        const ret = orig.apply(this, args);
        setTimeout(notifyUrlChange, 0);
        return ret;
      };
    }
  }
  window.addEventListener('popstate', () => setTimeout(notifyUrlChange, 0));
  setInterval(notifyUrlChange, 1000);

  // 接收 content script 的指令
  window.addEventListener('message', async (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.source !== 'bili-ws-content') return;
    if (d.type === 'switch' && d.bvid) {
      const res = await switchTo(d.bvid);
      window.postMessage({ source: 'bili-ws-main', type: 'switchResult', bvid: d.bvid, ...res }, '*');
    } else if (d.type === 'diagnose') {
      const vm = findCardVM();
      window.postMessage({
        source: 'bili-ws-main',
        type: 'log',
        m: 'diagnose: cardFound=' + !!vm + ' cardComp=' + (vm && vm.$options && vm.$options.name) + ' cardBvid=' + (vm && vm.item && vm.item.bvid),
      }, '*');
    }
  });

  window.postMessage({ source: 'bili-ws-main', type: 'ready' }, '*');
})();
