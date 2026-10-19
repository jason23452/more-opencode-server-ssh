'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { Client, utils } = require('ssh2');
const { spawnSync } = require('node:child_process');

function managedDirectory(dataFile) { return path.join(path.dirname(dataFile), 'keys'); }

function isManagedKeyPath(dataFile, target) {
  if (typeof target !== 'string') return false;
  const directory = path.resolve(managedDirectory(dataFile));
  const resolved = path.resolve(target);
  return path.dirname(resolved) === directory && /^[0-9a-f-]+$/i.test(path.basename(resolved));
}

function protectPrivateKey(file) {
  if (process.platform === 'win32') {
    const account = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : process.env.USERNAME;
    if (!account) throw new Error('找不到目前 Windows 使用者，無法設定私鑰 ACL');
    const result = spawnSync('icacls', [file, '/inheritance:r', '/grant:r', `${account}:(F)`], { encoding: 'utf8', windowsHide: true });
    if (result.error || result.status !== 0) throw new Error(`無法設定私鑰 ACL：${result.stderr || result.error?.message || result.status}`);
  } else fs.chmodSync(file, 0o600);
}

function managedKeysFile(dataFile) { return `${dataFile}.keys.json`; }

function listManagedKeys(dataFile) {
  return Object.values(readMap(managedKeysFile(dataFile)));
}

function resolveManagedKey(dataFile, selector) {
  const records = listManagedKeys(dataFile);
  const byId = records.find((record) => record.id === selector);
  if (byId) return byId;
  const matches = records.filter((record) => record.alias === selector);
  if (matches.length > 1) throw new Error(`別名 ${selector} 有多把已管理金鑰；請先執行 sshdeck key list，再以金鑰 ID 指定`);
  if (!matches.length) throw new Error(`找不到 sshdeck 管理的金鑰：${selector}`);
  return matches[0];
}

function managedKeyForPath(dataFile, target) {
  return listManagedKeys(dataFile).find((record) => path.resolve(record.keyPath) === path.resolve(target));
}

function updateManagedKeyProfile(dataFile, host) {
  if (!isManagedKeyPath(dataFile, host.keyPath)) return;
  const id = path.basename(path.resolve(host.keyPath));
  updateMap(managedKeysFile(dataFile), (records) => {
    const record = records[id];
    if (record) Object.assign(record, { alias: host.alias, hostname: host.hostname, port: host.port, username: host.username });
  });
}

