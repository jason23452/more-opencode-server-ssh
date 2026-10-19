#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');

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
      if (error.code !== 'EEXIST') throw error;
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

function hostList(hosts) {
  if (!hosts.length) return '尚未設定主機。';
  return hosts.map((host) => `${host.alias}\t${host.hostname}:${host.port}\t${host.username}\t${host.keyPath || '預設金鑰'}\t未檢查`).join('\n');
}

function hostCommand(dataFile, args) {
  const action = args[1];
  if (action === 'check') {
    const host = readHosts(dataFile).find((item) => item.alias === args[2]);
    if (!host) throw new Error(`找不到主機：${args[2] || ''}`);
    const { check, trust } = require('../lib/ssh');
    const readline = require('node:readline/promises');
    const prompt = readline.createInterface({ input: process.stdin, output: process.stderr });
    return (async () => {
      try {
        let passphrase;
        if (host.keyPath) { passphrase = await prompt.question('登入金鑰密語（未加密請直接按 Enter）：'); }
        let result;
        try { result = await check(dataFile, host, passphrase); }
        catch (error) {
          const challenge = error.message.match(/^首次主機信任確認：(.*)$/);
          if (!challenge) throw error;
          const answer = await prompt.question(`首次連線主機指紋 ${challenge[1]}。信任此主機？[y/N] `);
          if (!/^y(es)?$/i.test(answer.trim())) throw new Error('已拒絕主機指紋；未執行登入');
          trust(dataFile, host, challenge[1]); result = await check(dataFile, host, passphrase);
        }
        console.log(`SSH 登入檢查成功：${host.alias}（${result.fingerprint}）`);
      } finally { prompt.close(); }
    })();
  }
  if (action === 'list') {
    console.log(hostList(readHosts(dataFile)));
    return;
  }
  if (!['add', 'update', 'delete', 'remove'].includes(action)) {
    throw new Error('用法：sshdeck host <add|list|update|delete|check> ...');
  }

  const alias = args[2];
  if (!alias) throw new Error('請提供主機別名');
  const options = parseOptions(args.slice(3));
  mutateHosts(dataFile, (hosts) => {
    const index = hosts.findIndex((host) => host.alias === alias);
    if (action === 'add') {
      if (index >= 0) throw new Error(`主機別名已存在：${alias}`);
      hosts.push(validateHost({ alias, ...options }));
    } else {
      if (index < 0) throw new Error(`找不到主機：${alias}`);
      if (action === 'delete' || action === 'remove') hosts.splice(index, 1);
      else hosts[index] = validateHost({ ...hosts[index], ...options });
    }
  });
  const description = action === 'add' ? '新增' : action === 'update' ? '更新' : '刪除';
  console.log(`已${description}主機設定：${alias}`);
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

const page = `<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>sshdeck 主機設定</title><h1>主機設定管理</h1><form id="form"><label>別名 <input name="alias" required></label><label>主機名稱 <input name="hostname" required></label><label>連接埠 <input name="port" type="number" value="22" min="1" max="65535" required></label><label>登入帳號 <input name="username" required></label><label>金鑰路徑 <input name="keyPath"></label><button>新增主機</button></form><p id="error" role="alert"></p><ul id="hosts"></ul><script>
const form=document.querySelector('#form'), hosts=document.querySelector('#hosts'), error=document.querySelector('#error');
async function send(url,method,body){const response=await fetch(url,{method,headers:{'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});if(!response.ok){const result=await response.json();throw Error(result.error)}return response.status===204?null:response.json()}
async function refresh(){const list=await send('/api/hosts','GET');hosts.replaceChildren();for(const host of list){const item=document.createElement('li');item.textContent=host.alias+' — '+host.username+'@'+host.hostname+':'+host.port+'（未檢查） ';const edit=document.createElement('button');edit.textContent='編輯';edit.onclick=async()=>{const hostname=prompt('主機名稱',host.hostname);if(hostname===null)return;const port=prompt('連接埠',host.port);if(port===null)return;const username=prompt('登入帳號',host.username);if(username===null)return;const keyPath=prompt('金鑰路徑（留空使用預設）',host.keyPath||'');if(keyPath===null)return;try{await send('/api/hosts/'+encodeURIComponent(host.alias),'PUT',{hostname,port:Number(port),username,keyPath});await refresh()}catch(reason){error.textContent=reason.message}};const remove=document.createElement('button');remove.textContent='刪除';remove.onclick=async()=>{try{await send('/api/hosts/'+encodeURIComponent(host.alias),'DELETE');await refresh()}catch(reason){error.textContent=reason.message}};item.append(edit,remove);hosts.append(item)}}
form.onsubmit=async event=>{event.preventDefault();error.textContent='';const host=Object.fromEntries(new FormData(form));host.port=Number(host.port);try{await send('/api/hosts','POST',host);form.reset();form.elements.port.value=22;await refresh()}catch(reason){error.textContent=reason.message}};refresh().catch(reason=>{error.textContent=reason.message});
</script></html>`;

function createServer({ dataFile, port }) {
  const server = http.createServer((req, res) => {
    const send = (status, value, contentType = 'application/json') => {
      res.writeHead(status, { 'content-type': `${contentType}; charset=utf-8`, 'cache-control': 'no-store' });
      res.end(contentType === 'application/json' ? JSON.stringify(value) : value);
    };
    if (!trustedRequest(req, server.address()?.port || port)) return send(403, { error: '不允許的 Host 或 Origin' });
    if (req.method === 'GET' && req.url === '/') return send(200, page, 'text/html');
    if (req.method === 'GET' && req.url === '/api/hosts') {
      try { return send(200, readHosts(dataFile)); } catch (error) { return send(500, { error: error.message }); }
    }

    const match = req.url.match(/^\/api\/hosts\/([^/?]+)$/);
    const collection = req.url === '/api/hosts';
    if (!(collection && req.method === 'POST') && !(match && ['PUT', 'DELETE'].includes(req.method))) return send(404, { error: '找不到路徑' });
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 32_768) {
        send(413, { error: '要求內容過大' });
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        const alias = match && decodeURIComponent(match[1]);
        if (req.method === 'DELETE') {
          mutateHosts(dataFile, (hosts) => {
            const index = hosts.findIndex((host) => host.alias === alias);
            if (index < 0) throw new Error(`找不到主機：${alias}`);
            hosts.splice(index, 1);
          });
          res.writeHead(204, { 'cache-control': 'no-store' });
          return res.end();
        }
        const input = JSON.parse(body || '{}');
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
        return send(200, updated);
      } catch (error) {
        return send(400, { error: error.message });
      }
    });
  });
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
  if (args[0] !== 'host') throw new Error('用法：sshdeck host <add|list|update|delete> ... | sshdeck ui');
  await hostCommand(dataFileFor(), args);
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`sshdeck：${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { dataFileFor, hostList, openBrowser, startUi };
