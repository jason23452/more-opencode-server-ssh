import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

export function runProcess(input) {
  try {
    const { command, args, cwd, timeoutMs = 120000 } = input ?? {};
    if (typeof command !== 'string' || !command || !Array.isArray(args)
      || args.some((arg) => typeof arg !== 'string')
      || typeof cwd !== 'string' || !isAbsolute(cwd)
      || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      return { ok: false, code: 'INVALID_INPUT' };
    }
    if (/\.(cmd|bat)$/i.test(command)) {
      return { ok: false, code: 'SHELL_SCRIPT_UNSUPPORTED' };
    }
    let directory;
    try {
      directory = realpathSync(cwd);
      if (!statSync(directory).isDirectory()) throw new Error('非目錄');
    } catch {
      return { ok: false, code: 'INVALID_CWD' };
    }
    const result = spawnSync(command, args, {
      cwd: directory,
      shell: false,
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    });
    return {
      ok: !result.error && result.status === 0,
      code: result.error?.code ?? (result.status === 0 ? 'OK' : 'PROCESS_FAILED'),
      exitCode: result.status,
      signal: result.signal,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
  } catch (error) {
    return { ok: false, code: error.code ?? 'INVALID_INPUT' };
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  let result;
  try {
    if (process.argv.length !== 3) throw new Error('需要一個 JSON 輸入檔案');
    result = runProcess(JSON.parse(readFileSync(process.argv[2], 'utf8')));
  } catch {
    result = { ok: false, code: 'INVALID_INPUT_FILE' };
  }
  console.log(JSON.stringify(result));
  process.exitCode = result.ok ? 0 : 1;
}
