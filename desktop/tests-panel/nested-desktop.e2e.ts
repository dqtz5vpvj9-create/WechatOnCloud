import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test('a desktop redirect to the panel cannot mount a second app or claim another viewer', async ({ app, browser }) => {
  const id = 'ad22dcbaa6';
  let documents = 0;
  let authReads = 0;
  await browser.route('**/registerSW.js', route => route.fulfill({ body: '' }));
  await browser.route('**/api/**', route => {
    const path = new URL(route.request.url).pathname;
    if (path === '/api/auth/me') authReads++;
    const json = path === '/api/auth/me' ? { user: { id: 'test', role: 'admin' } }
      : path === '/api/instances' ? { instances: [{ id, name: '微信', runtime: 'running', appType: 'wechat', wechat: { installed: true, phase: 'done' } }] }
      : { ok: true, free: true, mine: true, quality: 'standard', phase: 'ready' };
    return route.fulfill({ json });
  });
  await browser.route('**/desktop/**', route => route.fulfill({ contentType: 'text/html', body: ++documents === 1
    ? `<script>location.replace('/i/${id}')</script>`
    : '<html class="noVNC_connected"><div id="noVNC_container"><canvas id="real-desktop"></canvas></div></html>' }));
  await app.open(`/i/${id}`);
  await expect.poll(() => browser.evaluate(() => !!document.querySelector('iframe')?.contentDocument?.querySelector('#real-desktop'))).toBe(true);
  expect(authReads).toBeLessThanOrEqual(2); // React StrictMode repeats the root auth effect in development.
  expect(await browser.evaluate(() => document.querySelector('iframe')!.contentDocument!.querySelectorAll('.sidebar').length)).toBe(0);
  expect(documents).toBe(2);
});

test('one native window keeps its viewer identity across WeChat and WeFlow navigation', async ({ app, browser }) => {
  const id = 'ad22dcbaa6';
  let blockedViewer: string | null = null;
  await browser.addInitScript(() => { (window as any).__TAURI__ = { core: { invoke: async () => null } }; });
  await browser.route('**/registerSW.js', route => route.fulfill({ body: '' }));
  await browser.route('**/api/**', route => {
    const path = new URL(route.request.url).pathname;
    if (path === '/api/notifications/stream') return route.fulfill({ contentType: 'text/event-stream', body: 'data: {"snapshot":true,"count":0,"sessions":[]}\n\n' });
    return route.fulfill({ json: path === '/api/auth/me' ? { user: { id: 'test', role: 'admin' } }
      : path === '/api/instances' ? { instances: [{ id, name: '微信', runtime: 'running', appType: 'wechat', wechat: { installed: true, phase: 'done' } }] }
      : { ok: true, free: true, mine: true, quality: 'standard', phase: 'ready',
        superseded: blockedViewer && route.request.headers['x-woc-viewer'] === blockedViewer ? { by: 'another viewer', at: Date.now() } : null } });
  });
  await browser.route('**/desktop/**', route => route.fulfill({ contentType: 'text/html', body: '<div id="noVNC_container"><canvas id="real-desktop"></canvas></div>' }));
  const viewer = () => browser.evaluate(() => {
    const src = document.querySelector('iframe')?.getAttribute('src');
    return src ? new URL('http://fixture/' + new URL(src, location.origin).searchParams.get('path')).searchParams.get('woc_viewer') : null;
  });
  await app.open(`/i/${id}`);
  await expect.poll(viewer).not.toBe(null);
  const initial = await viewer();
  await browser.evaluate(() => {
    (window as any).desktopDocument = document.querySelector('iframe')!.contentDocument;
    for (let i = 0; i < 10; i++) {
      window.dispatchEvent(new FocusEvent('blur'));
      window.dispatchEvent(new FocusEvent('focus'));
    }
  });
  expect(await browser.evaluate(() => document.querySelector('iframe')!.contentDocument === (window as any).desktopDocument)).toBe(true);
  expect(await viewer()).toBe(initial);
  for (let i = 0; i < 3; i++) {
    await browser.locator('.sidebar [aria-label="打开 WeFlow"]').click();
    await expect.poll(() => browser.evaluate(() => location.search)).toBe('?screen=weflow');
    await expect.poll(viewer).toBe(initial);
    await browser.locator('.sidebar [aria-label="打开微信"]').click();
    await expect.poll(() => browser.evaluate(() => location.search)).toBe('');
    await expect.poll(viewer).toBe(initial);
  }
  blockedViewer = initial;
  await app.open(`/i/${id}`);
  const reclaim = browser.locator('button[title="整页重载、在这里重新连接（另一处会被切到这个提示）"]');
  await expect.poll(() => reclaim.isVisible()).toBe(true);
  await reclaim.click();
  await expect.poll(viewer).not.toBe(null);
  await expect.poll(viewer).not.toBe(initial);
  await expect.poll(() => browser.evaluate(() => !!document.querySelector('iframe')?.contentDocument?.querySelector('#real-desktop'))).toBe(true);
});
