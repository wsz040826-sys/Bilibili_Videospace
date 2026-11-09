// 日志窗口：查看/导出 debug 模式记录的日志
const LOG_KEY = 'biliWsLogs';
const SETTINGS_KEY = 'biliWsSettings';
const STATE_KEY = 'biliWsState';

let logs = [];

function fmt(log) {
  const t = new Date(log.t);
  const hh = String(t.getHours()).padStart(2, '0');
  const mm = String(t.getMinutes()).padStart(2, '0');
  const ss = String(t.getSeconds()).padStart(2, '0');
  const ms = String(t.getMilliseconds()).padStart(3, '0');
  return `[${hh}:${mm}:${ss}.${ms}] [${log.s}] ${log.m}`;
}

function render() {
  document.getElementById('logs').textContent = logs.slice().reverse().map(fmt).join('\n');
  document.getElementById('count').textContent = `共 ${logs.length} 条`;
}

async function loadAll() {
  const got = await chrome.storage.local.get([LOG_KEY, SETTINGS_KEY, STATE_KEY, 'biliWsDiag']);
  logs = Array.isArray(got[LOG_KEY]) ? got[LOG_KEY] : [];
  const s = got[SETTINGS_KEY] || {};
  const st = got[STATE_KEY] || {};
  document.getElementById('meta').textContent =
    `debug=${!!s.debug} 虚拟标签=${(st.tabs || []).length} 宿主tab=${st.hostTabId || '-'}`;
  const diagEl = document.getElementById('diag');
  if (diagEl) diagEl.textContent = got.biliWsDiag ? JSON.stringify(got.biliWsDiag, null, 2) : '(还没有诊断信息，点击工作台标签栏的“日志”即可)';
  render();
}

document.getElementById('refresh').addEventListener('click', loadAll);
document.getElementById('clear').addEventListener('click', async () => {
  await chrome.storage.local.set({ [LOG_KEY]: [] });
  await loadAll();
});
document.getElementById('download').addEventListener('click', async () => {
  const header = [
    `Bilibili工作台日志导出`,
    `时间: ${new Date().toISOString()}`,
    `扩展版本: ${chrome.runtime.getManifest().version}`,
    `UA: ${navigator.userAgent}`,
    '',
  ].join('\n');
  const text = header + logs.map(fmt).join('\n');
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `bili-workspace-log-${Date.now()}.txt`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
});

loadAll();
setInterval(loadAll, 2000);
