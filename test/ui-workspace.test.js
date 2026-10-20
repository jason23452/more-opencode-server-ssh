const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startUi } = require('../bin/sshdeck.js');

// 使用外部安裝的 Playwright，避免只為介面驗證增加執行期相依套件。
const browserModule = process.env.SSHDECK_PLAYWRIGHT_MODULE;
test('工作區保留選取與輸入，分頁不重建終端，窄螢幕可用鍵盤導覽', {
  skip: browserModule ? false : '設定 SSHDECK_PLAYWRIGHT_MODULE 為 playwright 模組路徑以執行瀏覽器驗證。',
}, async () => {
  const { chromium } = require(browserModule);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sshdeck-workspace-'));
  const server = await startUi({ port: 0, dataFile: path.join(directory, 'hosts.json'), openBrowser: async () => {}, log: () => {} });
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    let sshRequests = 0;
    page.on('request', (request) => { if (/\/check$|\/api\/shell/.test(request.url())) sshRequests++; });
    page.on('websocket', () => sshRequests++);
    await page.goto(server.url);
    await page.locator('#empty-hosts').waitFor({ state: 'visible' });
    assert.deepEqual(await page.getByRole('tab').allTextContents(), ['主機操作', '建立指南']);
    await page.getByRole('button', { name: '開始建立指南' }).click();
    assert.equal(await page.locator('#guide-panel').isVisible(), true);
    await page.locator('[name="alias"]').fill('未送出的草稿');
    await page.getByRole('tab', { name: '主機操作' }).click();
    const add = (host) => fetch(server.url + '/api/hosts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(host) });
    assert.equal((await add({ alias: 'unfinished', hostname: 'missing.invalid', port: 22, username: 'alice' })).status, 201);
    assert.equal((await add({ alias: 'unreachable', hostname: '127.0.0.1', port: 1, username: 'bob' })).status, 201);
    await page.evaluate(() => window.sshdeck.services.refresh());
    assert.equal(await page.locator('#hosts > li').count(), 2);
    await page.getByRole('button', { name: 'unfinished — alice@missing.invalid:22', exact: true }).click();
    assert.equal(await page.locator('#target-alias').textContent(), 'unfinished');
    assert.equal(await page.locator('#target-address').textContent(), 'missing.invalid:22');
    assert.equal(await page.locator('#target-username').textContent(), 'alice');
    assert.equal(sshRequests, 0);
    await page.locator('#advanced-management summary').click();
    await page.getByRole('button', { name: '開啟既有主機與金鑰管理', exact: true }).click();
    assert.equal(await page.locator('#legacy-management').getAttribute('open'), '');
    for (const text of ['檢查 SSH', '開啟互動終端機', '編輯', '刪除', '檢視公鑰', '授權／撤銷指南', '建立登入金鑰']) {
      assert.equal(await page.locator('#host-management').getByRole('button', { name: text, exact: true }).count(), 2);
    }
    assert.equal(await page.locator('#lock-keys').isVisible(), true);
    assert.equal(await page.locator('#exec-form').isVisible(), true);
    await page.evaluate(() => { window.sshdeck.services.beforeSelectHost = async () => false; });
    await page.getByRole('button', { name: 'unreachable — bob@127.0.0.1:1', exact: true }).click();
    assert.equal(await page.locator('#target-alias').textContent(), 'unfinished');
    await page.evaluate(() => { delete window.sshdeck.services.beforeSelectHost; });
    await page.evaluate(() => {
      window.savedTerminal = document.querySelector('#shell-sessions');
      const marker = document.createElement('input');
      marker.id = 'terminal-state-marker';
      marker.value = '保留的終端子功能狀態';
      window.savedTerminal.append(marker);
      document.querySelector('#exec-host').value = 'unreachable';
      document.querySelector('#exec-command').value = '尚未執行的遠端命令';
    });
    await page.getByRole('tab', { name: '建立指南' }).click();
    assert.equal(await page.locator('[name="alias"]').inputValue(), '未送出的草稿');
    await page.evaluate(() => window.sshdeck.services.refresh());
    await page.getByRole('tab', { name: '主機操作' }).click();
    assert.equal(await page.evaluate(() => window.savedTerminal === document.querySelector('#shell-sessions')), true);
    assert.equal(await page.locator('#terminal-state-marker').inputValue(), '保留的終端子功能狀態');
    assert.equal(await page.locator('#target-alias').textContent(), 'unfinished');
    assert.equal(await page.locator('#exec-command').inputValue(), '尚未執行的遠端命令');
    assert.equal(await page.locator('#exec-host').inputValue(), 'unreachable');
    await page.locator('#hosts button').first().focus();
    await page.evaluate(() => window.sshdeck.services.refresh());
    assert.equal(await page.evaluate(() => document.activeElement.closest('#hosts') !== null), true);
    await page.getByRole('button', { name: 'unreachable — bob@127.0.0.1:1', exact: true }).click();
    assert.equal(await page.locator('#target-alias').textContent(), 'unreachable');
    assert.equal(sshRequests, 0);
    await fetch(server.url + '/api/hosts/unreachable', { method: 'DELETE' });
    await page.evaluate(() => window.sshdeck.services.refresh());
    assert.equal(await page.locator('#host-workspace').isVisible(), false);
    assert.equal(await page.locator('#target-alias').textContent(), '');
    assert.equal(await page.locator('#connect-host').isDisabled(), true);
    await page.getByRole('tab', { name: '主機操作' }).focus();
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.getByRole('tab', { name: '建立指南' }).getAttribute('aria-selected'), 'true');
    await page.keyboard.press('Home');
    assert.equal(await page.getByRole('tab', { name: '主機操作' }).getAttribute('aria-selected'), 'true');
    for (const width of [375, 320]) {
      await page.setViewportSize({ width, height: 800 });
      await page.locator('#navigation-toggle').focus();
      await page.keyboard.press('Enter');
      assert.equal(await page.locator('#navigation').isVisible(), true);
      await page.keyboard.press('Tab');
      await page.keyboard.press('ArrowDown');
      assert.equal(await page.locator('#guide-panel').isVisible(), true);
      assert.equal(await page.locator('#navigation-toggle').getAttribute('aria-expanded'), 'false');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'guide-panel');
      await page.evaluate(() => { document.querySelector('#key-output').textContent = '長指令'.repeat(1000); });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
      await page.evaluate(() => window.sshdeck.showPage('hosts'));
    }
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
