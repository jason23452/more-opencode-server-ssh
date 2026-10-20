const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const os = require('node:os');
const path = require('node:path');

const cli = path.join(__dirname, '..', 'bin', 'sshdeck.js');
const { dataFileFor, openBrowser } = require('../bin/sshdeck.js');
function run(home, ...args) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    env: { ...process.env, SSHDECK_HOME: home },
  });
}

function waitForChild(child) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('CLI host CRUD persists separately and validates errors', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sshdeck-'));
  try {
    const add = run(home, 'host', 'add', 'web', '--hostname', 'example.org', '--port', '2222', '--user', 'alice', '--key', '~/.ssh/id_ed25519');
    assert.equal(add.status, 0, add.stderr);
    assert.equal(run(home, 'host', 'add', 'db', '--hostname', 'db.example.org', '--user', 'bob').status, 0);
    assert.match(run(home, 'host', 'list').stdout, /web.*example\.org/s);
    assert.match(run(home, 'host', 'list').stdout, /db.*db\.example\.org/s);
    assert.match(run(home, 'host', 'list').stdout, /未檢查/);
    assert.notEqual(run(home, 'host', 'add', 'web', '--hostname', 'duplicate').status, 0);
    assert.equal(run(home, 'host', 'update', 'web', '--user', 'carol').status, 0);
    assert.match(run(home, 'host', 'list').stdout, /carol/);
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(path.join(home, 'hosts.json')).mode & 0o777, 0o600);
    }
    assert.equal(run(home, 'host', 'delete', 'db').status, 0);
    assert.doesNotMatch(run(home, 'host', 'list').stdout, /db\.example/);
    assert.notEqual(run(home, 'host', 'delete', 'missing').status, 0);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('recovers a stale host-data lock', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sshdeck-'));
  try {
    const lockFile = path.join(home, 'hosts.json.lock');
    fs.writeFileSync(lockFile, JSON.stringify({ pid: 2_147_483_647, token: 'abandoned' }));
    const stale = new Date(Date.now() - 60_000);
    fs.utimesSync(lockFile, stale, stale);
    const result = run(home, 'host', 'add', 'recovered', '--hostname', 'recovered.example.test', '--user', 'test');
    assert.equal(result.status, 0, result.stderr);
    assert.match(run(home, 'host', 'list').stdout, /recovered/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('uses platform app data locations and supports an explicit override', () => {
  assert.equal(
    dataFileFor({ platform: 'win32', env: { APPDATA: 'C:\\Users\\tester\\AppData\\Roaming' }, home: 'C:\\Users\\tester' }),
    path.win32.join('C:\\Users\\tester\\AppData\\Roaming', 'sshdeck', 'hosts.json'),
  );
  assert.equal(
    dataFileFor({ platform: 'linux', env: { XDG_DATA_HOME: '/tmp/sshdeck-data' }, home: '/home/tester' }),
    '/tmp/sshdeck-data/sshdeck/hosts.json',
  );
  assert.equal(
    dataFileFor({ platform: 'linux', env: { SSHDECK_HOME: '/tmp/sshdeck-override' }, home: '/home/tester' }),
    '/tmp/sshdeck-override/hosts.json',
  );
});

test('Windows browser opener uses a safely separated start command', async () => {
  const child = new EventEmitter();
  child.unref = () => {};
  let invocation;
  const opening = openBrowser('http://127.0.0.1:4567', 'win32', (command, args, options) => {
    invocation = { command, args, options };
    queueMicrotask(() => child.emit('close', 0));
    return child;
  });
  await opening;
  assert.equal(invocation.command, 'cmd');
  assert.deepEqual(invocation.args, ['/c', 'start', '', 'http://127.0.0.1:4567']);
  assert.equal(invocation.options.detached, true);
});

test('parallel CLI writes retain every distinct host profile', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sshdeck-'));
  try {
    const children = Array.from({ length: 8 }, (_, index) => {
      const name = `host-${index}`;
      const child = spawn(process.execPath, [cli, 'host', 'add', name, '--hostname', `${name}.example.test`, '--user', `user-${index}`], {
        env: { ...process.env, SSHDECK_HOME: home },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return waitForChild(child);
    });
    const results = await Promise.all(children);
    assert.deepEqual(results.map(({ code }) => code), Array(8).fill(0), results.map(({ stderr }) => stderr).join('\n'));
    const hosts = JSON.parse(fs.readFileSync(path.join(home, 'hosts.json'), 'utf8'));
    assert.deepEqual(new Set(hosts.map(({ alias }) => alias)), new Set(Array.from({ length: 8 }, (_, index) => `host-${index}`)));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('UI shares CRUD with CLI, edits every connection field, and rejects untrusted origins', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sshdeck-'));
  const { startUi } = require('../bin/sshdeck.js');
  const server = await startUi({
    port: 0,
    dataFile: path.join(home, 'hosts.json'),
    openBrowser: async () => {},
    log: () => {},
  });
  const address = server.url;
  try {
    assert.match(await (await fetch(address)).text(), /主機設定管理/);
    assert.equal(server.address().address, '127.0.0.1');
    let response = await fetch(`${address}/api/hosts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ alias: 'uihost', hostname: 'host.local', username: 'sam', port: 22, keyPath: '~/.ssh/key' }),
    });
    assert.equal(response.status, 201);
    assert.match(run(home, 'host', 'list').stdout, /uihost/);

    response = await fetch(`${address}/api/hosts/uihost`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hostname: 'new-host.local', port: 2200, username: 'updated', keyPath: '~/.ssh/new-key' }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { alias: 'uihost', hostname: 'new-host.local', port: 2200, username: 'updated', keyPath: '~/.ssh/new-key' });
    assert.match(run(home, 'host', 'list').stdout, /new-host\.local:2200\tupdated/);

    response = await fetch(`${address}/api/hosts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://attacker.invalid' },
      body: JSON.stringify({ alias: 'bad', hostname: 'bad.local', username: 'bad' }),
    });
    assert.equal(response.status, 403);

    const target = new URL(`${address}/api/hosts`);
    response = await new Promise((resolve, reject) => {
      const request = http.request(target, { headers: { host: 'attacker.invalid' } }, resolve);
      request.once('error', reject);
      request.end();
    });
    assert.equal(response.statusCode, 403);

    response = await fetch(address);
    assert.equal(response.headers.get('access-control-allow-origin'), null);

    assert.equal((await fetch(`${address}/api/hosts/uihost`, { method: 'DELETE' })).status, 204);
    assert.match(address, /^http:\/\/127\.0\.0\.1:/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('UI attempts to open a browser and prints a manual URL when the opener fails', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sshdeck-'));
  const { startUi } = require('../bin/sshdeck.js');
  const messages = [];
  let openedUrl;
  const server = await startUi({
    port: 0,
    dataFile: path.join(home, 'hosts.json'),
    openBrowser: async (url) => {
      openedUrl = url;
      throw new Error('browser unavailable');
    },
    log: (message) => messages.push(message),
  });
  try {
    assert.equal(openedUrl, server.url);
    assert(messages.some((message) => message.includes('請手動開啟') && message.includes(server.url)));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
  }
});
