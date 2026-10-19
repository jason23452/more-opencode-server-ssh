const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');
const { spawn, spawnSync } = require('node:child_process');
const { Client, utils } = require('ssh2');
const ssh = require('../lib/ssh');
const { check, endpoint, fingerprint, getStatuses, stores } = ssh;
const { readSecret, startUi } = require('../bin/sshdeck');

const integrationHost = process.env.SSHDECK_TEST_SSH_HOST;
const integrationPort = Number(process.env.SSHDECK_TEST_SSH_PORT || 22);
const integrationKeyA = process.env.SSHDECK_TEST_SSH_KEY_A;
const integrationKeyB = process.env.SSHDECK_TEST_SSH_KEY_B;
const integrationKeyAEncrypted = process.env.SSHDECK_TEST_SSH_KEY_A_ENCRYPTED;
const integrationHostFingerprint = process.env.SSHDECK_TEST_SSH_FINGERPRINT;
const integrationEnabled = Boolean(integrationHost && integrationKeyA && integrationKeyB);

function run(home, ...args) {
  return spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'sshdeck.js'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, SSHDECK_HOME: home },
  });
}

function makeHost(alias, username, keyPath, port = integrationPort) {
  return { alias, hostname: integrationHost, port, username, keyPath };
}

function shellQuote(value) { return `'${String(value).replaceAll("'", "'\\''")}'`; }

function runTestSsh(command) {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      client.end();
      if (error) reject(error); else resolve(result);
    };
    client.on('error', finish);
    client.on('ready', () => client.exec(command, (error, stream) => {
      if (error) return finish(error);
      stream.on('data', (chunk) => { stdout += chunk.toString(); });
      stream.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
      stream.on('close', (code) => finish(null, { code, stdout, stderr }));
    }));
    client.connect({
      host: integrationHost,
      port: integrationPort,
      username: 'sshdeck',
      privateKey: fs.readFileSync(integrationKeyA),
      readyTimeout: 10_000,
      hostVerifier: (key) => fingerprint(key) === integrationHostFingerprint,
    });
  });
}

async function runInteractiveKeyCheck(home, alias, passphrase) {
  const cli = path.join(__dirname, '..', 'bin', 'sshdeck.js');
  const child = spawn(process.execPath, [cli, 'host', 'check', alias], {
    env: { ...process.env, SSHDECK_HOME: home },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  const waitFor = (marker) => new Promise((resolve, reject) => {
    if (output.includes(marker)) return resolve();
    const onData = () => { if (output.includes(marker)) { child.stderr.off('data', onData); clearTimeout(timer); resolve(); } };
    const timer = setTimeout(() => { child.stderr.off('data', onData); reject(new Error(`Timed out waiting for ${marker}. Output: ${output}`)); }, 5000);
    child.stderr.on('data', onData);
  });
  await waitFor('登入金鑰密語');
  child.stdin.write(`${passphrase}\n`);
  await waitFor('確認信任此主機？');
  child.stdin.write('y\n');
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  return { code, output };
}

function runWithInput(home, input, ...args) {
  return spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'sshdeck.js'), ...args], {
    encoding: 'utf8',
    input,
    env: { ...process.env, SSHDECK_HOME: home },
  });
}

test('SSH host fingerprints use a stable SHA-256 SSH key digest', () => {
  const key = Buffer.from('ephemeral host public key');
  assert.equal(fingerprint(key), fingerprint(Buffer.from(key)));
  assert.match(fingerprint(key), /^SHA256:[A-Za-z0-9+/]+$/);
});

