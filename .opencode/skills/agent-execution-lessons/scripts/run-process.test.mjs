import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { runProcess } from './run-process.mjs';

test('含空白與 Unicode 的 cwd，以及引號與 Shell 字元，均原樣傳入子程序', () => {
  const cwd = mkdtempSync(join(process.env.TEMP ?? tmpdir(), 'agent 中文 space '));
  try {
    const values = ['two words', '"quoted"', '{"name":"中文"}', '$HOME; echo x', '& | > <'];
    const result = runProcess({ command: process.execPath, cwd,
      args: ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))', '--', ...values] });
    assert.equal(result.ok, true);
    assert.deepEqual(JSON.parse(result.stdout), values);
    const check = runProcess({ command: process.execPath, cwd, args: ['-e', 'console.log(process.cwd())'] });
    assert.equal(check.stdout.trim().toLowerCase(), cwd.toLowerCase());
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('無效 cwd 或參數在執行前回報', () => {
  assert.equal(runProcess({ command: process.execPath, args: [], cwd: '.' }).code, 'INVALID_INPUT');
  assert.equal(runProcess({ command: process.execPath, args: [], cwd: join(process.cwd(), 'missing-cwd-987654321') }).code, 'INVALID_CWD');
  assert.equal(runProcess({ command: process.execPath, args: [1], cwd: process.cwd() }).code, 'INVALID_INPUT');
  assert.equal(runProcess({ command: 'npm.cmd', args: [], cwd: process.cwd() }).code, 'SHELL_SCRIPT_UNSUPPORTED');
});

test('保留程序失敗、找不到命令與 timeout 的差異', () => {
  const input = { command: process.execPath, cwd: process.cwd(), args: ['-e', 'console.error("失敗"); process.exit(7)'] };
  const failed = runProcess(input);
  assert.equal(failed.ok, false);
  assert.equal(failed.exitCode, 7);
  assert.match(failed.stderr, /失敗/);
  assert.equal(runProcess({ ...input, command: 'missing-executable-987654321' }).code, 'ENOENT');
  assert.equal(runProcess({ ...input, args: ['-e', 'setInterval(() => {}, 1000)'], timeoutMs: 100 }).code, 'ETIMEDOUT');
});

test('CLI 讀取 JSON 輸入檔並以結束碼回報成功或無效輸入', () => {
  const cwd = mkdtempSync(join(process.env.TEMP ?? tmpdir(), 'agent-cli-'));
  const script = fileURLToPath(new URL('./run-process.mjs', import.meta.url));
  const file = join(cwd, 'input.json');
  try {
    writeFileSync(file, JSON.stringify({ command: process.execPath, args: ['-e', 'console.log("ok")'], cwd }));
    const success = spawnSync(process.execPath, [script, file], { encoding: 'utf8' });
    assert.equal(success.status, 0);
    assert.equal(JSON.parse(success.stdout).stdout.trim(), 'ok');
    writeFileSync(file, '{');
    const failure = spawnSync(process.execPath, [script, file], { encoding: 'utf8' });
    assert.equal(failure.status, 1);
    assert.equal(JSON.parse(failure.stdout).code, 'INVALID_INPUT_FILE');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
