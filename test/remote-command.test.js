const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { parseExecArgs, startUi } = require('../bin/sshdeck');

const integrationHost = process.env.SSHDECK_TEST_SSH_HOST;
const integrationPort = Number(process.env.SSHDECK_TEST_SSH_PORT || 22);
const integrationKeyA = process.env.SSHDECK_TEST_SSH_KEY_A;
const integrationKeyB = process.env.SSHDECK_TEST_SSH_KEY_B;
const integrationHostFingerprint = process.env.SSHDECK_TEST_SSH_FINGERPRINT;
const integrationEnabled = Boolean(integrationHost && integrationKeyA && integrationKeyB && integrationHostFingerprint);

function run(home, ...args) {
  return spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'sshdeck.js'), ...args], {
    encoding: 'utf8', env: { ...process.env, SSHDECK_HOME: home },
  });
}

function waitFor(child, marker, state) {
  return new Promise((resolve, reject) => {
    if (state.output.includes(marker)) return resolve();
    const onData = () => {
      if (state.output.includes(marker)) { child.stdout.off('data', onData); child.stderr.off('data', onData); clearTimeout(timer); resolve(); }
    };
    const timer = setTimeout(() => { child.stdout.off('data', onData); child.stderr.off('data', onData); reject(new Error(`逾時等待 ${marker}：${state.output}`)); }, 5000);
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
  });
}

