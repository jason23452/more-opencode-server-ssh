const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const { EventEmitter } = require('node:events');
const WebSocket = require('ws');
const { attachLocalTerminal, startUi } = require('../bin/sshdeck');

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

function waitFor(child, marker, state, timeout = 8000) {
  return new Promise((resolve, reject) => {
    if (state.output.includes(marker)) return resolve();
    const onData = () => {
      if (state.output.includes(marker)) {
        child.stdout.off('data', onData);
        child.stderr.off('data', onData);
        clearTimeout(timer);
        resolve();
      }
    };
    const timer = setTimeout(() => {
      child.stdout.off('data', onData);
      child.stderr.off('data', onData);
      reject(new Error(`等待輸出逾時：${marker}\n${state.output}`));
    }, timeout);
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
  });
}

async function connectWebTerminal(server, alias, { passphrase = '', acceptTrust = true, origin } = {}) {
  const originValue = origin || server.url;
  const socketUrl = `ws://127.0.0.1:${server.address().port}/api/shell?alias=${encodeURIComponent(alias)}`;
  const socket = new WebSocket(socketUrl, { origin: originValue });
  const decoder = new StringDecoder('utf8');
  let output = '';
  const controls = [];
  const controlWaiters = [];
  socket.on('message', (data, isBinary) => {
    if (isBinary) { output += decoder.write(data); return; }
    let message;
    try { message = JSON.parse(data.toString()); } catch { output += data.toString(); return; }
    controls.push(message);
    for (let index = controlWaiters.length - 1; index >= 0; index -= 1) {
      if (controlWaiters[index].predicate(message)) {
        const [waiter] = controlWaiters.splice(index, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      }
    }
  });
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  const waitControl = (predicate, timeout = 8000) => {
    const existing = controls.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, timer: setTimeout(() => {
        const index = controlWaiters.indexOf(waiter);
        if (index >= 0) controlWaiters.splice(index, 1);
        reject(new Error(`等待 WebSocket 控制訊息逾時。已收到：${JSON.stringify(controls)}`));
      }, timeout) };
      controlWaiters.push(waiter);
    });
  };
  const unlocked = waitControl((message) => message.type === 'unlock-required');
  await unlocked;
  socket.send(JSON.stringify({ type: 'unlock', passphrase }));
  await waitControl((message) => message.type === 'unlocked');
  const next = await waitControl((message) => message.type === 'started' || ['trust-required', 'host-key-changed'].includes(message.type));
  if (next.type !== 'started') {
    const trust = next;
    if (!acceptTrust) {
      socket.send(JSON.stringify({ type: 'trust-reject' }));
      return { socket, output, controls, waitControl, rejected: trust };
    }
    socket.send(JSON.stringify({ type: 'trust', fingerprint: trust.fingerprint }));
  }
  await waitControl((message) => message.type === 'started');
  const waitText = (marker, timeout = 8000) => new Promise((resolve, reject) => {
    const deadline = Date.now() + timeout;
    const poll = () => {
      if (output.includes(marker)) return resolve(output);
      if (socket.readyState !== WebSocket.OPEN) return reject(new Error(`終端機已關閉，未收到 ${marker}；目前輸出：${output}`));
      if (Date.now() >= deadline) return reject(new Error(`等待終端機輸出逾時：${marker}\n${output}`));
      setTimeout(poll, 20);
    };
    poll();
  });
  return {
    socket,
    controls,
    output: () => output,
    waitControl,
    waitText,
    send: (text) => socket.send(Buffer.from(text)),
    resize: (cols, rows) => socket.send(JSON.stringify({ type: 'resize', cols, rows })),
  };
}

test('shell argument parser accepts exactly one managed host alias', () => {
  const { parseShellArgs } = require('../bin/sshdeck');
  assert.deepEqual(parseShellArgs(['shell', 'dev']), { alias: 'dev' });
  assert.throws(() => parseShellArgs(['shell']), /別名/);
  assert.throws(() => parseShellArgs(['shell', 'dev', 'extra']), /別名/);
});

test('CLI terminal forwarding resizes the PTY and restores the original raw mode on close', () => {
  class FakeInput extends EventEmitter {
    isTTY = true;
    isRaw = false;
    paused = false;
    setRawMode(value) { this.isRaw = value; }
    resume() { this.paused = false; }
    pause() { this.paused = true; }
  }
  const input = new FakeInput();
  const output = new EventEmitter();
  const signals = new EventEmitter();
  output.columns = 132;
  output.rows = 44;
  const written = [];
  const sizes = [];
  let closed = false;
  const cleanup = attachLocalTerminal({
    write: (data) => written.push(data.toString()),
    resize: (cols, rows) => sizes.push([cols, rows]),
    close: () => { closed = true; },
  }, { input, output, signalSource: signals });
  assert.equal(input.isRaw, true);
  assert.equal(input.paused, false);
  input.emit('data', Buffer.from('interactive input'));
  output.emit('resize');
  signals.emit('SIGINT');
  assert.deepEqual(written, ['interactive input']);
  assert.deepEqual(sizes, [[132, 44]]);
  assert.equal(closed, true);
  cleanup();
  assert.equal(input.isRaw, false);
  assert.equal(input.paused, true);
  assert.equal(input.listenerCount('data'), 0);
  assert.equal(output.listenerCount('resize'), 0);
  assert.equal(signals.listenerCount('SIGINT'), 0);
});

