#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');
const { WebSocketServer, WebSocket } = require('ws');
const ssh = require('../lib/ssh');

function dataFileFor({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  if (env.SSHDECK_HOME) return pathApi.join(env.SSHDECK_HOME, 'hosts.json');

  let base;
  if (platform === 'win32') base = env.APPDATA || pathApi.join(home, 'AppData', 'Roaming');
  else if (platform === 'darwin') base = pathApi.join(home, 'Library', 'Application Support');
  else base = env.XDG_DATA_HOME && pathApi.isAbsolute(env.XDG_DATA_HOME)
    ? env.XDG_DATA_HOME
    : pathApi.join(home, '.local', 'share');

  return pathApi.join(base, 'sshdeck', 'hosts.json');
}

function readHosts(dataFile) {
  try {
    const hosts = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    if (!Array.isArray(hosts)) throw new Error('Host data must be a list');
    return hosts;
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw new Error(`無法讀取主機設定：${error.message}`);
  }
}

function processIsRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function acquireLock(lockFile, timeoutMs = 5000) {
  const token = `${process.pid}:${randomUUID()}`;
  const deadline = Date.now() + timeoutMs;
  const waitBuffer = new Int32Array(new SharedArrayBuffer(4));

  while (Date.now() < deadline) {
    try {
      const descriptor = fs.openSync(lockFile, 'wx', 0o600);
      fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, token }));
      return () => {
        fs.closeSync(descriptor);
        try {
          const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
          if (lock.token === token) fs.unlinkSync(lockFile);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      };
    } catch (error) {
      if (error.code !== 'EEXIST' && !(error.code === 'EPERM' && fs.existsSync(lockFile))) throw error;
    }

    try {
      const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
      const ageMs = Date.now() - fs.statSync(lockFile).mtimeMs;
      if (ageMs > 30_000 && !processIsRunning(lock.pid)) fs.unlinkSync(lockFile);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      if (error instanceof SyntaxError) {
        try {
          if (Date.now() - fs.statSync(lockFile).mtimeMs > 30_000) fs.unlinkSync(lockFile);
        } catch (statError) {
          if (statError.code !== 'ENOENT') throw statError;
        }
      } else if (error.code !== 'ENOENT') {
        throw error;
      }
    }
    Atomics.wait(waitBuffer, 0, 0, 10);
  }

  throw new Error('等待主機設定鎖定逾時；請確認沒有其他 sshdeck 程序正在修改設定。');
}

