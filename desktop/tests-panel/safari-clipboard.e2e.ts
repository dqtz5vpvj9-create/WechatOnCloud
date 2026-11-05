import { beforeEach, test } from '@e2e-dev/web';
import { expect } from 'e2e';

const id = 'ad22dcbaa6';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGP4z8DwH4QZYAwAR8oH+WdZbrcAAAAASUVORK5CYII=', 'base64');
beforeEach(async ({ browser }) => {
  await browser.route('**/registerSW.js', route => route.fulfill({ contentType: 'text/javascript', body: '' }));
  await browser.addInitScript(() => {
    (window as any).clipboardErrors = [];
    (window as any).clipboardNativeWrites = [];
    const proto = Object.getPrototypeOf(navigator.clipboard);
    const write = proto.write;
    proto.write = function(items: ClipboardItem[]) {
      (window as any).clipboardNativeWrites.push('start');
      return write.call(this, items).then(() => { (window as any).clipboardNativeWrites.push('done'); }, (error: Error) => {
        (window as any).clipboardNativeWrites.push(error.name); throw error;
      });
    };
    window.addEventListener('unhandledrejection', e => (window as any).clipboardErrors.push(String(e.reason)));
    localStorage.setItem('enable_ime', 'true');
    localStorage.setItem('woc_input_mode', 'seamless');
  });
  if (process.env.WOC_SAFARI_CLIPBOARD === 'off') {
    await browser.route('**/src/safariClipboard.ts', route => route.fulfill({ contentType: 'text/javascript', body: 'export const installSafariClipboard = () => () => {};' }));
  }
  await browser.route('**/api/**', async route => {
    const path = new URL(route.request.url).pathname;
    if (path.endsWith('/clipboard-image')) {
      await route.fulfill({ body: png, contentType: 'image/png' });
      return;
    }
    let data: any = { ok: true };
    if (path === '/api/auth/me') data = { user: { id: 'test', username: 'test', role: 'admin', allowedInstances: [] } };
    else if (path === '/api/instances') data = { instances: [{ id, name: 'Safari复制验证', appType: 'wechat', runtime: 'running', wechat: { phase: 'done', installed: true } }] };
    else if (path === '/api/version') data = { current: 'test', hasUpdate: false, isDev: true };
    else if (path.includes('/control')) data = { free: true, mine: true, holder: null };
    await route.fulfill({ json: data });
  });
  // Match the deployed KasmVNC text path: updates its textarea and posts
  // clipboardrx, with Safari seamless/binary mode disabled. Native Clipboard
  // APIs remain real; only the remote application/transport is a fixture.
  await browser.route('**/desktop/**', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html>
    <html class="noVNC_connected"><body style="margin:0">
    <div id="noVNC_container"><canvas id="noVNC_canvas" tabindex="0" width="600" height="350"></canvas>
    <textarea id="noVNC_keyboardinput" style="position:absolute;opacity:0;width:1px;height:1px"></textarea></div>
    <textarea id="noVNC_clipboard_text" hidden></textarea>
    <script>
      window.fixtureGeneration = ${JSON.stringify(Date.now())};
      window.remoteCopy = text => {
        document.getElementById('noVNC_clipboard_text').value = text;
        parent.postMessage({action:'clipboardrx',value:text},location.origin);
      };
    </script></body></html>` }));
});

async function prepare(app: any, browser: any, suffix = '') {
  await app.open(`/i/${id}${suffix}`);
  test.skip(!await browser.evaluate(() => /Safari/.test(navigator.userAgent) && !/Chrome/.test(navigator.userAgent)), 'Safari compatibility path');
  await expect.poll(() => browser.evaluate(() => !!document.querySelector('iframe')?.contentDocument?.getElementById('noVNC_canvas'))).toBe(true);
  // Real trusted UI action seeds the native clipboard before the remote copy.
  await browser.evaluate(() => {
    const button = document.createElement('button');
    button.id = 'clipboard-seed'; button.textContent = 'seed';
    button.style.cssText = 'position:fixed;top:4px;left:4px;z-index:99999';
    button.onclick = () => { void navigator.clipboard.writeText('local-before-copy'); };
    document.body.append(button);
  });
  await browser.mouse.move(20, 15);
  await browser.mouse.down();
  await browser.mouse.up();
  await expect.poll(() => browser.evaluate(() => navigator.clipboard.readText())).toBe('local-before-copy');
  await browser.evaluate(() => document.getElementById('clipboard-seed')!.remove());
}
async function clickRemote(browser: any) {
  await browser.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const box = await browser.evaluate(() => {
    const r = document.querySelector('iframe')!.getBoundingClientRect();
    return { x: r.left + 100, y: r.top + 100 };
  });
  await browser.mouse.move(box.x, box.y);
  await browser.mouse.down();
  await browser.mouse.up();
}
async function receive(browser: any, text: string) {
  await browser.evaluate((value: string) => (document.querySelector('iframe')!.contentWindow as any).remoteCopy(value), text);
}

for (const screen of ['wechat', 'weflow']) {
  test(`${screen}: remote Copy automatically reaches the native Safari text clipboard`, async ({ app, browser }) => {
    await prepare(app, browser, screen === 'weflow' ? '?screen=weflow' : '');
    await clickRemote(browser);
    await receive(browser, '微信复制：第一行\nsecond line 😀');
    await expect.poll(() => browser.evaluate(() => navigator.clipboard.readText())).toBe('微信复制：第一行\nsecond line 😀');
    expect(await browser.evaluate(() => (window as any).clipboardErrors)).toEqual([]);
  });
}

test('ordinary clicks and typing leave the local clipboard intact', async ({ app, browser }) => {
  await prepare(app, browser);
  await clickRemote(browser);
  await browser.keyboard.press('a'); // Cancels the pending copy; does not read the clipboard.
  await expect.poll(() => browser.evaluate(() => navigator.clipboard.readText())).toBe('local-before-copy');
  await receive(browser, 'unsolicited background update');
  expect(await browser.evaluate(() => navigator.clipboard.readText())).toBe('local-before-copy');
  expect(await browser.evaluate(() => (window as any).clipboardErrors)).toEqual([]);
});

test('keyboard copy and repeated copies of the same text work', async ({ app, browser }) => {
  await prepare(app, browser);
  for (let n = 0; n < 2; n++) {
    await clickRemote(browser);
    await browser.keyboard.press('Meta+c');
    await receive(browser, 'repeated remote text');
    await expect.poll(() => browser.evaluate(() => navigator.clipboard.readText())).toBe('repeated remote text');
  }
});

test('keyboard copy of a remote image reaches the native Safari PNG clipboard', async ({ app, browser }) => {
  await prepare(app, browser);
  test.skip(!await browser.evaluate(() => ClipboardItem.supports?.('image/png') !== false), 'Safari PNG clipboard support');
  await clickRemote(browser);
  await browser.keyboard.press('Meta+c');
  await expect.poll(() => browser.evaluate(async () => {
    const items = await navigator.clipboard.read();
    const image = items.find(item => item.types.includes('image/png'));
    return image ? (await image.getType('image/png')).size : 0;
  })).toBe(png.length);
  expect(await browser.evaluate(() => (window as any).clipboardErrors)).toEqual([]);
});

test('IME temporary clipboard content is filtered before a genuine copy', async ({ app, browser }) => {
  await prepare(app, browser);
  await clickRemote(browser);
  await browser.evaluate(() => {
    const w = document.querySelector('iframe')!.contentWindow as any;
    w.document.getElementById('noVNC_keyboardinput').dispatchEvent(new w.CompositionEvent('compositionend', { bubbles: true, data: '输入的临时文字' }));
  });
  await receive(browser, '输入的临时文字');
  expect(await browser.evaluate(() => navigator.clipboard.readText())).toBe('local-before-copy');
  await receive(browser, '真正复制的文字');
  await expect.poll(() => browser.evaluate(() => navigator.clipboard.readText())).toBe('真正复制的文字');
});

test('messages from another frame or another origin cannot overwrite the clipboard', async ({ app, browser }) => {
  await prepare(app, browser);
  await clickRemote(browser);
  await browser.evaluate(() => {
    window.postMessage({ action: 'clipboardrx', value: 'wrong source' }, location.origin);
    window.dispatchEvent(new MessageEvent('message', { source: document.querySelector('iframe')!.contentWindow,
      origin: 'https://unrelated.invalid', data: { action: 'clipboardrx', value: 'wrong origin' } }));
  });
  expect(await browser.evaluate(() => navigator.clipboard.readText())).toBe('local-before-copy');
  await receive(browser, 'correct source');
  await expect.poll(() => browser.evaluate(() => navigator.clipboard.readText())).toBe('correct source');
});

test('iframe reload reattaches the bridge and cancels the old pending copy', async ({ app, browser }) => {
  await prepare(app, browser);
  await clickRemote(browser);
  const old = await browser.evaluate(() => {
    const w = document.querySelector('iframe')!.contentWindow as any;
    const generation = w.fixtureGeneration;
    w.location.reload();
    return generation;
  });
  await expect.poll(() => browser.evaluate((generation: number) => {
    const w = document.querySelector('iframe')!.contentWindow as any;
    return w.fixtureGeneration !== generation && !!w.remoteCopy && Object.hasOwn(w.navigator.clipboard, 'write');
  }, old)).toBe(true);
  await clickRemote(browser);
  await receive(browser, 'copied after reconnect');
  await expect.poll(() => browser.evaluate(() => navigator.clipboard.readText())).toBe('copied after reconnect');
  expect(await browser.evaluate(() => (window as any).clipboardErrors)).toEqual([]);
});
