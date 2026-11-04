import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { chromium } from 'playwright';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

test('desktop accepts dropped files and saves downloads without overwriting', async () => {
  const connection = await chromium.connectOverCDP(`http://127.0.0.1:${process.env.WOC_E2E_CDP_PORT ?? '9333'}`);
  const name = `云微文件测试-${Date.now()}.txt`;
  const content = Buffer.from('云微文件传输回归测试\n');
  const downloads = path.resolve('.e2e/native-downloads');
  const source = path.resolve('.e2e/fixtures', name);
  const saved = path.join(downloads, name);
  const second = path.join(downloads, name.replace('.txt', ' (1).txt'));
  await mkdir(path.dirname(source), { recursive: true });
  await mkdir(downloads, { recursive: true });
  await writeFile(source, content);
  let uploaded = false;
  try {
    // e2e normally routes downloads into its artifacts. Restore the browser's
    // default so WebView2 calls Tauri's real native download handler.
    const browserSession = await connection.newBrowserCDPSession();
    await browserSession.send('Browser.setDownloadBehavior', { behavior: 'default' });
    await expect.poll(() => connection.contexts().flatMap(c => c.pages()).some(p => p.url().startsWith('https://wechat.tail.lixinrui000.cn/'))).toBe(true);
    const page = connection.contexts().flatMap(c => c.pages()).find(p => p.url().startsWith('https://wechat.tail.lixinrui000.cn/'))!;
    await page.route('**/api/**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith('/upload')) {
        expect(url.searchParams.get('name')).toBe(name);
        uploaded = true;
        await route.fulfill({ json: { ok: true } });
      } else if (url.pathname.endsWith('/download')) {
        await route.fulfill({
          headers: { 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}` },
          contentType: 'application/octet-stream', body: content,
        });
      } else {
        const json = url.pathname === '/api/auth/me'
          ? { user: { id: 'fixture-user', username: '测试', role: 'sub', disabled: false } }
          : url.pathname === '/api/instances'
            ? { instances: [{ id: 'file-fixture', name: '文件测试', appType: 'wechat', runtime: 'running', createdAt: '2026-11-04', createdBy: 'fixture-user', wechat: { installed: true, phase: 'installed' } }] }
            : url.pathname.endsWith('/files')
              ? { files: uploaded ? [{ name, size: content.length }] : [] }
              : { ok: true, free: true, mine: false, holder: null, dark: false };
        await route.fulfill({ json });
      }
    });
    await page.route('**/desktop/**', route => route.fulfill({ contentType: 'text/html', body: '<html><body>桌面测试画布</body></html>' }));
    await page.goto('https://wechat.tail.lixinrui000.cn/i/file-fixture');
    await page.getByTitle('文件传输', { exact: true }).click();
    const box = await page.locator('.files-hint').boundingBox();
    expect(box).not.toBeNull();
    const session = await page.context().newCDPSession(page);
    await page.evaluate(() => {
      window.addEventListener('drop', event => {
        event.dataTransfer?.files[0]?.text().then(value => { (window as any).__droppedContent = value; });
      }, { capture: true, once: true });
    });
    const drag = { x: box!.x + 10, y: box!.y + 10, data: { items: [], files: [source], dragOperationsMask: 1 } };
    await session.send('Input.dispatchDragEvent', { type: 'dragEnter', ...drag });
    await expect.poll(() => page.locator('.iv-drop').isVisible()).toBe(true);
    await session.send('Input.dispatchDragEvent', { type: 'dragOver', ...drag });
    await session.send('Input.dispatchDragEvent', { type: 'drop', ...drag });
    await expect.poll(() => uploaded, { message: 'dropped file starts an upload request' }).toBe(true);
    await expect.poll(() => page.evaluate(() => (window as any).__droppedContent)).toBe(content.toString('utf8'));
    await expect.poll(() => page.locator('.files-dl').textContent()).toContain(name);
    // A local Blob exercises native saving without CDP response interception.
    // native-files-live covers the real authenticated HTTP download endpoint.
    await page.locator('.files-dl').evaluate((element, body) => {
      (element as HTMLAnchorElement).href = URL.createObjectURL(new Blob([body], { type: 'text/plain' }));
    }, content.toString('utf8'));
    await page.locator('.files-dl').click();
    await expect.poll(() => page.locator('#yunwei-download-status').count(), { message: 'native download handler reports status' }).toBe(1);
    await expect.poll(async () => readFile(saved, 'utf8').catch(() => '')).toBe(content.toString('utf8'));
    await expect.poll(() => page.locator('#yunwei-download-status').getAttribute('data-status')).toBe('finished');
    await writeFile(saved, 'keep original');
    await page.locator('.files-dl').click();
    await expect.poll(async () => readFile(second, 'utf8').catch(() => '')).toBe(content.toString('utf8'));
    expect(await readFile(saved, 'utf8')).toBe('keep original');
    await expect.poll(() => page.locator('#yunwei-download-status').getAttribute('data-status')).toBe('finished');
    expect(new URL(page.url()).pathname).toBe('/i/file-fixture');
    await page.goto('https://wechat.tail.lixinrui000.cn/login');
  } finally {
    await connection.close();
    await Promise.all([source, saved, second].map(file => rm(file, { force: true })));
  }
});