test('CLI opens a persistent SSH PTY, accepts interactive input, and reports its final status', {
  skip: !integrationEnabled && 'Set SSHDECK_TEST_SSH_* variables to run against the isolated OpenSSH test host.',
}, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sshdeck-cli-shell-'));
  const added = run(directory, 'host', 'add', 'cli-pty', '--hostname', integrationHost, '--port', String(integrationPort), '--user', 'sshdeck', '--key', integrationKeyA);
  assert.equal(added.status, 0, added.stderr);
  const child = spawn(process.execPath, [cli, 'shell', 'cli-pty'], { env: { ...process.env, SSHDECK_HOME: directory }, stdio: ['pipe', 'pipe', 'pipe'] });
  const state = { output: '' };
  child.stdout.on('data', (chunk) => { state.output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { state.output += chunk.toString(); });
  try {
    await waitFor(child, '登入金鑰密語', state);
    child.stdin.write('\n');
    await waitFor(child, '確認信任？', state);
    child.stdin.write('y\n');
    await waitFor(child, '已連線至 cli-pty', state);
    child.stdin.write("stty size; printf 'INPUT:'; read -r value; printf 'RECEIVED:%s\\n' \"$value\"; exit 0\n");
    await waitFor(child, '24 80', state);
    await waitFor(child, 'INPUT:', state);
    child.stdin.write('interactive-value\n');
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    assert.equal(code, 0, state.output);
    assert.match(state.output, /RECEIVED:interactive-value/);
    assert.match(state.output, /cli-pty（sshdeck@/);
  } finally {
    if (child.exitCode === null) child.kill();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('browser PTYs support unlock/trust, interactive input, resize, parallel identities, and close isolation', {
  skip: !integrationEnabled && 'Set SSHDECK_TEST_SSH_* variables to run against the isolated OpenSSH test host.',
}, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sshdeck-web-shell-'));
  const dataFile = path.join(directory, 'hosts.json');
  for (const [alias, user, key] of [['web-a', 'sshdeck', integrationKeyA], ['web-b', 'sshdeck2', integrationKeyB]]) {
    const added = run(directory, 'host', 'add', alias, '--hostname', integrationHost, '--port', String(integrationPort), '--user', user, '--key', key);
    assert.equal(added.status, 0, added.stderr);
  }
  const server = await startUi({ port: 0, dataFile, openBrowser: async () => {}, log: () => {} });
  try {
    for (const asset of ['/assets/xterm.js', '/assets/xterm.css', '/assets/addon-fit.js']) {
      const response = await fetch(`${server.url}${asset}`);
      assert.equal(response.status, 200);
      assert.ok(Number(response.headers.get('content-length') || '0') >= 0);
    }
    const shellA = await connectWebTerminal(server, 'web-a');
    shellA.resize(111, 37);
    shellA.send('stty size\r');
    await shellA.waitText('37 111');
    shellA.send("printf 'INPUT:'; read -r value; printf 'RECEIVED:%s\\n' \"$value\"\r");
    await shellA.waitText('INPUT:');
    shellA.send('Ada-Lovelace\r');
    await shellA.waitText('RECEIVED:Ada-Lovelace');

    const shellB = await connectWebTerminal(server, 'web-b');
    shellB.send('whoami\r');
    await shellB.waitText('sshdeck2');
    shellA.send('whoami\r');
    await shellA.waitText('sshdeck');
    assert.doesNotMatch(shellA.output(), /sshdeck2/);
    assert.doesNotMatch(shellB.output(), /\nsshdeck\r?\n/);

    const lock = await fetch(`${server.url}/api/lock`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(lock.status, 204);
    shellA.send("printf 'STILL_OPEN\\n'\r");
    await shellA.waitText('STILL_OPEN');

    shellA.send("export SSHDECK_SESSION_MARK=old-session; printf 'OLD_SESSION_SET\\n'\r");
    await shellA.waitText('OLD_SESSION_SET');
    shellA.socket.close(1000, 'test close');
    await new Promise((resolve) => shellA.socket.once('close', resolve));
    assert.equal(shellB.socket.readyState, WebSocket.OPEN, 'closing one PTY must not close another host session');

    const shellARestarted = await connectWebTerminal(server, 'web-a');
    shellARestarted.send("printf 'NEW_SESSION:%s\\n' \"${SSHDECK_SESSION_MARK:-unset}\"\r");
    await shellARestarted.waitText('NEW_SESSION:unset');
    shellARestarted.socket.close(1000, 'test close reopened shell');
    if (shellARestarted.socket.readyState !== WebSocket.CLOSED) await new Promise((resolve) => shellARestarted.socket.once('close', resolve));

    shellB.send('printf "SECOND_SURVIVES\\n"\r');
    await shellB.waitText('SECOND_SURVIVES');
    shellB.send('exit 7\r');
    const remoteExit = await shellB.waitControl((message) => message.type === 'closed');
    assert.equal(remoteExit.code, 7);
    if (shellB.socket.readyState !== WebSocket.CLOSED) await new Promise((resolve) => shellB.socket.once('close', resolve));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('stopping the local service closes its active SSH shell WebSockets', {
  skip: !integrationEnabled && 'Set SSHDECK_TEST_SSH_* variables to run against the isolated OpenSSH test host.',
}, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sshdeck-web-shell-stop-'));
  assert.equal(run(directory, 'host', 'add', 'stop-shell', '--hostname', integrationHost, '--port', String(integrationPort), '--user', 'sshdeck', '--key', integrationKeyA).status, 0);
  const server = await startUi({ port: 0, dataFile: path.join(directory, 'hosts.json'), openBrowser: async () => {}, log: () => {} });
  let socket;
  try {
    const shell = await connectWebTerminal(server, 'stop-shell');
    socket = shell.socket;
    const closed = socket.readyState === WebSocket.CLOSED
      ? Promise.resolve()
      : new Promise((resolve) => socket.once('close', resolve));
    await new Promise((resolve) => server.close(resolve));
    await closed;
    assert.equal(socket.readyState, WebSocket.CLOSED);
  } finally {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('CLI and browser report an unreachable SSH shell without leaving a local terminal open', {
  skip: !integrationEnabled && 'Set SSHDECK_TEST_SSH_* variables to run against the isolated OpenSSH test host.',
}, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sshdeck-shell-offline-'));
  assert.equal(run(directory, 'host', 'add', 'offline-shell', '--hostname', '127.0.0.1', '--port', '1', '--user', 'sshdeck', '--key', integrationKeyA).status, 0);
  const child = spawn(process.execPath, [cli, 'shell', 'offline-shell'], { env: { ...process.env, SSHDECK_HOME: directory }, stdio: ['pipe', 'pipe', 'pipe'] });
  const state = { output: '' };
  child.stdout.on('data', (chunk) => { state.output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { state.output += chunk.toString(); });
  try {
    await waitFor(child, '登入金鑰密語', state);
    child.stdin.write('\n');
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    assert.notEqual(code, 0);
    assert.match(state.output, /SSH 連線失敗/);
    assert.doesNotMatch(state.output, /已連線至 offline-shell/);

    const server = await startUi({ port: 0, dataFile: path.join(directory, 'hosts.json'), openBrowser: async () => {}, log: () => {} });
    try {
      const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/api/shell?alias=offline-shell`, { origin: server.url });
      const controls = [];
      const pendingControls = [];
      socket.on('message', (data, isBinary) => {
        if (isBinary) return;
        let message;
        try { message = JSON.parse(data.toString()); } catch { return; }
        controls.push(message);
        const index = pendingControls.findIndex((item) => item.type === message.type);
        if (index >= 0) { const [waiter] = pendingControls.splice(index, 1); clearTimeout(waiter.timer); waiter.resolve(message); }
      });
      const waitControl = (type) => new Promise((resolve, reject) => {
        const current = controls.find((item) => item.type === type);
        if (current) return resolve(current);
        const waiter = { type, resolve, timer: setTimeout(() => {
          const index = pendingControls.indexOf(waiter);
          if (index >= 0) pendingControls.splice(index, 1);
          reject(new Error(`等待終端機訊息 ${type} 逾時：${JSON.stringify(controls)}`));
        }, 5000) };
        pendingControls.push(waiter);
      });
      await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
      await waitControl('unlock-required');
      socket.send(JSON.stringify({ type: 'unlock', passphrase: '' }));
      const failure = await waitControl('error');
      assert.equal(failure.code, 'SSH_CONNECTION_FAILED');
      assert.match(failure.error, /SSH 連線失敗/);
      socket.close();
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    if (child.exitCode === null) child.kill();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('WebSocket shell endpoint rejects untrusted or missing browser Origin', {
  skip: !integrationEnabled && 'Set SSHDECK_TEST_SSH_* variables to run against the isolated OpenSSH test host.',
}, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sshdeck-ws-origin-'));
  assert.equal(run(directory, 'host', 'add', 'origin', '--hostname', integrationHost, '--port', String(integrationPort), '--user', 'sshdeck', '--key', integrationKeyA).status, 0);
  const server = await startUi({ port: 0, dataFile: path.join(directory, 'hosts.json'), openBrowser: async () => {}, log: () => {} });
  try {
    for (const origin of ['http://attacker.invalid', undefined]) {
      const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/api/shell?alias=origin`, origin ? { origin } : {});
      const result = await new Promise((resolve) => {
        socket.once('open', () => { socket.close(); resolve({ accepted: true }); });
        socket.once('unexpected-response', (_request, response) => { response.resume(); resolve({ accepted: false, status: response.statusCode }); });
        socket.once('error', () => resolve({ accepted: false }));
      });
      assert.equal(result.accepted, false);
      if (origin) assert.equal(result.status, 403);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
