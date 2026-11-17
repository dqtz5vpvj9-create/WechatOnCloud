import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { chromium } from 'playwright';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

test('native Windows shell copies a remote PNG into the real OS clipboard', { timeout: 60_000 }, async () => {
  test.skip(process.env.WOC_CLIPBOARD_NATIVE_TEST !== '1', 'run only with an isolated or preserved OS clipboard');
  const connection = await chromium.connectOverCDP(`http://127.0.0.1:${process.env.WOC_E2E_CDP_PORT ?? '9333'}`);
  const dist = path.resolve('../panel/web/dist');
  const png = path.resolve('tests-panel/fixtures/clipboard.png');
  const root = 'https://wechat.tail.lixinrui000.cn';
  try {
    await expect.poll(() => connection.contexts().flatMap(c => c.pages()).some(p => p.url().startsWith(root))).toBe(true);
    const page = connection.contexts().flatMap(c => c.pages()).find(p => p.url().startsWith(root))!;
    const session = await page.context().newCDPSession(page);
    await session.send('Network.enable');
    await session.send('Network.setBypassServiceWorker', { bypass: true });
    await page.addInitScript(() => {
      const realFetch = window.fetch;
      window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
        if (!String(input).endsWith('/clipboard-events')) return realFetch(input, init);
        const body = new ReadableStream({ start(controller) {
          (window as any).emitClipboardChange = () => controller.enqueue(new TextEncoder().encode('event: changed\ndata: 1\n\n'));
          init?.signal?.addEventListener('abort', () => { try { controller.close(); } catch {} }, { once: true });
        } });
        return Promise.resolve(new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }));
      };
    });
    await page.route('**/registerSW.js', route => route.fulfill({ contentType: 'text/javascript', body: '' }));
    await page.route('**/assets/**', route => {
      const asset = path.basename(new URL(route.request().url()).pathname);
      return route.fulfill({ path: path.join(dist, 'assets', asset), contentType: asset.endsWith('.css') ? 'text/css' : 'text/javascript' });
    });
    await page.route('**/i/ad22dcbaa6', route => route.fulfill({ path: path.join(dist, 'index.html'), contentType: 'text/html' }));
    await page.route('**/desktop/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html class="noVNC_connected"><body style="margin:0"><div id="noVNC_container"><canvas id="noVNC_canvas" tabindex="0" width="600" height="350"></canvas><textarea id="noVNC_keyboardinput"></textarea></div><textarea id="noVNC_clipboard_text" hidden></textarea><script>document.addEventListener("contextmenu",e=>e.preventDefault());</script></body></html>' }));
    await page.route('**/api/**', route => {
      const p = new URL(route.request().url()).pathname;
      if (p.endsWith('/clipboard-image')) return route.fulfill({ path: png, contentType: 'image/png' });
      let data: any = { ok: true, free: true, mine: true };
      if (p === '/api/auth/me') data = { user: { id: 'test', username: 'test', role: 'admin', allowedInstances: [] } };
      else if (p === '/api/instances') data = { instances: [{ id: 'ad22dcbaa6', name: 'clipboard fixture', appType: 'wechat', runtime: 'running', wechat: { phase: 'done', installed: true } }] };
      else if (p === '/api/version') data = { current: 'test', hasUpdate: false, isDev: true };
      return route.fulfill({ json: data });
    });
    await page.goto(`${root}/i/ad22dcbaa6`);
    await page.bringToFront();
    try {
      await expect.poll(() => page.evaluate(() => typeof (window as any).emitClipboardChange === 'function'), { message: 'clipboard event listener becomes ready' }).toBe(true);
    } catch (error) {
      console.log('fixture state', await page.evaluate(() => ({ path: location.pathname, tauri: !!(window as any).__TAURI__, invoke: typeof (window as any).__TAURI__?.core?.invoke, frame: !!document.querySelector('iframe'), frameUrl: document.querySelector('iframe')?.getAttribute('src'), fetchPatched: String(window.fetch).includes('emitClipboardChange'), scripts: [...document.scripts].map(s => s.src).filter(Boolean), text: document.body.innerText.slice(0, 300) })));
      throw error;
    }
    await page.evaluate(() => {
      const core = (window as any).__TAURI__.core;
      const original = core.invoke;
      (window as any).nativeCopyCalls = [];
      core.invoke = (name: string, args: object) => {
        const result = original(name, args);
        if (name.includes('remote_image_copy')) {
          (window as any).nativeCopyCalls.push({ name, status: 'started' });
          void result.then(() => (window as any).nativeCopyCalls.push({ name, status: 'ok' }), (e: unknown) => (window as any).nativeCopyCalls.push({ name, status: String(e) }));
        }
        return result;
      };
    });
    const canvas = page.frameLocator('iframe').locator('#noVNC_canvas');
    await canvas.click({ button: 'right' });
    await canvas.click();
    await page.evaluate(() => (window as any).emitClipboardChange());
    try {
      await expect.poll(() => page.getByText('图片已复制，可直接粘贴').isVisible(), { message: 'native clipboard write completes' }).toBe(true);
    } catch (error) {
      console.log('native copy diagnostics', await page.evaluate(async () => ({ calls: (window as any).nativeCopyCalls, status: document.querySelector('.image-copy-progress')?.textContent, runtime: await (window as any).__TAURI__.core.invoke('get_desktop_runtime_state') })));
      throw error;
    }
    const inspect = await promisify(execFile)('powershell.exe', ['-NoLogo', '-NoProfile', '-Sta', '-File', path.resolve('scripts/inspect-clipboard-image.ps1')], { windowsHide: true });
    expect(JSON.parse(inspect.stdout)).toEqual({ image: true, width: 2, height: 2, pixel: [255, 0, 0, 255] });
    const nativeState = () => page.evaluate(() => (window as any).__TAURI__.core.invoke('remote_copy_test_state'));
    await canvas.click({ button: 'right' });
    await canvas.click();
    await expect.poll(async () => (await nativeState()).pending).toBe(true);
    const expectedToken = (await nativeState()).generation;
    await promisify(execFile)('powershell.exe', ['-NoLogo', '-NoProfile', '-Sta', '-Command', "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::SetText('new-local-clipboard')"], { windowsHide: true });
    await page.evaluate(() => (window as any).emitClipboardChange());
    await expect.poll(async () => (await nativeState()).finished).toBe(expectedToken);
    const local = await promisify(execFile)('powershell.exe', ['-NoLogo', '-NoProfile', '-Sta', '-Command', 'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::GetText()'], { windowsHide: true });
    expect(local.stdout.trim()).toBe('new-local-clipboard');
  } finally { await connection.close(); }
});