function writeHosts(dataFile, hosts) {
  fs.mkdirSync(path.dirname(dataFile), { recursive: true, mode: 0o700 });
  const temporaryFile = `${dataFile}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporaryFile, `${JSON.stringify(hosts, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporaryFile, dataFile);
  } finally {
    try { fs.unlinkSync(temporaryFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function mutateHosts(dataFile, change) {
  fs.mkdirSync(path.dirname(dataFile), { recursive: true, mode: 0o700 });
  const release = acquireLock(`${dataFile}.lock`);
  try {
    const hosts = readHosts(dataFile);
    const result = change(hosts);
    writeHosts(dataFile, hosts);
    return result;
  } finally {
    release();
  }
}

function validateHost(input) {
  const host = { ...input };
  for (const field of ['alias', 'hostname', 'username']) {
    if (typeof host[field] !== 'string' || !host[field].trim()) throw new Error(`${field} 必須是非空文字`);
    host[field] = host[field].trim();
  }
  host.port = Number(host.port ?? 22);
  if (!Number.isInteger(host.port) || host.port < 1 || host.port > 65535) {
    throw new Error('port 必須是 1 到 65535 的整數');
  }
  if (host.keyPath !== undefined && typeof host.keyPath !== 'string') throw new Error('keyPath 必須是文字');
  return {
    alias: host.alias,
    hostname: host.hostname,
    port: host.port,
    username: host.username,
    ...(host.keyPath === undefined ? {} : { keyPath: host.keyPath }),
  };
}

function parseOptions(args) {
  const values = {};
  const names = { user: 'username', username: 'username', key: 'keyPath', 'key-path': 'keyPath', hostname: 'hostname', port: 'port' };
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index].match(/^--(hostname|port|user|username|key|key-path)$/);
    if (!option || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`無效的選項：${args[index]}`);
    values[names[option[1]]] = args[index + 1];
    index += 1;
  }
  return values;
}

function dockerStatusLabel(docker) {
  if (!docker) return '未檢查';
  if (docker.state === 'available') return `可用 ${docker.version}`;
  if (docker.state === 'permission-denied') return '權限不足';
  if (docker.state === 'missing-cli') return 'CLI 未安裝';
  if (docker.state === 'daemon-unavailable') return 'daemon 不可用';
  if (docker.state === 'not-run') return '未執行';
  return '無法使用';
}

function hostList(hosts, statuses = {}) {
  if (!hosts.length) return '尚未設定主機。';
  return hosts.map((host) => {
    const state = statuses[host.alias]?.state;
    const check = state === 'success' ? 'SSH 成功'
      : state === 'untrusted' ? '等待主機指紋確認'
        : state === 'changed' ? '主機指紋已變更'
          : state === 'failure' ? 'SSH 失敗' : '未檢查';
    const docker = statuses[host.alias]?.docker;
    const dockerCheck = `Docker ${dockerStatusLabel(docker)}`;
    const checkedAt = statuses[host.alias]?.checkedAt;
    return `${host.alias}\t${host.hostname}:${host.port}\t${host.username}\t${host.keyPath || '未設定金鑰'}\t${check}${checkedAt ? `（${checkedAt}）` : ''}\t${dockerCheck}`;
  }).join('\n');
}

async function readSecret(prompt, input = process.stdin, output = process.stderr) {
  output.write(prompt);
  const wasRaw = input.isRaw;
  const canHide = Boolean(input.isTTY && typeof input.setRawMode === 'function');
  if (canHide) input.setRawMode(true);
  const readline = require('node:readline/promises');
  const terminal = readline.createInterface({ input, output, terminal: false });
  try {
    return await terminal.question('');
  } finally {
    terminal.close();
    if (canHide) input.setRawMode(Boolean(wasRaw));
    output.write('\n');
  }
}

async function hostCommand(dataFile, args) {
  const action = args[1];
  if (action === 'check') {
    const host = readHosts(dataFile).find((item) => item.alias === args[2]);
    if (!host) throw new Error(`找不到主機：${args[2] || ''}`);
    const passphrase = await readSecret('登入金鑰密語（輸入隱藏；未加密請按 Enter）：');
    let result;
    try {
      result = await ssh.checkWithDocker(dataFile, host, passphrase);
    } catch (error) {
      if (!['HOST_TRUST_REQUIRED', 'HOST_KEY_CHANGED'].includes(error.code)) {
        if (ssh.getStatuses(dataFile)[host.alias]?.docker?.state === 'not-run') {
          console.error('Docker 檢查：未執行（SSH 檢查未成功）');
        }
        throw error;
      }
      const readline = require('node:readline/promises');
      const prompt = readline.createInterface({ input: process.stdin, output: process.stderr });
      let answer;
      try {
        const previous = error.previousFingerprint ? `（原信任指紋 ${error.previousFingerprint}）` : '';
        answer = await prompt.question(`主機指紋 ${error.fingerprint}${previous}。確認信任此主機？[y/N] `);
      } finally { prompt.close(); }
      if (!/^y(es)?$/i.test(answer.trim())) throw new Error('已拒絕主機指紋；未執行登入');
      result = await ssh.checkWithDocker(dataFile, host, passphrase, { expectedFingerprint: error.fingerprint });
    }
    console.log(`SSH 登入檢查成功：${host.alias}（${result.fingerprint}）`);
    if (result.docker.state === 'available') {
      console.log(`Docker daemon 可用：${result.docker.version}`);
    } else {
      console.error(`Docker 檢查：${dockerStatusLabel(result.docker)}${result.docker.diagnostic ? `\n診斷：${result.docker.diagnostic}` : ''}`);
      process.exitCode = 1;
    }
    return;
  }
  if (action === 'list') {
    console.log(hostList(readHosts(dataFile), ssh.getStatuses(dataFile)));
    return;
  }
  if (!['add', 'update', 'delete', 'remove'].includes(action)) {
    throw new Error('用法：sshdeck host <add|list|update|delete|check> ...');
  }

  const alias = args[2];
  if (!alias) throw new Error('請提供主機別名');
  const options = parseOptions(args.slice(3));
  let updated;
  mutateHosts(dataFile, (hosts) => {
    const index = hosts.findIndex((host) => host.alias === alias);
    if (action === 'add') {
      if (index >= 0) throw new Error(`主機別名已存在：${alias}`);
      hosts.push(validateHost({ alias, ...options }));
    } else {
      if (index < 0) throw new Error(`找不到主機：${alias}`);
      if (action === 'delete' || action === 'remove') hosts.splice(index, 1);
      else { hosts[index] = validateHost({ ...hosts[index], ...options }); updated = hosts[index]; }
    }
  });
  if (updated) ssh.updateManagedKeyProfile(dataFile, updated);
  const description = action === 'add' ? '新增' : action === 'update' ? '更新' : '刪除';
  console.log(`已${description}主機設定：${alias}`);
}

async function keyCommand(dataFile, args) {
  const action = args[1]; const alias = args[2];
  if (action === 'list') {
    const hosts = readHosts(dataFile);
    const records = ssh.listManagedKeys(dataFile);
    if (!records.length) { console.log('尚無 sshdeck 管理的金鑰。'); return; }
    console.log(records.map((record) => {
      const aliases = hosts.filter((host) => host.keyPath === record.keyPath).map((host) => host.alias);
      return `${record.id}\t${record.alias}\t${record.username || '未設定帳號'}@${record.hostname || '未設定主機'}:${record.port || 22}\t${aliases.length ? `使用中：${aliases.join(', ')}` : '未關聯'}`;
    }).join('\n'));
    return;
  }
  if (!alias) throw new Error('請提供主機別名或金鑰 ID');
  const host = readHosts(dataFile).find((item) => item.alias === alias);
  if (action === 'create') {
    if (!host) throw new Error(`找不到主機：${alias}`);
    if (host.keyPath) throw new Error('此主機已關聯登入金鑰；請先解除外部金鑰關聯或刪除 sshdeck 金鑰，再建立新金鑰');
    const passphrase = await readSecret('設定新金鑰密語（輸入隱藏）：');
    const created = ssh.createManagedKey(dataFile, alias, passphrase, host);
    try { mutateHosts(dataFile, (hosts) => { const current = hosts.find((item) => item.alias === alias); if (!current) throw new Error(`找不到主機：${alias}`); current.keyPath = created.keyPath; }); }
    catch (error) { ssh.deleteManagedKey(dataFile, created.keyPath); throw error; }
    console.log(`已建立金鑰：${alias}\n公鑰：${created.publicKey}`);
    return;
  }
  if (action === 'show') {
    const record = host?.keyPath ? ssh.managedKeyForPath(dataFile, host.keyPath) : ssh.resolveManagedKey(dataFile, alias);
    const keyPath = host?.keyPath || record?.keyPath;
    if (!keyPath) throw new Error(`找不到關聯金鑰：${alias}`);
    console.log(ssh.managedPublicKey(keyPath));
    return;
  }
  if (action === 'guide') {
    const record = host?.keyPath ? ssh.managedKeyForPath(dataFile, host.keyPath) : ssh.resolveManagedKey(dataFile, alias);
    const keyPath = host?.keyPath || record?.keyPath;
    if (!keyPath) throw new Error(`找不到關聯金鑰：${alias}`);
    console.log(ssh.installationGuide(host?.keyPath ? host : record, ssh.managedPublicKey(keyPath)));
    return;
  }
  if (action === 'unlink') {
    if (!host) throw new Error(`找不到主機：${alias}`);
    if (!host.keyPath) throw new Error('此主機尚未關聯登入金鑰');
    const managed = ssh.isManagedKeyPath(dataFile, host.keyPath);
    mutateHosts(dataFile, (hosts) => {
      const current = hosts.find((item) => item.alias === alias);
      if (!current) throw new Error(`找不到主機：${alias}`);
      delete current.keyPath;
    });
    console.log(managed
      ? `已解除主機 ${alias} 的金鑰關聯；金鑰仍保留在 sshdeck 管理清單，遠端授權不變`
      : `已解除主機 ${alias} 的既有金鑰關聯；未刪除原私鑰或遠端公鑰授權`);
    return;
  }
  if (action === 'delete') {
    if (host?.keyPath && !ssh.isManagedKeyPath(dataFile, host.keyPath)) throw new Error('此金鑰非 sshdeck 建立，請使用 key unlink 解除關聯；不會刪除使用者檔案');
    const record = host?.keyPath ? ssh.managedKeyForPath(dataFile, host.keyPath) : ssh.resolveManagedKey(dataFile, alias);
    const keyPath = host?.keyPath || record?.keyPath;
    if (!keyPath || !ssh.isManagedKeyPath(dataFile, keyPath)) throw new Error(`找不到 sshdeck 管理的金鑰：${alias}`);
    const users = readHosts(dataFile).filter((item) => item.keyPath === keyPath);
    if (users.length > 1) throw new Error(`此金鑰仍由其他設定共用：${users.filter((item) => item.alias !== alias).map((item) => item.alias).join(', ')}；請先解除關聯`);
    const publicKey = ssh.managedPublicKey(keyPath);
    const guide = ssh.installationGuide(host || record, publicKey);
    if (users.length === 1) mutateHosts(dataFile, (hosts) => {
      const current = hosts.find((item) => item.keyPath === keyPath);
      if (current) delete current.keyPath;
    });
    try { ssh.deleteManagedKey(dataFile, keyPath); }
    catch (error) {
      if (users.length === 1) {
        try { mutateHosts(dataFile, (hosts) => { const current = hosts.find((item) => item.alias === users[0].alias); if (current) current.keyPath = keyPath; }); }
        catch (restoreError) { throw new Error(`本機私鑰刪除失敗，且無法恢復主機關聯：${error.message}; ${restoreError.message}`); }
      }
      throw error;
    }
    console.log(`已刪除本機私鑰：${record?.alias || alias}\n遠端 authorized_keys 授權不會自動撤銷；請手動依下列公鑰撤銷指南操作：\n${guide}`);
    return;
  }
  throw new Error('用法：sshdeck key <list|create|show|guide|unlink|delete> [別名|金鑰 ID]');
}

function trustedRequest(req, port) {
  let requestUrl;
  try { requestUrl = new URL(`http://${req.headers.host}`); } catch { return false; }
  const localHost = ['127.0.0.1', 'localhost'].includes(requestUrl.hostname.toLowerCase());
  if (!localHost || Number(requestUrl.port || 80) !== port) return false;

  if (!req.headers.origin) return true;
  try {
    const origin = new URL(req.headers.origin);
    return origin.protocol === 'http:'
      && ['127.0.0.1', 'localhost'].includes(origin.hostname.toLowerCase())
      && origin.host.toLowerCase() === requestUrl.host.toLowerCase();
  } catch {
    return false;
  }
}

const page = `<!doctype html>
<html lang="zh-Hant">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width">
<link rel="stylesheet" href="/assets/xterm.css">
<title>sshdeck 主機設定</title>
<h1>主機設定管理</h1>
<form id="form">
  <label>別名 <input name="alias" required></label>
  <label>主機名稱 <input name="hostname" required></label>
  <label>連接埠 <input name="port" type="number" value="22" min="1" max="65535" required></label>
  <label>登入帳號 <input name="username" required></label>
  <label>既有金鑰路徑 <input name="keyPath"></label>
  <button>新增主機</button>
</form>
<button id="lock-keys" type="button">鎖定已解鎖金鑰</button>
<p id="error" role="alert"></p>
<ul id="hosts"></ul>
<h2>本機管理金鑰</h2>
<ul id="managed-keys"></ul>
<h2>遠端單次命令</h2>
<form id="exec-form"><label>主機別名 <select id="exec-host"></select></label><label>遠端命令 <input id="exec-command" required></label><button>執行</button></form>
<div id="exec-sessions" aria-live="polite"></div>
<h2>SSH 互動終端機</h2>
<div id="shell-sessions"></div>
<dialog id="unlock-dialog">
  <form id="unlock-form">
    <label>登入金鑰密語 <input id="passphrase" type="password" autocomplete="current-password"></label>
    <button type="submit">解鎖</button>
    <button id="cancel-unlock" type="button">取消</button>
  </form>
</dialog>
<dialog id="key-create-dialog">
  <form id="key-create-form">
    <label>新 Ed25519 金鑰密語 <input id="new-key-passphrase" type="password" autocomplete="new-password" required></label>
    <label>再次輸入密語 <input id="confirm-key-passphrase" type="password" autocomplete="new-password" required></label>
    <button type="submit">建立金鑰</button>
    <button id="cancel-key-create" type="button">取消</button>
  </form>
</dialog>
<section aria-label="登入金鑰資訊">
  <pre id="key-output"></pre>
  <button id="copy-public-key" type="button" disabled>複製公鑰</button>
</section>
<script src="/assets/xterm.js"></script>
<script src="/assets/addon-fit.js"></script>
<script>
const form = document.querySelector('#form');
const hosts = document.querySelector('#hosts');
const managedKeys = document.querySelector('#managed-keys');
const shellSessions = document.querySelector('#shell-sessions');
const error = document.querySelector('#error');
const unlockDialog = document.querySelector('#unlock-dialog');
const unlockForm = document.querySelector('#unlock-form');
const passphraseInput = document.querySelector('#passphrase');
const keyCreateDialog = document.querySelector('#key-create-dialog');
const keyCreateForm = document.querySelector('#key-create-form');
const newKeyPassphrase = document.querySelector('#new-key-passphrase');
const confirmKeyPassphrase = document.querySelector('#confirm-key-passphrase');
const keyOutput = document.querySelector('#key-output');
const copyPublicKey = document.querySelector('#copy-public-key');
let currentPublicKey = '';

async function request(url, method = 'GET', body) {
  const response = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const value = response.status === 204 ? null : await response.json();
  return { response, value };
}

async function send(url, method, body) {
  const { response, value } = await request(url, method, body);
  if (!response.ok) {
    const reason = Error(value?.error || '操作失敗');
    reason.code = value?.code;
    reason.fingerprint = value?.fingerprint;
    reason.previousFingerprint = value?.previousFingerprint;
    throw reason;
  }
  return value;
}

function askPassphrase() {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      unlockDialog.removeEventListener('cancel', cancel);
      unlockDialog.close();
      passphraseInput.value = '';
      resolve(value);
    };
    const cancel = (event) => { event.preventDefault(); finish(null); };
    unlockDialog.addEventListener('cancel', cancel, { once: true });
    unlockForm.onsubmit = (event) => { event.preventDefault(); finish(passphraseInput.value); };
    document.querySelector('#cancel-unlock').onclick = () => finish(null);
    unlockDialog.showModal();
    passphraseInput.focus();
  });
}

function askNewKeyPassphrase() {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      keyCreateDialog.removeEventListener('cancel', cancel);
      keyCreateDialog.close();
      newKeyPassphrase.value = '';
      confirmKeyPassphrase.value = '';
      resolve(value);
    };
    const cancel = (event) => { event.preventDefault(); finish(null); };
    keyCreateDialog.addEventListener('cancel', cancel, { once: true });
    keyCreateForm.onsubmit = (event) => {
      event.preventDefault();
      if (!newKeyPassphrase.value) { error.textContent = '金鑰密語不可空白'; return; }
      if (newKeyPassphrase.value !== confirmKeyPassphrase.value) { error.textContent = '兩次輸入的金鑰密語不一致'; return; }
      finish(newKeyPassphrase.value);
    };
    document.querySelector('#cancel-key-create').onclick = () => finish(null);
    keyCreateDialog.showModal();
    newKeyPassphrase.focus();
  });
}

function showKeyInfo(publicKey, guide = '') {
  currentPublicKey = publicKey || '';
  keyOutput.textContent = (publicKey ? '公鑰：\\n' + publicKey + '\\n\\n' : '') + guide;
  copyPublicKey.disabled = !currentPublicKey;
}

copyPublicKey.onclick = async () => {
  try { await navigator.clipboard.writeText(currentPublicKey); error.textContent = '已複製公鑰'; }
  catch (reason) { error.textContent = '無法複製公鑰，請手動選取複製'; }
};

async function unlock(host) {
  const passphrase = await askPassphrase();
  if (passphrase === null) return false;
  await send('/api/unlock', 'POST', { alias: host.alias, passphrase });
  return true;
}

async function checkHost(host, expectedFingerprint) {
  const route = '/api/hosts/' + encodeURIComponent(host.alias) + '/check';
  const body = expectedFingerprint ? { expectedFingerprint } : {};
  let { response, value } = await request(route, 'POST', body);
  if (response.status === 428) {
    if (!await unlock(host)) return;
    ({ response, value } = await request(route, 'POST', body));
  }
  if (response.status === 409 && ['HOST_TRUST_REQUIRED', 'HOST_KEY_CHANGED'].includes(value.code)) {
    const previous = value.previousFingerprint ? '（原信任 ' + value.previousFingerprint + '）' : '';
    if (!confirm('SSH 主機指紋：' + value.fingerprint + previous + '。你已從可信管道核對此指紋嗎？')) {
      throw Error('已拒絕主機指紋');
    }
    return checkHost(host, value.fingerprint);
  }
  if (!response.ok) throw Error(value.error || 'SSH 檢查失敗');
  return value;
}

function startShell(host) {
  const section = document.createElement('section');
  section.dataset.alias = host.alias;
  const heading = document.createElement('h3');
  heading.textContent = '終端機：' + host.alias + '（' + host.username + '@' + host.hostname + ':' + host.port + '）';
  const close = document.createElement('button');
  close.textContent = '關閉終端機';
  const terminalElement = document.createElement('div');
  terminalElement.className = 'sshdeck-terminal';
  terminalElement.style.cssText = 'height:360px; min-width:320px; background:#111; padding:6px;';
  section.append(heading, close, terminalElement);
  shellSessions.prepend(section);

  const terminal = new window.Terminal({ cursorBlink: true, convertEol: true, scrollback: 2000 });
  const fit = new window.FitAddon.FitAddon();
  terminal.loadAddon(fit);
  terminal.open(terminalElement);
  fit.fit();
  terminal.focus();
  let socket;
  let finished = false;
  const closeSocket = () => {
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, 'terminal closed');
  };
  close.onclick = closeSocket;

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(protocol + '//' + location.host + '/api/shell?alias=' + encodeURIComponent(host.alias));
  socket.binaryType = 'arraybuffer';
  const sendControl = (value) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
  };
  const resize = () => {
    try { fit.fit(); sendControl({ type: 'resize', cols: terminal.cols, rows: terminal.rows }); }
    catch { /* hidden or detached terminal */ }
  };
  const terminalEncoder = new TextEncoder();
  terminal.onData((data) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(terminalEncoder.encode(data));
  });
  terminal.onResize(({ cols, rows }) => sendControl({ type: 'resize', cols, rows }));
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(terminalElement);

  socket.onopen = resize;
  socket.onmessage = async (event) => {
    if (typeof event.data !== 'string') {
      terminal.write(new Uint8Array(event.data));
      return;
    }
    let message;
    try { message = JSON.parse(event.data); }
    catch { terminal.write(event.data); return; }
    if (message.type === 'unlock-required') {
      try {
        if (!await unlock(host)) { socket.close(1000, 'unlock cancelled'); return; }
        sendControl({ type: 'unlocked' });
      } catch (reason) {
        terminal.write('\\r\\n金鑰解鎖失敗：' + reason.message + '\\r\\n');
        socket.close(1011, 'unlock failed');
      }
    } else if (message.type === 'trust-required' || message.type === 'host-key-changed') {
      const previous = message.previousFingerprint ? '（原信任 ' + message.previousFingerprint + '）' : '';
      if (confirm('SSH 主機指紋：' + message.fingerprint + previous + '。你已從可信管道核對此指紋嗎？')) {
        sendControl({ type: 'trust', fingerprint: message.fingerprint });
      } else {
        terminal.write('\\r\\n已拒絕主機指紋。\\r\\n');
        sendControl({ type: 'trust-reject' });
      }
    } else if (message.type === 'started') {
      terminal.write('已連線。輸入 exit 或關閉此終端機結束工作階段。\\r\\n');
      resize();
      terminal.focus();
    } else if (message.type === 'error') {
      terminal.write('\\r\\nSSH 終端機錯誤：' + message.error + '\\r\\n');
    } else if (message.type === 'closed') {
      const detail = message.error ? '：' + message.error : message.code === undefined ? '' : '（結束狀態 ' + message.code + '）';
      terminal.write('\\r\\n終端機已關閉' + detail + '\\r\\n');
      finished = true;
      close.disabled = true;
      resizeObserver.disconnect();
    }
  };
  socket.onerror = () => { terminal.write('\\r\\nWebSocket 終端機連線失敗。\\r\\n'); };
  socket.onclose = (event) => {
    if (!finished && event.code !== 1000) terminal.write('\\r\\n終端機連線中斷（' + event.code + '）。\\r\\n');
    finished = true;
    close.disabled = true;
    resizeObserver.disconnect();
  };
}

async function refresh() {
  const list = await send('/api/hosts');
  hosts.replaceChildren();
  for (const host of list) {
    const item = document.createElement('li');
    item.dataset.alias = host.alias;
    const state = host.check?.state === 'success' ? 'SSH 成功'
      : host.check?.state === 'failure' ? 'SSH 失敗'
        : host.check?.state === 'changed' ? '指紋已變更'
          : host.check?.state === 'untrusted' ? '等待指紋確認' : '未檢查';
    const docker = host.check?.docker;
    const dockerState = !docker ? '未檢查'
      : docker.state === 'available' ? '可用 ' + docker.version
        : docker.state === 'permission-denied' ? '權限不足'
          : docker.state === 'missing-cli' ? 'CLI 未安裝'
            : docker.state === 'daemon-unavailable' ? 'daemon 不可用'
              : docker.state === 'not-run' ? '未執行'
                : '無法使用';
    const checked = host.check?.checkedAt ? '，最近檢查 ' + host.check.checkedAt : '';
    item.title = docker?.diagnostic || '';
    item.textContent = host.alias + ' — ' + host.username + '@' + host.hostname + ':' + host.port + '（SSH：' + state + '；Docker：' + dockerState + checked + '） ';

    const check = document.createElement('button');
    check.textContent = '檢查 SSH';
    check.onclick = async () => {
      error.textContent = '';
      try { await checkHost(host); await refresh(); }
      catch (reason) { error.textContent = reason.message; await refresh(); }
    };

    const shell = document.createElement('button');
    shell.textContent = '開啟互動終端機';
    shell.onclick = () => startShell(host);

    const edit = document.createElement('button');
    edit.textContent = '編輯';
    edit.onclick = async () => {
      const hostname = prompt('主機名稱', host.hostname);
      if (hostname === null) return;
      const port = prompt('連接埠', host.port);
      if (port === null) return;
      const username = prompt('登入帳號', host.username);
      if (username === null) return;
      const keyPath = prompt('既有金鑰路徑', host.keyPath || '');
      if (keyPath === null) return;
      try {
        await send('/api/hosts/' + encodeURIComponent(host.alias), 'PUT', { hostname, port: Number(port), username, keyPath });
        await refresh();
      } catch (reason) { error.textContent = reason.message; }
    };

    const remove = document.createElement('button');
    remove.textContent = '刪除';
    remove.onclick = async () => {
      try { await send('/api/hosts/' + encodeURIComponent(host.alias), 'DELETE'); await refresh(); }
      catch (reason) { error.textContent = reason.message; }
    };
    const publicKey = document.createElement('button');
    publicKey.textContent = '檢視公鑰';
    publicKey.disabled = !host.keyPath;
    publicKey.onclick = async () => {
      try {
        const result = await send('/api/hosts/' + encodeURIComponent(host.alias) + '/key/public');
        showKeyInfo(result.publicKey);
      } catch (reason) { error.textContent = reason.message; }
    };

    const guide = document.createElement('button');
    guide.textContent = '授權／撤銷指南';
    guide.disabled = !host.keyPath;
    guide.onclick = async () => {
      try {
        const result = await send('/api/hosts/' + encodeURIComponent(host.alias) + '/guide');
        showKeyInfo(result.publicKey, result.guide);
      } catch (reason) { error.textContent = reason.message; }
    };

    const keyAction = document.createElement('button');
    keyAction.textContent = host.keyPath ? (host.keyManaged ? '刪除本機金鑰' : '解除既有金鑰關聯') : '建立登入金鑰';
    keyAction.onclick = async () => {
      error.textContent = '';
      try {
        if (!host.keyPath) {
          const passphrase = await askNewKeyPassphrase();
          if (passphrase === null) return;
          const result = await send('/api/hosts/' + encodeURIComponent(host.alias) + '/key', 'POST', { passphrase });
          await refresh();
          showKeyInfo(result.publicKey, result.guide);
          return;
        }
        if (!host.keyManaged) {
          if (!confirm('只解除此主機與既有私鑰的關聯，不會刪除本機私鑰或遠端公鑰。')) return;
          await send('/api/hosts/' + encodeURIComponent(host.alias) + '/key/unlink', 'POST', {});
          await refresh();
          error.textContent = '已解除金鑰關聯；原私鑰與遠端授權均保留';
          return;
        }
        if (!confirm('刪除 sshdeck 管理的本機私鑰？遠端 authorized_keys 授權不會自動撤銷。請先取得／保存撤銷指南。')) return;
        const result = await send('/api/hosts/' + encodeURIComponent(host.alias) + '/key/delete', 'POST', {});
        await refresh();
        showKeyInfo(result.publicKey, result.guide);
        error.textContent = '本機私鑰已刪除；遠端公鑰仍授權，請手動依指南撤銷';
      } catch (reason) { error.textContent = reason.message; }
    };

    item.append(check, shell, edit, remove, publicKey, guide, keyAction);
    if (host.keyPath && host.keyManaged) {
      const unlinkManaged = document.createElement('button');
      unlinkManaged.textContent = '解除此主機關聯';
      unlinkManaged.onclick = async () => {
        if (!confirm('只解除主機關聯；sshdeck 管理的本機金鑰會保留在金鑰清單，遠端授權不變。')) return;
        try {
          await send('/api/hosts/' + encodeURIComponent(host.alias) + '/key/unlink', 'POST', {});
          await refresh();
          error.textContent = '已解除主機關聯；本機金鑰與遠端授權均保留';
        } catch (reason) { error.textContent = reason.message; }
      };
      item.append(unlinkManaged);
    }
    hosts.append(item);
  }
  const selector = document.querySelector('#exec-host');
  selector.replaceChildren(...list.map((host) => { const option = document.createElement('option'); option.value = host.alias; option.textContent = host.alias + ' — ' + host.username + '@' + host.hostname; return option; }));
  const records = await send('/api/keys');
  managedKeys.replaceChildren();
  for (const record of records) {
    const item = document.createElement('li');
    item.dataset.keyId = record.id;
    const state = record.associatedAliases.length ? '使用中：' + record.associatedAliases.join(', ') : '未關聯主機';
    item.textContent = record.alias + '（' + record.id + '）— ' + (record.username || '未設定帳號') + '@' + (record.hostname || '未設定主機') + '；' + state + ' ';
    const view = document.createElement('button');
    view.textContent = '公鑰／撤銷指南';
    view.onclick = async () => {
      try {
        const info = await send('/api/keys/' + encodeURIComponent(record.id) + '/guide');
        showKeyInfo(info.publicKey, info.guide);
      } catch (reason) { error.textContent = reason.message; }
    };
    const remove = document.createElement('button');
    remove.textContent = '刪除本機金鑰';
    remove.onclick = async () => {
      if (record.associatedAliases.length) { error.textContent = '金鑰仍被主機設定使用，請先解除所有關聯'; return; }
      if (!confirm('刪除本機私鑰？遠端 authorized_keys 不會自動撤銷。請先保存撤銷指南。')) return;
      try {
        const result = await send('/api/keys/' + encodeURIComponent(record.id) + '/delete', 'POST', {});
        showKeyInfo(result.publicKey, result.guide);
        error.textContent = '本機金鑰已刪除；遠端授權仍存在，請手動撤銷';
        await refresh();
      } catch (reason) { error.textContent = reason.message; }
    };
    item.append(view, remove);
    managedKeys.append(item);
  }
}

async function runRemoteCommand(host, command, controller, output, expectedFingerprint) {
  const response = await fetch('/api/exec', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ alias: host.alias, command, ...(expectedFingerprint ? { expectedFingerprint } : {}) }),
    signal: controller.signal,
  });
  if (response.status === 428) {
    if (!await unlock(host)) throw Error('已取消金鑰解鎖');
    return runRemoteCommand(host, command, controller, output, expectedFingerprint);
  }
  if (response.status === 409) {
    const challenge = await response.json();
    if (['HOST_TRUST_REQUIRED', 'HOST_KEY_CHANGED'].includes(challenge.code)) {
      const previous = challenge.previousFingerprint ? '（原信任 ' + challenge.previousFingerprint + '）' : '';
      if (!confirm('SSH 主機指紋：' + challenge.fingerprint + previous + '。你已從可信管道核對此指紋嗎？')) throw Error('已拒絕主機指紋；未執行命令');
      return runRemoteCommand(host, command, controller, output, challenge.fingerprint);
    }
    throw Error(challenge.error || '遠端命令失敗');
  }
  if (!response.ok) throw Error((await response.json()).error || '遠端命令失敗');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    const lines = pending.split('\\n');
    pending = lines.pop();
    for (const line of lines) {
      if (!line) continue;
      const event = JSON.parse(line);
      if (event.type === 'stdout' || event.type === 'stderr') output.textContent += event.data;
      else if (event.type === 'exit') output.textContent += '\\n結束狀態：' + event.code;
      else if (event.type === 'error') throw Error(event.error || '遠端命令失敗');
    }
  }
}

document.querySelector('#exec-form').onsubmit = async (event) => {
  event.preventDefault();
  const sessions = document.querySelector('#exec-sessions');
  const alias = document.querySelector('#exec-host').value;
  const command = document.querySelector('#exec-command').value;
  if (!alias || !command.trim()) return;
  const host = (await send('/api/hosts')).find((item) => item.alias === alias);
  if (!host) { error.textContent = '找不到主機：' + alias; return; }
  const section = document.createElement('section');
  section.dataset.alias = host.alias;
  const heading = document.createElement('h3');
  heading.textContent = '目標：' + host.alias + '（' + host.username + '@' + host.hostname + ':' + host.port + '） ' + command;
  const output = document.createElement('pre');
  const cancel = document.createElement('button');
  cancel.textContent = '取消此命令';
  const controller = new AbortController();
  cancel.onclick = () => controller.abort();
  section.append(heading, cancel, output);
  sessions.prepend(section);
  output.textContent = '';
  try { await runRemoteCommand(host, command, controller, output); }
  catch (reason) { output.textContent += '\\n' + (reason.name === 'AbortError' ? '已取消' : reason.message); }
  finally { cancel.disabled = true; }
};

form.onsubmit = async (event) => {
  event.preventDefault();
  error.textContent = '';
  const host = Object.fromEntries(new FormData(form));
  host.port = Number(host.port);
  try {
    await send('/api/hosts', 'POST', host);
    form.reset();
    form.elements.port.value = 22;
    await refresh();
  } catch (reason) { error.textContent = reason.message; }
};

document.querySelector('#lock-keys').onclick = async () => {
  try { await send('/api/lock', 'POST', {}); error.textContent = '已鎖定所有登入金鑰'; }
  catch (reason) { error.textContent = reason.message; }
};

refresh().catch((reason) => { error.textContent = reason.message; });
</script>
</html>`;

function createServer({ dataFile, port }) {
  const unlockedKeys = new Map();
  const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });
  const server = http.createServer((req, res) => {
    const send = (status, value, contentType = 'application/json') => {
      res.writeHead(status, { 'content-type': `${contentType}; charset=utf-8`, 'cache-control': 'no-store' });
      res.end(contentType === 'application/json' ? JSON.stringify(value) : value);
    };
    if (!trustedRequest(req, server.address()?.port || port)) return send(403, { error: '不允許的 Host 或 Origin' });
    if (req.method === 'GET' && req.url === '/') return send(200, page, 'text/html');
    const assets = {
      '/assets/xterm.js': [path.join(__dirname, '..', 'node_modules', '@xterm', 'xterm', 'lib', 'xterm.js'), 'text/javascript'],
      '/assets/xterm.css': [path.join(__dirname, '..', 'node_modules', '@xterm', 'xterm', 'css', 'xterm.css'), 'text/css'],
      '/assets/addon-fit.js': [path.join(__dirname, '..', 'node_modules', '@xterm', 'addon-fit', 'lib', 'addon-fit.js'), 'text/javascript'],
    };
    if (req.method === 'GET' && assets[req.url]) {
      const [file, contentType] = assets[req.url];
      res.writeHead(200, { 'content-type': `${contentType}; charset=utf-8`, 'cache-control': 'public, max-age=3600' });
      fs.createReadStream(file).pipe(res);
      return;
    }
    if (req.method === 'GET' && req.url === '/api/keys') {
      try {
        const hosts = readHosts(dataFile);
        const records = ssh.listManagedKeys(dataFile).map((record) => ({
          ...record,
          associatedAliases: hosts.filter((host) => host.keyPath === record.keyPath).map((host) => host.alias),
        }));
        return send(200, records);
      } catch (error) { return send(500, { error: error.message }); }
    }
    const managedKeyRoute = req.url.match(/^\/api\/keys\/([^/?]+)\/(public|guide|delete)$/);
    if (req.method === 'GET' && managedKeyRoute && managedKeyRoute[2] !== 'delete') {
      try {
        const record = ssh.resolveManagedKey(dataFile, decodeURIComponent(managedKeyRoute[1]));
        const publicKey = ssh.managedPublicKey(record.keyPath);
        return send(200, managedKeyRoute[2] === 'public' ? { publicKey } : { publicKey, guide: ssh.installationGuide(record, publicKey) });
      } catch (error) { return send(404, { error: error.message }); }
    }
    if (req.method === 'GET' && req.url === '/api/hosts') {
      try {
        const statuses = ssh.getStatuses(dataFile);
        return send(200, readHosts(dataFile).map((host) => ({
          ...host,
          keyManaged: ssh.isManagedKeyPath(dataFile, host.keyPath),
          check: statuses[host.alias] || { state: 'unchecked' },
        })));
      } catch (error) { return send(500, { error: error.message }); }
    }

    if (req.method === 'POST' && req.url === '/api/lock') {
      unlockedKeys.clear();
      res.writeHead(204, { 'cache-control': 'no-store' });
      return res.end();
    }
    const match = req.url.match(/^\/api\/hosts\/([^/?]+)(?:\/(check))?$/);
    const checking = Boolean(match && match[2] === 'check');
    const keyActionMatch = req.url.match(/^\/api\/hosts\/([^/?]+)\/key\/(delete|unlink)$/);
    const managedKeyDelete = Boolean(managedKeyRoute && managedKeyRoute[2] === 'delete' && req.method === 'POST');
    const keyPublicMatch = req.url.match(/^\/api\/hosts\/([^/?]+)\/key\/public$/);
    const keyGuideMatch = req.url.match(/^\/api\/hosts\/([^/?]+)\/guide$/);
    const keyCreate = req.method === 'POST' && /^\/api\/hosts\/[^/?]+\/key$/.test(req.url);
    const collection = req.url === '/api/hosts';
    const unlockRequest = req.method === 'POST' && req.url === '/api/unlock';
    const executing = req.method === 'POST' && req.url === '/api/exec';
    if (req.method === 'GET' && (keyPublicMatch || keyGuideMatch)) {
      try {
        const alias = decodeURIComponent((keyPublicMatch || keyGuideMatch)[1]);
        const host = readHosts(dataFile).find((item) => item.alias === alias);
        if (!host || !host.keyPath) return send(404, { error: `找不到登入金鑰：${alias}` });
        const publicKey = ssh.managedPublicKey(host.keyPath);
        return send(200, keyPublicMatch ? { publicKey } : { publicKey, guide: ssh.installationGuide(host, publicKey) });
      } catch (error) { return send(400, { error: error.message }); }
    }
    const keyOperation = Boolean(keyActionMatch && req.method === 'POST');
    if (!unlockRequest && !executing && !keyCreate && !keyOperation && !managedKeyDelete && !(collection && req.method === 'POST') && !(checking && req.method === 'POST') && !(match && !checking && ['PUT', 'DELETE'].includes(req.method))) return send(404, { error: '找不到路徑' });
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 32_768) {
        send(413, { error: '要求內容過大' });
        req.destroy();
      }
    });
    req.on('end', async () => {
      try {
        const alias = match && decodeURIComponent(match[1]);
        const input = JSON.parse(body || '{}');
        if (executing) {
          const host = readHosts(dataFile).find((item) => item.alias === input.alias);
          if (!host) return send(404, { error: `找不到主機：${input.alias || ''}` });
          const keyPath = ssh.keyPathFor(host);
          if (!unlockedKeys.has(keyPath)) return send(428, { error: '請先解鎖此主機的登入金鑰' });
          const abort = new AbortController();
          res.on('close', () => { if (!res.writableEnded) abort.abort(); });
          const stdoutDecoder = new StringDecoder('utf8');
          const stderrDecoder = new StringDecoder('utf8');
          const writeOutput = (type, text) => { if (text && !res.destroyed) res.write(JSON.stringify({ type, data: text }) + '\n'); };
          let started = false;
          try {
            const code = await ssh.exec(dataFile, host, unlockedKeys.get(keyPath), input.command, {
              signal: abort.signal,
              ...(typeof input.expectedFingerprint === 'string' ? { expectedFingerprint: input.expectedFingerprint } : {}),
              onStart: () => {
                started = true;
                res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' });
                res.flushHeaders();
              },
              onStdout: (chunk) => writeOutput('stdout', stdoutDecoder.write(chunk)),
              onStderr: (chunk) => writeOutput('stderr', stderrDecoder.write(chunk)),
            });
            writeOutput('stdout', stdoutDecoder.end());
            writeOutput('stderr', stderrDecoder.end());
            if (!res.destroyed) res.end(JSON.stringify({ type: 'exit', code }) + '\n');
          } catch (error) {
            if (error.code === 'INVALID_KEY_PASSPHRASE' || error.code === 'INVALID_PRIVATE_KEY') unlockedKeys.delete(keyPath);
            if (res.destroyed) return;
            if (!started) {
              const status = ['HOST_TRUST_REQUIRED', 'HOST_KEY_CHANGED'].includes(error.code) ? 409 : error.code === 'AUTHENTICATION_FAILED' ? 401 : 502;
              return send(status, { code: error.code || 'REMOTE_EXEC_FAILED', error: error.message, fingerprint: error.fingerprint, previousFingerprint: error.previousFingerprint });
            }
            writeOutput('stdout', stdoutDecoder.end());
            writeOutput('stderr', stderrDecoder.end());
            res.end(JSON.stringify({ type: 'error', code: error.code, error: error.message }) + '\n');
          }
          return;
        }
        if (managedKeyDelete) {
          const id = decodeURIComponent(managedKeyRoute[1]);
          const record = ssh.resolveManagedKey(dataFile, id);
          const associated = readHosts(dataFile).filter((host) => host.keyPath === record.keyPath);
          if (associated.length) return send(409, { error: `金鑰仍由主機設定使用：${associated.map((host) => host.alias).join(', ')}` });
          const publicKey = ssh.managedPublicKey(record.keyPath);
          const guide = ssh.installationGuide(record, publicKey);
          unlockedKeys.delete(record.keyPath);
          ssh.deleteManagedKey(dataFile, record.keyPath);
          return send(200, { deleted: true, publicKey, guide });
        }
        if (keyOperation) {
          const keyAlias = decodeURIComponent(keyActionMatch[1]);
          const action = keyActionMatch[2];
          const host = readHosts(dataFile).find((item) => item.alias === keyAlias);
          if (!host || !host.keyPath) return send(404, { error: `找不到已關聯的登入金鑰：${keyAlias}` });
          const managed = ssh.isManagedKeyPath(dataFile, host.keyPath);
          if (action === 'unlink') {
            const oldPath = ssh.keyPathFor(host);
            mutateHosts(dataFile, (hosts) => {
              const current = hosts.find((item) => item.alias === keyAlias);
              if (!current) throw new Error(`找不到主機：${keyAlias}`);
              delete current.keyPath;
            });
            unlockedKeys.delete(oldPath);
            res.writeHead(204, { 'cache-control': 'no-store' });
            return res.end();
          }
          if (!managed) return send(409, { error: '此私鑰由使用者管理；解除關聯不會刪除檔案' });
          const shared = readHosts(dataFile).filter((item) => item.alias !== keyAlias && item.keyPath === host.keyPath);
          if (shared.length) return send(409, { error: `此金鑰仍由其他設定共用：${shared.map((item) => item.alias).join(', ')}` });
          const publicKey = ssh.managedPublicKey(host.keyPath);
          const guide = ssh.installationGuide(host, publicKey);
          mutateHosts(dataFile, (hosts) => {
            const current = hosts.find((item) => item.alias === keyAlias);
            if (!current) throw new Error(`找不到主機：${keyAlias}`);
            delete current.keyPath;
          });
          try { ssh.deleteManagedKey(dataFile, host.keyPath); }
          catch (error) {
            try { mutateHosts(dataFile, (hosts) => { const current = hosts.find((item) => item.alias === keyAlias); if (current) current.keyPath = host.keyPath; }); }
            catch (restoreError) { return send(500, { error: `本機金鑰刪除失敗，且無法恢復設定：${error.message}; ${restoreError.message}` }); }
            throw error;
          }
          unlockedKeys.delete(host.keyPath);
          return send(200, { deleted: true, publicKey, guide });
        }
        if (keyCreate) {
          const keyAlias = decodeURIComponent(req.url.match(/^\/api\/hosts\/([^/?]+)\/key$/)[1]);
          const host = readHosts(dataFile).find((item) => item.alias === keyAlias);
          if (!host) return send(404, { error: `找不到主機：${keyAlias}` });
          if (host.keyPath) return send(409, { error: '此主機已關聯登入金鑰，請先解除關聯或刪除 sshdeck 金鑰' });
          const made = ssh.createManagedKey(dataFile, keyAlias, input.passphrase, host);
          try { mutateHosts(dataFile, (hosts) => { const target = hosts.find((item) => item.alias === keyAlias); if (!target) throw new Error(`找不到主機：${keyAlias}`); target.keyPath = made.keyPath; }); }
          catch (error) { ssh.deleteManagedKey(dataFile, made.keyPath); throw error; }
          unlockedKeys.set(made.keyPath, input.passphrase);
          return send(201, { publicKey: made.publicKey, guide: ssh.installationGuide(host, made.publicKey) });
        }
        if (unlockRequest) {
          const host = readHosts(dataFile).find((item) => item.alias === input.alias);
          if (!host) return send(404, { error: `找不到主機：${input.alias || ''}` });
          const keyPath = ssh.validateKey(host, typeof input.passphrase === 'string' ? input.passphrase : '');
          unlockedKeys.set(keyPath, typeof input.passphrase === 'string' ? input.passphrase : '');
          res.writeHead(204, { 'cache-control': 'no-store' });
          return res.end();
        }
        if (checking) {
          const host = readHosts(dataFile).find((item) => item.alias === alias);
          if (!host) return send(404, { error: `找不到主機：${alias}` });
          const keyPath = ssh.keyPathFor(host);
          if (!unlockedKeys.has(keyPath)) return send(428, { code: 'NEEDS_UNLOCK', error: '請先解鎖此主機的登入金鑰' });
          try {
            const result = await ssh.checkWithDocker(dataFile, host, unlockedKeys.get(keyPath), {
              ...(typeof input.expectedFingerprint === 'string' ? { expectedFingerprint: input.expectedFingerprint } : {}),
            });
            return send(200, result);
          } catch (error) {
            if (error.code === 'INVALID_KEY_PASSPHRASE' || error.code === 'INVALID_PRIVATE_KEY') unlockedKeys.delete(keyPath);
            if (['HOST_TRUST_REQUIRED', 'HOST_KEY_CHANGED'].includes(error.code)) {
              return send(409, {
                code: error.code,
                error: error.message,
                fingerprint: error.fingerprint,
                previousFingerprint: error.previousFingerprint,
              });
            }
            const status = error.code === 'AUTHENTICATION_FAILED' ? 401 : 502;
            return send(status, {
              code: error.code || 'SSH_CHECK_FAILED',
              error: error.message,
              docker: ssh.getStatuses(dataFile)[alias]?.docker,
            });
          }
        }
        if (req.method === 'DELETE') {
          mutateHosts(dataFile, (hosts) => {
            const index = hosts.findIndex((host) => host.alias === alias);
            if (index < 0) throw new Error(`找不到主機：${alias}`);
            hosts.splice(index, 1);
          });
          res.writeHead(204, { 'cache-control': 'no-store' });
          return res.end();
        }
        if (req.method === 'POST') {
          let created;
          mutateHosts(dataFile, (hosts) => {
            created = validateHost(input);
            if (hosts.some((host) => host.alias === created.alias)) throw new Error(`主機別名已存在：${created.alias}`);
            hosts.push(created);
          });
          return send(201, created);
        }
        let updated;
        mutateHosts(dataFile, (hosts) => {
          const index = hosts.findIndex((host) => host.alias === alias);
          if (index < 0) throw new Error(`找不到主機：${alias}`);
          const patch = { ...input };
          delete patch.alias;
          updated = validateHost({ ...hosts[index], ...patch });
          hosts[index] = updated;
        });
        ssh.updateManagedKeyProfile(dataFile, updated);
        return send(200, updated);
      } catch (error) {
        return send(400, { error: error.message });
      }
    });
  });
  server.on('upgrade', (req, socket, head) => {
    let requestUrl;
    try { requestUrl = new URL(req.url, `http://127.0.0.1:${server.address()?.port || port}`); }
    catch {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    if (requestUrl.pathname !== '/api/shell'
      || !trustedRequest(req, server.address()?.port || port)
      || !req.headers.origin) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const alias = requestUrl.searchParams.get('alias');
    let knownAlias = false;
    try { knownAlias = Boolean(alias && readHosts(dataFile).some((host) => host.alias === alias)); }
    catch {
      socket.write('HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    if (!knownAlias) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    webSocketServer.handleUpgrade(req, socket, head, (webSocket) => {
      webSocketServer.emit('connection', webSocket, req, alias);
    });
  });

  webSocketServer.on('connection', (webSocket, _request, alias) => {
    let session;
    let pendingFingerprint;
    let closing = false;
    let unlockRequested = false;
    const sendControl = (message) => {
      if (webSocket.readyState === WebSocket.OPEN) webSocket.send(JSON.stringify(message));
    };
    const closeSocket = (code, reason) => {
      if (webSocket.readyState === WebSocket.OPEN || webSocket.readyState === WebSocket.CONNECTING) {
        try { webSocket.close(code, reason); } catch { webSocket.terminate(); }
      }
    };
    const startShell = async (expectedFingerprint) => {
      if (closing || webSocket.readyState !== WebSocket.OPEN) return;
      const host = readHosts(dataFile).find((item) => item.alias === alias);
      if (!host) { sendControl({ type: 'error', error: `找不到主機：${alias}` }); closeSocket(1008, 'unknown host'); return; }
      let keyPath;
      try { keyPath = ssh.keyPathFor(host); }
      catch (error) { sendControl({ type: 'error', error: error.message }); closeSocket(1008, 'missing key'); return; }
      if (!unlockedKeys.has(keyPath)) {
        if (!unlockRequested) { unlockRequested = true; sendControl({ type: 'unlock-required' }); }
        return;
      }
      try {
        const openedSession = await ssh.openShell(dataFile, host, unlockedKeys.get(keyPath), {
          cols: 80,
          rows: 24,
          ...(expectedFingerprint ? { expectedFingerprint } : {}),
          onData: (chunk) => {
            if (webSocket.readyState === WebSocket.OPEN) webSocket.send(chunk, { binary: true });
          },
          onClose: ({ error, code, signal }) => {
            if (closing) return;
            closing = true;
            sendControl({ type: 'closed', ...(error ? { error: error.message } : {}), ...(code === undefined ? {} : { code }), ...(signal ? { signal } : {}) });
            closeSocket(1000, 'ssh shell closed');
          },
        });
        if (closing || webSocket.readyState !== WebSocket.OPEN) { openedSession.close(); return; }
        session = openedSession;
        sendControl({ type: 'started', alias, username: host.username, cols: 80, rows: 24 });
      } catch (error) {
        if (webSocket.readyState !== WebSocket.OPEN) return;
        if (error.code === 'INVALID_KEY_PASSPHRASE' || error.code === 'INVALID_PRIVATE_KEY') unlockedKeys.delete(keyPath);
        if (['HOST_TRUST_REQUIRED', 'HOST_KEY_CHANGED'].includes(error.code)) {
          pendingFingerprint = error.fingerprint;
          sendControl({
            type: error.code === 'HOST_KEY_CHANGED' ? 'host-key-changed' : 'trust-required',
            code: error.code,
            fingerprint: error.fingerprint,
            previousFingerprint: error.previousFingerprint,
          });
          return;
        }
        sendControl({ type: 'error', code: error.code || 'SSH_SHELL_FAILED', error: error.message });
        closeSocket(1011, 'ssh shell failed');
      }
    };

    webSocket.on('message', (data, isBinary) => {
      if (isBinary) { session?.write(data); return; }
      let message;
      try { message = JSON.parse(data.toString()); }
      catch { sendControl({ type: 'error', error: '無效的終端機控制訊息' }); return; }
      if (message.type === 'resize') { session?.resize(message.cols, message.rows); return; }
      if (message.type === 'unlock') {
        const host = readHosts(dataFile).find((item) => item.alias === alias);
        if (!host) { closeSocket(1008, 'unknown host'); return; }
        try {
          const keyPath = ssh.validateKey(host, typeof message.passphrase === 'string' ? message.passphrase : '');
          unlockedKeys.set(keyPath, typeof message.passphrase === 'string' ? message.passphrase : '');
          unlockRequested = false;
          sendControl({ type: 'unlocked' });
          startShell();
        } catch (error) {
          sendControl({ type: 'error', code: error.code || 'KEY_UNLOCK_FAILED', error: error.message });
          closeSocket(1008, 'key unlock failed');
        }
        return;
      }
      if (message.type === 'unlocked') {
        unlockRequested = false;
        startShell();
        return;
      }
      if (message.type === 'trust') {
        if (!pendingFingerprint || message.fingerprint !== pendingFingerprint) {
          sendControl({ type: 'error', error: '主機指紋確認資料不符' });
          closeSocket(1008, 'invalid trust confirmation');
          return;
        }
        const confirmedFingerprint = pendingFingerprint;
        pendingFingerprint = undefined;
        startShell(confirmedFingerprint);
        return;
      }
      if (message.type === 'trust-reject') {
        sendControl({ type: 'error', code: 'HOST_TRUST_REJECTED', error: '已拒絕主機指紋' });
        closeSocket(1008, 'host key rejected');
        return;
      }
      if (message.type === 'close') closeSocket(1000, 'client closed');
    });

    webSocket.on('close', () => {
      if (closing) return;
      closing = true;
      session?.close();
    });
    webSocket.on('error', () => {
      if (closing) return;
      closing = true;
      session?.close();
    });
    startShell();
  });

  server.on('close', () => {
    unlockedKeys.clear();
    for (const webSocket of webSocketServer.clients) webSocket.terminate();
    webSocketServer.close();
  });
  const closeHttpServer = server.close.bind(server);
  server.close = (callback) => {
    for (const webSocket of webSocketServer.clients) webSocket.terminate();
    return closeHttpServer(callback);
  };
  return server;
}

