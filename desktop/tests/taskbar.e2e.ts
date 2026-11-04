import { test } from '@e2e-dev/web';
import { credentials, expect } from 'e2e';

test('a server notification reaches the Windows taskbar through SSE and Tauri', async ({ app, browser, screen }) => {
  const admin = credentials.user('admin');
  await app.open('/');

  const signedIn = await browser.evaluate(async () => (await fetch('/api/auth/me')).ok);
  if (!signedIn) {
    await app.open('/login');
    await screen.getByPlaceholder('用户名').fill(admin.username);
    await screen.getByPlaceholder('密码').fill(admin.password);
    await screen.getByRole('button', '登录').tap();
    await expect(browser).toHaveURL('https://wechat.tail.lixinrui000.cn/');
  }
  await expect(browser.locator('.ws-title')).toHaveText('主页');

  const bridge = await browser.evaluate(() => ({
    tauri: typeof (window as any).__TAURI__,
    internals: typeof (window as any).__TAURI_INTERNALS__,
    invoke: typeof (window as any).__TAURI__?.core?.invoke,
    globals: Object.keys(window).filter((key) => /tauri|ipc/i.test(key)),
  }));
  expect(bridge.invoke).toBe('function');

  await browser.evaluate(async () => {
    if ((window as any).__WOC_LIVE_NOTIFICATIONS_READY__) return;
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error('desktop notification stream did not connect')), 5_000);
      window.addEventListener('woc-live-notifications-ready', () => {
        window.clearTimeout(timeout);
        resolve();
      }, { once: true });
    });
  });

  const unreadState = await browser.evaluate(async () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => false });
    await new Promise((resolve) => setTimeout(resolve, 500));

    const response = await fetch('/api/notifications/test', { method: 'POST' });
    if (!response.ok) throw new Error(`test notification failed with HTTP ${response.status}`);
    await new Promise((resolve) => setTimeout(resolve, 500));

    const invoke = (window as any).__TAURI__.core.invoke as (command: string, args?: object) => Promise<any>;
    return await invoke('get_taskbar_unread_state');
  });
  expect(unreadState[0]).toBe(1);
  expect(unreadState[1]).toBe(1);
  expect(unreadState[2]).toBeGreaterThan(0);
  expect(unreadState[3]).toBe(1);

  const clearedState = await browser.evaluate(async () => {
    delete (document as any).visibilityState;
    delete (document as any).hasFocus;
    window.dispatchEvent(new Event('focus'));
    await new Promise((resolve) => setTimeout(resolve, 200));

    const invoke = (window as any).__TAURI__.core.invoke as (command: string, args?: object) => Promise<any>;
    return await invoke('get_taskbar_unread_state');
  });
  expect(clearedState[0]).toBe(0);
  expect(clearedState[1]).toBe(1);
  expect(clearedState[3]).toBe(0);
});
