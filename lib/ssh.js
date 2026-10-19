'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { Client, utils } = require('ssh2');
const { spawnSync } = require('node:child_process');

function managedDirectory(dataFile) { return path.join(path.dirname(dataFile), 'keys'); }

function protectPrivateKey(file) {
  if (process.platform === 'win32') {
    const result = spawnSync('icacls', [file, '/inheritance:r', '/grant:r', `${process.env.USERNAME}:(F)`], { encoding: 'utf8', windowsHide: true });
    if (result.error || result.status !== 0) throw new Error(`無法設定私鑰 ACL：${result.stderr || result.error?.message || result.status}`);
  } else fs.chmodSync(file, 0o600);
}

function createManagedKey(dataFile, alias, passphrase) {
  if (typeof alias !== 'string' || !/^[\p{L}\p{N}_.-]+$/u.test(alias) || alias === '.' || alias === '..') throw new Error('金鑰別名只能包含文字、數字、底線、句點及連字號');
  if (typeof passphrase !== 'string' || !passphrase.trim()) throw new Error('新金鑰必須設定非空密語');
  const directory = managedDirectory(dataFile);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(directory, 0o700);
  const keyPath = path.join(directory, randomUUID());
  const publicPath = `${keyPath}.pub`;
  let madePrivate = false; let madePublic = false;
  try {
    const pair = utils.generateKeyPairSync('ed25519', { passphrase, cipher: 'aes256-cbc', comment: `sshdeck:${alias}` });
    const fd = fs.openSync(keyPath, 'wx', 0o600); madePrivate = true;
    try { fs.writeFileSync(fd, pair.private); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    protectPrivateKey(keyPath);
    const pubfd = fs.openSync(publicPath, 'wx', 0o644); madePublic = true;
    try { fs.writeFileSync(pubfd, `${pair.public.trim()}\n`); } finally { fs.closeSync(pubfd); }
    return { keyPath, publicKey: pair.public.trim() };
  } catch (error) {
    if (madePrivate) try { fs.unlinkSync(keyPath); } catch { /* best effort */ }
    if (madePublic) try { fs.unlinkSync(publicPath); } catch { /* best effort */ }
    throw error;
  }
}

function deleteManagedKey(dataFile, target) {
  const directory = path.resolve(managedDirectory(dataFile));
  const resolved = path.resolve(target);
  if (path.dirname(resolved) !== directory || !/^[0-9a-f-]+$/i.test(path.basename(resolved))) throw new Error('拒絕刪除非 sshdeck 管理的金鑰路徑');
  if (!fs.existsSync(resolved)) return false;
  fs.unlinkSync(resolved);
  try { fs.unlinkSync(`${resolved}.pub`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return true;
}

function managedPublicKey(keyPath) { return fs.readFileSync(`${keyPath}.pub`, 'utf8').trim(); }

function installationGuide(host, publicKey) {
  const q = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
  return `手動安裝 SSH 公鑰（sshdeck 不會自動登入或修改遠端權限）\n\n登入帳號：${host.username}\n透過既有登入管道或主控台，以管理員確認／建立帳號：\n  sudo useradd --create-home --shell /bin/bash ${q(host.username)}\n\n確認帳號 home：getent passwd ${q(host.username)}。以下須由管理員在確認實際 home 後執行，逐行 append 並保留 authorized_keys 既有內容；將 <HOME> 換成該帳號 home 的絕對路徑：\n  install -d -m 700 -o ${q(host.username)} -g ${q(host.username)} <HOME>/.ssh\n  printf '%s\\n' ${q(publicKey)} | sudo -u ${q(host.username)} tee -a <HOME>/.ssh/authorized_keys >/dev/null\n  chown ${q(host.username)}:${q(host.username)} <HOME>/.ssh/authorized_keys\n  chmod 600 <HOME>/.ssh/authorized_keys\n\n群組名稱若與帳號不同，請以 getent passwd / getent group 查明並調整；.ssh 與 authorized_keys 必須由目標帳號擁有，權限分別 700/600。\n\n遠端撤銷（另行手動）：只刪除 authorized_keys 中與下列公鑰完全相同的一行，保留其他 keys：\n${publicKey}\n`;
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
      if (error.code !== 'EEXIST') throw error;
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

module.exports = { check, createManagedKey, deleteManagedKey, endpoint, fingerprint, getStatuses, installationGuide, keyPathFor, managedDirectory, managedPublicKey, parsePrivateKey, stores, trust, validateKey };
