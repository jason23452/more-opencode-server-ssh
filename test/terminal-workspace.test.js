const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startUi } = require('../bin/sshdeck.js');

const browserModule = process.env.SSHDECK_PLAYWRIGHT_MODULE;

test('互動終端機一次只連線到選定主機，切換確認、分頁保留與重連正確', { skip: browserModule ? false : '需設定 Playwright 模組路徑。' }, async () => {
  const { chromium } = require(browserModule);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sshdeck-terminal-ui-'));
  const server = await startUi({ port: 0, dataFile: path.join(directory, 'hosts.json'), openBrowser: async () => {}, log: () => {} });
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const closed = [];
    const inputs = { alpha: [], beta: [] };
    for (const alias of ['alpha', 'beta']) {
      await page.routeWebSocket(new RegExp('/api/shell\\?alias=' + alias + '$'), (socket) => {
        socket.onMessage((message) => inputs[alias].push(Buffer.isBuffer(message) ? message.toString('utf8') : message));
        socket.onClose(() => closed.push(alias));
        socket.send(JSON.stringify({ type: 'started' }));
      });
    }
    let gammaAttempts = 0;
    await page.routeWebSocket(/\/api\/shell\?alias=gamma$/, (socket) => {
      gammaAttempts++;
      socket.send(JSON.stringify({ type: 'error', error: '測試連線失敗' }));
    });
    let deltaClosed = false;
    await page.routeWebSocket(/\/api\/shell\?alias=delta$/, (socket) => {
      socket.onClose(() => { deltaClosed = true; });
    });
    await page.goto(server.url);
    await page.waitForFunction(() => document.querySelector('#hosts-loading').hidden);
    await page.evaluate(() => { window.sshdeck.services.refresh = async () => {}; });
    await page.evaluate(() => window.sshdeck.setHosts([
      { alias: 'alpha', hostname: 'alpha.invalid', port: 22, username: 'tester' },
      { alias: 'beta', hostname: 'beta.invalid', port: 22, username: 'tester' },
    ]));
    assert.equal(await page.evaluate(() => window.sshdeck.selectHost('alpha')), true);
    assert.equal(await page.evaluate(() => window.sshdeck.selectedHost?.alias), 'alpha');
    assert.equal(await page.locator('#connect-host').isDisabled(), false, JSON.stringify(await page.evaluate(() => ({ button: document.querySelector('#connect-host').outerHTML, host: window.sshdeck.selectedHost, status: document.querySelector('#terminal-status').textContent }))));
    await page.locator('#connect-host').click();
    await page.waitForFunction(() => document.querySelector('#terminal-status').textContent.includes('已連線至 alpha'));
    assert.equal(await page.locator('#shell-sessions section').count(), 1);
    await page.evaluate(() => window.sshdeck.setHosts([
      { alias: 'alpha', hostname: 'alpha.invalid', port: 22, username: 'tester' },
      { alias: 'beta', hostname: 'beta.invalid', port: 22, username: 'tester' },
    ]));
    assert.equal(await page.locator('#shell-sessions section').count(), 1);
    await page.locator('#shell-sessions .xterm-helper-textarea').click();
    await page.keyboard.type('whoami');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(50);
    assert(inputs.alpha.join('').includes('whoami'), JSON.stringify(inputs.alpha));
    assert.equal(inputs.beta.length, 0);

    await page.locator('#guide-tab').click();
    await page.locator('#hosts-tab').click();
    assert.equal(await page.locator('#terminal-status').textContent(), '已連線至 alpha');
    assert.equal(await page.locator('#shell-sessions section').count(), 1);

    await page.evaluate(() => { window.confirm = () => false; });
    assert.equal(await page.evaluate(() => window.sshdeck.selectHost('beta')), false);
    assert.equal(await page.evaluate(() => window.sshdeck.selectedHost.alias), 'alpha');
    assert.equal(await page.locator('#shell-sessions section').count(), 1);

    await page.evaluate(() => { window.confirm = () => true; });
    assert.equal(await page.evaluate(() => window.sshdeck.selectHost('beta')), true);
    assert.equal(await page.locator('#shell-sessions section').count(), 0);
    assert.match(await page.locator('#terminal-status').textContent(), /已中斷/);
    await page.waitForTimeout(50);
    assert(closed.includes('alpha'));

    await page.locator('#connect-host').click();
    await page.waitForFunction(() => document.querySelector('#terminal-status').textContent.includes('已連線至 beta'));
    assert.equal(await page.locator('#shell-sessions section').count(), 1);
    await page.locator('#shell-sessions .xterm-helper-textarea').click();
    await page.keyboard.type('pwd');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(50);
    assert(inputs.beta.join('').includes('pwd'));
    assert(!inputs.alpha.join('').includes('pwd'));

    await page.evaluate(() => window.sshdeck.setHosts([{ alias: 'beta', hostname: 'changed.invalid', port: 22, username: 'tester' }]));
    assert.equal(await page.locator('#shell-sessions section').count(), 0);
    assert.match(await page.locator('#terminal-status').textContent(), /設定已修改/);

    await page.locator('#connect-host').click();
    await page.waitForFunction(() => document.querySelector('#terminal-status').textContent.includes('已連線至 beta'));
    await page.locator('#connect-host').click();
    assert.equal(await page.locator('#shell-sessions section').count(), 0);
    assert.match(await page.locator('#terminal-status').textContent(), /已中斷/);
    await page.locator('#connect-host').click();
    await page.waitForFunction(() => document.querySelector('#terminal-status').textContent.includes('已連線至 beta'));
    await page.evaluate(() => window.sshdeck.setHosts([]));
    assert.equal(await page.locator('#shell-sessions section').count(), 0);
    assert.match(await page.locator('#terminal-status').textContent(), /受管主機已刪除/);

    await page.evaluate(() => window.sshdeck.setHosts([
      { alias: 'gamma', hostname: 'gamma.invalid', port: 22, username: 'tester' },
      { alias: 'delta', hostname: 'delta.invalid', port: 22, username: 'tester' },
    ]));
    await page.evaluate(() => window.sshdeck.selectHost('delta'));
    await page.locator('#connect-host').click();
    await page.waitForFunction(() => document.querySelector('#terminal-status').textContent.includes('正在連線至 delta'));
    await page.evaluate(() => { window.confirm = () => true; });
    assert.equal(await page.evaluate(() => window.sshdeck.selectHost('gamma')), true);
    assert.equal(await page.locator('#shell-sessions section').count(), 0);
    assert.match(await page.locator('#terminal-status').textContent(), /已中斷.*gamma/);
    await page.waitForTimeout(50);
    assert.equal(deltaClosed, true);

    await page.evaluate(() => window.sshdeck.selectHost('gamma'));
    await page.locator('#connect-host').click();
    await page.waitForFunction(() => document.querySelector('#terminal-status').textContent.includes('測試連線失敗'));
    assert.equal(await page.locator('#shell-sessions section').count(), 0);
    await page.locator('#connect-host').click();
    await page.waitForFunction(() => document.querySelector('#terminal-status').textContent.includes('測試連線失敗'));
    assert.equal(gammaAttempts, 2);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