function openBrowser(url, platform = process.platform, spawnProcess = spawn) {
  const command = platform === 'win32' ? 'cmd' : platform === 'darwin' ? 'open' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnProcess(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    } catch (error) {
      reject(error);
      return;
    }
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`瀏覽器啟動程序結束，代碼 ${code}`)));
    child.unref();
  });
}

async function startUi({ port = 8787, dataFile = dataFileFor(), openBrowser: browserOpener = openBrowser, log = console.log } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('port 必須是 0 到 65535 的整數');
  const server = createServer({ dataFile, port });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  server.url = url;
  log(`sshdeck UI：${url}`);
  try {
    await browserOpener(url);
  } catch {
    log(`無法自動開啟瀏覽器，請手動開啟：${url}`);
  }
  return server;
}

function parseExecArgs(args) {
  const separator = args.indexOf('--');
  if (separator !== 2 || !args[1]) throw new Error('用法：sshdeck exec <別名> -- <遠端命令>');
  const command = args.slice(separator + 1).join(' ');
  if (!command.trim()) throw new Error('遠端命令不可空白');
  return { alias: args[1], command };
}

async function execCommand(dataFile, args) {
  const { alias, command } = parseExecArgs(args);
  const host = readHosts(dataFile).find((item) => item.alias === alias);
  if (!host) throw new Error(`找不到主機：${alias}`);
  const passphrase = await readSecret('登入金鑰密語（輸入隱藏；未加密請按 Enter）：');
  const controller = new AbortController(); const interrupt = () => controller.abort(); process.once('SIGINT', interrupt);
  console.log(`目標：${host.alias}（${host.username}@${host.hostname}:${host.port}）`);
  try {
    const options = { signal: controller.signal, onStdout: (chunk) => process.stdout.write(chunk), onStderr: (chunk) => process.stderr.write(chunk) };
    let code;
    try { code = await ssh.exec(dataFile, host, passphrase, command, options); }
    catch (error) {
      if (!['HOST_TRUST_REQUIRED', 'HOST_KEY_CHANGED'].includes(error.code)) throw error;
      const prompt = require('node:readline/promises').createInterface({ input: process.stdin, output: process.stderr }); let answer;
      try { answer = await prompt.question(`主機指紋 ${error.fingerprint}。請先由可信管道核對，確認信任？[y/N] `); } finally { prompt.close(); }
      if (!/^y(es)?$/i.test(answer.trim())) throw new Error('已拒絕主機指紋；未執行命令');
      code = await ssh.exec(dataFile, host, passphrase, command, { ...options, expectedFingerprint: error.fingerprint });
    }
    console.log(`\n結束狀態：${code}`); if (code !== 0) process.exitCode = code;
  } finally { process.removeListener('SIGINT', interrupt); }
}

