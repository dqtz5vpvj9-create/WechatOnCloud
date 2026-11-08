import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import ts from '../../panel/web/node_modules/typescript/lib/typescript.js';

const code = ts.transpileModule(readFileSync(new URL('../../panel/web/src/desktopBridge.ts', import.meta.url), 'utf8'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText.replace(/^export /gm, '');

test('native tray blinking stops on activation and cannot be restored by already-read notifications', async () => {
  const connection = await chromium.connectOverCDP(`http://127.0.0.1:${process.env.WOC_E2E_CDP_PORT || '9333'}`);
  try {
    const page = connection.contexts().flatMap(context => context.pages()).find(page => page.url().startsWith('https://wechat.tail.lixinrui000.cn/'))!;
    await page.waitForFunction(() => !!(window as any).__TAURI__?.core?.invoke);
    await page.evaluate(code => {
      (window as any).testBackground = true;
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (window as any).testBackground ? 'hidden' : 'visible' });
      Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => !(window as any).testBackground });
      const bridge = new Function(`${code}; return { notifyTaskbar, installTaskbarUnreadReset };`)();
      (window as any).policy = bridge;
      (window as any).readAcks = 0;
      (window as any).cleanupPolicy = bridge.installTaskbarUnreadReset(async () => {
        (window as any).readAcks++;
        return { readSequence: 10 };
      });
    }, code);
    const state = () => page.evaluate(() => (window as any).__TAURI__.core.invoke('get_taskbar_unread_state'));
    const old = { tag: 'old-fixture', title: '旧提醒测试', body: 'fixture', count: 3, url: '/i/fixture' };
    await page.evaluate(old => (window as any).policy.notifyTaskbar({ snapshot: true, count: 3, sessions: [old] }), old);
    await expect.poll(async () => (await state())[0]).toBe(3);
    await page.evaluate(() => { (window as any).testBackground = false; window.dispatchEvent(new Event('focus')); });
    await expect.poll(async () => (await state())[0]).toBe(0);
    expect((await state())[3]).toBe(0);
    await page.evaluate(async old => {
      (window as any).testBackground = true;
      window.dispatchEvent(new Event('blur'));
      await (window as any).policy.notifyTaskbar({ snapshot: true, count: 3, sessions: [old] });
      await (window as any).policy.notifyTaskbar({ ...old, sequence: 9 });
    }, old);
    expect((await state())[0]).toBe(0);
    expect((await state())[3]).toBe(0);
    await page.evaluate(() => (window as any).policy.notifyTaskbar({ tag: 'fresh-fixture', title: '新提醒测试', body: 'fixture', count: 1, sequence: 11, url: '/i/fixture' }));
    await expect.poll(async () => (await state())[0]).toBe(1);
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('woc-native-visibility', { detail: { visible: true } })));
    await expect.poll(async () => (await state())[0]).toBe(0);
    expect((await state())[3]).toBe(0);
    await page.evaluate(() => (window as any).cleanupPolicy());
  } finally { await connection.close(); }
});
