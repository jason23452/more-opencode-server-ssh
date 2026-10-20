const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { statusForHost } = require('../lib/ssh');

test('只對應目前連線設定顯示 SSH 檢查結果', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sshdeck-status-profile-'));
  const dataFile = path.join(directory, 'hosts.json');
  const host = { alias: 'sample', hostname: 'host.example', port: 22, username: 'tester', keyPath: '~/.ssh/id_ed25519' };
  try {
    fs.writeFileSync(`${dataFile}.checks.json`, JSON.stringify({
      sample: {
        state: 'success', checkedAt: '2026-10-20T00:00:00.000Z',
        profile: JSON.stringify([host.hostname, host.port, host.username, host.keyPath]),
      },
    }));

    assert.deepEqual(statusForHost(dataFile, host), { state: 'success', checkedAt: '2026-10-20T00:00:00.000Z' });
    assert.deepEqual(statusForHost(dataFile, { ...host, hostname: 'changed.example' }), { state: 'unchecked' });
    assert.deepEqual(statusForHost(dataFile, { ...host, keyPath: '' }), { state: 'unchecked' });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
