import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { chromium } from 'playwright';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

test('real cloud transfer uploads and downloads the same generated file', async () => {
  const instance = process.env.WOC_LIVE_FILES_INSTANCE;
  if (!instance) test.skip('Set WOC_LIVE_FILES_INSTANCE and WOC_E2E_PROFILE=app for an authorized live test');
  const connection = await chromium.connectOverCDP(`http://127.0.0.1:${process.env.WOC_E2E_CDP_PORT ?? '9333'}`);
  const name = `yunwei-transfer-check-${Date.now()}.txt`;
  const content = `云微文件往返校验 ${name}\n`;
  const source = path.resolve('.e2e/fixtures', name);
  const saved = path.resolve('.e2e/native-downloads', name);
  await mkdir(path.dirname(source), { recursive: true });
  await writeFile(source, content);
  let page: import('playwright').Page | undefined;
  let uploaded = false;
  try {
    const browserSession = await connection.newBrowserCDPSession();
    await browserSession.send('Browser.setDownloadBehavior', { behavior: 'default' });
    await expect.poll(() => connection.contexts().flatMap(c => c.pages()).some(p => p.url().startsWith('https://wechat.tail.lixinrui000.cn/'))).toBe(true);
    page = connection.contexts().flatMap(c => c.pages()).find(p => p.url().startsWith('https://wechat.tail.lixinrui000.cn/'))!;
    expect(await page.evaluate(async () => (await fetch('/api/auth/me')).ok)).toBe(true);
    // The real file APIs are used; keep the remote desktop/control channel idle.
    await page.route('**/desktop/**', route => route.fulfill({ contentType: 'text/html', body: '<html><body>文件往返测试</body></html>' }));
    await page.route('**/control**', route => route.fulfill({ json: { ok: true, free: true, mine: false, holder: null } }));
    await page.goto(`https://wechat.tail.lixinrui000.cn/i/${instance}`);
    await page.getByTitle('文件传输', { exact: true }).click();
    const box = await page.locator('.files-hint').boundingBox();
    expect(box).not.toBeNull();
    const session = await page.context().newCDPSession(page);
    const drag = { x: box!.x + 10, y: box!.y + 10, data: { items: [], files: [source], dragOperationsMask: 1 } };
    await session.send('Input.dispatchDragEvent', { type: 'dragEnter', ...drag });
    await expect.poll(() => page!.locator('.iv-drop').isVisible()).toBe(true);
    await session.send('Input.dispatchDragEvent', { type: 'dragOver', ...drag });
    await session.send('Input.dispatchDragEvent', { type: 'drop', ...drag });
    const download = page.locator('.files-dl').filter({ hasText: name });
    await expect.poll(() => download.count(), { message: 'uploaded fixture appears in real cloud file list', timeout: 15000 }).toBe(1);
    uploaded = true;
    await download.click();
    await expect.poll(async () => readFile(saved, 'utf8').catch(() => ''), { message: 'native download matches the uploaded content', timeout: 15000 }).toBe(content);
    await expect.poll(() => page!.locator('#yunwei-download-status').getAttribute('data-status')).toBe('finished');
  } finally {
    if (page && uploaded) {
      const deleted = await page.evaluate(async ({ id, filename }) => {
        return (await fetch(`/api/instances/${encodeURIComponent(id!)}/files?name=${encodeURIComponent(filename)}`, { method: 'DELETE' })).ok;
      }, { id: instance, filename: name });
      expect(deleted).toBe(true);
    }
    if (page) await page.goto('https://wechat.tail.lixinrui000.cn/');
    await connection.close();
    await Promise.all([source, saved].map(file => rm(file, { force: true })));
  }
});