function createManagedKey(dataFile, alias, passphrase, profile = {}) {
  if (typeof alias !== 'string' || !/^[\p{L}\p{N}_.-]+$/u.test(alias) || alias === '.' || alias === '..') throw new Error('金鑰別名只能包含文字、數字、底線、句點及連字號');
  if (typeof passphrase !== 'string' || !passphrase.trim()) throw new Error('新金鑰必須設定非空密語');
  const directory = managedDirectory(dataFile);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(directory, 0o700);
  const keyPath = path.join(directory, randomUUID());
  const publicPath = `${keyPath}.pub`;
  let madePrivate = false; let madePublic = false;
  let managedId;
  try {
    const pair = utils.generateKeyPairSync('ed25519', { passphrase, cipher: 'aes256-cbc', comment: `sshdeck:${alias}` });
    const fd = fs.openSync(keyPath, 'wx', 0o600); madePrivate = true;
    try { fs.writeFileSync(fd, pair.private); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    protectPrivateKey(keyPath);
    const pubfd = fs.openSync(publicPath, 'wx', 0o644); madePublic = true;
    try { fs.writeFileSync(pubfd, `${pair.public.trim()}\n`); } finally { fs.closeSync(pubfd); }
    managedId = path.basename(keyPath);
    updateMap(managedKeysFile(dataFile), (records) => {
      records[managedId] = {
        id: managedId,
        alias,
        keyPath,
        hostname: profile.hostname,
        port: profile.port,
        username: profile.username,
        createdAt: new Date().toISOString(),
      };
    });
    return { id: managedId, keyPath, publicKey: pair.public.trim() };
  } catch (error) {
    if (managedId) try { updateMap(managedKeysFile(dataFile), (records) => { delete records[managedId]; }); } catch { /* best effort */ }
    if (madePrivate) try { fs.unlinkSync(keyPath); } catch { /* best effort */ }
    if (madePublic) try { fs.unlinkSync(publicPath); } catch { /* best effort */ }
    throw error;
  }
}

function deleteManagedKey(dataFile, target) {
  const resolved = path.resolve(target);
  if (!isManagedKeyPath(dataFile, target)) throw new Error('拒絕刪除非 sshdeck 管理的金鑰路徑');
  const exists = fs.existsSync(resolved);
  if (exists) fs.unlinkSync(resolved);
  try { fs.unlinkSync(`${resolved}.pub`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const id = path.basename(resolved);
  updateMap(managedKeysFile(dataFile), (records) => { delete records[id]; });
  return exists;
}

function managedPublicKey(keyPath) { return fs.readFileSync(`${keyPath}.pub`, 'utf8').trim(); }

function installationGuide(host, publicKey) {
  const q = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
  return `手動安裝 SSH 公鑰（sshdeck 不會自動登入或修改遠端權限）

登入帳號：${host.username}
透過既有登入管道或主控台，以管理員確認帳號是否存在；只有不存在時才建立：
  if ! getent passwd ${q(host.username)} >/dev/null; then sudo useradd --create-home --shell /bin/bash ${q(host.username)}; fi
  home="$(getent passwd ${q(host.username)} | cut -d: -f6)"
  sudo install -d -m 700 -o ${q(host.username)} -g ${q(host.username)} "$home/.ssh"
  key=${q(publicKey)}
  if ! sudo grep -Fqx -- "$key" "$home/.ssh/authorized_keys" 2>/dev/null; then printf '%s\\n' "$key" | sudo tee -a "$home/.ssh/authorized_keys" >/dev/null; fi
  sudo chown ${q(host.username)}:${q(host.username)} "$home/.ssh/authorized_keys"
  sudo chmod 700 "$home/.ssh" && sudo chmod 600 "$home/.ssh/authorized_keys"

若帳號的主要群組名稱與登入名稱不同，請以 getent passwd / getent group 查明並調整擁有者。上述操作保留 authorized_keys 中其他公鑰；設定後請重新登入測試。

遠端撤銷（另行手動）：確認要撤銷的主機與帳號後，只移除完全相同的公鑰行，保留其他 keys：
  home="$(getent passwd ${q(host.username)} | cut -d: -f6)"
  file="$home/.ssh/authorized_keys"
  key=${q(publicKey)}
  tmp="$(mktemp)"
  sudo awk -v key="$key" '$0 != key' "$file" > "$tmp"
  sudo install -o ${q(host.username)} -g ${q(host.username)} -m 600 "$tmp" "$file"
  rm -f "$tmp"

撤銷授權不會刪除本機私鑰；刪除本機私鑰也不會自動撤銷此遠端公鑰。
`;
}

function fingerprint(key) {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

function stores(dataFile) {
  return { trust: `${dataFile}.trust.json`, status: `${dataFile}.checks.json` };
}

function readMap(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('主機檢查資料格式錯誤');
    return Object.assign(Object.create(null), value);
  } catch (error) {
    if (error.code === 'ENOENT') return Object.create(null);
    throw error;
  }
}

function pidIsRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function lockFile(lockPath) {
  const wait = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + 5000;
  const token = `${process.pid}:${randomUUID()}`;
  while (Date.now() < deadline) {
    try {
      const descriptor = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, token }));
      return () => {
        fs.closeSync(descriptor);
        try {
          if (JSON.parse(fs.readFileSync(lockPath, 'utf8')).token === token) fs.unlinkSync(lockPath);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      };
    } catch (error) {
      if (error.code !== 'EEXIST' && !(error.code === 'EPERM' && fs.existsSync(lockPath))) throw error;
    }
    try {
      const current = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      if (Date.now() - fs.statSync(lockPath).mtimeMs > 30_000 && !pidIsRunning(current.pid)) fs.unlinkSync(lockPath);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      if (error instanceof SyntaxError) {
        try {
          if (Date.now() - fs.statSync(lockPath).mtimeMs > 30_000) fs.unlinkSync(lockPath);
        } catch (statError) {
          if (statError.code !== 'ENOENT') throw statError;
        }
      } else if (error.code !== 'ENOENT') {
        throw error;
      }
    }
    Atomics.wait(wait, 0, 0, 10);
  }
  throw new Error('等待主機檢查資料鎖定逾時');
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function updateMap(file, update) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const release = lockFile(`${file}.lock`);
  try {
    const value = readMap(file);
    update(value);
    writeJsonAtomic(file, value);
    return value;
  } finally {
    release();
  }
}

function keyPathFor(host) {
  if (!host.keyPath) {
    const error = new Error('請先設定既有登入金鑰路徑');
    error.code = 'KEY_PATH_REQUIRED';
    throw error;
  }
  return host.keyPath.replace(/^~(?=$|[\\/])/, os.homedir());
}

function parsePrivateKey(privateKey, passphrase) {
  const parsed = utils.parseKey(privateKey, passphrase);
  if (parsed instanceof Error) {
    const encrypted = /passphrase|bad passphrase|integrity check|decrypt|encrypted/i.test(parsed.message);
    const error = new Error(encrypted
      ? '登入金鑰密語錯誤或無法解鎖此金鑰'
      : `登入金鑰格式不支援：${parsed.message}`);
    error.code = encrypted ? 'INVALID_KEY_PASSPHRASE' : 'INVALID_PRIVATE_KEY';
    throw error;
  }
  return parsed;
}

function readPrivateKey(host) {
  const keyPath = keyPathFor(host);
  let privateKey;
  try { privateKey = fs.readFileSync(keyPath); } catch (error) {
    const reason = error.code === 'ENOENT' ? '檔案不存在' : error.code === 'EACCES' ? '沒有讀取權限' : error.message;
    const failure = new Error(`無法讀取登入金鑰：${reason}`);
    failure.code = error.code === 'ENOENT' ? 'KEY_FILE_NOT_FOUND' : 'KEY_FILE_UNREADABLE';
    throw failure;
  }
  return { keyPath, privateKey };
}

function validateKey(host, passphrase) {
  const { keyPath, privateKey } = readPrivateKey(host);
  parsePrivateKey(privateKey, passphrase);
  return keyPath;
}

function endpoint(host) {
  return `${host.hostname.toLowerCase()}:${host.port}`;
}

function statusFor(error, currentFingerprint) {
  if (error.code === 'HOST_TRUST_REQUIRED') return { state: 'untrusted', fingerprint: currentFingerprint };
  if (error.code === 'HOST_KEY_CHANGED') return { state: 'changed', fingerprint: currentFingerprint, error: error.message };
  return { state: 'failure', error: error.message };
}

function recordStatus(dataFile, host, status) {
  const file = stores(dataFile).status;
  updateMap(file, (statuses) => {
    statuses[host.alias] = { checkedAt: new Date().toISOString(), ...status };
  });
}

function getStatuses(dataFile) {
  return readMap(stores(dataFile).status);
}

function trust(dataFile, host, hostFingerprint) {
  updateMap(stores(dataFile).trust, (trusted) => {
    trusted[endpoint(host)] = hostFingerprint;
  });
}

function check(dataFile, host, passphrase, { expectedFingerprint } = {}) {
  let privateKey;
  let knownFingerprint;
  try {
    ({ privateKey } = readPrivateKey(host));
    parsePrivateKey(privateKey, passphrase);
    knownFingerprint = readMap(stores(dataFile).trust)[endpoint(host)];
  } catch (error) {
    try { recordStatus(dataFile, host, { state: 'failure', error: error.message }); } catch { /* 保留原始認證錯誤 */ }
    return Promise.reject(error);
  }
  let currentFingerprint;

  return new Promise((resolve, reject) => {
    const client = new Client();
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      client.end();
      try {
        if (error) recordStatus(dataFile, host, statusFor(error, currentFingerprint));
        else recordStatus(dataFile, host, { state: 'success' });
      } catch (storageError) {
        if (!error) error = new Error(`無法保存主機信任／檢查狀態：${storageError.message}`);
      }
      if (error) reject(error);
      else resolve(result);
    };

    client.on('error', (cause) => {
      const authenticationFailure = /auth|configured authentication/i.test(cause.message);
      const error = new Error(authenticationFailure ? 'SSH 登入認證失敗；請確認登入帳號及金鑰授權' : `SSH 連線失敗：${cause.message}`);
      error.code = authenticationFailure ? 'AUTHENTICATION_FAILED' : 'SSH_CONNECTION_FAILED';
      finish(error);
    });
    client.on('ready', () => finish(null, { ok: true, fingerprint: currentFingerprint }));

    client.connect({
      host: host.hostname,
      port: host.port,
      username: host.username,
      privateKey,
      ...(passphrase ? { passphrase } : {}),
      readyTimeout: 10_000,
      hostVerifier: (key) => {
        currentFingerprint = fingerprint(key);
        if (expectedFingerprint) {
          if (currentFingerprint === expectedFingerprint) {
            if (expectedFingerprint !== knownFingerprint) {
              try { trust(dataFile, host, currentFingerprint); } catch (storageError) {
                const error = new Error(`無法保存主機指紋信任：${storageError.message}`);
                error.code = 'TRUST_STORAGE_FAILED';
                finish(error);
                return false;
              }
            }
            return true;
          }
          const error = new Error(`主機指紋在確認後再次改變：${currentFingerprint}`);
          error.code = 'HOST_KEY_CHANGED';
          error.fingerprint = currentFingerprint;
          finish(error);
          return false;
        }
        if (!knownFingerprint) {
          const error = new Error(`首次連線需確認主機指紋：${currentFingerprint}`);
          error.code = 'HOST_TRUST_REQUIRED';
          error.fingerprint = currentFingerprint;
          finish(error);
          return false;
        }
        if (knownFingerprint !== currentFingerprint) {
          const error = new Error(`主機指紋已改變：原信任 ${knownFingerprint}，目前為 ${currentFingerprint}；需重新確認`);
          error.code = 'HOST_KEY_CHANGED';
          error.fingerprint = currentFingerprint;
          error.previousFingerprint = knownFingerprint;
          finish(error);
          return false;
        }
        return true;
      },
    });
  });
}

