/* 單一選定受管主機的互動終端生命週期。 */
(() => {
  'use strict';
  const ui = window.sshdeck;
  const sessions = document.querySelector('#shell-sessions');
  const status = document.querySelector('#terminal-status');
  const connect = document.querySelector('#connect-host');
  const originalStart = ui.services.startShell;
  let active = null;
  let generation = 0;

  function stop(message = '已中斷；遠端程序可能仍在執行。') {
    generation++;
    const current = active;
    active = null;
    current?.handle.close();
    status.textContent = message;
    connect.textContent = '連線';
    connect.disabled = !ui.selectedHost;
  }

  ui.services.startShell = (host) => {
    if (!host || ui.selectedHost?.alias !== host.alias) return Promise.reject(new Error('請先選取要連線的受管主機。'));
    if (active?.alias === host.alias) return active.handle.ready;
    stop('連線中…');
    const token = generation;
    const handle = originalStart(host, {
      onState(state, detail) {
        if (token !== generation || active?.alias !== host.alias) return;
        if (state === 'connected') {
          status.textContent = '已連線至 ' + host.alias;
          connect.textContent = '中斷';
        } else if (state === 'failed' || state === 'closed') {
          active = null;
          status.textContent = detail || (state === 'failed' ? '終端連線失敗。' : '終端連線已中斷。');
          connect.textContent = '連線';
          connect.disabled = !ui.selectedHost;
        }
      },
    });
    active = { alias: host.alias, host, handle };
    status.textContent = '正在連線至 ' + host.alias + '…';
    connect.textContent = '中斷';
    connect.disabled = false;
    return handle.ready;
  };

  connect.addEventListener('click', () => {
    if (active) { stop(); return; }
    if (ui.selectedHost) ui.services.startShell(ui.selectedHost).catch(ui.reportError);
  });

  ui.services.beforeSelectHost = async (next, previous) => {
    if (!active || active.alias !== previous?.alias) return true;
    if (!window.confirm('切換至「' + next.alias + '」將中斷「' + previous.alias + '」的終端連線。遠端程序可能仍在執行。要繼續嗎？')) return false;
    stop('已中斷；請連線至 ' + next.alias + '。');
    return true;
  };

  ui.on('selectionchange', (event) => {
    const { host, reason } = event.detail;
    if (active && (!host || host.alias !== active.alias)) {
      stop(reason === 'removed' ? '受管主機已刪除，終端連線已中斷。' : '終端連線已中斷。');
    }
    connect.disabled = !host;
  });

  ui.on('hostschange', (event) => {
    const { hosts } = event.detail;
    if (!active) return;
    const host = hosts.find((item) => item.alias === active.alias);
    const before = active.host;
    if (!host || JSON.stringify([host.hostname, host.port, host.username, host.keyPath]) !== JSON.stringify([before.hostname, before.port, before.username, before.keyPath])) {
      stop(host ? '受管主機設定已修改，終端連線已中斷。' : '受管主機已刪除，終端連線已中斷。');
    }
  });

  ui.on('pagechange', (event) => {
    const { page } = event.detail;
    if (page === 'hosts' && active) requestAnimationFrame(() => active?.handle.fit());
  });

  window.addEventListener('beforeunload', () => stop('已中斷。'));
})();
