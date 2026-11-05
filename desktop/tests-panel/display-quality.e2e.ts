import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { readFileSync } from 'node:fs';
import ts from '../../panel/web/node_modules/typescript/lib/typescript.js';
import { execFileSync } from 'node:child_process';

const qualitySource = readFileSync(new URL('../../panel/web/src/displayQuality.tsx', import.meta.url), 'utf8');
const renderingCode = ts.transpileModule(qualitySource.slice(qualitySource.indexOf('export function connectDisplayQuality')).replace('export function', 'function'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

test('global quality switch confirms restart, updates rendering and persists across app switches', async ({ app, browser, screen }) => {
  const id = 'ad22dcbaa6';
  let quality = 'standard';
  let writes = 0;
  await browser.route('**/registerSW.js', route => route.fulfill({ body: '' }));
  await browser.route('**/api/**', async route => {
    const pathname = new URL(route.request.url).pathname;
    let value: any = { ok: true, free: true, mine: true, dark: false };
    if (pathname === '/api/auth/me') value = { user: { id: 'test', username: 'test', role: 'admin' } };
    if (pathname === '/api/instances') value = { instances: [{ id, name: '微信', appType: 'wechat', runtime: 'running', wechat: { phase: 'done', installed: true } }] };
    if (pathname.endsWith('/desktop-quality')) {
      if (route.request.method === 'POST') { quality = JSON.parse(route.request.postData || '{}').quality; writes++; }
      value = { quality, phase: 'ready' };
    }
    await route.fulfill({ json: value });
  });
  await browser.route('**/desktop/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><html class="noVNC_connected"><body><div id="noVNC_container" style="position:fixed;inset:0"></div><script>window.qualityMessages=[];addEventListener("message",e=>qualityMessages.push(e.data));</script></body></html>' }));
  await app.open(`/i/${id}`);
  await expect.poll(() => browser.locator('[aria-label="切换全局画质"]').textContent()).toBe('画质：标准');
  await browser.locator('[aria-label="切换全局画质"]').click();
  await screen.getByRole('button', '取消').click();
  expect(writes).toBe(0);
  await browser.locator('[aria-label="切换全局画质"]').click();
  await screen.getByRole('button', '切换并重启应用').click();
  await expect.poll(() => browser.locator('[aria-label="切换全局画质"]').textContent()).toBe('画质：高清');
  await expect.poll(() => browser.evaluate(() => {
    const frame = document.querySelector('iframe')!;
    const win = frame.contentWindow as any;
    const message = win.qualityMessages?.findLast((data: any) => data.action === 'set_resolution');
    return message?.value_x === Math.floor(win.document.getElementById('noVNC_container').getBoundingClientRect().width) * 2;
  })).toBe(true);
  await browser.locator('.sidebar [aria-label="打开 WeFlow"]').click();
  await expect.poll(() => browser.locator('[aria-label="切换全局画质"]').textContent()).toBe('画质：高清');
  expect(writes).toBe(1);
  expect(await browser.locator('.ws-head .ws-app-switch').count()).toBe(0);
});

test('real KasmVNC renders at 2x and returns to standard without reconnecting', async ({ app, browser }) => {
  test.skip(process.env.WOC_HDPI_LIVE !== '1', 'Requires the disposable KasmVNC probe on port 19455');
  // Exercise Kasm's narrow/high-DPI special case, in addition to its normal path.
  await browser.addInitScript(() => Object.defineProperty(window, 'devicePixelRatio', { get: () => 3 }));
  await browser.route('**/quality-wrapper', route => route.fulfill({ contentType: 'text/html', body: '<html><body style="margin:0"><script>addEventListener("load",()=>{const f=document.createElement("iframe");f.style="border:0;width:400px;height:600px";f.src="/index.html?autoconnect=1&resize=remote&path=websockify&enable_webrtc=false";document.body.append(f);});</script></body></html>' }));
  await app.open('http://127.0.0.1:19455/quality-wrapper');
  await expect.poll(() => browser.evaluate(() => document.querySelector('iframe')?.contentDocument?.documentElement.classList.contains('noVNC_connected'))).toBe(true);
  await browser.evaluate((code: string) => {
    (window as any).stopQuality = new Function(`${code};return connectDisplayQuality`)()(document.querySelector('iframe')!.contentWindow, 'hd');
  }, renderingCode);
  await expect.poll(() => browser.evaluate(() => {
    const canvas = document.querySelector('iframe')!.contentDocument!.querySelector('#noVNC_container canvas') as HTMLCanvasElement;
    return Math.round(canvas.width / canvas.getBoundingClientRect().width * 100);
  })).toBe(200);
  const point = await browser.evaluate(() => {
    const frame = document.querySelector('iframe')!;
    const rect = frame.contentDocument!.querySelector('#noVNC_container canvas')!.getBoundingClientRect();
    const outer = frame.getBoundingClientRect();
    return { x: outer.left + rect.left + 100, y: outer.top + rect.top + 100 };
  });
  await browser.mouse.move(point.x, point.y);
  await expect.poll(() => {
    const position = execFileSync('wsl.exe', ['-d', 'Ubuntu-24.04', '-u', 'root', '--', 'docker', 'exec', 'woc-hdpi-e2e-20261105', 'env', 'DISPLAY=:1', 'xdotool', 'getmouselocation', '--shell'], { encoding: 'utf8', windowsHide: true });
    return Number(position.match(/^X=(\d+)/m)?.[1]);
  }).toBe(200);
  await browser.evaluate((code: string) => {
    (window as any).stopQuality();
    (window as any).stopQuality = new Function(`${code};return connectDisplayQuality`)()(document.querySelector('iframe')!.contentWindow, 'standard');
  }, renderingCode);
  await expect.poll(() => browser.evaluate(() => {
    const canvas = document.querySelector('iframe')!.contentDocument!.querySelector('#noVNC_container canvas') as HTMLCanvasElement;
    return Math.round(canvas.width / canvas.getBoundingClientRect().width * 100);
  })).toBe(100);
});
