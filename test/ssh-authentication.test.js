const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');
const { spawn, spawnSync } = require('node:child_process');
const { utils } = require('ssh2');
const { check, endpoint, fingerprint, getStatuses, stores } = require('../lib/ssh');
const { readSecret, startUi } = require('../bin/sshdeck');

const integrationHost = process.env.SSHDECK_TEST_SSH_HOST;
const integrationPort = Number(process.env.SSHDECK_TEST_SSH_PORT || 22);
const integrationKeyA = process.env.SSHDECK_TEST_SSH_KEY_A;
const integrationKeyB = process.env.SSHDECK_TEST_SSH_KEY_B;
const integrationKeyAEncrypted = process.env.SSHDECK_TEST_SSH_KEY_A_ENCRYPTED;
const integrationEnabled = Boolean(integrationHost && integrationKeyA && integrationKeyB);

function makeHost(alias, username, keyPath, port = integrationPort) {
  return { alias, hostname: integrationHost, port, username, keyPath };
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

test('managed key creation writes encrypted Ed25519 keys without overwriting and can be deleted independently', () => {
  const { createManagedKey, deleteManagedKey } = require('../lib/ssh');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sshdeck-managed-'));
  try {
    const created = createManagedKey(path.join(directory, 'hosts.json'), 'alpha', 'private-test-passphrase');
    assert.match(created.publicKey, /^ssh-ed25519 /);
    assert.match(fs.readFileSync(created.keyPath, 'utf8'), /BEGIN OPENSSH PRIVATE KEY/);
    assert.ok(utils.parseKey(fs.readFileSync(created.keyPath), 'wrong-test-passphrase') instanceof Error);
    assert.equal(fs.statSync(created.keyPath).mode & 0o777, process.platform === 'win32' ? fs.statSync(created.keyPath).mode & 0o777 : 0o600);
    assert.throws(() => createManagedKey(path.join(directory, 'hosts.json'), '../escape', 'passphrase'));
    const duplicate = fs.readFileSync(created.keyPath);
    const second = createManagedKey(path.join(directory, 'hosts.json'), 'alpha', 'other-passphrase');
    assert.notEqual(second.keyPath, created.keyPath);
    assert.deepEqual(fs.readFileSync(created.keyPath), duplicate);
    assert.equal(deleteManagedKey(path.join(directory, 'hosts.json'), created.keyPath), true);
    assert.equal(fs.existsSync(created.keyPath), false);
    assert.throws(() => deleteManagedKey(path.join(directory, 'hosts.json'), path.join(directory, 'external')));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
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
