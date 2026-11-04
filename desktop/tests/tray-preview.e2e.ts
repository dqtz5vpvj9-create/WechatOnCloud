import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

test('native tray preview fits, accumulates session counts, shows avatars and opens a row', async () => {
  const connection = await chromium.connectOverCDP(
    `http://127.0.0.1:${process.env.WOC_E2E_CDP_PORT ?? '9333'}`,
  );
  try {
    // WebView2 exposes two windows; choose the main page explicitly instead of
    // letting page creation order decide which window app.open() navigates.
    await expect.poll(() => connection.contexts().flatMap((context) => context.pages())
      .some((page) => page.url().startsWith('https://wechat.tail.lixinrui000.cn/'))).toBe(true);
    const browser = connection.contexts().flatMap((context) => context.pages())
      .find((page) => page.url().startsWith('https://wechat.tail.lixinrui000.cn/'))!;
    await browser.goto('https://wechat.tail.lixinrui000.cn/login');
    await expect.poll(() => browser.evaluate(() => typeof (window as any).__TAURI__?.core?.invoke)).toBe('function');
    await expect.poll(() => connection.contexts().flatMap((context) => context.pages())
      .some((page) => page.url().includes('tray-preview.html'))).toBe(true);
    const preview = connection.contexts().flatMap((context) => context.pages())
      .find((page) => page.url().includes('tray-preview.html'));
    if (!preview) throw new Error('native tray WebView was not created');
    await preview.waitForFunction(() => typeof (window as any).renderTrayPreview === 'function');
    // Local fixture image: deterministic avatar loading, without contacting a user's contacts.
    await preview.route('https://avatar.example.test/**', (route) => route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#77978a"/><circle cx="32" cy="24" r="10" fill="#ecf1ed"/><path d="M12 58a20 20 0 0 1 40 0" fill="#ecf1ed"/></svg>',
    }));
    await browser.evaluate(async () => {
      const invoke = (window as any).__TAURI__.core.invoke;
      await invoke('set_taskbar_unread', { count: 0, notify: false });
      for (let index = 0; index < 3; index++) {
        await invoke('set_desktop_notification', { payload: {
          count: index + 1, notify: true, messageCount: 1,
          tag: 'preview-test-a', title: '设计协作群 · 界面与交互讨论',
          body: '小林：方案已经更新，下午一起看一下最终效果。',
          url: '/i/preview-test?screen=weflow',
          avatarUrl: 'https://avatar.example.test/group.png',
        } });
      }
      await invoke('show_tray_preview_for_test');
    });
    await expect.poll(() => preview.locator('.badge').allTextContents()).toEqual(['3']);
    expect(await preview.locator('.header-count').textContent()).toBe('3 条新消息');
    await preview.waitForFunction(() => {
      const picture = document.querySelector('.avatar img') as HTMLImageElement;
      return picture?.complete && picture.naturalWidth > 0;
    });
    const single = await preview.evaluate(() => {
      const row = document.querySelector('.message')!.getBoundingClientRect();
      const title = document.querySelector('.title')!.getBoundingClientRect();
      const body = document.querySelector('.body')!.getBoundingClientRect();
      return {
        width: innerWidth, height: innerHeight, rowBottom: row.bottom,
        titleBottom: title.bottom, bodyTop: body.top,
        clipped: document.documentElement.scrollWidth > innerWidth,
        scale: devicePixelRatio,
      };
    });
    expect(single.width).toBe(304);
    expect(single.height).toBe(106);
    expect(single.titleBottom).toBeLessThanOrEqual(single.bodyTop);
    expect(single.rowBottom).toBeLessThan(single.height);
    expect(single.clipped).toBe(false);
    const screenshots = path.resolve('test-results/tray-preview');
    await mkdir(screenshots, { recursive: true });
    await preview.screenshot({ path: path.join(screenshots, 'single-native.png') });
    // A second session with the same title must remain a distinct row. Long text
    // must not push the badge or the last row outside the native window.
    await browser.evaluate(async () => {
      const invoke = (window as any).__TAURI__.core.invoke;
      await invoke('set_desktop_notification', { payload: {
        count: 4, notify: true, messageCount: 1,
        tag: 'preview-test-b', title: '设计协作群 · 界面与交互讨论',
        body: '这是一条很长很长的消息，用来验证文字会正确截断，红色数字保持对齐。',
        url: '/i/preview-second?screen=weflow',
      } });
    });
    await expect.poll(() => preview.locator('.message').count()).toBe(2);
    expect(await preview.locator('.badge').allTextContents()).toEqual(['1', '3']);
    expect(await preview.locator('.header-count').textContent()).toBe('4 条新消息');
    await preview.screenshot({ path: path.join(screenshots, 'multiple-native.png') });
    await browser.evaluate(async () => {
      const invoke = (window as any).__TAURI__.core.invoke;
      for (let index = 0; index < 4; index++) {
        await invoke('set_desktop_notification', { payload: {
          count: 5 + index, notify: true, messageCount: 1,
          tag: 'preview-extra-' + index, title: '会话 ' + (index + 1),
          body: '新的消息', url: '/i/preview-extra?screen=weflow',
          avatarUrl: 'https://avatar.example.test/' + index + '.png',
        } });
      }
    });
    await expect.poll(() => preview.locator('.message').count()).toBe(6);
    const overflow = await preview.evaluate(() => {
      const list = document.querySelector('.messages')!;
      return { height: innerHeight, scrollHeight: list.scrollHeight, clientHeight: list.clientHeight };
    });
    expect(overflow.height).toBe(346);
    expect(overflow.scrollHeight).toBeGreaterThan(overflow.clientHeight);
    expect(await preview.locator('.header-count').textContent()).toBe('8 条新消息');
    await preview.screenshot({ path: path.join(screenshots, 'scroll-native.png') });
    // Exercise the real panel's screen selection using an isolated instance.
    // Keep VNC and API calls local to the test so no real desktop is taken over.
    await browser.route('**/api/**', async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      const json = pathname === '/api/auth/me'
        ? { user: { id: 'preview-user', username: '预览测试', role: 'sub', disabled: false } }
        : pathname === '/api/instances'
          ? { instances: [{
            id: 'preview-extra', name: '通知跳转测试', appType: 'wechat', runtime: 'running',
            createdAt: '2026-11-04T00:00:00Z', createdBy: 'preview-user',
            wechat: { installed: true, phase: 'installed', version: 'test' },
          }] }
          : { ok: true, free: true, mine: false, holder: null, dark: false };
      await route.fulfill({ json });
    });
    await browser.route('**/desktop/**', (route) => route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><body>微信桌面测试画布</body></html>',
    }));
    await preview.locator('.message').first().click();
    // Keep the legacy WeFlow URLs above: cached notifications must also open WeChat.
    await expect.poll(() => browser.evaluate(() => location.pathname + location.search)).toBe('/i/preview-extra');
    await expect.poll(() => browser.locator('iframe.iv-frame').getAttribute('src')).toMatch(/^\/desktop\/preview-extra\/vnc\/index\.html\?/);
    await expect.poll(() => browser.frameLocator('iframe.iv-frame').getByText('微信桌面测试画布').isVisible()).toBe(true);
    await expect.poll(() => browser.evaluate(async () => {
      return (await (window as any).__TAURI__.core.invoke('get_taskbar_unread_state'))[0];
    })).toBe(0);
  } finally {
    await connection.close();
  }
});
