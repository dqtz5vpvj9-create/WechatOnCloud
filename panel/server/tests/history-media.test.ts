import assert from 'node:assert/strict';
import { test } from 'node:test';
import { historyMediaMounts } from '../src/history-media.js';

test('history media stays opt-in and only overlays the declared media directories', () => {
  assert.deepEqual(historyMediaMounts(undefined), []);
  assert.deepEqual(historyMediaMounts({ accountDirectory: 'wxid_example_abcd', mounts: [
    { relativePath: 'msg/attach', sourcePath: '/mnt/e/Cloud Data/history/msg/attach' },
    { relativePath: 'msg/file', sourcePath: '/mnt/f/CloudData/history/msg/file' },
  ] }), [
    { Type: 'bind', Source: '/mnt/e/Cloud Data/history/msg/attach', Target: '/config/xwechat_files/wxid_example_abcd/msg/attach', ReadOnly: false },
    { Type: 'bind', Source: '/mnt/f/CloudData/history/msg/file', Target: '/config/xwechat_files/wxid_example_abcd/msg/file', ReadOnly: false },
  ]);
});

test('history media cannot replace databases, escape the account, or repeat a mount', () => {
  const base = { accountDirectory: 'wxid_example', mounts: [{ relativePath: 'msg/file', sourcePath: '/data/files' }] };
  for (const accountDirectory of ['..', '../another', '', 'a/b', 'a:b']) {
    assert.throws(() => historyMediaMounts({ ...base, accountDirectory }));
  }
  for (const relativePath of ['db_storage', '../db_storage', 'msg', '/config', 'business/xweb']) {
    assert.throws(() => historyMediaMounts({ ...base, mounts: [{ ...base.mounts[0], relativePath }] }));
  }
  assert.throws(() => historyMediaMounts({ ...base, mounts: [...base.mounts, ...base.mounts] }));
});

test('history media requires unambiguous Linux host source paths', () => {
  for (const sourcePath of ['/', 'relative', '/data/../private', '/data/./files', '/data//files', '/data/files/', '/data/files:ro', '/data/fi\nles', 'E:\\files', null]) {
    assert.throws(() => historyMediaMounts({ accountDirectory: 'wxid_example', mounts: [{ relativePath: 'msg/file', sourcePath }] }), String(sourcePath));
  }
});
