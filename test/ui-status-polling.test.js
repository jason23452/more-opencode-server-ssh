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

test('狀態檢查忽略舊設定回應，解鎖取消及指紋拒絕不誤報紅綠燈', { skip: browserModule ? false : '需設定 Playwright 模組路徑。' }, async () => {
  const { chromium } = require(browserModule);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sshdeck-status-race-'));
  const server = await startUi({ port: 0, dataFile: path.join(directory, 'hosts.json'), openBrowser: async () => {}, log: () => {} });
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(server.url);
    await page.evaluate(() => {
      window.pendingChecks = [];
      window.sshdeck.services.checkSSH = () => new Promise((resolve) => window.pendingChecks.push(resolve));
      window.sshdeck.services.checkHost = async () => undefined;
      const host = { alias: 'sample', hostname: 'old.invalid', port: 22, username: 'tester', keyPath: 'key' };
      window.sshdeck.setHosts([host]);
    });
    await page.waitForFunction(() => window.pendingChecks.length === 1);
    await page.evaluate(() => window.sshdeck.setHosts([{ alias: 'sample', hostname: 'new.invalid', port: 22, username: 'tester', keyPath: 'key' }]));
    await page.evaluate(() => window.pendingChecks[0]({ ok: true }));
    await page.waitForFunction(() => window.pendingChecks.length === 2);
    assert.equal(await page.locator('.host-status').getAttribute('data-state'), 'pending');
    await page.evaluate(() => window.pendingChecks[1]({ ok: true }));
    await page.waitForFunction(() => document.querySelector('.host-status').dataset.state === 'success');

    await page.evaluate(async () => {
      await window.sshdeck.setHosts([{ alias: 'sample', hostname: 'new.invalid', port: 22, username: 'tester', keyPath: 'key', check: { state: 'needs-unlock', error: '需要解鎖' } }]);
      await window.sshdeck.selectHost('sample');
    });
    await page.locator('#check-selected-host').click();
    assert.equal(await page.locator('.host-status').getAttribute('data-state'), 'needs-unlock');
    assert.match(await page.locator('.host-status').textContent(), /立即檢查/);

    await page.evaluate(() => {
      window.sshdeck.services.checkHost = async () => { const error = Error('已拒絕主機指紋'); error.code = 'HOST_TRUST_REQUIRED'; throw error; };
      window.sshdeck.setHosts([{ alias: 'sample', hostname: 'new.invalid', port: 22, username: 'tester', keyPath: 'key', check: { state: 'untrusted' } }]);
    });
    await page.locator('#check-selected-host').click();
    assert.equal(await page.locator('.host-status').getAttribute('data-state'), 'untrusted');

    await page.evaluate(() => {
      window.confirmCalls = 0;
      window.confirm = () => { window.confirmCalls++; return true; };
      window.sshdeck.services.checkSSH = async () => ({ state: 'needs-unlock', error: '請先解鎖登入金鑰' });
      window.sshdeck.setHosts([{ alias: 'locked', hostname: 'locked.invalid', port: 22, username: 'tester', keyPath: 'key' }]);
    });
    await page.waitForFunction(() => document.querySelector('#hosts [data-alias="locked"] .host-status').dataset.state === 'needs-unlock');
    assert.equal(await page.evaluate(() => window.confirmCalls), 0);
    assert.match(await page.locator('#hosts [data-alias="locked"] .host-status').textContent(), /立即檢查/);

    await page.evaluate(async () => {
      window.manualChecks = 0;
      window.sshdeck.services.checkHost = async () => {
        window.manualChecks++;
        if (window.manualChecks === 1) throw Error('主機尚未啟動');
        return { ok: true };
      };
      window.sshdeck.setHosts([{ alias: 'retry', hostname: 'retry.invalid', port: 22, username: 'tester', check: { state: 'unchecked' } }]);
      await window.sshdeck.selectHost('retry');
    });
    await page.locator('#check-selected-host').click();
    assert.equal(await page.locator('#hosts [data-alias="retry"] .host-status').getAttribute('data-state'), 'failure');
    await page.locator('#check-selected-host').click();
    await page.waitForFunction(() => document.querySelector('#hosts [data-alias="retry"] .host-status').dataset.state === 'success');
    assert.equal(await page.evaluate(() => window.manualChecks), 2);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('輪詢間隔為 30 秒，頁面隱藏時暫停且返回時立即檢查', { skip: browserModule ? false : '需設定 Playwright 模組路徑。' }, async () => {
  const { chromium } = require(browserModule);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sshdeck-status-visibility-'));
  const server = await startUi({ port: 0, dataFile: path.join(directory, 'hosts.json'), openBrowser: async () => {}, log: () => {} });
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.addInitScript(() => {
      const nativeSetInterval = window.setInterval.bind(window);
      window.__pollIntervals = [];
      window.setInterval = (callback, delay, ...args) => {
        window.__pollIntervals.push({ callback, delay });
        return nativeSetInterval(callback, delay, ...args);
      };
      window.__pageHidden = false;
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.__pageHidden });
    });
    await page.goto(server.url);
    await page.evaluate(() => {
      window.checkCalls = 0;
      window.sshdeck.services.checkSSH = async () => { window.checkCalls++; return { ok: true }; };
      window.sshdeck.setHosts([{ alias: 'sample', hostname: 'host.invalid', port: 22, username: 'tester', keyPath: 'key' }]);
    });
    await page.waitForFunction(() => document.querySelector('.host-status').dataset.state === 'success');
    const delay = await page.evaluate(() => window.__pollIntervals.find((timer) => timer.delay === 30000)?.delay);
    assert.equal(delay, 30000);
    await page.evaluate(() => window.__pollIntervals.find((timer) => timer.delay === 30000).callback());
    await page.waitForFunction(() => window.checkCalls === 2);

    await page.evaluate(() => { window.__pageHidden = true; document.dispatchEvent(new Event('visibilitychange')); });
    await page.evaluate(() => window.__pollIntervals.find((timer) => timer.delay === 30000).callback());
    assert.equal(await page.evaluate(() => window.checkCalls), 2);
    await page.evaluate(() => { window.__pageHidden = false; document.dispatchEvent(new Event('visibilitychange')); });
    await page.waitForFunction(() => window.checkCalls === 3);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
