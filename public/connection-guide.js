(() => {
  'use strict';
  const ui = window.sshdeck;
  const services = ui.services;
  const root = document.querySelector('#connection-guide-app');
  const steps = ['連線資料', '登入金鑰', '遠端授權', '檢查連線'];
  const storageKey = 'sshdeck.connection-guide.v1';
  const state = { step: 0, alias: '', hostname: '', port: '22', username: '', keyPath: '', mode: 'new', host: null, publicKey: '', guide: '', createdKeyPath: null, authorized: false, checked: false, checkedAt: null, checkedFingerprint: null, checking: false, failure: null, storageUnavailable: false };
  const fingerprint = (h) => JSON.stringify([h.alias, h.hostname, Number(h.port), h.username, h.keyPath || null]);
  const validRecord = (r) => !!r && typeof r.alias === 'string' && typeof r.hostname === 'string' && typeof r.username === 'string'
    && Number.isInteger(Number(r.port)) && Number(r.port) >= 1 && Number(r.port) <= 65535
    && ['new', 'existing'].includes(r.mode) && (r.keyPath === null || typeof r.keyPath === 'string')
    && Number.isInteger(r.step) && r.step >= 0 && r.step <= 3
    && typeof r.authorized === 'boolean' && typeof r.createdKey === 'boolean'
    && (r.checkedAt === undefined || r.checkedAt === null || typeof r.checkedAt === 'string')
    && (r.checkedFingerprint === undefined || r.checkedFingerprint === null || typeof r.checkedFingerprint === 'string');
  function readSaved() {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return { version: 1, hosts: {}, draft: null, lastAlias: null };
    const saved = JSON.parse(raw);
    if (!saved || saved.version !== 1 || !saved.hosts || typeof saved.hosts !== 'object' || Array.isArray(saved.hosts)) throw new Error('指南進度資料格式錯誤');
    if (Object.values(saved.hosts).some((record) => !validRecord(record)) || (saved.draft !== null && saved.draft !== undefined && !validRecord(saved.draft))) throw new Error('指南進度欄位格式錯誤');
    return saved;
  }
  function syncStorageWarning() {
    let warning = root.querySelector('.guide-storage-warning');
    if (!state.storageUnavailable) { warning?.remove(); return; }
    if (!warning) { warning = document.createElement('p'); warning.className = 'guide-storage-warning'; warning.setAttribute('role', 'status'); root.prepend(warning); }
    warning.textContent = '瀏覽器儲存目前無法讀取或寫入；本次指南仍可繼續，但重新整理後無法保證接續。';
  }
  function persist() {
    try {
      const old = readSaved();
      const record = { step: state.step, alias: state.alias, hostname: state.hostname, port: String(state.port), username: state.username, keyPath: state.host?.alias === state.alias ? state.host.keyPath || null : state.keyPath || null, mode: state.mode === 'existing' ? 'existing' : 'new', authorized: !!state.authorized, createdKey: !!(state.createdKeyPath && state.host?.keyPath === state.createdKeyPath) };
      if (state.host && state.host.alias === state.alias) { old.hosts[state.alias] = { ...record, checkedAt: state.checked && state.checkedFingerprint === fingerprint(state.host) ? state.checkedAt : null, checkedFingerprint: state.checked && state.checkedFingerprint === fingerprint(state.host) ? state.checkedFingerprint : null }; delete old.draft; }
      else old.draft = record;
      old.version = 1; old.lastAlias = state.alias || null; localStorage.setItem(storageKey, JSON.stringify(old)); state.storageUnavailable = false; syncStorageWarning();
    } catch { state.storageUnavailable = true; syncStorageWarning(); }
  }
  function applyRecord(record, host = null) {
    Object.assign(state, { step: record.step, alias: record.alias, hostname: record.hostname, port: String(record.port), username: record.username, keyPath: record.keyPath || '', mode: record.mode, authorized: !!record.authorized, host, checked: false, checkedAt: null, checkedFingerprint: null, createdKeyPath: null });
    if (!host) return;
    const profileChanged = host.hostname !== record.hostname || Number(host.port) !== Number(record.port) || host.username !== record.username;
    const keyChanged = (host.keyPath || null) !== (record.keyPath || null);
    if (profileChanged || keyChanged) {
      state.hostname = host.hostname; state.port = String(host.port); state.username = host.username;
      state.keyPath = host.keyPath || record.keyPath || ''; state.mode = record.createdKey && host.keyPath ? 'new' : host.keyPath ? 'existing' : record.mode;
      state.step = host.keyPath ? 2 : 1; state.authorized = false;
    }
    if (host.keyPath && record.createdKey && !keyChanged) state.createdKeyPath = host.keyPath;
    if (record.mode === 'existing' && !host.keyPath) { state.step = 1; state.authorized = false; }
    if (!profileChanged && !keyChanged && record.checkedAt && record.checkedFingerprint === fingerprint(host)) {
      state.checked = true; state.checkedAt = record.checkedAt; state.checkedFingerprint = record.checkedFingerprint;
    }
  }
  function restore() {
    try {
      if (!document.querySelector('#hosts-loading')?.hidden) return;
      const saved = readSaved();
      const hosts = Array.isArray(ui.hosts) ? ui.hosts : [];
      const existingAliases = new Set(hosts.map((h) => h.alias));
      for (const alias of Object.keys(saved.hosts)) if (!existingAliases.has(alias)) delete saved.hosts[alias];
      const preferDraft = validRecord(saved.draft) && (saved.draft.alias === saved.lastAlias || !saved.lastAlias);
      const preferred = !preferDraft && saved.lastAlias && saved.hosts[saved.lastAlias];
      const candidates = preferred ? [[saved.lastAlias, preferred], ...Object.entries(saved.hosts).filter(([alias]) => alias !== saved.lastAlias)] : Object.entries(saved.hosts);
      const pair = preferDraft ? null : candidates.map(([alias, r]) => ({ alias, r, h: hosts.find((h) => h.alias === alias) })).find((x) => x.h && validRecord(x.r));
      const draft = validRecord(saved.draft) ? saved.draft : null;
      const r = pair ? pair.r : draft; if (!r) { localStorage.setItem(storageKey, JSON.stringify(saved)); return; }
      applyRecord(r, pair?.h || null);
      localStorage.setItem(storageKey, JSON.stringify(saved));
    } catch { try { localStorage.removeItem(storageKey); } catch {} state.storageUnavailable = true; }
  }
  const el = (tag, text, attrs = {}) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    for (const [name, value] of Object.entries(attrs)) {
      if (name === 'className') node.className = value;
      else if (name === 'checked' || name === 'disabled' || name === 'hidden' || name === 'required') node[name] = value;
      else node.setAttribute(name, value);
    }
    return node;
  };
  const field = (label, name, type = 'text', value = '', help = '') => {
    const wrap = el('label');
    wrap.append(el('span', label));
    const input = el('input', undefined, { name, type, value, required: true });
    if (name === 'port') { input.min = '1'; input.max = '65535'; input.inputMode = 'numeric'; }
    if (name === 'keyPath') input.autocomplete = 'off';
    wrap.append(input);
    if (help) wrap.append(el('small', help));
    return wrap;
  };
  function readValues() {
    for (const key of ['alias', 'hostname', 'port', 'username', 'keyPath']) {
      const input = root.querySelector(`[name="${key}"]`);
      if (input) state[key] = ['alias', 'hostname', 'username'].includes(key) ? input.value.trim() : input.value;
    }
  }
  function button(text, action, disabled = false) {
    const b = el('button', text, { type: 'button', disabled });
    b.addEventListener('click', action);
    return b;
  }
  function go(step) { readValues(); state.step = step; persist(); render(); }
  function addNavigation(content) {
    const nav = el('div', undefined, { className: 'guide-navigation' });
    if (state.step > 0) nav.append(button('上一步', () => go(state.step - 1)));
    if (state.step < 3) nav.append(button('下一步', async () => {
      readValues();
      if (state.step === 0) {
        try { if (!await prepareHost()) return; }
        catch (error) { state.failure = { friendly: '無法新增或載入受管主機，請檢查資料後重試。', detail: error.message }; render(); return; }
      }
      if (state.step === 1 && !await prepareKey()) return;
      if (state.step === 2 && !state.guide) { state.failure = { friendly: '請先準備登入金鑰。', detail: '' }; render(); return; }
      if (state.step === 2 && !state.authorized) { state.failure = { friendly: '請先在目標 Linux 主機完成或確認手動授權，再進入連線檢查。', detail: '' }; render(); return; }
      go(state.step + 1);
    }));
    content.append(nav);
  }
  function errorBox(content, friendly, detail) {
    const box = el('div', undefined, { role: 'alert', className: 'guide-error' });
    box.append(el('p', friendly));
    const details = el('details'); details.append(el('summary', '技術詳細資訊'));
    details.append(el('pre', detail || '沒有額外的技術資訊。'));
    box.append(details); content.append(box);
  }
  async function prepareHost() {
    const form = root.querySelector('form');
    if (!form.reportValidity()) return false;
    const port = Number(state.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      root.querySelector('[name="port"]').setCustomValidity('請輸入 1 到 65535 的整數連接埠。');
      root.querySelector('[name="port"]').reportValidity(); return false;
    }
    const hosts = await services.send('/api/hosts');
    const duplicate = hosts.find((h) => h.alias === state.alias);
    if (duplicate) {
      if (duplicate.hostname !== state.hostname || Number(duplicate.port) !== port || duplicate.username !== state.username) {
        root.querySelector('[name="alias"]').setCustomValidity('此別名已用於其他連線資料，請選擇其他別名。');
        root.querySelector('[name="alias"]').reportValidity(); return false;
      }
      state.host = duplicate;
      persist();
      if (duplicate.keyPath && !state.keyPath && duplicate.keyPath !== state.createdKeyPath) {
        state.mode = 'existing';
        state.keyPath = duplicate.keyPath;
      }
      if (state.keyPath && duplicate.keyPath !== state.keyPath) {
        await services.send('/api/hosts/' + encodeURIComponent(state.alias), 'PUT', { ...duplicate, keyPath: state.keyPath });
      }
      await services.refresh();
      return true;
    }
    state.host = await services.send('/api/hosts', 'POST', { alias: state.alias, hostname: state.hostname, port, username: state.username, ...(state.mode === 'existing' && state.keyPath ? { keyPath: state.keyPath } : {}) });
    persist();
    await services.refresh();
    return true;
  }
  async function prepareKey() {
    state.preparingKey = true;
    try {
      if (!state.host) return false;
      if (state.mode === 'new') {
        if (state.host.keyPath && state.host.keyPath !== state.createdKeyPath) {
          state.failure = { friendly: '此受管主機已關聯登入金鑰。請展開「使用既有登入金鑰」沿用它，或先到進階管理解除關聯。', detail: '' }; render(); return false;
        }
        if (!state.host.keyPath) {
          const passphrase = await services.askNewKeyPassphrase();
          if (passphrase === null) return false;
          const result = await services.send('/api/hosts/' + encodeURIComponent(state.alias) + '/key', 'POST', { passphrase });
          state.publicKey = result.publicKey; state.guide = result.guide;
        } else {
          const result = await services.send('/api/hosts/' + encodeURIComponent(state.alias) + '/guide');
          state.publicKey = result.publicKey; state.guide = result.guide;
        }
      } else {
        if (state.mode === 'existing' && !state.keyPath) {
          state.failure = { friendly: '請輸入 sshdeck 所在電腦上的登入金鑰路徑。', detail: '' }; render(); return false;
        }
        if (state.mode === 'existing' && state.host.keyPath !== state.keyPath) {
          state.host = await services.send('/api/hosts/' + encodeURIComponent(state.alias), 'PUT', { ...state.host, keyPath: state.keyPath });
        }
        const result = await services.send('/api/hosts/' + encodeURIComponent(state.alias) + '/guide');
        state.publicKey = result.publicKey; state.guide = result.guide;
      }
      await services.refresh();
      state.host = ui.hosts.find((h) => h.alias === state.alias) || state.host;
      if (state.mode === 'new') state.createdKeyPath = state.host.keyPath;
      return true;
    } catch (error) { state.failure = { friendly: '無法準備登入金鑰，請確認路徑與金鑰狀態後重試。', detail: error.message }; render(); return false; }
    finally { state.preparingKey = false; }
  }
  function removeSavedHost(alias) {
    try {
      const saved = readSaved();
      delete saved.hosts[alias];
      if (saved.draft?.alias === alias) saved.draft = null;
      if (saved.lastAlias === alias) saved.lastAlias = null;
      localStorage.setItem(storageKey, JSON.stringify(saved));
    } catch { state.storageUnavailable = true; }
  }
  function pruneSavedHosts() {
    try {
      const saved = readSaved();
      const existing = new Set(ui.hosts.map((host) => host.alias));
      let changed = false;
      for (const alias of Object.keys(saved.hosts)) if (!existing.has(alias)) { delete saved.hosts[alias]; changed = true; }
      if (changed) localStorage.setItem(storageKey, JSON.stringify(saved));
    } catch { state.storageUnavailable = true; }
  }
  async function copy(text, buttonNode) {
    try { await navigator.clipboard.writeText(text); buttonNode.textContent = '已複製'; }
    catch { buttonNode.textContent = '複製失敗，請手動選取'; }
  }
  function resumeSaved(alias) {
    try {
      const saved = readSaved();
      const record = saved.hosts[alias];
      const host = ui.hosts.find((item) => item.alias === alias);
      if (!validRecord(record) || !host) return;
      applyRecord(record, host);
      saved.lastAlias = alias;
      localStorage.setItem(storageKey, JSON.stringify(saved));
      state.storageUnavailable = false;
    } catch { state.storageUnavailable = true; }
    render();
  }
  function startNewGuide() {
    Object.assign(state, { step: 0, alias: '', hostname: '', port: '22', username: '', keyPath: '', mode: 'new', host: null, publicKey: '', guide: '', createdKeyPath: null, authorized: false, checked: false, checkedAt: null, checkedFingerprint: null, failure: null });
    persist();
    render();
  }
  function classify(error) {
    const code = error.code || '';
    if (code === 'HOST_TRUST_REQUIRED') return '尚未確認此 SSH 主機的指紋。請核對顯示的指紋，只在確認是自己的受管主機後同意。';
    if (code === 'HOST_KEY_CHANGED') return '主機指紋與先前紀錄不同。請先向管理者確認主機是否重新安裝或更換，勿直接略過警告。';
    if (code === 'NEEDS_UNLOCK') return '登入金鑰尚未解鎖。請重新按「檢查連線」，並在安全提示中輸入密語。';
    if (/invalid.*passphrase|passphrase.*(incorrect|invalid)|密語錯誤/i.test(error.message)) return '登入金鑰密語不正確。請重新檢查金鑰密語後再嘗試連線。';
    if (/unlock|passphrase|密語/i.test(error.message)) return '此登入金鑰需要解鎖。請在接下來的安全提示中輸入密語。';
    if (/auth|permission denied|認證/i.test(error.message)) return '登入認證失敗。請確認帳號、公鑰授權及所選登入金鑰。';
    if (/timeout|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|unreachable/i.test(error.message)) return '無法連到主機。請確認位址、連接埠及網路防火牆設定。';
    return 'SSH 連線檢查未成功。請檢查連線資料與遠端授權，再重試。';
  }
  async function check() {
    state.failure = null; state.checking = true; render();
    try {
      const host = ui.hosts.find((h) => h.alias === state.alias) || state.host;
      const result = await services.checkHost(host);
      if (!result) { const error = new Error('NEEDS_UNLOCK'); error.code = 'NEEDS_UNLOCK'; throw error; }
      state.host = ui.hosts.find((h) => h.alias === state.alias) || host;
      state.checked = true; state.checkedAt = new Date().toISOString(); state.checkedFingerprint = fingerprint(state.host);
    } catch (error) {
      state.checked = false; state.checkedAt = null; state.checkedFingerprint = null;
      state.failure = { friendly: classify(error), detail: error.message };
    } finally { state.checking = false; await services.refresh(); persist(); render(); }
  }
  function render() {
    root.replaceChildren();
    const progress = el('ol', undefined, { className: 'step-progress', 'aria-label': '指南進度' });
    steps.forEach((label, i) => progress.append(el('li', `${i + 1}. ${label}`, { 'aria-current': i === state.step ? 'step' : 'false' })));
    root.append(progress);
    if (state.host || state.alias) root.append(button('開始新的建立指南', startNewGuide));
      if (state.storageUnavailable) syncStorageWarning();
    const panel = el('section', undefined, { className: 'guide-step', 'aria-labelledby': 'guide-step-title' });
    panel.append(el('h3', `步驟 ${state.step + 1}：${steps[state.step]}`, { id: 'guide-step-title' }));
    if (state.failure) errorBox(panel, state.failure.friendly, state.failure.detail);
    if (state.step === 0) {
      panel.append(el('p', '目的：告訴 sshdeck 要連線的受管主機。你需要已有的登入管道，例如主機商網頁控制台或既有 SSH 登入。若沒有，請向主機商取得控制台或請管理者協助。'));
      const form = el('form');
      form.append(field('主機別名', 'alias', 'text', state.alias, '在 sshdeck 中辨識這台主機的名稱。'), field('主機位址', 'hostname', 'text', state.hostname, '例如 server.example.com 或 IP 位址。'), field('SSH 連接埠', 'port', 'number', state.port || '22', 'SSH 常用連接埠為 22。'), field('登入帳號', 'username', 'text', state.username, '遠端 Linux 帳號；請確認此帳號可透過既有管道登入。'));
      form.addEventListener('input', (event) => { event.target.setCustomValidity(''); readValues(); if (state.host && (state.alias !== state.host.alias || state.hostname !== state.host.hostname || Number(state.port) !== Number(state.host.port) || state.username !== state.host.username)) state.host = null; state.checked = false; state.checkedAt = null; state.checkedFingerprint = null; state.authorized = false; state.failure = null; persist(); });
      panel.append(form, el('p', '完成後會新增或沿用相同設定的受管主機；不會因此自動開啟終端連線。'));
      try {
        const saved = readSaved();
        const entries = Object.entries(saved.hosts).filter(([alias, record]) => validRecord(record) && ui.hosts.some((host) => host.alias === alias));
        if (entries.length) {
          const details = el('details'); details.append(el('summary', '接續其他受管主機的建立指南進度'));
          for (const [alias, record] of entries) details.append(button(`接續 ${alias}（步驟 ${record.step + 1}）`, () => resumeSaved(alias)));
          panel.append(details);
        }
      } catch { state.storageUnavailable = true; }
    } else if (state.step === 1) {
      panel.append(el('p', '目的：選擇 sshdeck 用來證明登入身分的登入金鑰。預設建立新的 Ed25519 金鑰。'));
      const newLabel = el('label'); const newRadio = el('input', undefined, { type: 'radio', name: 'key-mode', value: 'new', checked: state.mode === 'new' }); newRadio.onchange = () => { state.mode = 'new'; state.checked = false; state.checkedAt = null; state.checkedFingerprint = null; state.authorized = false; state.failure = null; state.publicKey = ''; state.guide = ''; persist(); render(); }; newLabel.append(newRadio, document.createTextNode(' 建立新的登入金鑰（建議）')); panel.append(newLabel);
      const details = el('details'); details.open = state.mode === 'existing'; details.append(el('summary', '使用既有登入金鑰'));
       const existingLabel = el('label'); const radio = el('input', undefined, { type: 'radio', name: 'key-mode', value: 'existing', checked: state.mode === 'existing' }); radio.onchange = () => { state.mode = 'existing'; state.checked = false; state.checkedAt = null; state.checkedFingerprint = null; state.authorized = false; state.failure = null; state.publicKey = ''; state.guide = ''; persist(); render(); };
      existingLabel.append(radio, document.createTextNode(' 使用既有金鑰')); details.append(existingLabel);
      const keyPathField = field('私鑰路徑', 'keyPath', 'text', state.keyPath, '此路徑位於執行 sshdeck 的電腦，不是瀏覽器所在電腦，也不是遠端主機。');
       keyPathField.querySelector('input').addEventListener('input', () => { readValues(); state.checked = false; state.checkedAt = null; state.checkedFingerprint = null; state.authorized = false; state.failure = null; persist(); });
      details.append(keyPathField);
      panel.append(details, el('p', '公鑰可提供給遠端帳號授權；私鑰留在執行 sshdeck 的電腦。密語用來保護私鑰，請勿把私鑰或密語貼進遠端指令或分享給他人。建立新金鑰時會以安全提示要求輸入並再次確認密語。'));
      if (state.publicKey) { panel.append(el('p', '預期結果：已取得公鑰，下一步可在遠端帳號中授權。')); const pre = el('pre', state.publicKey); panel.append(pre, button('複製公鑰', (event) => copy(state.publicKey, event.currentTarget))); }
    } else if (state.step === 2) {
      panel.append(el('p', '目的：允許指定的遠端登入帳號接受此登入金鑰。操作位置：在目標受管主機的控制台或既有 SSH 視窗執行。'));
      panel.append(el('p', `目標：${state.username}@${state.hostname}（${state.alias}）；以下指令適用於常見 Linux shell。`));
      const installGuide = state.guide.split(/\n遠端撤銷/)[0];
      if (installGuide) { const pre = el('pre', installGuide); panel.append(pre, button('複製授權指令', (event) => copy(installGuide, event.currentTarget))); }
      panel.append(el('p', '此指令會保留 authorized_keys 中既有公鑰，不會以新內容覆蓋。建立帳號、設定檔案擁有者與權限需要 sudo 管理者權限；若你不是管理者，請將指令交由主機管理者在此 Linux 主機執行。完成手動操作只代表可以進入檢查，不代表授權已驗證成功。'));
      const doneLabel = el('label'); const done = el('input', undefined, { type: 'checkbox', checked: state.authorized }); doneLabel.append(done, document.createTextNode(' 我已在目標 Linux 主機嘗試完成授權')); done.onchange = () => { state.authorized = done.checked; persist(); }; panel.append(doneLabel);
    } else {
      panel.append(el('p', '目的：由 sshdeck 主動測試目前登入資料及金鑰能否建立 SSH 連線。檢查成功不代表終端機已連線；Docker 狀態不影響本指南完成。'));
      panel.append(el('p', `檢查目標：${state.alias}（${state.username}@${state.hostname}:${state.port}）`));
      if (state.checking) panel.append(el('p', '正在檢查 SSH 連線…', { role: 'status' }));
      if (state.failure) panel.append(button('回到連線資料', () => go(0)), button('回到登入金鑰', () => go(1)), button('回到遠端授權', () => go(2)));
      if (state.checked && !state.failure) {
        panel.append(el('p', `SSH 連線檢查成功（${state.checkedAt ? new Date(state.checkedAt).toLocaleString() : '歷史結果'}）。這是歷史檢查，不代表終端機目前已連線。`, { role: 'status' }));
        panel.append(button('前往主機操作', async () => { if (await ui.selectHost(state.alias)) ui.showPage('hosts'); }));
      } else panel.append(button(state.checking ? '檢查中…' : '檢查連線', check, state.checking));
    }
    addNavigation(panel); root.append(panel);
  }
  restore();
  ui.on('hostschange', () => {
    pruneSavedHosts();
    if (!state.host) restore();
    if (state.host) {
      const current = ui.hosts.find((h) => h.alias === state.alias);
      if (!current) {
        removeSavedHost(state.alias);
        Object.assign(state, { host: null, step: 0, alias: '', hostname: '', port: '22', username: '', keyPath: '', mode: 'new', publicKey: '', guide: '', createdKeyPath: null, authorized: false, checked: false, checkedAt: null, checkedFingerprint: null, failure: null });
      } else {
        const changed = fingerprint(current) !== fingerprint(state.host);
        if (changed) {
          const keyChanged = (current.keyPath || null) !== (state.host.keyPath || null);
          state.checked = false; state.checkedAt = null; state.checkedFingerprint = null; state.authorized = false;
          state.hostname = current.hostname; state.port = String(current.port); state.username = current.username;
          state.keyPath = current.keyPath || state.keyPath;
          if (!state.preparingKey) {
            state.createdKeyPath = null;
            if (keyChanged && current.keyPath) state.mode = 'existing';
            state.step = current.keyPath ? 2 : 1;
          }
        }
        state.host = current;
        persist();
      }
    }
    render();
  });
  services.readyGuide = true;
  render();
})();
