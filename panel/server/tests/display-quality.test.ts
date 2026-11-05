import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('global quality defaults to standard and survives reload without replacing other settings', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'woc-quality-'));
  const file = join(dir, 'accounts.json');
  process.env.PANEL_DATA = file;
  writeFileSync(file, JSON.stringify({ users: [], instances: [], settings: { desktopDark: true } }));
  try {
    const store = await import('../src/store.js');
    store.initStore();
    assert.equal(store.getDesktopQuality(), 'standard');
    store.setDesktopQuality('hd');
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).settings.desktopQuality, 'hd');
    store.initStore();
    assert.equal(store.getDesktopQuality(), 'hd');
    assert.equal(store.getDesktopDark(), true);
    store.setDesktopQuality('standard');
    store.initStore();
    assert.equal(store.getDesktopQuality(), 'standard');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
