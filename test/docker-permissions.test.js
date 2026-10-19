const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const ssh = require('../lib/ssh');
const { startUi } = require('../bin/sshdeck');

const integrationHost = process.env.SSHDECK_TEST_SSH_HOST;
const integrationPort = Number(process.env.SSHDECK_TEST_SSH_PORT || 22);
const integrationKeyA = process.env.SSHDECK_TEST_SSH_KEY_A;
const integrationKeyB = process.env.SSHDECK_TEST_SSH_KEY_B;
const integrationHostFingerprint = process.env.SSHDECK_TEST_SSH_FINGERPRINT;
const integrationEnabled = Boolean(integrationHost && integrationKeyA && integrationKeyB && integrationHostFingerprint);
const cli = path.join(__dirname, '..', 'bin', 'sshdeck.js');

function run(home, ...args) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...process.env, SSHDECK_HOME: home } });
}

function addHost(home, alias, username, keyPath, port = integrationPort) {
  const result = run(home, 'host', 'add', alias, '--hostname', integrationHost || '127.0.0.1', '--port', String(port), '--user', username, '--key', keyPath);
  assert.equal(result.status, 0, result.stderr);
}

function waitFor(child, markers, state, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const match = () => markers.find((marker) => state.output.includes(marker));
    if (match()) return resolve(match());
    const onData = () => {
      if (match()) {
        child.stdout.off('data', onData);
        child.stderr.off('data', onData);
        clearTimeout(timer);
        resolve(match());
      }
    };
    const timer = setTimeout(() => {
      child.stdout.off('data', onData);
      child.stderr.off('data', onData);
      reject(new Error(`等待輸出逾時：${markers.join(' / ')}\n${state.output}`));
    }, timeout);
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
  });
}