function runInteractiveExec(home, alias, command, passphrase, trustAnswer, interruptMarker) {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'sshdeck.js'), 'exec', alias, '--', command], {
    env: { ...process.env, SSHDECK_HOME: home },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const state = { output: '' };
  child.stdout.on('data', (chunk) => { state.output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { state.output += chunk.toString(); });
  return (async () => {
    await waitFor(child, '登入金鑰密語', state);
    child.stdin.write(`${passphrase}\n`);
    if (trustAnswer !== undefined) {
      await waitFor(child, '確認信任？', state);
      child.stdin.write(`${trustAnswer}\n`);
    }
    if (interruptMarker) {
      await waitFor(child, interruptMarker, state);
      child.kill('SIGINT');
    }
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    return { code, output: state.output };
  })();
}

function readEvents(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  return {
    async next() {
      while (!pending.includes('\n')) {
        const { value, done } = await reader.read();
        if (done) return null;
        pending += decoder.decode(value, { stream: true });
      }
      const newline = pending.indexOf('\n');
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      return JSON.parse(line);
    },
    cancel() { return reader.cancel(); },
  };
}

test('exec argument parser keeps the remote command as one shell string', () => {
  assert.deepEqual(parseExecArgs(['exec', 'dev', '--', "printf '%s' 'two words; $HOME'"]), {
    alias: 'dev', command: "printf '%s' 'two words; $HOME'",
  });
  assert.throws(() => parseExecArgs(['exec', 'dev', 'printf nope']), /--/);
  assert.throws(() => parseExecArgs(['exec', 'dev', '--']), /不可空白/);
});

test('CLI executes remote command, streams output, and returns the remote exit code', {
  skip: !integrationEnabled && 'Set SSHDECK_TEST_SSH_* variables to run against the isolated OpenSSH test host.',
}, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sshdeck-exec-cli-'));
  try {
    assert.equal(run(directory, 'host', 'add', 'cli-exec', '--hostname', integrationHost, '--port', String(integrationPort), '--user', 'sshdeck', '--key', integrationKeyA).status, 0);
    const result = await runInteractiveExec(directory, 'cli-exec', "printf '%s' 'remote cli output'; printf '%s' 'remote stderr' >&2; exit 7", '', 'y');
    assert.equal(result.code, 7, result.output);
    assert.match(result.output, /目標：cli-exec/);
    assert.match(result.output, /remote cli output/);
    assert.match(result.output, /remote stderr/);
    assert.match(result.output, /結束狀態：7/);
    assert.doesNotMatch(result.output, /C:\\|localhost process/i);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('CLI Ctrl+C cancels only its foreground SSH command', {
  skip: !integrationEnabled && 'Set SSHDECK_TEST_SSH_* variables to run against the isolated OpenSSH test host.',
}, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sshdeck-exec-cli-cancel-'));
  try {
    assert.equal(run(directory, 'host', 'add', 'cancel-cli', '--hostname', integrationHost, '--port', String(integrationPort), '--user', 'sshdeck', '--key', integrationKeyA).status, 0);
    const canceled = await runInteractiveExec(directory, 'cancel-cli', "printf 'cli-started'; sleep 30; printf 'cli-finished'", '', 'y', 'cli-started');
    assert.notEqual(canceled.code, 0);
    assert.match(canceled.output, /cli-started/);
    assert.doesNotMatch(canceled.output, /cli-finished/);
    const recovered = await runInteractiveExec(directory, 'cancel-cli', "printf 'cli-recovered'", '', undefined);
    assert.equal(recovered.code, 0, recovered.output);
    assert.match(recovered.output, /cli-recovered/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('browser exec streams chunks, handles trust confirmation, and isolates concurrent aliases', {
  skip: !integrationEnabled && 'Set SSHDECK_TEST_SSH_* variables to run against the isolated OpenSSH test host.',
}, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sshdeck-exec-ui-'));
  const dataFile = path.join(directory, 'hosts.json');
  const first = run(directory, 'host', 'add', 'one', '--hostname', integrationHost, '--port', String(integrationPort), '--user', 'sshdeck', '--key', integrationKeyA);
  const second = run(directory, 'host', 'add', 'two', '--hostname', integrationHost, '--port', String(integrationPort), '--user', 'sshdeck2', '--key', integrationKeyB);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  const server = await startUi({ port: 0, dataFile, openBrowser: async () => {}, log: () => {} });
  const post = (alias, body) => fetch(`${server.url}/api/hosts/${alias}/check`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
  });
  try {
    const rejectedOrigin = await fetch(`${server.url}/api/exec`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://attacker.invalid' },
      body: JSON.stringify({ alias: 'one', command: "printf 'MUST_NOT_RUN'" }),
    });
    assert.equal(rejectedOrigin.status, 403, 'the command endpoint must retain the browser Origin boundary');

    for (const [alias, passphrase] of [['one', ''], ['two', '']]) {
      const unlocked = await fetch(`${server.url}/api/unlock`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ alias, passphrase }) });
      assert.equal(unlocked.status, 204);
    }
    const firstResponse = await fetch(`${server.url}/api/exec`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ alias: 'one', command: 'printf initial' }) });
    assert.equal(firstResponse.status, 409);
    const challenge = await firstResponse.json();
    assert.equal(challenge.code, 'HOST_TRUST_REQUIRED');

    const command = "printf 'first'; sleep 1; printf ' second'; printf ' problem' >&2; exit 7";
    const startedAt = Date.now();
    const response = await fetch(`${server.url}/api/exec`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ alias: 'one', command, expectedFingerprint: challenge.fingerprint }) });
    assert.equal(response.status, 200);
    const events = readEvents(response);
    const firstEvent = await events.next();
    assert.deepEqual(firstEvent, { type: 'stdout', data: 'first' });
    assert(Date.now() - startedAt < 900, 'the first output chunk should arrive before the remote command completes');
    const received = [firstEvent];
    let event;
    while ((event = await events.next())) received.push(event);
    assert(received.some((item) => item.type === 'stdout' && item.data.includes('second')));
    assert(received.some((item) => item.type === 'stderr' && item.data.includes('problem')));
    assert.deepEqual(received.at(-1), { type: 'exit', code: 7 });

    const unicode = await fetch(`${server.url}/api/exec`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ alias: 'one', command: "printf '\\344'; sleep 0.1; printf '\\275\\240'" }) });
    assert.equal(unicode.status, 200);
    const unicodeEvents = readEvents(unicode);
    const unicodeChunks = [];
    let unicodeEvent;
    while ((unicodeEvent = await unicodeEvents.next())) unicodeChunks.push(unicodeEvent);
    assert.equal(unicodeChunks.filter((item) => item.type === 'stdout').map((item) => item.data).join(''), '你');

    const concurrent = await Promise.all([
      fetch(`${server.url}/api/exec`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ alias: 'one', command: "printf 'from-one'" }) }),
      fetch(`${server.url}/api/exec`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ alias: 'two', command: "printf 'from-two'" }) }),
    ]);
    const outputs = await Promise.all(concurrent.map(async (item) => {
      assert.equal(item.status, 200);
      const stream = readEvents(item);
      const chunks = [];
      let next;
      while ((next = await stream.next())) chunks.push(next);
      return chunks;
    }));
    assert(outputs[0].some((item) => item.data === 'from-one'));
    assert(outputs[1].some((item) => item.data === 'from-two'));
    assert(!outputs[0].some((item) => item.data === 'from-two'));
    assert(!outputs[1].some((item) => item.data === 'from-one'));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('browser cancellation aborts the local SSH channel without replaying the command', {
  skip: !integrationEnabled && 'Set SSHDECK_TEST_SSH_* variables to run against the isolated OpenSSH test host.',
}, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sshdeck-exec-cancel-'));
  const dataFile = path.join(directory, 'hosts.json');
  assert.equal(run(directory, 'host', 'add', 'cancel', '--hostname', integrationHost, '--port', String(integrationPort), '--user', 'sshdeck', '--key', integrationKeyA).status, 0);
  const server = await startUi({ port: 0, dataFile, openBrowser: async () => {}, log: () => {} });
  const controller = new AbortController();
  try {
    const unlocked = await fetch(`${server.url}/api/unlock`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ alias: 'cancel', passphrase: '' }) });
    assert.equal(unlocked.status, 204);
    const initial = await fetch(`${server.url}/api/exec`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ alias: 'cancel', command: 'printf ping' }) });
    const challenge = await initial.json();
    assert.equal(initial.status, 409);
    const running = fetch(`${server.url}/api/exec`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ alias: 'cancel', command: "printf 'started'; sleep 10; printf 'should-not-appear'", expectedFingerprint: challenge.fingerprint }), signal: controller.signal });
    const response = await running;
    assert.equal(response.status, 200);
    const events = readEvents(response);
    assert.deepEqual(await events.next(), { type: 'stdout', data: 'started' });
    controller.abort();
    await assert.rejects(events.next(), (error) => error.name === 'AbortError');
    await delay(100);

    const followup = await fetch(`${server.url}/api/exec`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ alias: 'cancel', command: "printf 'still-usable'" }) });
    assert.equal(followup.status, 200);
    const followupEvents = readEvents(followup);
    const chunks = [];
    let next;
    while ((next = await followupEvents.next())) chunks.push(next);
    assert(chunks.some((item) => item.data === 'still-usable'));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('unreachable SSH endpoint fails clearly and the command is not run locally or retried', {
  skip: !integrationEnabled && 'Set SSHDECK_TEST_SSH_* variables to run against the isolated OpenSSH test host.',
}, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sshdeck-exec-offline-'));
  try {
    assert.equal(run(directory, 'host', 'add', 'offline', '--hostname', '127.0.0.1', '--port', '1', '--user', 'sshdeck', '--key', integrationKeyA).status, 0);
    const cli = await runInteractiveExec(directory, 'offline', 'printf MUST_NOT_RUN', '');
    assert.notEqual(cli.code, 0);
    assert.match(cli.output, /SSH 連線失敗/);
    assert.doesNotMatch(cli.output, /MUST_NOT_RUN/);

    const dataFile = path.join(directory, 'hosts.json');
    const server = await startUi({ port: 0, dataFile, openBrowser: async () => {}, log: () => {} });
    try {
      const unlocked = await fetch(`${server.url}/api/unlock`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ alias: 'offline', passphrase: '' }) });
      assert.equal(unlocked.status, 204);
      const response = await fetch(`${server.url}/api/exec`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ alias: 'offline', command: 'printf MUST_NOT_RUN' }) });
      assert.equal(response.status, 502);
      const result = await response.json();
      assert.equal(result.code, 'SSH_CONNECTION_FAILED');
      assert.doesNotMatch(JSON.stringify(result), /MUST_NOT_RUN/);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