function exec(dataFile, host, passphrase, command, { signal, onStdout = () => {}, onStderr = () => {}, expectedFingerprint } = {}) {
  if (typeof command !== 'string' || !command.trim()) return Promise.reject(new Error('遠端命令不可空白'));
  const { privateKey } = readPrivateKey(host);
  try { parsePrivateKey(privateKey, passphrase); } catch (error) { return Promise.reject(error); }
  const known = readMap(stores(dataFile).trust)[endpoint(host)];
  return new Promise((resolve, reject) => {
    const client = new Client();
    let channel; let settled = false; let currentFingerprint;
    const finish = (error, code) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      if (channel) channel.close();
      client.end();
      if (error) reject(error); else resolve(code);
    };
    const abort = () => { const error = new Error('遠端命令已取消'); error.code = 'ABORT_ERR'; finish(error); };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) return abort();
    client.on('error', (cause) => { const error = new Error(`SSH 連線／命令失敗：${cause.message}`); error.code = /auth|configured authentication/i.test(cause.message) ? 'AUTHENTICATION_FAILED' : 'SSH_CONNECTION_FAILED'; finish(error); });
    client.on('ready', () => client.exec(command, (error, stream) => {
      if (error) return finish(error);
      channel = stream;
      stream.on('data', onStdout);
      stream.stderr.on('data', onStderr);
      stream.on('close', (code, signalName) => signalName ? finish(new Error(`遠端命令因 ${signalName} 結束`)) : finish(null, code ?? 1));
    }));
    client.connect({ host: host.hostname, port: host.port, username: host.username, privateKey, ...(passphrase ? { passphrase } : {}), readyTimeout: 10000,
      hostVerifier: (key) => {
        currentFingerprint = fingerprint(key);
        if (expectedFingerprint && currentFingerprint === expectedFingerprint) { if (known !== expectedFingerprint) trust(dataFile, host, currentFingerprint); return true; }
        if (known === currentFingerprint) return true;
        const error = new Error(known ? `主機指紋已改變：原信任 ${known}，目前為 ${currentFingerprint}` : `首次連線需確認主機指紋：${currentFingerprint}`);
        error.code = known ? 'HOST_KEY_CHANGED' : 'HOST_TRUST_REQUIRED'; error.fingerprint = currentFingerprint; error.previousFingerprint = known; finish(error); return false;
      },
    });
  });
}

module.exports = { check, exec, createManagedKey, deleteManagedKey, endpoint, fingerprint, getStatuses, installationGuide, isManagedKeyPath, keyPathFor, listManagedKeys, managedDirectory, managedKeyForPath, managedKeysFile, managedPublicKey, parsePrivateKey, resolveManagedKey, stores, trust, updateManagedKeyProfile, validateKey };