async function runHostCheck(home, alias) {
  const child = spawn(process.execPath, [cli, 'host', 'check', alias], {
    env: { ...process.env, SSHDECK_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const state = { output: '' };
  child.stdout.on('data', (chunk) => { state.output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { state.output += chunk.toString(); });
  await waitFor(child, ['登入金鑰密語'], state);
  child.stdin.write('\n');
  const prompt = await waitFor(child, ['確認信任此主機？', 'SSH 登入檢查成功', 'sshdeck：SSH 連線失敗'], state);
  if (prompt === '確認信任此主機？') {
    child.stdin.write('y\n');
    await waitFor(child, ['SSH 登入檢查成功'], state);
  }
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  return { code, output: state.output };
}

async function runRemote(home, alias, command) {
  const child = spawn(process.execPath, [cli, 'exec', alias, '--', command], {
    env: { ...process.env, SSHDECK_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  await new Promise((resolve, reject) => {
    const marker = '登入金鑰密語';
    const onData = () => {
      if (output.includes(marker)) { child.stderr.off('data', onData); resolve(); }
    };
    child.stderr.on('data', onData);
    if (output.includes(marker)) resolve();
    setTimeout(() => reject(new Error(`等待 CLI 密語提示逾時：${output}`)), 8000).unref();
    child.once('error', reject);
  });
  child.stdin.write('\n');
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  return { code, output };
}

test('Docker diagnostics preserve distinct failure causes', () => {
  assert.equal(ssh.classifyDockerFailure('sh: docker: not found', 127).state, 'missing-cli');
  assert.equal(ssh.classifyDockerFailure('permission denied while connecting to docker.sock', 1).state, 'permission-denied');
  assert.equal(ssh.classifyDockerFailure('Cannot connect to the Docker daemon', 1).state, 'daemon-unavailable');
  const unknown = ssh.classifyDockerFailure('unexpected OCI runtime error', 1);
  assert.equal(unknown.state, 'unavailable');
  assert.match(unknown.diagnostic, /OCI runtime error/);
});

test('CLI and UI report SSH and Docker separately for authorized, denied, and SSH-failed accounts', {
  skip: !integrationEnabled && 'Set SSHDECK_TEST_SSH_* variables to run against the isolated OpenSSH/Docker test host.',
}, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sshdeck-docker-check-'));
  const dataFile = path.join(directory, 'hosts.json');
  addHost(directory, 'docker-enabled', 'sshdeck', integrationKeyA);
  addHost(directory, 'docker-denied', 'sshdeck2', integrationKeyB);
  addHost(directory, 'ssh-offline', 'sshdeck', integrationKeyA, 1);
  try {
    const allowed = await runHostCheck(directory, 'docker-enabled');
    assert.equal(allowed.code, 0, allowed.output);
    assert.match(allowed.output, /SSH 登入檢查成功/);
    assert.match(allowed.output, /Docker daemon 可用/);

    const denied = await runHostCheck(directory, 'docker-denied');
    assert.notEqual(denied.code, 0);
    assert.match(denied.output, /SSH 登入檢查成功/);
    assert.match(denied.output, /Docker 檢查：權限不足/);
    assert.match(denied.output, /permission denied/i);

    const offline = await runHostCheck(directory, 'ssh-offline');
    assert.notEqual(offline.code, 0);
    assert.match(offline.output, /SSH 連線失敗/);
    assert.match(offline.output, /Docker 檢查：未執行/);
    assert.doesNotMatch(offline.output, /Docker daemon 可用/);
    const cliList = run(directory, 'host', 'list');
    assert.match(cliList.stdout, /docker-enabled.*Docker 可用/s);
    assert.match(cliList.stdout, /docker-denied.*Docker 權限不足/s);
    assert.match(cliList.stdout, /ssh-offline.*Docker 未執行/s);
    const statuses = ssh.getStatuses(dataFile);
    assert.equal(statuses['docker-enabled'].docker.state, 'available');
    assert.equal(statuses['docker-denied'].docker.state, 'permission-denied');
    assert.equal(statuses['ssh-offline'].docker.state, 'not-run');

    const server = await startUi({ port: 0, dataFile, openBrowser: async () => {}, log: () => {} });
    try {
      const page = await (await fetch(server.url)).text();
      assert.match(page, /Docker：/);
      const unlock = async (alias) => {
        const response = await fetch(`${server.url}/api/unlock`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ alias, passphrase: '' }),
        });
        assert.equal(response.status, 204, alias);
      };
      await unlock('docker-enabled');
      await unlock('docker-denied');
      const check = (alias, expectedFingerprint) => fetch(`${server.url}/api/hosts/${alias}/check`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(expectedFingerprint ? { expectedFingerprint } : {}),
      });
      let response = await check('docker-enabled');
      if (response.status === 409) {
        const challenge = await response.json();
        assert.equal(challenge.code, 'HOST_TRUST_REQUIRED');
        response = await check('docker-enabled', challenge.fingerprint);
      }
      assert.equal(response.status, 200);
      assert.equal((await response.json()).docker.state, 'available');
      response = await check('docker-denied');
      assert.equal(response.status, 200);
      assert.equal((await response.json()).docker.state, 'permission-denied');
      response = await check('ssh-offline');
      assert.equal(response.status, 502);
      const listed = await (await fetch(`${server.url}/api/hosts`)).json();
      assert.equal(listed.find((host) => host.alias === 'docker-enabled').check.docker.state, 'available');
      assert.equal(listed.find((host) => host.alias === 'docker-denied').check.docker.state, 'permission-denied');
      assert.equal(listed.find((host) => host.alias === 'ssh-offline').check.docker.state, 'not-run');
      response = await fetch(`${server.url}/api/hosts/docker-denied/guide`);
      assert.equal(response.status, 200);
      const guide = await response.json();
      assert.match(guide.guide, /usermod -aG docker/);
      assert.match(guide.guide, /重新登入/);
      assert.match(guide.guide, /高權限/);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('authorized account can create, start, inspect, and remove only its uniquely named test container', {
  skip: !integrationEnabled && 'Set SSHDECK_TEST_SSH_* variables to run against the isolated OpenSSH/Docker test host.',
}, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sshdeck-docker-container-'));
  const alias = 'docker-e2e';
  const testName = `sshdeck-test-ticket06-${process.pid}-${Date.now()}`;
  addHost(directory, alias, 'sshdeck', integrationKeyA);
  let created = false;
  try {
    const checked = await runHostCheck(directory, alias);
    assert.equal(checked.code, 0, checked.output);
    assert.match(checked.output, /Docker daemon 可用/);
    const create = await runRemote(directory, alias,
      `docker create --name ${testName} --label owner=sshdeck --label purpose=sshdeck-ticket06 --network none node:22-bookworm-slim sh -c 'printf ticket06-running; sleep 60'`);
    assert.equal(create.code, 0, create.output);
    assert.match(create.output, /[0-9a-f]{12,}/i);
    created = true;
    const start = await runRemote(directory, alias, `docker start ${testName}`);
    assert.equal(start.code, 0, start.output);
    assert.match(start.output, new RegExp(testName));
    const inspect = await runRemote(directory, alias, `docker inspect --format '{{.State.Running}}' ${testName}`);
    assert.equal(inspect.code, 0, inspect.output);
    assert.match(inspect.output, /true/);
  } finally {
    if (created) {
      const cleanup = await runRemote(directory, alias, `docker rm --force ${testName}`);
      assert.equal(cleanup.code, 0, cleanup.output);
      assert.match(cleanup.output, new RegExp(testName));
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('manual group authorization becomes available after the SSH user logs in again', {
  skip: !integrationEnabled && 'Set SSHDECK_TEST_SSH_* variables to run against the isolated OpenSSH/Docker test host.',
}, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sshdeck-docker-group-'));
  const alias = 'docker-group';
  addHost(directory, alias, 'sshdeck2', integrationKeyB);
  addHost(directory, 'docker-admin', 'sshdeck', integrationKeyA);
  let groupRenamed = false;
  try {
    const denied = await runHostCheck(directory, alias);
    assert.notEqual(denied.code, 0);
    assert.match(denied.output, /Docker 檢查：權限不足/);

    // The isolated SSH test container's Docker socket maps to gid 0. Rename only that
    // container-local group to `docker`, then apply the documented supplementary group.
    const rename = await runRemote(directory, 'docker-admin', 'docker exec -u 0 sshdeck-test-ssh groupmod -n docker root');
    assert.equal(rename.code, 0, rename.output);
    groupRenamed = true;
    const apply = await runRemote(directory, 'docker-admin', 'docker exec -u 0 sshdeck-test-ssh usermod -aG docker sshdeck2');
    assert.equal(apply.code, 0, apply.output);

    const allowedAfterRelogin = await runHostCheck(directory, alias);
    assert.equal(allowedAfterRelogin.code, 0, allowedAfterRelogin.output);
    assert.match(allowedAfterRelogin.output, /Docker daemon 可用/);

    const server = await startUi({ port: 0, dataFile: path.join(directory, 'hosts.json'), openBrowser: async () => {}, log: () => {} });
    try {
      const unlock = await fetch(`${server.url}/api/unlock`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ alias, passphrase: '' }),
      });
      assert.equal(unlock.status, 204);
      const response = await fetch(`${server.url}/api/hosts/${alias}/check`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).docker.state, 'available');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    if (groupRenamed) {
      const restore = await runRemote(directory, 'docker-admin',
        'docker exec -u 0 sshdeck-test-ssh sh -lc "gpasswd -d sshdeck2 docker >/dev/null 2>&1 || true; groupmod -n root docker"');
      assert.equal(restore.code, 0, restore.output);
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
