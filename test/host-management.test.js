const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cli = path.join(__dirname, '..', 'bin', 'sshdeck.js');
function run(home, ...args) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home } });
}

test('CLI host CRUD persists separately and validates errors', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sshdeck-'));
  const add = run(home, 'host', 'add', 'web', '--hostname', 'example.org', '--port', '2222', '--user', 'alice', '--key', '~/.ssh/id_ed25519');
  assert.equal(add.status, 0, add.stderr);
  assert.equal(run(home, 'host', 'add', 'db', '--hostname', 'db.example.org', '--user', 'bob').status, 0);
  assert.match(run(home, 'host', 'list').stdout, /web.*example\.org/s);
  assert.match(run(home, 'host', 'list').stdout, /db.*db\.example\.org/s);
  assert.notEqual(run(home, 'host', 'add', 'web', '--hostname', 'duplicate').status, 0);
  assert.equal(run(home, 'host', 'update', 'web', '--user', 'carol').status, 0);
  assert.match(run(home, 'host', 'list').stdout, /carol/);
  assert.equal(run(home, 'host', 'delete', 'db').status, 0);
  assert.doesNotMatch(run(home, 'host', 'list').stdout, /db\.example/);
  assert.notEqual(run(home, 'host', 'delete', 'missing').status, 0);
  fs.rmSync(home, { recursive: true, force: true });
});

test('UI binds loopback and serves CRUD through shared persistence', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sshdeck-'));
  const child = require('node:child_process').spawn(process.execPath, [cli, 'ui', '--port', '0'], { env: { ...process.env, HOME: home, USERPROFILE: home }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const address = await new Promise((resolve, reject) => {
      let text = ''; child.stdout.on('data', chunk => { text += chunk; const m = text.match(/http:\/\/127\.0\.0\.1:\d+/); if (m) resolve(m[0]); });
      child.once('exit', code => reject(new Error(`server exited ${code}`)));
      setTimeout(() => reject(new Error('server did not start')), 3000);
    });
    assert.match(await (await fetch(address)).text(), /Host management/);
    let r = await fetch(`${address}/api/hosts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ alias: 'uihost', hostname: 'host.local', username: 'sam', port: 22, keyPath: '~/.ssh/key' }) });
    assert.equal(r.status, 201);
    assert.match(run(home, 'host', 'list').stdout, /uihost/);
    r = await fetch(`${address}/api/hosts/uihost`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'updated' }) });
    assert.equal(r.status, 200);
    assert.equal((await fetch(`${address}/api/hosts/uihost`, { method: 'DELETE' })).status, 204);
    assert.match(address, /^http:\/\/127\.0\.0\.1:/);
  } finally { child.kill(); fs.rmSync(home, { recursive: true, force: true }); }
});
