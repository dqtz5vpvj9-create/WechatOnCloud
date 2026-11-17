import { fileURLToPath } from 'node:url';
import { beforeEach, test } from '@e2e-dev/web';
import { expect } from 'e2e';

const id = 'ad22dcbaa6';
const png = fileURLToPath(new URL('./fixtures/clipboard.png', import.meta.url));
let imageRequests = 0;
let imageResponse = 200;
let imageGate: Promise<void> | undefined;

beforeEach(async ({ browser }) => {
  imageRequests = 0; imageResponse = 200; imageGate = undefined;
  await browser.addInitScript(() => {
    (window as any).nativeCalls = [];
    const realFetch = window.fetch;
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      if (!String(input).endsWith('/clipboard-events')) return realFetch(input, init);
      const body = new ReadableStream({ start(controller) {
        (window as any).emitClipboardChange = () => controller.enqueue(new TextEncoder().encode('event: changed\ndata: 1\n\n'));
        init?.signal?.addEventListener('abort', () => { try { controller.close(); } catch {} }, { once: true });
      } });
      return Promise.resolve(new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }));
    };
    (window as any).__TAURI__ = { core: { invoke: async (name: string, args: any) => {
      (window as any).nativeCalls.push(name);
      if (name === 'begin_remote_image_copy') return 1;
      if (name === 'finish_remote_image_copy') {
        const binary = Uint8Array.from(atob(args.png), c => c.charCodeAt(0));
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([binary], { type: 'image/png' }) })]);
      }
      return undefined;
    } } };
  });
  await browser.route('**/registerSW.js', route => route.fulfill({ contentType: 'text/javascript', body: '' }));
  await browser.route('**/desktop/**', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html class="noVNC_connected"><body style="margin:0"><div id="noVNC_container"><canvas tabindex="0" id="noVNC_canvas" width="600" height="350"></canvas><textarea id="noVNC_keyboardinput"></textarea></div><textarea hidden id="noVNC_clipboard_text"></textarea><script>document.addEventListener('contextmenu',e=>e.preventDefault());</script></body></html>` }));
  await browser.route('**/api/**', async route => {
    const path = new URL(route.request.url).pathname;
    if (path.endsWith('/clipboard-image')) {
      imageRequests++;
      if (imageGate) await imageGate;
      if (imageResponse !== 200) return route.fulfill({ status: imageResponse, json: { error: '剪贴板里没有图片，请先在应用里复制图片' } });
      return route.fulfill({ contentType: 'image/png', path: png });
    }
    let data: any = { ok: true };
    if (path === '/api/auth/me') data = { user: { id: 'test', username: 'test', role: 'admin', allowedInstances: [] } };
    else if (path === '/api/instances') data = { instances: [{ id, name: '复制图片测试', appType: 'wechat', runtime: 'running', wechat: { phase: 'done', installed: true } }] };
    else if (path === '/api/version') data = { current: 'test', hasUpdate: false, isDev: true };
    else if (path.includes('/control')) data = { free: true, mine: true, holder: null };
    await route.fulfill({ json: data });
  });
});

test('slow image read shows progress and finishes without a toolbar', async ({ app, browser, screen }) => {
  let release!: () => void;
  imageGate = new Promise<void>(resolve => { release = resolve; });
  try {
    await prepare(app, browser);
    const p = await point(browser);
    await browser.mouse.move(p.x, p.y); await browser.mouse.down(); await browser.mouse.up();
    await browser.keyboard.press('Control+c');
    await browser.evaluate(() => (window as any).emitClipboardChange());
    await expect(screen.getByText('正在同步剪贴板…', { exact: true })).toBeVisible();
    release();
    await expect(screen.getByText('图片已复制，可直接粘贴', { exact: true })).toBeVisible();
  } finally { release(); }
});

async function prepare(app: any, browser: any) {
  await app.open(`/i/${id}`);
  test.skip(!await browser.evaluate(() => /Chrome/.test(navigator.userAgent)), 'native clipboard fixture requires Chromium');
  await expect.poll(() => browser.evaluate(() => typeof (window as any).emitClipboardChange === 'function')).toBe(true);
  await expect.poll(() => browser.evaluate(() => !!document.querySelector('iframe')?.contentDocument?.getElementById('noVNC_canvas'))).toBe(true);
}
async function point(browser: any) {
  return browser.evaluate(() => { const r = document.querySelector('iframe')!.getBoundingClientRect(); return { x: r.left + 100, y: r.top + 100 }; });
}

test('remote keyboard image copy writes an actual PNG without opening the drawer', async ({ app, browser, screen }) => {
  await prepare(app, browser);
  const p = await point(browser);
  await browser.mouse.move(p.x, p.y); await browser.mouse.down(); await browser.mouse.up();
  await browser.keyboard.press('Control+c');
  await expect.poll(() => browser.evaluate(() => (window as any).nativeCalls.includes('begin_remote_image_copy'))).toBe(true);
  await browser.evaluate(() => (window as any).emitClipboardChange());
  await expect(screen.getByText('图片已复制，可直接粘贴', { exact: true })).toBeVisible();
  const image = await browser.evaluate(async () => {
    const item = (await navigator.clipboard.read()).find(i => i.types.includes('image/png'))!;
    const bitmap = await createImageBitmap(await item.getType('image/png'));
    const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d')!; ctx.drawImage(bitmap, 0, 0);
    return { width: bitmap.width, height: bitmap.height, pixel: [...ctx.getImageData(0, 0, 1, 1).data] };
  });
  expect(image).toEqual({ width: 2, height: 2, pixel: [255, 0, 0, 255] });
  expect(imageRequests).toBe(1);
});

test('plain text copy does not overwrite the local clipboard with an image', async ({ app, browser }) => {
  await prepare(app, browser);
  imageResponse = 422;
  await browser.evaluate(() => navigator.clipboard.writeText('local-clipboard'));
  const p = await point(browser);
  await browser.mouse.move(p.x, p.y); await browser.mouse.down(); await browser.mouse.up();
  await browser.keyboard.press('Control+c');
  await browser.evaluate(() => (window as any).emitClipboardChange());
  await expect.poll(() => imageRequests).toBe(1);
  await expect.poll(() => browser.evaluate(() => document.querySelector('.image-copy-progress') === null)).toBe(true);
  expect(await browser.evaluate(() => (window as any).nativeCalls.includes('finish_remote_image_copy'))).toBe(false);
  expect(await browser.evaluate(() => navigator.clipboard.readText())).toBe('local-clipboard');
});
