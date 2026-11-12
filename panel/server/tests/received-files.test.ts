import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { receivedFileCommand, receivedFilesCommand } from '../src/received-files.js';

const run = promisify(execFile);
test('monthly file discovery and exact lookup preserve names and exclude symlink escapes', { skip: process.platform === 'win32' }, async () => {
  const base = await mkdtemp(join(tmpdir(), 'woc-received-'));
  const root = join(base, 'accounts with spaces');
  const account = join(root, 'account[1]');
  const month = join(account, 'msg/file/2026-11');
  const outside = join(base, 'private');
  const name = '报告 [1]*? $(echo not-executed).pdf';
  const execute = async (cmd: string[]) => (await run(cmd[0], cmd.slice(1))).stdout;
  try {
    await mkdir(month, { recursive: true });
    await mkdir(outside);
    await writeFile(join(month, name), 'complete-file');
    await writeFile(join(outside, 'secret'), 'private');
    await mkdir(join(month, 'nested'));
    await writeFile(join(month, 'nested/hidden'), 'outside monthly layout');
    await mkdir(join(account, 'msg/attach'), { recursive: true });
    await writeFile(join(account, 'msg/attach/irrelevant'), 'not a received file');
    await symlink(outside, join(month, 'file-link'));
    await symlink(outside, join(account, 'msg/file/2026-10'));
    await symlink(account, join(root, 'account-link'));
    const rows = (await execute(receivedFilesCommand(root))).trim().split('\n');
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].split('\t').slice(0, 2), [join(month, name), '13']);
    assert.equal((await execute(receivedFileCommand('2026-11', name, root))).trim(), join(month, name));
    for (const [m, n] of [['2026-11', 'file-link'], ['2026-10', 'secret'], ['2026-11', 'not-present']]) {
      assert.equal(await execute(receivedFileCommand(m, n, root)), '');
    }
    assert.equal(await execute(receivedFilesCommand(join(base, 'absent'))), '');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
