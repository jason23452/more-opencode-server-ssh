const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startUi } = require('../bin/sshdeck.js');

const browserModule = process.env.SSHDECK_PLAYWRIGHT_MODULE;
test('SSH 狀態檢查共用請求並保留工作區互動狀態', { skip: browserModule ? false : '需設定 Playwright 模組路徑。' }, async () => {
  const { chromium } = require(browserModule);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sshdeck-status-'));
  const server = await startUi({ port: 0, dataFile: path.join(directory, 'hosts.json'), openBrowser: async () => {}, log: () => {} });
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(server.url);
    await page.evaluate(() => {
      let finish;
      window.checkCalls = 0;
      const check = () => { window.checkCalls++; return new Promise((resolve) => { finish = resolve; }); };
      window.sshdeck.services.checkSSH = check;
      window.sshdeck.services.checkHost = check;
      window.finishCheck = () => finish({ fingerprint: 'test' });
      window.sshdeck.setHosts([{ alias: 'sample', hostname: 'host.invalid', port: 22, username: 'tester', keyPath: 'key' }]);
      window.sshdeck.selectHost('sample');
    });
    await page.waitForFunction(() => window.checkCalls === 1);
    await page.locator('#check-selected-host').click({ timeout: 1000 }).catch(() => {});
    assert.equal(await page.evaluate(() => window.checkCalls), 1);
    await page.evaluate(() => window.finishCheck());
    await page.waitForFunction(() => document.querySelector('.host-status').dataset.state === 'success');
    const before = await page.locator('.host-status').textContent();
    assert.match(before, /成功/);
    assert.match(before, /不代表終端機已連線/);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