function parseShellArgs(args) {
  if (args.length !== 2 || args[0] !== 'shell' || !args[1]) throw new Error('用法：sshdeck shell <別名>');
  return { alias: args[1] };
}

async function connectInteractiveShell(dataFile, host, passphrase, options = {}) {
  let expectedFingerprint;
  for (;;) {
    try {
      return await ssh.openShell(dataFile, host, passphrase, {
        cols: options.cols || process.stdout.columns || 80,
        rows: options.rows || process.stdout.rows || 24,
        ...(expectedFingerprint ? { expectedFingerprint } : {}),
        onData: options.onData,
        onClose: options.onClose,
      });
    } catch (error) {
      if (!['HOST_TRUST_REQUIRED', 'HOST_KEY_CHANGED'].includes(error.code) || options.confirmTrust === false) throw error;
      if (options.confirmTrust) {
        if (!await options.confirmTrust(error)) throw new Error('已拒絕主機指紋；未開啟終端機');
      } else {
        const prompt = require('node:readline/promises').createInterface({ input: process.stdin, output: process.stderr });
        let answer;
        try {
          const previous = error.previousFingerprint ? `（原信任指紋 ${error.previousFingerprint}）` : '';
          answer = await prompt.question(`主機指紋 ${error.fingerprint}${previous}。請先由可信管道核對，確認信任？[y/N] `);
        } finally { prompt.close(); }
        if (!/^y(es)?$/i.test(answer.trim())) throw new Error('已拒絕主機指紋；未開啟終端機');
      }
      expectedFingerprint = error.fingerprint;
    }
  }
}

