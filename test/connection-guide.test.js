const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startUi } = require('../bin/sshdeck.js');
const ssh = require('../lib/ssh');

const browserModule = process.env.SSHDECK_PLAYWRIGHT_MODULE;
test('建立指南驗證四步流程、新舊金鑰、授權及主動檢查結果', {
  skip: browserModule ? false : '設定 SSHDECK_PLAYWRIGHT_MODULE 為 Playwright 模組絕對路徑以執行 Chromium 驗證。',
}, async () => {
  const { chromium } = require(browserModule);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sshdeck-guide-'));
  const dataFile = path.join(directory, 'hosts.json');
  const existingKey = ssh.createManagedKey(dataFile, 'existing-seed', 'seed passphrase', {});
  const server = await startUi({ port: 0, dataFile, openBrowser: async () => {}, log: () => {} });
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ permissions: ['clipboard-read', 'clipboard-write'] });
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.route(/\/api\/hosts\/[^/]+\/ssh-check$/, (route) => route.fulfill({ status: 428, contentType: 'application/json', body: JSON.stringify({ code: 'NEEDS_UNLOCK', error: '需解鎖測試金鑰' }) }));
    await page.goto(server.url);
    await page.evaluate(async () => fetch('/api/hosts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ alias: 'collision', hostname: 'other.invalid', port: 22, username: 'alice' }) }));
    await page.getByRole('button', { name: '開始建立指南' }).click();
    assert.equal(await page.locator('#form').count(), 0);
    await page.getByRole('button', { name: '下一步' }).click();
    assert.equal(await page.locator('[name="alias"]').count(), 1, '缺少欄位不能離開第一步');
    await page.locator('[name="alias"]').fill('collision');
    await page.locator('[name="hostname"]').fill('unreachable.invalid');
    await page.locator('[name="username"]').fill('alice');
    await page.getByRole('button', { name: '下一步' }).click();
    await page.waitForFunction(() => document.querySelector('[name="alias"]')?.validationMessage.includes('已用於其他連線資料'));
    assert.equal(await page.locator('#guide-step-title').textContent().then((text) => /步驟 1/.test(text)), true, '別名衝突不可離開連線資料步驟');
    assert.match(await page.locator('[name="alias"]').evaluate((input) => input.validationMessage), /已用於其他連線資料/);
    await page.locator('[name="alias"]').fill('new-guide');
    await page.getByRole('button', { name: '下一步' }).click();
    await page.locator('#guide-step-title').filter({ hasText: '步驟 2' }).waitFor();
    await page.getByRole('button', { name: '上一步' }).click();
    assert.equal(await page.locator('[name="alias"]').inputValue(), 'new-guide');
    await page.getByRole('button', { name: '下一步' }).click();
    await page.getByRole('button', { name: '下一步' }).click();
    await page.getByLabel('新 Ed25519 金鑰密語').fill('test passphrase');
    await page.getByLabel('再次輸入密語').fill('test passphrase');
    await page.getByRole('button', { name: '建立金鑰', exact: true }).click();
    await page.locator('#guide-step-title').filter({ hasText: '步驟 3' }).waitFor();
    assert.match(await page.locator('#guide-step-title').textContent(), /步驟 3/);
    assert.match(await page.locator('#connection-guide-app pre').textContent(), /ssh-ed25519/);
    assert.doesNotMatch(await page.locator('#connection-guide-app').innerText(), /遠端撤銷/);
    await page.getByLabel(/我已在目標 Linux 主機嘗試完成授權/).check();
    await page.getByRole('button', { name: '下一步' }).click();
    await page.getByRole('button', { name: '上一步' }).click();
    await page.getByRole('button', { name: '上一步' }).click();
    await page.locator('summary', { hasText: '使用既有登入金鑰' }).click();
    await page.getByLabel('使用既有金鑰').check();
    await page.locator('[name="keyPath"]').fill(existingKey.keyPath);
    await page.getByRole('button', { name: '下一步' }).click();
    await page.waitForTimeout(100);
    assert.match(await page.locator('#guide-step-title').textContent(), /步驟 3/, JSON.stringify({ title: await page.locator('#guide-step-title').textContent(), alert: await page.getByRole('alert').textContent().catch(() => '') }));
    assert.equal(await page.locator('#connection-guide-app input[type="checkbox"]').isChecked(), false, '更換登入金鑰後需重新確認遠端授權');
    await page.setViewportSize({ width: 320, height: 800 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.setViewportSize({ width: 1280, height: 900 });
    assert.equal(await page.locator('#connection-guide-app input[type="checkbox"]').isChecked(), false);
    await page.getByRole('button', { name: '下一步' }).click();
    assert.match(await page.locator('#guide-step-title').textContent(), /步驟 3/);
    assert.match(await page.getByRole('alert').textContent(), /請先在目標 Linux 主機/);
    await page.getByRole('button', { name: '複製授權指令' }).click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()).then((value) => value.includes('authorized_keys')), true);
    await page.getByLabel(/我已在目標 Linux 主機嘗試完成授權/).check();
    await page.getByRole('button', { name: '下一步' }).click();
    assert.match(await page.locator('#guide-step-title').textContent(), /步驟 4/);
    await page.evaluate(() => {
      window.sshdeck.services.checkHost = async () => {
        window.guideCheckCount = (window.guideCheckCount || 0) + 1;
        if (window.guideCheckCount === 1) { const error = new Error('connect ETIMEDOUT 198.51.100.1'); error.code = 'ETIMEDOUT'; throw error; }
        return { ssh: true, docker: { available: false } };
      };
    });
    await page.getByRole('button', { name: '檢查連線' }).click();
    await page.getByRole('alert').waitFor();
    assert.match(await page.getByRole('alert').textContent(), /無法連到主機/);
    assert.equal(await page.locator('#connection-guide-app details').getAttribute('open'), null);
    assert.match(await page.locator('#connection-guide-app details pre').textContent(), /ETIMEDOUT/);
    assert.equal(await page.locator('[name="alias"]').count(), 0, '失敗停留檢查步驟並保留狀態');
    await page.getByRole('button', { name: '檢查連線' }).click();
    await page.getByRole('button', { name: '前往主機操作' }).waitFor();
    await page.getByRole('button', { name: '前往主機操作' }).click();
    assert.equal(await page.locator('#hosts-panel').isVisible(), true);
    assert.equal(await page.locator('#target-alias').textContent(), 'new-guide');
    assert.equal(await page.locator('#terminal-status').textContent(), '尚未開啟終端機');
    assert.equal(await page.evaluate(() => window.guideCheckCount), 2);
    const firstProgress = await page.evaluate(() => JSON.parse(localStorage.getItem('sshdeck.connection-guide.v1')));
    assert.deepEqual(Object.keys(firstProgress.hosts), ['new-guide']);
    assert.equal(firstProgress.draft, undefined, '建立受管主機後，未建立草稿應轉為主機進度');
    assert.doesNotMatch(JSON.stringify(firstProgress), /test passphrase|ssh-ed25519|authorized_keys|PRIVATE KEY/);
    assert.equal(await page.locator('body').innerText().then((value) => value.includes('test passphrase')), false);

    // Existing-key flow: the path belongs to the sshdeck process host; no secret enters persistent browser storage.
    await page.evaluate(async (keyPath) => fetch('/api/hosts', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ alias: 'existing-guide', hostname: 'example.invalid', port: 22, username: 'bob', keyPath }),
    }), existingKey.keyPath);
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#hosts-loading').hidden);
    await page.getByRole('tab', { name: '建立指南' }).click();
    await page.getByRole('button', { name: '開始新的建立指南' }).click();
    await page.locator('[name="alias"]').fill('existing-guide');
    await page.locator('[name="hostname"]').fill('example.invalid');
    await page.locator('[name="username"]').fill('bob');
    await page.getByRole('button', { name: '下一步' }).click();
    await page.locator('#guide-step-title').filter({ hasText: '步驟 2' }).waitFor();
    assert.equal(await page.locator('input[name="key-mode"][value="existing"]').isChecked(), true, '已關聯登入金鑰的主機應明確沿用既有金鑰');
    assert.equal(await page.locator('[name="keyPath"]').inputValue(), existingKey.keyPath);
    await page.getByLabel('使用既有金鑰').check();
    await page.locator('[name="keyPath"]').fill(existingKey.keyPath);
    assert.match(await page.locator('#connection-guide-app').textContent(), /執行 sshdeck 的電腦/);
    await page.getByRole('button', { name: '下一步' }).click();
    await page.locator('#guide-step-title').filter({ hasText: '步驟 3' }).waitFor();
    assert.match(await page.locator('#connection-guide-app pre').textContent(), /ssh-ed25519/);
    await page.getByLabel(/我已在目標 Linux 主機嘗試完成授權/).check();
    await page.getByRole('button', { name: '下一步' }).click();
    await page.evaluate(() => { window.sshdeck.services.checkHost = async () => ({ ssh: true, docker: { state: 'unavailable' } }); });
    await page.getByRole('button', { name: '檢查連線' }).click();
    await page.getByRole('button', { name: '前往主機操作' }).waitFor();
    const progress = await page.evaluate(() => JSON.parse(localStorage.getItem('sshdeck.connection-guide.v1')));
    assert.deepEqual(new Set(Object.keys(progress.hosts)), new Set(['new-guide', 'existing-guide']));
    assert.equal(progress.hosts['existing-guide'].keyPath, existingKey.keyPath);
    assert.doesNotMatch(JSON.stringify(progress), /test passphrase|ssh-ed25519|authorized_keys|PRIVATE KEY/);

    await page.reload();
    await page.waitForFunction(() => document.querySelector('#hosts-loading').hidden);
    await page.getByRole('tab', { name: '建立指南' }).click();
    assert.match(await page.locator('#guide-step-title').textContent(), /步驟 4/);
    assert.match(await page.locator('#connection-guide-app').textContent(), /歷史檢查/);
    assert.equal(await page.locator('#terminal-status').textContent(), '尚未開啟終端機');
    await page.getByRole('button', { name: '開始新的建立指南' }).click();
    await page.getByText('接續其他受管主機的建立指南進度').click();
    await page.getByRole('button', { name: /接續 new-guide/ }).click();
    assert.match(await page.locator('#guide-step-title').textContent(), /步驟 4/);
    await page.getByRole('button', { name: '開始新的建立指南' }).click();
    await page.getByText('接續其他受管主機的建立指南進度').click();
    await page.getByRole('button', { name: /接續 existing-guide/ }).click();
    assert.match(await page.locator('#guide-step-title').textContent(), /步驟 4/);

    await page.evaluate(async () => {
      const current = await (await fetch('/api/hosts')).json();
      const host = current.find((item) => item.alias === 'existing-guide');
      await fetch('/api/hosts/existing-guide', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...host, hostname: 'changed.invalid' }) });
      await window.sshdeck.services.refresh();
    });
    assert.match(await page.locator('#guide-step-title').textContent(), /步驟 3/);
    assert.equal(await page.locator('#connection-guide-app input[type="checkbox"]').isChecked(), false, '連線資料變更後不得沿用舊授權確認');
    await page.evaluate(async () => {
      await fetch('/api/hosts/existing-guide/key/unlink', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      await window.sshdeck.services.refresh();
    });
    assert.match(await page.locator('#guide-step-title').textContent(), /步驟 2/);
    assert.equal(await page.locator('#connection-guide-app input[type="checkbox"]').count(), 0);
    await page.evaluate(async () => {
      await fetch('/api/hosts/existing-guide', { method: 'DELETE' });
      await window.sshdeck.services.refresh();
    });
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('sshdeck.connection-guide.v1')).hosts['existing-guide']), undefined);
    await page.getByText('接續其他受管主機的建立指南進度').click();
    await page.getByRole('button', { name: /接續 new-guide/ }).click();
    assert.match(await page.locator('#guide-step-title').textContent(), /步驟 4/);
    assert.match(await page.locator('#connection-guide-app').textContent(), /歷史檢查/);
    assert.deepEqual(pageErrors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('指南進度資料損壞或瀏覽器拒絕寫入時仍可使用', {
  skip: browserModule ? false : '設定 SSHDECK_PLAYWRIGHT_MODULE 為 Playwright 模組絕對路徑以執行 Chromium 驗證。',
}, async () => {
  const { chromium } = require(browserModule);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sshdeck-guide-storage-'));
  const server = await startUi({ port: 0, dataFile: path.join(directory, 'hosts.json'), openBrowser: async () => {}, log: () => {} });
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(server.url);
    await page.waitForFunction(() => document.querySelector('#hosts-loading').hidden);
    await page.evaluate(() => localStorage.setItem('sshdeck.connection-guide.v1', '{broken json'));
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#hosts-loading').hidden);
    await page.getByRole('tab', { name: '建立指南' }).click();
    await page.locator('.guide-storage-warning').waitFor();
    assert.equal(await page.evaluate(() => localStorage.getItem('sshdeck.connection-guide.v1')), null);

    await page.evaluate(() => { Storage.prototype.setItem = () => { throw new DOMException('storage blocked', 'SecurityError'); }; });
    await page.locator('[name="alias"]').fill('storage-host');
    await page.locator('[name="hostname"]').fill('storage.invalid');
    await page.locator('[name="username"]').fill('tester');
    await page.getByRole('button', { name: '下一步' }).click();
    await page.locator('#guide-step-title').filter({ hasText: '步驟 2' }).waitFor();
    assert.match(await page.locator('.guide-storage-warning').textContent(), /仍可繼續/);
    assert.equal((await (await fetch(`${server.url}/api/hosts`)).json()).some((host) => host.alias === 'storage-host'), true);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
