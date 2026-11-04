import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { chromium } from 'playwright';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

test('Alt+W hides the foreground app and restores it from the background', async () => {
  const connection = await chromium.connectOverCDP(`http://127.0.0.1:${process.env.WOC_E2E_CDP_PORT ?? '9333'}`);
  const press = () => promisify(execFile)('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', path.resolve('scripts/press-alt-w.ps1')], { windowsHide: true });
  try {
    await expect.poll(() => connection.contexts().flatMap(c => c.pages()).some(p => p.url().startsWith('https://wechat.tail.lixinrui000.cn/'))).toBe(true);
    const page = connection.contexts().flatMap(c => c.pages()).find(p => p.url().startsWith('https://wechat.tail.lixinrui000.cn/'))!;
    await page.goto('https://wechat.tail.lixinrui000.cn/login');
    const state = () => page.evaluate(() => (window as any).__TAURI__.core.invoke('get_desktop_runtime_state'));
    await expect.poll(async () => (await state()).shortcutRegistered, { message: 'Alt+W registered with the OS' }).toBe(true);
    // The OS hotkey first brings an unfocused app forward, or hides a focused one.
    if (!(await state()).focused) await press();
    await expect.poll(async () => (await state()).focused, { message: 'Alt+W foregrounds the window' }).toBe(true);
    await press();
    await expect.poll(async () => (await state()).visible, { message: 'Alt+W hides the foreground window' }).toBe(false);
    await press();
    await expect.poll(async () => (await state()).visible, { message: 'Alt+W restores a hidden window' }).toBe(true);
    await expect.poll(async () => (await state()).focused, { message: 'restored window has focus' }).toBe(true);
  } finally {
    await connection.close();
  }
});
