/* 共用工作區只管理導覽與選取；SSH、指南與持久化由功能模組接入。 */
(() => {
  'use strict';
  const events = new EventTarget();
  const services = {};
  let hostList = [];
  let selectedAlias = null;
  let currentPage = 'hosts';
  let selectionRequest = 0;
  const checksInFlight = new Map();
  const checkVersions = new Map();
  let pollTimer;
  const query = (selector) => document.querySelector(selector);
  const emit = (type, detail) => events.dispatchEvent(new CustomEvent(type, { detail }));
  const selectedHost = () => hostList.find((host) => host.alias === selectedAlias) || null;
  const reportError = (reason) => { query('#error').textContent = reason.message; };

  function showPage(page, { focus = false } = {}) {
    if (!['hosts', 'guide'].includes(page)) return;
    currentPage = page;
    for (const name of ['hosts', 'guide']) {
      const active = name === page;
      const tab = query('#' + name + '-tab');
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
      query('#' + name + '-panel').hidden = !active;
    }
    query('.sidebar').classList.remove('navigation-open');
    query('#navigation-toggle').setAttribute('aria-expanded', 'false');
    query('#navigation-toggle').textContent = '開啟導覽';
    const mobile = window.matchMedia('(max-width: 700px)').matches;
    if (mobile && (focus || query('#navigation').contains(document.activeElement))) query('#' + page + '-panel').focus();
    else if (focus) query('#' + page + '-tab').focus();
    emit('pagechange', { page });
  }

  function renderSelection() {
    const host = selectedHost();
    query('#host-workspace').hidden = !host;
    query('#select-host-hint').hidden = Boolean(host) || !hostList.length;
    query('#target-alias').textContent = host?.alias || '';
    query('#target-address').textContent = host ? host.hostname + ':' + host.port : '';
    query('#target-username').textContent = host?.username || '';
    query('#connect-host').disabled = !host;
    query('#check-selected-host').disabled = !host;
    for (const item of query('#hosts').children) {
      const active = item.dataset.alias === host?.alias;
      item.classList.toggle('selected', active);
      item.querySelector('button').setAttribute('aria-pressed', String(active));
    }
  }

  async function selectHost(alias) {
    if (!hostList.some((host) => host.alias === alias)) return false;
    if (alias === selectedAlias) return true;
    const request = ++selectionRequest;
    const previous = selectedHost();
    const next = hostList.find((host) => host.alias === alias);
    if (services.beforeSelectHost && !await services.beforeSelectHost(next, previous)) return false;
    if (request !== selectionRequest || !hostList.some((host) => host.alias === alias)) return false;
    selectedAlias = alias;
    renderSelection();
    emit('selectionchange', { host: selectedHost(), previous, reason: 'select' });
    return true;
  }

  function renderHosts() {
    const list = query('#hosts');
    const existing = new Map([...list.children].map((item) => [item.dataset.alias, item]));
    for (const host of hostList) {
      let item = existing.get(host.alias);
      if (!item) {
        item = document.createElement('li');
        item.dataset.alias = host.alias;
        const select = document.createElement('button');
        select.type = 'button';
        select.className = 'host-select';
        select.onclick = () => selectHost(host.alias).catch(reportError);
        const status = document.createElement('p');
        status.className = 'host-status';
        item.append(select, status);
        list.append(item);
      }
      item.querySelector('button').textContent = host.alias + ' — ' + host.username + '@' + host.hostname + ':' + host.port;
      const status = item.querySelector('.host-status');
      status.dataset.state = host.check?.pending ? 'pending' : (host.check?.state || 'unchecked');
      if (services.renderHostStatus) services.renderHostStatus(host, status);
      else {
        const state = host.check?.state === 'success' ? '最近 SSH 檢查成功'
          : host.check?.state === 'failure' ? '最近 SSH 檢查失敗'
            : host.check?.state === 'changed' ? '主機指紋已變更'
              : host.check?.state === 'untrusted' ? '等待主機指紋確認' : '尚未完成 SSH 連線檢查';
        status.textContent = state + (host.check?.checkedAt ? '；檢查時間：' + host.check.checkedAt : '') + '。不代表終端機已連線。';
      }
      existing.delete(host.alias);
    }
    for (const item of existing.values()) item.remove();
    query('#hosts-loading').hidden = true;
    query('#empty-hosts').hidden = hostList.length > 0;
    renderSelection();
  }

  function setHosts(list) {
    const previous = selectedHost();
    hostList = list;
    if (selectedAlias && !selectedHost()) {
      selectedAlias = null;
      selectionRequest++;
      renderSelection();
      emit('selectionchange', { host: null, previous, reason: 'removed' });
    }
    renderHosts();
    emit('hostschange', { hosts: hostList, selectedHost: selectedHost() });
    if (!document.hidden) runChecks();
  }

  window.sshdeck = {
    services,
    get hosts() { return hostList; },
    get selectedHost() { return selectedHost(); },
    get page() { return currentPage; },
    configure(adapters) { Object.assign(services, adapters); emit('ready', { services }); if (!pollTimer) { pollTimer = setInterval(() => { if (!document.hidden) runChecks(); }, 30000); document.addEventListener('visibilitychange', () => { if (!document.hidden) runChecks(); }); runChecks(); } },
    on(type, listener) { events.addEventListener(type, listener); return () => events.removeEventListener(type, listener); },
    emit, showPage, selectHost, setHosts, renderHosts, reportError,
  };

  for (const name of ['hosts', 'guide']) query('#' + name + '-tab').onclick = () => showPage(name);
  query('[role="tablist"]').onkeydown = (event) => {
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const page = event.key === 'Home' ? 'hosts' : event.key === 'End' ? 'guide' : currentPage === 'hosts' ? 'guide' : 'hosts';
    showPage(page, { focus: true });
  };
  for (const button of document.querySelectorAll('[data-page]')) button.onclick = () => {
    showPage(button.dataset.page, { focus: true });
  };
  query('#navigation-toggle').onclick = () => {
    const open = query('.sidebar').classList.toggle('navigation-open');
    query('#navigation-toggle').setAttribute('aria-expanded', String(open));
    query('#navigation-toggle').textContent = open ? '收合導覽' : '開啟導覽';
  };
  query('#open-legacy-management').onclick = () => {
    query('#legacy-management').open = true;
    query('#legacy-management summary').focus();
  };
  query('#connect-host').onclick = async () => {
    const host = selectedHost();
    if (!host) return;
    try { await services.startShell(host); }
    catch (reason) { reportError(reason); }
  };
  async function runCheck(host, automatic = true) {
    if (checksInFlight.has(host.alias)) return checksInFlight.get(host.alias);
    const snapshot = JSON.stringify([host.hostname, host.port, host.username, host.keyPath]);
    const version = checkVersions.get(host.alias) || 0;
    const task = (async () => {
      host.check = { ...(host.check || {}), pending: true }; renderHosts();
      try {
        const result = automatic && services.checkSSH ? await services.checkSSH(host, { automatic: true }) : await services.checkHost(host);
        if (!hostList.includes(host) || snapshot !== JSON.stringify([host.hostname, host.port, host.username, host.keyPath]) || version !== (checkVersions.get(host.alias) || 0)) return;
        host.check = ['needs-unlock','untrusted','changed'].includes(result?.state) ? { ...result, checkedAt: host.check?.checkedAt } : { ...(result || {}), state: 'success', checkedAt: new Date().toLocaleString(), pending: false };
      } catch (error) { if (!hostList.includes(host) || version !== (checkVersions.get(host.alias) || 0)) return; host.check = { state: 'failure', error: error.message, checkedAt: new Date().toLocaleString() }; }
      finally { if (hostList.includes(host)) { host.check = { ...host.check, pending: false }; renderHosts(); } }
    })().finally(() => checksInFlight.delete(host.alias));
    checksInFlight.set(host.alias, task); return task;
  }
  function runChecks() { if (document.hidden) return; for (const host of hostList) if (host.hostname && host.port && host.username && host.keyPath) runCheck(host, true); }
  query('#check-selected-host').onclick = async () => {
    const host = selectedHost();
    if (!host) return;
    try { await runCheck(host, false); }
    catch (reason) { reportError(reason); }
  };
})();
