import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test('file drawer distinguishes loading and discovers new downloads while staying open', async ({ app, browser }) => {
  const id = 'ad22dcbaa6';
  let calls = 0;
  let active = 0;
  let peak = 0;
  let releaseFirst!: () => void;
  const first = new Promise<void>(resolve => { releaseFirst = resolve; });
  await browser.route('**/registerSW.js', route => route.fulfill({ body: '' }));
  await browser.route('**/api/**', async route => {
    const path = new URL(route.request.url).pathname;
    if (path.endsWith('/files')) {
      calls++; active++; peak = Math.max(peak, active);
      if (calls === 1) await first;
      active--;
      return route.fulfill({ json: { files: calls === 1 ? [] : [{ name: 'received.pdf', size: 13, source: 'wechat', path: '2026-11/received.pdf' }] } });
    }
    return route.fulfill({ json: path === '/api/auth/me' ? { user: { id: 'test', role: 'admin' } }
      : path === '/api/instances' ? { instances: [{ id, name: '微信', runtime: 'running', appType: 'wechat', wechat: { installed: true, phase: 'done' } }] }
      : { ok: true, free: true, mine: true, quality: 'standard', phase: 'ready' } });
  });
  await browser.route('**/desktop/**', route => route.fulfill({ contentType: 'text/html', body: '<div id="noVNC_container"><canvas></canvas></div>' }));
  await app.open(`/i/${id}`);
  const button = browser.locator('button[title="文件传输"]');
  await expect.poll(() => button.isVisible()).toBe(true);
  await button.click();
  await expect.poll(() => browser.locator('.files-list').textContent()).toContain('正在读取文件');
  expect(await browser.locator('.files-list').textContent()).not.toContain('暂无文件');
  // Reopening during an outstanding request must reuse it, not start another scan.
  await button.click(); await button.click();
  expect(calls).toBe(1);
  releaseFirst();
  await expect.poll(() => browser.locator('.files-list').textContent()).toContain('received.pdf');
  expect(peak).toBe(1);
  expect(await browser.locator('.files-dl').getAttribute('href')).toContain('received=2026-11%2Freceived.pdf');
  await browser.locator('.files-head button').click();
  expect(await browser.locator('.iv-files').count()).toBe(0);
});

test('file drawer displays a failed request and can retry', async ({ app, browser }) => {
  const id = 'ad22dcbaa6';
  let failed = true;
  await browser.route('**/registerSW.js', route => route.fulfill({ body: '' }));
  await browser.route('**/api/**', route => {
    const path = new URL(route.request.url).pathname;
    if (path.endsWith('/files')) return failed
      ? route.fulfill({ status: 503, json: { error: 'temporary' } })
      : route.fulfill({ json: { files: [{ name: 'retry.pdf', size: 13 }] } });
    return route.fulfill({ json: path === '/api/auth/me' ? { user: { id: 'test', role: 'admin' } }
      : path === '/api/instances' ? { instances: [{ id, name: '微信', runtime: 'running', appType: 'wechat', wechat: { installed: true, phase: 'done' } }] }
      : { ok: true, free: true, mine: true, quality: 'standard', phase: 'ready' } });
  });
  await browser.route('**/desktop/**', route => route.fulfill({ contentType: 'text/html', body: '<div id="noVNC_container"><canvas></canvas></div>' }));
  await app.open(`/i/${id}`);
  const button = browser.locator('button[title="文件传输"]');
  await expect.poll(() => button.isVisible()).toBe(true);
  await button.click();
  await expect.poll(() => browser.locator('.files-list [role="alert"]').textContent()).toContain('读取文件列表失败');
  failed = false;
  await browser.locator('.files-list button').click();
  await expect.poll(() => browser.locator('.files-list').textContent()).toContain('retry.pdf');
});