function attachLocalTerminal(session, {
  input = process.stdin,
  output = process.stdout,
  signalSource = process,
  onInterrupt = () => session.close(),
} = {}) {
  const previousRawMode = input.isRaw;
  const canSetRawMode = Boolean(input.isTTY && typeof input.setRawMode === 'function');
  if (canSetRawMode) input.setRawMode(true);
  const forwardInput = (data) => session.write(data);
  const resize = () => session.resize(output.columns || 80, output.rows || 24);
  input.on('data', forwardInput);
  input.resume();
  output.on('resize', resize);
  signalSource.once('SIGINT', onInterrupt);

  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    input.off('data', forwardInput);
    output.off('resize', resize);
    signalSource.removeListener('SIGINT', onInterrupt);
    if (canSetRawMode) {
      try { input.setRawMode(Boolean(previousRawMode)); } catch { /* stdin may already be closed */ }
    }
    input.pause();
  };
}

async function shellCommand(dataFile, args) {
  const { alias } = parseShellArgs(args);
  const host = readHosts(dataFile).find((item) => item.alias === alias);
  if (!host) throw new Error(`找不到主機：${alias}`);
  const passphrase = await readSecret('登入金鑰密語（輸入隱藏；未加密請按 Enter）：');
  let resolveClosed;
  const closed = new Promise((resolve) => { resolveClosed = resolve; });
  let session;
  let restoreTerminal;
  const interrupt = () => {
    process.exitCode = 130;
    session?.close();
  };
  try {
    session = await connectInteractiveShell(dataFile, host, passphrase, {
      cols: process.stdout.columns || 80,
      rows: process.stdout.rows || 24,
      onData: (chunk) => process.stdout.write(chunk),
      onClose: ({ error, code, signal }) => {
        if (error) {
          process.stderr.write(`\r\nSSH 終端機錯誤：${error.message}\r\n`);
          process.exitCode = 1;
        } else if (signal) {
          process.stderr.write(`\r\n遠端 shell 由 ${signal} 結束。\r\n`);
          process.exitCode = 1;
        }
        else if (code !== undefined && code !== 0) process.exitCode = code;
        resolveClosed();
      },
    });
    process.stderr.write(`已連線至 ${host.alias}（${host.username}@${host.hostname}:${host.port}），Ctrl+D 結束終端機。\r\n`);
    restoreTerminal = attachLocalTerminal(session, { onInterrupt: interrupt });
    await closed;
  } finally {
    restoreTerminal?.();
  }
}

