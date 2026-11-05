import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

const id = 'ad22dcbaa6';

test('single instance opens directly, exposes global controls and uses direct file transfer paths', async ({ app, browser }) => {
  let upload: { url: string; screen: string | null } | undefined;
  await browser.route('**/registerSW.js', route => route.fulfill({ contentType: 'text/javascript', body: '' }));
  await browser.route('**/api/**', async route => {
    const request = route.request;
    const url = new URL(request.url);
    if (url.pathname.endsWith('/upload')) {
      upload = { url: url.href, screen: request.headers['x-woc-screen'] || null };
      await route.fulfill({ json: { ok: true } });
      return;
    }
    const data = url.pathname === '/api/auth/me'
      ? { user: { id: 'test', username: 'test', role: 'admin', allowedInstances: [] } }
      : url.pathname === '/api/instances'
        ? { instances: [{ id, name: '我的微信', appType: 'wechat', runtime: 'running', wechat: { phase: 'done', installed: true } }] }
        : url.pathname.endsWith('/files')
          ? { files: [{ name: '报告.pdf', size: 1234, source: 'wechat', path: '2026-11/报告.pdf' }] }
          : url.pathname === '/api/version'
            ? { current: 'test', hasUpdate: false, isDev: true }
            : { ok: true, free: true, mine: true, holder: null, dark: false };
    await route.fulfill({ json: data });
  });
  await browser.route('**/desktop/**', route => route.fulfill({ contentType: 'text/html', body: '<div id="noVNC_container">微信桌面</div>' }));

  await app.open('/');
  await expect.poll(() => browser.evaluate(() => location.pathname)).toBe(`/i/${id}`);
  await expect.poll(() => browser.locator('[aria-label="开启消息通知"]').isVisible()).toBe(true);
  await expect.poll(() => browser.locator('[aria-label^="主题："]').isVisible()).toBe(true);
  await expect.poll(() => browser.locator('[aria-label="切换到 WeFlow"]').isVisible()).toBe(true);
  await expect.poll(() => browser.locator('.sidebar [title="主页"]').count()).toBe(0);

  await browser.evaluate(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['direct-file'], '直发.txt', { type: 'text/plain' }));
    (window as any).__testTransfer = transfer;
    window.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer: transfer }));
  });
  await expect.poll(() => browser.locator('.iv-drop').isVisible()).toBe(true);
  await browser.evaluate(() => {
    const transfer = (window as any).__testTransfer as DataTransfer;
    document.querySelector('.iv-drop')!.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: transfer }));
  });
  await expect.poll(() => upload?.url || '').toContain('send=1');
  expect(upload?.screen).toBe('wechat');

  await browser.locator('[title="文件传输"]').click();
  const received = browser.locator('a[title="下载"]', { hasText: '报告.pdf' });
  await expect.poll(() => received.isVisible()).toBe(true);
  expect(await received.getAttribute('href')).toContain('received=2026-11%2F%E6%8A%A5%E5%91%8A.pdf');
});
