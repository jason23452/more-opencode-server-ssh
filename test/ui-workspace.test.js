const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { startUi } = require('../bin/sshdeck.js');
const ssh = require('../lib/ssh');

// 使用外部安裝的 Playwright，避免只為介面驗證增加執行期相依套件。
const browserModule = process.env.SSHDECK_PLAYWRIGHT_MODULE;
test('建立指南資源使用版本網址並停用瀏覽器快取', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sshdeck-assets-'));
  const server = await startUi({ port: 0, dataFile: path.join(directory, 'hosts.json'), openBrowser: async () => {}, log: () => {} });
  try {
    const page = await fetch(server.url);
    const html = await page.text();
    assert.match(html, /workspace\.css\?v=2/);
    assert.match(html, /connection-guide\.js\?v=2/);
    const inlineScript = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    assert.ok(inlineScript, '頁面包含初始化服務的內嵌腳本');
    assert.doesNotThrow(() => new vm.Script(inlineScript), '伺服器輸出的內嵌腳本必須可解析');
    for (const asset of ['/assets/workspace.css?v=2', '/assets/connection-guide.js?v=2']) {
      const response = await fetch(new URL(asset, server.url));
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('工作區保留選取與輸入，分頁不重建終端，窄螢幕可用鍵盤導覽', {
  skip: browserModule ? false : '設定 SSHDECK_PLAYWRIGHT_MODULE 為 playwright 模組路徑以執行瀏覽器驗證。',
}, async () => {
  const { chromium } = require(browserModule);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sshdeck-workspace-'));
  const dataFile = path.join(directory, 'hosts.json');
  const managedKey = ssh.createManagedKey(dataFile, 'workspace-key', 'test passphrase', {});
  const server = await startUi({ port: 0, dataFile, openBrowser: async () => {}, log: () => {} });
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
    assert.equal((await add({ alias: 'unfinished', hostname: 'missing.invalid', port: 22, username: 'alice', keyPath: managedKey.keyPath })).status, 201);
    assert.equal((await add({ alias: 'unreachable', hostname: '127.0.0.1', port: 1, username: 'bob' })).status, 201);
    await page.evaluate(() => window.sshdeck.services.refresh());
    assert.equal(await page.locator('#hosts > li').count(), 2);
    await page.getByRole('button', { name: 'unfinished — alice@missing.invalid:22', exact: true }).click();
    assert.equal(await page.locator('#target-alias').textContent(), 'unfinished');
    assert.equal(await page.locator('#target-address').textContent(), 'missing.invalid:22');
    assert.equal(await page.locator('#target-username').textContent(), 'alice');
    assert.equal(sshRequests, 0);
    await page.locator('#advanced-management > summary').click();
    await page.locator('#selected-host-actions h3').waitFor();
    await page.getByRole('button', { name: '全域登入金鑰管理', exact: true }).click();
    assert.equal(await page.locator('#legacy-management').getAttribute('open'), '');
    for (const text of ['檢查 SSH 與 Docker', '編輯', '刪除', '檢視公鑰', '授權／撤銷指南', '刪除本機金鑰', '解除此主機關聯']) {
      assert.equal(await page.locator('#selected-host-actions').getByRole('button', { name: text, exact: true }).count(), 1);
    }
    assert.equal(await page.locator('#host-management').count(), 0, '主機管理操作已集中至選定主機的進階入口');
    assert.equal(await page.locator('#lock-keys').isVisible(), true);
    await page.locator('#advanced-exec summary').click();
    assert.equal(await page.locator('#exec-form').isVisible(), true);
    await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => { window.copiedGuide = text; } } }); });
    await page.locator('#selected-host-actions').getByRole('button', { name: '授權／撤銷指南' }).click();
    await page.getByRole('button', { name: '複製授權指令' }).click();
    assert.match(await page.evaluate(() => window.copiedGuide), /authorized_keys/);
    assert.doesNotMatch(await page.evaluate(() => window.copiedGuide), /手動安裝|登入帳號：|Docker 權限指南|遠端撤銷/);
    await page.route('**/api/exec', (route) => route.fulfill({
      status: 200,
      headers: { 'content-type': 'application/x-ndjson' },
      body: '{"type":"stdout","data":"mock remote output"}\n{"type":"exit","code":0}\n',
    }));
    await page.locator('#exec-command').fill('hostname');
    await page.locator('#exec-form button').click();
    await page.locator('#exec-sessions section').waitFor();
    assert.match(await page.locator('#exec-sessions section h3').textContent(), /unfinished.*alice@missing.invalid:22/);
    assert.match(await page.locator('#exec-sessions section pre').textContent(), /mock remote output/);
    await page.unroute('**/api/exec');
    await page.evaluate(() => {
      const originalFetch = window.fetch.bind(window);
      window.execResponseStarted = false;
      window.execRequestAborted = false;
      window.fetch = (url, options = {}) => {
        if (new URL(url, location.href).pathname === '/api/exec') return new Promise((resolve, reject) => {
          window.execResponseStarted = true;
          options.signal.addEventListener('abort', () => { window.execRequestAborted = true; reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
        });
        return originalFetch(url, options);
      };
    });
    await page.locator('#exec-command').fill('sleep 30');
    await page.locator('#exec-form button').click();
    const pendingCommand = page.locator('#exec-sessions section').filter({ hasText: 'sleep 30' });
    await page.waitForFunction(() => window.execResponseStarted);
    await pendingCommand.getByRole('button', { name: '取消此命令' }).click({ timeout: 1000 });
    await pendingCommand.locator('pre').filter({ hasText: '已取消' }).waitFor();
    assert.equal(await page.evaluate(() => window.execRequestAborted), true);
    await page.evaluate(() => {
      window.dockerCheckAlias = null;
      window.sshdeck.services.checkHost = async (host) => { window.dockerCheckAlias = host.alias; return { ok: true, docker: { state: 'available' } }; };
    });
    await page.locator('#selected-host-actions').getByRole('button', { name: '檢查 SSH 與 Docker' }).click();
    await page.waitForFunction(() => window.dockerCheckAlias === 'unfinished');
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
    assert.match(await page.locator('#exec-target-hint').textContent(), /unfinished.*alice@missing.invalid:22/);
    await page.locator('#hosts button').first().focus();
    await page.evaluate(() => window.sshdeck.services.refresh());
    assert.equal(await page.evaluate(() => document.activeElement.closest('#hosts') !== null), true);
    await page.getByRole('button', { name: 'unreachable — bob@127.0.0.1:1', exact: true }).click();
    await page.locator('#selected-host-actions h3').filter({ hasText: 'unreachable' }).waitFor();
    assert.equal(await page.locator('#target-alias').textContent(), 'unreachable');
    assert.match(await page.locator('#exec-target-hint').textContent(), /unreachable.*bob@127.0.0.1:1/);
    assert.equal(sshRequests, 0);
    await page.evaluate(() => { window.prompt = (label) => ({ '主機名稱': 'changed.invalid', '連接埠': '2222', '登入帳號': 'bob2', '既有金鑰路徑': '' })[label] ?? null; });
    await page.locator('#selected-host-actions').getByRole('button', { name: '編輯', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#target-address').textContent === 'changed.invalid:2222');
    assert.equal(await page.locator('#target-username').textContent(), 'bob2');
    await page.evaluate(() => { window.confirm = () => true; });
    await page.locator('#selected-host-actions').getByRole('button', { name: '刪除', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#host-workspace').hidden);
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