async function main(args) {
  if (args[0] === 'ui') {
    let port = 8787;
    for (let index = 1; index < args.length; index += 1) {
      if (args[index] !== '--port' || !args[index + 1]) throw new Error('用法：sshdeck ui [--port <連接埠>]');
      port = Number(args[index + 1]);
      index += 1;
    }
    await startUi({ port });
    return;
  }
  if (args[0] === 'exec') { await execCommand(dataFileFor(), args); return; }
  if (args[0] === 'shell') { await shellCommand(dataFileFor(), args); return; }
  if (args[0] === 'key') { await keyCommand(dataFileFor(), args); return; }
  if (args[0] === 'guide') {
    const dataFile = dataFileFor();
    const selector = args[1];
    if (!selector) throw new Error('請提供主機別名或金鑰 ID');
    const host = readHosts(dataFile).find((item) => item.alias === selector);
    const record = host?.keyPath ? ssh.managedKeyForPath(dataFile, host.keyPath) : ssh.resolveManagedKey(dataFile, selector);
    const keyPath = host?.keyPath || record?.keyPath;
    if (!keyPath) throw new Error(`找不到關聯金鑰：${selector}`);
    console.log(ssh.installationGuide(host || record, ssh.managedPublicKey(keyPath)));
    return;
  }
  if (args[0] !== 'host') throw new Error('用法：sshdeck exec <別名> -- <命令> | sshdeck shell <別名> | sshdeck host ... | sshdeck key ... | sshdeck guide <別名> | sshdeck ui');
  await hostCommand(dataFileFor(), args);
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`sshdeck：${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { attachLocalTerminal, connectInteractiveShell, dataFileFor, hostList, openBrowser, parseExecArgs, parseShellArgs, readSecret, shellCommand, startUi };