test('encrypted private key rejects an incorrect passphrase without exposing it', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sshdeck-key-test-'));
  try {
    const pair = utils.generateKeyPairSync('ed25519', { passphrase: 'correct-test-passphrase', cipher: 'aes256-cbc' });
    const keyPath = path.join(directory, 'encrypted-key');
    fs.writeFileSync(keyPath, pair.private, { mode: 0o600 });
    const host = { alias: 'encrypted', hostname: '127.0.0.1', port: 1, username: 'test', keyPath };
    await assert.rejects(check(path.join(directory, 'hosts.json'), host, 'incorrect-test-passphrase'), (error) => {
      assert.equal(error.code, 'INVALID_KEY_PASSPHRASE');
      assert.doesNotMatch(error.message, /incorrect-test-passphrase/);
      return true;
    });
    assert.equal(getStatuses(path.join(directory, 'hosts.json')).encrypted.state, 'failure');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('missing and malformed private key files fail clearly and update check status', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sshdeck-key-error-'));
  try {
    const dataFile = path.join(directory, 'hosts.json');
    const host = { alias: 'missing', hostname: '127.0.0.1', port: 22, username: 'test', keyPath: path.join(directory, 'missing-key') };
    await assert.rejects(check(dataFile, host), (error) => {
      assert.equal(error.code, 'KEY_FILE_NOT_FOUND');
      assert.match(error.message, /檔案不存在/);
      return true;
    });
    assert.equal(getStatuses(dataFile).missing.state, 'failure');

    fs.writeFileSync(host.keyPath, 'not an SSH private key');
    host.alias = 'malformed';
    await assert.rejects(check(dataFile, host), (error) => {
      assert.equal(error.code, 'INVALID_PRIVATE_KEY');
      assert.match(error.message, /格式不支援/);
      return true;
    });
    assert.equal(getStatuses(dataFile).malformed.state, 'failure');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('CLI secret prompt does not echo passphrase input', async () => {
  let output = '';
  const input = Readable.from(['test-secret', '\n']);
  const sink = new Writable({ write(chunk, _encoding, callback) { output += chunk.toString(); callback(); } });
  const value = await readSecret('密語：', input, sink);
  assert.equal(value, 'test-secret');
  assert.match(output, /密語：/);
  assert.doesNotMatch(output, /test-secret/);
});

test('key creation UI uses a password dialog, exposes public guidance, and separates unlink from deletion', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sshdeck-key-ui-'));
  const cli = path.join(__dirname, '..', 'bin', 'sshdeck.js');
  const externalKey = path.join(directory, 'external-private-key');
  fs.writeFileSync(externalKey, 'user-owned private key');
  assert.equal(run(directory, 'host', 'add', 'managed', '--hostname', 'managed.test', '--user', 'alice').status, 0);
  assert.equal(run(directory, 'host', 'add', 'external', '--hostname', 'external.test', '--user', 'bob', '--key', externalKey).status, 0);
  const dataFile = path.join(directory, 'hosts.json');
  const server = await startUi({ port: 0, dataFile, openBrowser: async () => {}, log: () => {} });
  const get = (route) => fetch(`${server.url}${route}`);
  const send = async (route, body) => fetch(`${server.url}${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
  });
  try {
    const page = await (await fetch(server.url)).text();
    assert.match(page, /key-create-dialog/);
    assert.match(page, /managed-keys/);
    assert.match(page, /type="password"/);
    assert.doesNotMatch(page, /prompt\('新 Ed25519 金鑰密語/);

    let response = await send('/api/hosts/managed/key', { passphrase: 'ui-test-passphrase' });
    assert.equal(response.status, 201);
    const made = await response.json();
    assert.match(made.publicKey, /^ssh-ed25519 /);
    assert.match(made.guide, /authorized_keys/);
    assert.doesNotMatch(JSON.stringify(made), /BEGIN OPENSSH PRIVATE KEY/);
    const hosts = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    const managed = hosts.find((host) => host.alias === 'managed');
    assert.equal(ssh.isManagedKeyPath(dataFile, managed.keyPath), true);
    const listed = await (await get('/api/hosts')).json();
    assert.equal(listed.find((host) => host.alias === 'managed').keyManaged, true);
    assert.equal(ssh.validateKey(managed, 'ui-test-passphrase'), managed.keyPath);
    assert.doesNotMatch(fs.readFileSync(dataFile, 'utf8'), /ui-test-passphrase/);

    response = await send('/api/hosts/managed/key');
    assert.equal(response.status, 409, 'a configured managed key must not be silently replaced');
    response = await get('/api/hosts/managed/guide');
    assert.equal(response.status, 200);
    assert.match((await response.json()).guide, /authorized_keys/);
    response = await get('/api/hosts/managed/key/public');
    assert.equal(response.status, 200);
    assert.match((await response.json()).publicKey, /^ssh-ed25519 /);

    response = await send('/api/hosts/external/key/delete');
    assert.equal(response.status, 409, 'the tool must not delete a user-owned private key');
    response = await send('/api/hosts/external/key/unlink');
    assert.equal(response.status, 204);
    assert.equal(fs.readFileSync(externalKey, 'utf8'), 'user-owned private key');

    assert.equal(run(directory, 'host', 'add', 'ui-shared', '--hostname', 'shared.test', '--user', 'dave', '--key', managed.keyPath).status, 0);
    response = await send('/api/hosts/managed/key/delete');
    assert.equal(response.status, 409);
    response = await send('/api/hosts/ui-shared/key/unlink');
    assert.equal(response.status, 204);
    assert.equal(fs.existsSync(managed.keyPath), true);

    response = await send('/api/hosts/managed/key/delete');
    assert.equal(response.status, 200);
    const deleted = await response.json();
    assert.equal(deleted.deleted, true);
    assert.match(deleted.guide, /authorized_keys/);
    assert.equal(fs.existsSync(managed.keyPath), false);
    const remainingHosts = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    const unlinkedManaged = remainingHosts.find((host) => host.alias === 'managed');
    assert.equal(unlinkedManaged.keyPath, undefined);
    assert.equal(ssh.isManagedKeyPath(dataFile, unlinkedManaged.keyPath), false);

    response = await send('/api/hosts', { alias: 'ui-orphan', hostname: 'orphan.test', username: 'carol', port: 22 });
    assert.equal(response.status, 201);
    response = await send('/api/hosts/ui-orphan/key', { passphrase: 'orphan-ui-passphrase' });
    assert.equal(response.status, 201);
    const orphanKey = await response.json();
    const orphanHost = JSON.parse(fs.readFileSync(dataFile, 'utf8')).find((host) => host.alias === 'ui-orphan');
    response = await fetch(`${server.url}/api/hosts/ui-orphan`, { method: 'DELETE' });
    assert.equal(response.status, 204);
    assert.equal(fs.existsSync(orphanHost.keyPath), true, 'deleting a host must retain its independent managed key');
    const inventory = await (await get('/api/keys')).json();
    const orphanRecord = inventory.find((record) => record.alias === 'ui-orphan');
    assert.ok(orphanRecord);
    assert.deepEqual(orphanRecord.associatedAliases, []);
    response = await send(`/api/keys/${orphanRecord.id}/delete`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).deleted, true);
    assert.equal(fs.existsSync(orphanHost.keyPath), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('managed key creation writes encrypted Ed25519 keys without overwriting and can be deleted independently', () => {
  const { createManagedKey, deleteManagedKey } = require('../lib/ssh');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sshdeck-managed-'));
  try {
    const created = createManagedKey(path.join(directory, 'hosts.json'), 'alpha', 'private-test-passphrase');
    assert.match(created.publicKey, /^ssh-ed25519 /);
    assert.match(fs.readFileSync(created.keyPath, 'utf8'), /BEGIN OPENSSH PRIVATE KEY/);
    assert.ok(utils.parseKey(fs.readFileSync(created.keyPath), 'wrong-test-passphrase') instanceof Error);
    if (process.platform === 'win32') {
      const acl = spawnSync('icacls', [created.keyPath], { encoding: 'utf8', windowsHide: true });
      assert.equal(acl.status, 0, acl.stderr);
      assert.match(acl.stdout, new RegExp(`${process.env.USERNAME}:\\(F\\)`, 'i'));
      assert.doesNotMatch(acl.stdout, /BUILTIN\\Users|Everyone/);
    } else {
      assert.equal(fs.statSync(created.keyPath).mode & 0o777, 0o600);
      assert.equal(fs.statSync(path.dirname(created.keyPath)).mode & 0o777, 0o700);
    }
    assert.throws(() => createManagedKey(path.join(directory, 'hosts.json'), '../escape', 'passphrase'));
    const duplicate = fs.readFileSync(created.keyPath);
    const second = createManagedKey(path.join(directory, 'hosts.json'), 'alpha', 'other-passphrase');
    assert.notEqual(second.keyPath, created.keyPath);
    assert.deepEqual(fs.readFileSync(created.keyPath), duplicate);
    assert.equal(deleteManagedKey(path.join(directory, 'hosts.json'), created.keyPath), true);
    assert.equal(fs.existsSync(created.keyPath), false);
    assert.throws(() => deleteManagedKey(path.join(directory, 'hosts.json'), path.join(directory, 'external')));

    const failedDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'sshdeck-managed-failure-'));
    const originalGenerate = utils.generateKeyPairSync;
    try {
      utils.generateKeyPairSync = () => { throw new Error('simulated key generation failure'); };
      assert.throws(() => createManagedKey(path.join(failedDirectory, 'hosts.json'), 'failed', 'passphrase'), /simulated/);
    } finally {
      utils.generateKeyPairSync = originalGenerate;
    }
    assert.deepEqual(fs.readdirSync(path.join(failedDirectory, 'keys')), [], 'failed creation must not leave a partial private key');
    fs.rmSync(failedDirectory, { recursive: true, force: true });
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('CLI manages generated keys, recognizes their paths after host updates, and unlinks external keys', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sshdeck-key-cli-'));
  try {
    assert.equal(run(directory, 'host', 'add', 'managed', '--hostname', 'example.test', '--user', 'alice').status, 0);
    const created = runWithInput(directory, 'first-test-passphrase\n', 'key', 'create', 'managed');
    assert.equal(created.status, 0, created.stderr);
    const managedHost = JSON.parse(fs.readFileSync(path.join(directory, 'hosts.json'), 'utf8')).find((host) => host.alias === 'managed');
    assert.equal(ssh.isManagedKeyPath(path.join(directory, 'hosts.json'), managedHost.keyPath), true);
    const privateKey = fs.readFileSync(managedHost.keyPath, 'utf8');
    assert.match(privateKey, /BEGIN OPENSSH PRIVATE KEY/);
    assert.doesNotMatch(created.stdout + created.stderr, /BEGIN OPENSSH PRIVATE KEY/);
    assert.match(run(directory, 'key', 'show', 'managed').stdout, /^ssh-ed25519 /);
    const guide = run(directory, 'guide', 'managed').stdout;
    assert.match(guide, /authorized_keys/);
    assert.match(guide, /install -d -m 700 -o/);
    assert.match(guide, /chown .*authorized_keys/);
    assert.match(guide, /chmod 600 .*authorized_keys/);
    assert.match(guide, /awk -v key/);

    assert.equal(run(directory, 'host', 'update', 'managed', '--user', 'updated').status, 0);
    const updatedHost = JSON.parse(fs.readFileSync(path.join(directory, 'hosts.json'), 'utf8')).find((host) => host.alias === 'managed');
    assert.equal(ssh.isManagedKeyPath(path.join(directory, 'hosts.json'), updatedHost.keyPath), true);
    assert.equal(updatedHost.keyPath, managedHost.keyPath);

    const repeated = runWithInput(directory, 'replacement-passphrase\n', 'key', 'create', 'managed');
    assert.notEqual(repeated.status, 0, 'generation must not silently replace an associated key');
    assert.equal(fs.readFileSync(managedHost.keyPath, 'utf8'), privateKey);

    const externalPath = path.join(directory, 'user-owned-key');
    fs.writeFileSync(externalPath, 'user-owned test key');
    assert.equal(run(directory, 'host', 'add', 'external', '--hostname', 'external.test', '--user', 'bob', '--key', externalPath).status, 0);
    const externalDelete = run(directory, 'key', 'delete', 'external');
    assert.notEqual(externalDelete.status, 0);
    const unlinked = run(directory, 'key', 'unlink', 'external');
    assert.equal(unlinked.status, 0, unlinked.stderr);
    assert.equal(fs.readFileSync(externalPath, 'utf8'), 'user-owned test key');

    assert.equal(run(directory, 'host', 'add', 'shared', '--hostname', 'shared.test', '--user', 'dave', '--key', managedHost.keyPath).status, 0);
    assert.notEqual(run(directory, 'key', 'delete', 'managed').status, 0, 'a shared managed key cannot be deleted while another host references it');
    assert.equal(run(directory, 'key', 'unlink', 'shared').status, 0, 'a managed-key association can be removed independently');
    assert.equal(fs.existsSync(managedHost.keyPath), true);

    const removed = run(directory, 'key', 'delete', 'managed');
    assert.equal(removed.status, 0, removed.stderr);
    assert.equal(fs.existsSync(managedHost.keyPath), false);
    const afterDelete = JSON.parse(fs.readFileSync(path.join(directory, 'hosts.json'), 'utf8')).find((host) => host.alias === 'managed');
    assert.equal(afterDelete.keyPath, undefined);

    assert.equal(run(directory, 'host', 'add', 'orphan', '--hostname', 'orphan.example.test', '--user', 'carol').status, 0);
    const orphanCreated = runWithInput(directory, 'orphan-passphrase\n', 'key', 'create', 'orphan');
    assert.equal(orphanCreated.status, 0, orphanCreated.stderr);
    const orphanHost = JSON.parse(fs.readFileSync(path.join(directory, 'hosts.json'), 'utf8')).find((host) => host.alias === 'orphan');
    assert.equal(run(directory, 'host', 'delete', 'orphan').status, 0);
    assert.equal(fs.existsSync(orphanHost.keyPath), true);
    const inventory = run(directory, 'key', 'list');
    assert.equal(inventory.status, 0, inventory.stderr);
    assert.match(inventory.stdout, /orphan/);
    assert.match(run(directory, 'key', 'show', 'orphan').stdout, /^ssh-ed25519 /);
    assert.match(run(directory, 'guide', 'orphan').stdout, /authorized_keys/);
    assert.equal(run(directory, 'key', 'delete', 'orphan').status, 0);
    assert.equal(fs.existsSync(orphanHost.keyPath), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('generated key can be manually authorized and log in from CLI and UI without replacing existing authorized keys', {
  skip: !(integrationEnabled && integrationHostFingerprint) && 'Set SSHDECK_TEST_SSH_* and SSHDECK_TEST_SSH_FINGERPRINT to run manual public-key authorization against the isolated OpenSSH host.',
}, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sshdeck-key-authorization-'));
  const dataFile = path.join(directory, 'hosts.json');
  const addedKeys = [];
  let server;
  const addRemoteKey = async (publicKey) => {
    const key = shellQuote(publicKey);
    const command = 'key=' + key + '; file="$HOME/.ssh/authorized_keys"; if ! grep -Fqx -- "$key" "$file"; then printf \'%s\\n\' ' + key + ' >> "$file"; fi; chmod 600 "$file"; if grep -Fqx -- "$key" "$file"; then printf \'new-key-installed\\n\'; fi';
    const result = await runTestSsh(command);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /new-key-installed/);
    addedKeys.push(publicKey);
  };
  try {
    assert.equal(run(directory, 'host', 'add', 'cli-managed', '--hostname', integrationHost, '--port', String(integrationPort), '--user', 'sshdeck').status, 0);
    const cliCreated = runWithInput(directory, 'cli-managed-passphrase\n', 'key', 'create', 'cli-managed');
    assert.equal(cliCreated.status, 0, cliCreated.stderr);
    const cliPublicKey = run(directory, 'key', 'show', 'cli-managed').stdout.trim();
    assert.match(cliPublicKey, /^ssh-ed25519 /);
    await addRemoteKey(cliPublicKey);
    const cliManagedHost = JSON.parse(fs.readFileSync(dataFile, 'utf8')).find((host) => host.alias === 'cli-managed');
    await assert.rejects(check(dataFile, cliManagedHost, 'wrong-managed-passphrase'), (error) => {
      assert.equal(error.code, 'INVALID_KEY_PASSPHRASE');
      return true;
    });

    const cliLogin = await runInteractiveKeyCheck(directory, 'cli-managed', 'cli-managed-passphrase');
    assert.equal(cliLogin.code, 0, cliLogin.output);
    assert.match(cliLogin.output, /SSH 登入檢查成功/);
    assert.equal((await check(dataFile, makeHost('existing-key', 'sshdeck', integrationKeyA))).ok, true, 'appending the new public key must preserve the existing authorized key');

    assert.equal(run(directory, 'host', 'add', 'ui-managed', '--hostname', integrationHost, '--port', String(integrationPort), '--user', 'sshdeck').status, 0);
    server = await startUi({ port: 0, dataFile, openBrowser: async () => {}, log: () => {} });
    let response = await fetch(`${server.url}/api/hosts/ui-managed/key`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ passphrase: 'ui-managed-passphrase' }),
    });
    assert.equal(response.status, 201);
    const uiCreated = await response.json();
    assert.match(uiCreated.publicKey, /^ssh-ed25519 /);
    assert.doesNotMatch(fs.readFileSync(path.join(directory, 'hosts.json'), 'utf8'), /ui-managed-passphrase/);
    assert.doesNotMatch(fs.readFileSync(`${dataFile}.keys.json`, 'utf8'), /ui-managed-passphrase/);
    await addRemoteKey(uiCreated.publicKey);

    await fetch(`${server.url}/api/lock`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    response = await fetch(`${server.url}/api/unlock`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ alias: 'ui-managed', passphrase: 'wrong-managed-passphrase' }) });
    assert.equal(response.status, 400);
    response = await fetch(`${server.url}/api/hosts/ui-managed/check`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 428, 'failed unlock must not remain cached');
    response = await fetch(`${server.url}/api/unlock`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ alias: 'ui-managed', passphrase: 'ui-managed-passphrase' }) });
    assert.equal(response.status, 204);
    response = await fetch(`${server.url}/api/hosts/ui-managed/check`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 200, 'UI key creation unlocks the key for its service and reuses CLI endpoint trust');
    assert.equal((await response.json()).ok, true);
    assert.equal((await check(dataFile, makeHost('existing-key-after-ui-key', 'sshdeck', integrationKeyA))).ok, true);

    const originalStillWorks = await check(dataFile, makeHost('original', 'sshdeck', integrationKeyA));
    assert.equal(originalStillWorks.ok, true, 'manual installation must preserve existing authorized_keys entries');
  } finally {
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    if (addedKeys.length) {
      const remove = addedKeys.map((key) => 'key=' + shellQuote(key) + '; awk -v key="$key" \'$0 != key\' "$HOME/.ssh/authorized_keys" > "$HOME/.ssh/authorized_keys.sshdeck.tmp" && cat "$HOME/.ssh/authorized_keys.sshdeck.tmp" > "$HOME/.ssh/authorized_keys" && rm -f "$HOME/.ssh/authorized_keys.sshdeck.tmp"').join('; ');
      const cleaned = await runTestSsh(remove + '; chmod 600 "$HOME/.ssh/authorized_keys"');
      assert.equal(cleaned.code, 0, cleaned.stderr);
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('SSH trust requires explicit acceptance, shares trust by endpoint, and records login status', {
  skip: !integrationEnabled && 'Set SSHDECK_TEST_SSH_HOST, SSHDECK_TEST_SSH_PORT, SSHDECK_TEST_SSH_KEY_A and SSHDECK_TEST_SSH_KEY_B to run against the isolated OpenSSH test host.',
}, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sshdeck-ssh-test-'));
  const dataFile = path.join(directory, 'hosts.json');
  const hostA = makeHost('primary', 'sshdeck', integrationKeyA);
  const hostB = makeHost('secondary', 'sshdeck2', integrationKeyB);
  try {
    let firstChallenge;
    await assert.rejects(check(dataFile, hostA), (error) => {
      assert.equal(error.code, 'HOST_TRUST_REQUIRED');
      assert.match(error.fingerprint, /^SHA256:/);
      firstChallenge = error;
      return true;
    });
    assert.deepEqual(fs.existsSync(stores(dataFile).trust), false, 'a rejected first challenge must not persist trust');

    const accepted = await check(dataFile, hostA, undefined, { expectedFingerprint: firstChallenge.fingerprint });
    assert.equal(accepted.ok, true);
    assert.equal(accepted.fingerprint, firstChallenge.fingerprint);

    const secondLogin = await check(dataFile, hostB);
    assert.equal(secondLogin.ok, true, 'different login accounts at one endpoint share host identity trust');
    assert.equal(secondLogin.fingerprint, firstChallenge.fingerprint);

    const failedLoginDataFile = path.join(directory, 'failed-login', 'hosts.json');
    const unauthorizedAccount = { ...hostA, alias: 'unauthorized', username: 'not-authorized' };
    let failedLoginChallenge;
    await assert.rejects(check(failedLoginDataFile, unauthorizedAccount), (error) => {
      assert.equal(error.code, 'HOST_TRUST_REQUIRED');
      failedLoginChallenge = error;
      return true;
    });
    await assert.rejects(check(failedLoginDataFile, unauthorizedAccount, undefined, { expectedFingerprint: failedLoginChallenge.fingerprint }), (error) => {
      assert.equal(error.code, 'AUTHENTICATION_FAILED');
      return true;
    });
    assert.equal(JSON.parse(fs.readFileSync(stores(failedLoginDataFile).trust, 'utf8'))[endpoint(unauthorizedAccount)], failedLoginChallenge.fingerprint, 'explicit host trust persists even when login credentials fail');
    await assert.rejects(check(failedLoginDataFile, unauthorizedAccount), (error) => {
      assert.equal(error.code, 'AUTHENTICATION_FAILED');
      return true;
    });

    await assert.rejects(check(dataFile, { ...hostA, keyPath: integrationKeyB }), (error) => {
      assert.equal(error.code, 'AUTHENTICATION_FAILED');
      return true;
    });
    await assert.rejects(check(dataFile, hostA, undefined, { expectedFingerprint: 'SHA256:incorrect-confirmation' }), (error) => {
      assert.equal(error.code, 'HOST_KEY_CHANGED');
      assert.equal(error.fingerprint, firstChallenge.fingerprint);
      return true;
    });
    await assert.rejects(check(dataFile, { ...hostA, alias: 'offline', port: 1 }), (error) => {
      assert.equal(error.code, 'SSH_CONNECTION_FAILED');
      return true;
    });

    const statuses = getStatuses(dataFile);
    assert.equal(statuses.primary.state, 'changed');
    assert.equal(statuses.secondary.state, 'success');
    assert.equal(statuses.offline.state, 'failure');
    assert.equal(JSON.parse(fs.readFileSync(stores(dataFile).trust, 'utf8'))[endpoint(hostA)], firstChallenge.fingerprint);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('CLI requires trust confirmation and then reuses endpoint trust', {
  skip: !integrationEnabled && 'Set SSHDECK_TEST_SSH_HOST, SSHDECK_TEST_SSH_PORT, SSHDECK_TEST_SSH_KEY_A and SSHDECK_TEST_SSH_KEY_B to run against the isolated OpenSSH test host.',
}, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sshdeck-cli-ssh-test-'));
  const cli = path.join(__dirname, '..', 'bin', 'sshdeck.js');
  const dataFile = path.join(directory, 'hosts.json');
  const added = spawnSync(process.execPath, [cli, 'host', 'add', 'cli-primary', '--hostname', integrationHost, '--port', String(integrationPort), '--user', 'sshdeck', '--key', integrationKeyA], {
    encoding: 'utf8', env: { ...process.env, SSHDECK_HOME: directory },
  });
  assert.equal(added.status, 0, added.stderr);

  async function runCheck(alias, passphrase, answer) {
    const child = spawn(process.execPath, [cli, 'host', 'check', alias], {
      env: { ...process.env, SSHDECK_HOME: directory },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    const waitFor = (marker) => new Promise((resolve, reject) => {
      if (output.includes(marker)) return resolve();
      const onData = () => { if (output.includes(marker)) { child.stderr.off('data', onData); clearTimeout(timer); resolve(); } };
      const timer = setTimeout(() => { child.stderr.off('data', onData); reject(new Error(`Timed out waiting for ${marker}. Output: ${output}`)); }, 5000);
      child.stderr.on('data', onData);
    });
    await waitFor('登入金鑰密語');
    child.stdin.write(`${passphrase}\n`);
    if (answer !== undefined) {
      await waitFor('確認信任此主機？');
      child.stdin.write(`${answer}\n`);
    }
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    return { code, output };
  }

  try {
    const rejected = await runCheck('cli-primary', '', 'n');
    assert.notEqual(rejected.code, 0);
    assert.match(rejected.output, /已拒絕主機指紋/);
    assert.equal(fs.existsSync(stores(dataFile).trust), false);

    const accepted = await runCheck('cli-primary', '', 'y');
    assert.equal(accepted.code, 0, accepted.output);
    assert.match(accepted.output, /SSH 登入檢查成功/);
    const listed = spawnSync(process.execPath, [cli, 'host', 'list'], { encoding: 'utf8', env: { ...process.env, SSHDECK_HOME: directory } }).stdout;
    assert.match(listed, /SSH 成功/);
    assert.match(listed, /\d{4}-\d\d-\d\dT/);

    const ui = await startUi({ port: 0, dataFile, openBrowser: async () => {}, log: () => {} });
    try {
      const unlock = await fetch(`${ui.url}/api/unlock`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ alias: 'cli-primary', passphrase: '' }) });
      assert.equal(unlock.status, 204);
      const uiCheck = await fetch(`${ui.url}/api/hosts/cli-primary/check`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      assert.equal(uiCheck.status, 200, 'browser check reuses the trust created by the CLI');
    } finally {
      await new Promise((resolve) => ui.close(resolve));
    }

    const wrongAdded = spawnSync(process.execPath, [cli, 'host', 'add', 'cli-wrong-key', '--hostname', integrationHost, '--port', String(integrationPort), '--user', 'sshdeck', '--key', integrationKeyB], {
      encoding: 'utf8', env: { ...process.env, SSHDECK_HOME: directory },
    });
    assert.equal(wrongAdded.status, 0, wrongAdded.stderr);
    const wrongKey = await runCheck('cli-wrong-key', '');
    assert.notEqual(wrongKey.code, 0);
    assert.match(wrongKey.output, /SSH 登入認證失敗/);

    if (integrationKeyAEncrypted) {
      const encryptedAdded = spawnSync(process.execPath, [cli, 'host', 'add', 'cli-encrypted', '--hostname', integrationHost, '--port', String(integrationPort), '--user', 'sshdeck', '--key', integrationKeyAEncrypted], {
        encoding: 'utf8', env: { ...process.env, SSHDECK_HOME: directory },
      });
      assert.equal(encryptedAdded.status, 0, encryptedAdded.stderr);
      const wrongPassphrase = await runCheck('cli-encrypted', 'wrong-test-passphrase');
      assert.notEqual(wrongPassphrase.code, 0);
      assert.doesNotMatch(wrongPassphrase.output, /wrong-test-passphrase/);
      const unlocked = await runCheck('cli-encrypted', 'sshdeck-test-only-passphrase');
      assert.equal(unlocked.code, 0, unlocked.output);
      assert.match(unlocked.output, /SSH 登入檢查成功/);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('browser SSH check gates on unlock and fingerprint confirmation, and lock clears service memory', {
  skip: !integrationEnabled && 'Set SSHDECK_TEST_SSH_HOST, SSHDECK_TEST_SSH_PORT, SSHDECK_TEST_SSH_KEY_A and SSHDECK_TEST_SSH_KEY_B to run against the isolated OpenSSH test host.',
}, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sshdeck-ui-ssh-test-'));
  const dataFile = path.join(directory, 'hosts.json');
  const { spawnSync } = require('node:child_process');
  const cli = path.join(__dirname, '..', 'bin', 'sshdeck.js');
  const added = spawnSync(process.execPath, [cli, 'host', 'add', 'ui-primary', '--hostname', integrationHost, '--port', String(integrationPort), '--user', 'sshdeck', '--key', integrationKeyA], {
    encoding: 'utf8', env: { ...process.env, SSHDECK_HOME: directory },
  });
  assert.equal(added.status, 0, added.stderr);
  if (integrationKeyAEncrypted) {
    const encryptedAdded = spawnSync(process.execPath, [cli, 'host', 'add', 'ui-encrypted', '--hostname', integrationHost, '--port', String(integrationPort), '--user', 'sshdeck', '--key', integrationKeyAEncrypted], {
      encoding: 'utf8', env: { ...process.env, SSHDECK_HOME: directory },
    });
    assert.equal(encryptedAdded.status, 0, encryptedAdded.stderr);
  }
  const server = await startUi({ port: 0, dataFile, openBrowser: async () => {}, log: () => {} });
  const url = server.url;
  const request = async (route, body) => fetch(`${url}${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
  });
  try {
    const page = await (await fetch(url)).text();
    assert.match(page, /檢查 SSH/);
    assert.match(page, /type="password"/);
    assert.match(page, /鎖定已解鎖金鑰/);
    let response = await request('/api/hosts/ui-primary/check');
    assert.equal(response.status, 428);
    assert.equal((await response.json()).code, 'NEEDS_UNLOCK');

    response = await request('/api/unlock', { alias: 'ui-primary', passphrase: '' });
    assert.equal(response.status, 204);
    assert.doesNotMatch(fs.readFileSync(path.join(directory, 'hosts.json'), 'utf8'), /passphrase/);

    response = await request('/api/hosts/ui-primary/check');
    assert.equal(response.status, 409);
    const challenge = await response.json();
    assert.equal(challenge.code, 'HOST_TRUST_REQUIRED');

    response = await request('/api/hosts/ui-primary/check', { expectedFingerprint: challenge.fingerprint });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).ok, true);
    const listed = await (await fetch(`${url}/api/hosts`)).json();
    assert.equal(listed[0].check.state, 'success');
    assert.equal(typeof listed[0].check.checkedAt, 'string');

    if (integrationKeyAEncrypted) {
      response = await request('/api/hosts/ui-encrypted/check');
      assert.equal(response.status, 428);
      response = await request('/api/unlock', { alias: 'ui-encrypted', passphrase: 'wrong-test-passphrase' });
      assert.equal(response.status, 400);
      response = await request('/api/hosts/ui-encrypted/check');
      assert.equal(response.status, 428, 'wrong passphrase must not be cached as unlocked');
      response = await request('/api/unlock', { alias: 'ui-encrypted', passphrase: 'sshdeck-test-only-passphrase' });
      assert.equal(response.status, 204);
      response = await request('/api/hosts/ui-encrypted/check');
      assert.equal(response.status, 200);
      assert.equal((await response.json()).ok, true);
      assert.doesNotMatch(fs.readFileSync(dataFile, 'utf8'), /sshdeck-test-only-passphrase/);
      for (const file of [stores(dataFile).trust, stores(dataFile).status]) {
        if (fs.existsSync(file)) assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /sshdeck-test-only-passphrase/);
      }
    }

    response = await request('/api/lock');
    assert.equal(response.status, 204);
    response = await request('/api/hosts/ui-primary/check');
    assert.equal(response.status, 428);

    response = await request('/api/unlock', { alias: 'ui-primary', passphrase: '' });
    assert.equal(response.status, 204);
    await new Promise((resolve) => server.close(resolve));

    const restarted = await startUi({ port: 0, dataFile, openBrowser: async () => {}, log: () => {} });
    try {
      const restartedResponse = await fetch(`${restarted.url}/api/hosts/ui-primary/check`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      });
      assert.equal(restartedResponse.status, 428);
    } finally {
      await new Promise((resolve) => restarted.close(resolve));
    }
  } finally {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
