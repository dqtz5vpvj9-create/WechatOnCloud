import { fileURLToPath } from 'node:url';
import { beforeEach, test } from '@e2e-dev/web';
import { expect } from 'e2e';

const id = 'ad22dcbaa6';
const png = fileURLToPath(new URL('./fixtures/clipboard.png', import.meta.url));
beforeEach(async ({ browser }) => {
  await browser.addInitScript(() => {
    (window as any).clipboardDownloads = 0;
    (window as any).clipboardErrors = [];
    document.addEventListener('click', e => {
      if ((e.target as Element)?.closest?.('a[download]')) (window as any).clipboardDownloads++;
    }, true);
    window.addEventListener('unhandledrejection', e => (window as any).clipboardErrors.push(String(e.reason)));
  });
  await browser.route('**/api/**', async route => {
    const path = new URL(route.request.url).pathname;
    let data: any = { ok: true };
    if (path === '/api/auth/me') data = { user: { id: 'clipboard-test', username: 'clipboard-test', role: 'admin', allowedInstances: [] } };
    else if (path === '/api/instances') data = { instances: [{ id, name: '复制图片测试', appType: 'wechat', runtime: 'running', wechat: { phase: 'done', installed: true, version: '4.1', percent: 100 } }] };
    else if (path === '/api/version') data = { current: 'dev-test', hasUpdate: false, isDev: true };
    else if (path.endsWith('/control')) data = { free: true, mine: true, holder: null };
    else if (path.endsWith('/clipboard-image')) {
      await route.fulfill({ contentType: 'image/png', path: png });
      return;
    }
    await route.fulfill({ json: data });
  });
  await browser.route('**/desktop/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html class="noVNC_connected"><body><canvas id="noVNC_canvas"></canvas></body></html>' }));
});

for (const screenName of ['wechat', 'weflow']) {
  test(`${screenName}: copy writes a real PNG to the local clipboard after the image response arrives`, async ({ app, screen, browser }) => {
    let release!: () => void;
    const responseGate = new Promise<void>(resolve => { release = resolve; });
    let requestedScreen = '';
    await browser.route('**/clipboard-image', async route => {
      requestedScreen = route.request.headers['x-woc-screen'];
      await responseGate;
      await route.fulfill({ contentType: 'image/png', path: png });
    });
    await app.open(`/i/${id}${screenName === 'weflow' ? '?screen=weflow' : ''}`);
    test.skip(await browser.evaluate(() => typeof ClipboardItem === 'undefined' || ClipboardItem.supports?.('image/png') === false), 'This browser build does not support the native PNG clipboard; run on macOS for Safari verification.');
    await screen.getByRole('button', '剪贴板', { exact: true }).tap();
    await screen.getByRole('button', '复制图片到本机', { exact: true }).tap();
    await expect(screen.getByRole('button', '正在复制图片…')).toBeVisible();
    release();
    await expect(screen.getByText('图片已复制到本机剪贴板，可以直接粘贴', { exact: true })).toBeVisible();
    expect(requestedScreen).toBe(screenName);
    // A trusted second click reads the actual browser clipboard; write is never mocked here.
    await browser.evaluate(() => {
      const button = document.createElement('button');
      button.textContent = '验证本机图片';
      button.style.cssText = 'position:fixed;top:80px;left:280px;z-index:99999';
      button.onclick = async () => {
        try {
          const items = await navigator.clipboard.read();
          const item = items.find(i => i.types.includes('image/png'))!;
          const bitmap = await createImageBitmap(await item.getType('image/png'));
          const canvas = document.createElement('canvas');
          canvas.width = bitmap.width; canvas.height = bitmap.height;
          const ctx = canvas.getContext('2d')!;
          ctx.drawImage(bitmap, 0, 0);
          (window as any).localClipboardImage = { width: bitmap.width, height: bitmap.height, pixel: [...ctx.getImageData(0, 0, 1, 1).data] };
          bitmap.close();
        } catch (e) { (window as any).localClipboardImage = { error: String(e) }; }
      };
      document.body.append(button);
    });
    await screen.getByRole('button', '验证本机图片').tap();
    await expect.poll(() => browser.evaluate(() => (window as any).localClipboardImage ?? null)).toEqual({ width: 2, height: 2, pixel: [255, 0, 0, 255] });
    expect(await browser.evaluate(() => (window as any).clipboardDownloads)).toBe(0);
  });
}

test('clipboard permission denial reports failure and never downloads', async ({ app, screen, browser }) => {
  await browser.addInitScript(() => {
    Object.defineProperty(ClipboardItem, 'supports', { value: () => true, configurable: true });
    Object.defineProperty(navigator.clipboard, 'write', { value: () => Promise.reject(new DOMException('denied', 'NotAllowedError')) });
  });
  await app.open(`/i/${id}`);
  await screen.getByRole('button', '剪贴板', { exact: true }).tap();
  await screen.getByRole('button', '复制图片到本机').tap();
  await expect(screen.getByText('复制失败：浏览器未允许写入剪贴板，请保持云微在前台并重试', { exact: true })).toBeVisible();
  expect(await browser.evaluate(() => (window as any).clipboardDownloads)).toBe(0);
  expect(await browser.evaluate(() => (window as any).clipboardErrors)).toEqual([]);
});

test('empty image clipboard preserves the server error without false success or download', async ({ app, screen, browser }) => {
  await browser.addInitScript(() => Object.defineProperty(ClipboardItem, 'supports', { value: () => true, configurable: true }));
  await browser.route('**/clipboard-image', route => route.fulfill({ status: 422, json: { error: '剪贴板里没有图片，请先在应用里复制图片' } }));
  await app.open(`/i/${id}`);
  await screen.getByRole('button', '剪贴板', { exact: true }).tap();
  await screen.getByRole('button', '复制图片到本机').tap();
  await expect(screen.getByText('剪贴板里没有图片，请先在应用里复制图片', { exact: true })).toBeVisible();
  expect(await browser.evaluate(() => (window as any).clipboardDownloads)).toBe(0);
  expect(await browser.evaluate(() => (window as any).clipboardErrors)).toEqual([]);
});

test('unsupported image clipboard reports failure and never fetches or downloads an image', async ({ app, screen, browser }) => {
  let requests = 0;
  await browser.addInitScript(() => Object.defineProperty(ClipboardItem, 'supports', { value: () => false, configurable: true }));
  await browser.route('**/clipboard-image', route => { requests++; return route.fulfill({ contentType: 'image/png', path: png }); });
  await app.open(`/i/${id}`);
  await screen.getByRole('button', '剪贴板', { exact: true }).tap();
  await screen.getByRole('button', '复制图片到本机').tap();
  await expect(screen.getByText('当前浏览器不支持复制图片到剪贴板', { exact: true })).toBeVisible();
  expect(requests).toBe(0);
  expect(await browser.evaluate(() => (window as any).clipboardDownloads)).toBe(0);
});
