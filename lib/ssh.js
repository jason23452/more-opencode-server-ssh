const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('ssh2');
const { createHash } = require('node:crypto');

function fingerprint(key) { return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`; }
function stores(dataFile) { return { trust: `${dataFile}.trust.json`, status: `${dataFile}.checks.json` }; }
function read(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return {}; throw e; } }
function endpoint(host) { return `${host.hostname.toLowerCase()}:${host.port}`; }
function check(dataFile, host, passphrase, { trustChallenge, expectedFingerprint } = {}) {
  const files = stores(dataFile), trusted = read(files.trust), keyPath = host.keyPath?.replace(/^~(?=$|[\\/])/, require('node:os').homedir());
  if (!keyPath) throw new Error('請先設定登入金鑰路徑');
  let privateKey;
  try { privateKey = fs.readFileSync(keyPath); } catch (e) { throw new Error(`無法讀取登入金鑰：${e.code === 'ENOENT' ? '檔案不存在' : e.message}`); }
  return new Promise((resolve, reject) => {
    const client = new Client(); let settled = false, fp;
    const finish = (error, result) => { if (settled) return; settled = true; client.end(); if (error) reject(error); else resolve(result); };
    client.on('keyboard-interactive', (_name, _instructions, _lang, _prompts, finishAuth) => finishAuth([]));
    client.on('error', e => finish(new Error(/passphrase|decrypt|private key/i.test(e.message) ? `登入金鑰密語錯誤或格式不支援：${e.message}` : `SSH 連線失敗：${e.message}`)));
    client.on('ready', () => finish(null, { ok: true, fingerprint: fp }));
    client.connect({ host: host.hostname, port: host.port, username: host.username, privateKey, ...(passphrase ? { passphrase } : {}), readyTimeout: 10000,
      hostVerifier: key => { fp = fingerprint(key); const known = trusted[endpoint(host)];
        if (expectedFingerprint && fp !== expectedFingerprint) return false;
        if (!known) { if (trustChallenge) return trustChallenge(fp); finish(new Error(`首次主機信任確認：${fp}`)); return false; }
        if (known !== fp) { finish(new Error(`主機指紋衝突：已信任 ${known}，目前為 ${fp}；需明確重新信任`)); return false; }
        return true;
      }});
  }).then(result => { const status = read(files.status); status[host.alias] = { checkedAt: new Date().toISOString(), ok: true }; fs.mkdirSync(path.dirname(dataFile), { recursive: true }); fs.writeFileSync(files.status, JSON.stringify(status)); return result; }, error => {
    const status = read(files.status); status[host.alias] = { checkedAt: new Date().toISOString(), ok: false, error: error.message }; fs.mkdirSync(path.dirname(dataFile), { recursive: true }); fs.writeFileSync(files.status, JSON.stringify(status)); throw error;
  });
}
function trust(dataFile, host, fp) { const file = stores(dataFile).trust, all = read(file); all[endpoint(host)] = fp; fs.mkdirSync(path.dirname(dataFile), { recursive: true }); fs.writeFileSync(file, JSON.stringify(all)); }
module.exports = { check, trust, fingerprint, stores };
