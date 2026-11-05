import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test('IME candidate numbers stay local while committed text and deliberate digits retain order', async ({ app, browser }) => {
  const typed: string[] = [];
  const keys: string[] = [];
  let finishFirst!: () => void;
  const firstPending = new Promise<void>(resolve => { finishFirst = resolve; });
  await browser.addInitScript(() => localStorage.setItem('woc_input_mode', 'seamless'));
  await browser.route('**/registerSW.js', route => route.fulfill({ body: '' }));
  await browser.route('**/api/**', async route => {
    const path = new URL(route.request.url).pathname;
    if (path.endsWith('/type')) {
      typed.push(JSON.parse(route.request.postData || '{}').text);
      if (typed.length === 1) await firstPending;
    }
    if (path.endsWith('/key')) keys.push(JSON.parse(route.request.postData || '{}').key);
    const json = path === '/api/auth/me' ? { user: { id: 'test', role: 'admin' } }
      : path === '/api/instances' ? { instances: [{ id: 'fixture', name: '微信', runtime: 'running', appType: 'wechat', wechat: { installed: true, phase: 'done' } }] }
      : { ok: true, free: true, mine: true, quality: 'standard', phase: 'ready' };
    await route.fulfill({ json });
  });
  await browser.route('**/desktop/**', route => route.fulfill({ contentType: 'text/html', body: `
    <div id="noVNC_container"><textarea id="noVNC_keyboardinput"></textarea></div>
    <script>
    window.forwarded=[];
    // Match the deployed KasmVNC keydown gate; uncaught candidate keys must
    // reach neither this native keysym path nor the panel's HTTP text queue.
    document.getElementById('noVNC_keyboardinput').addEventListener('keydown',e=>{
      if(e.isComposing||e.keyCode===229)return;
      window.forwarded.push(e.key);e.preventDefault();
    });
    </script>` }));
  try {
    await app.open('/i/fixture');
    await expect.poll(() => browser.locator('[title^="无感输入："]').count()).toBe(1);
    await expect.poll(() => browser.evaluate(() => Array.isArray((document.querySelector('iframe')!.contentWindow as any).forwarded))).toBe(true);
    const fire = async (phase: string, key = '', code = 0, data = '') => browser.evaluate(({ phase, key, code, data }) => {
      const w = document.querySelector('iframe')!.contentWindow! as any;
      const input = w.document.getElementById('noVNC_keyboardinput');
      const event = phase === 'keydown'
        ? new w.KeyboardEvent(phase, { key, code: key === 'Enter' ? 'Enter' : `Digit${key}`, keyCode: code, isComposing: false, bubbles: true, cancelable: true })
        : new w.CompositionEvent(phase, { data, bubbles: true });
      input.dispatchEvent(event);
      return event.defaultPrevented;
    }, { phase, key, code, data });
    // KasmVNC normally ignores keyCode 229 itself. First finish a word to
    // activate the panel queue, where the old implementation captures it.
    await fire('compositionstart');
    expect(await fire('keydown', '1', 49)).toBe(false);
    await fire('compositionend', '', 0, '你');
    await expect.poll(() => typed.length).toBe(1);
    await fire('compositionstart');
    expect(await fire('keydown', '2', 229)).toBe(false);
    await fire('compositionend', '', 0, '好');
    // A late candidate key must never become text, even if the event exposes
    // an ordinary keyCode and compositionend has already run.
    expect(await fire('keydown', '2', 50)).toBe(false);
    // The confirming event can arrive after compositionend in WebKit.
    expect(await fire('keydown', '3', 229)).toBe(false);
    expect(await fire('keydown', 'Enter', 229)).toBe(false);
    await fire('compositionstart');
    expect(await fire('keydown', '5', 53)).toBe(false);
    await fire('compositionend', '', 0, '呀');
    await browser.evaluate(() => (document.querySelector('iframe')!.contentDocument!.getElementById('noVNC_keyboardinput') as HTMLElement).focus());
    await browser.keyboard.type('4');
    finishFirst();
    await expect.poll(() => typed).toEqual(['你', '好', '呀', '4']);
    expect(keys).toEqual([]);
    expect(await browser.evaluate(() => (document.querySelector('iframe')!.contentWindow as any).forwarded)).toEqual([]);
    // Also use trusted browser typing when no earlier word is pending.
    await browser.keyboard.type('78');
    await expect.poll(() => typed).toEqual(['你', '好', '呀', '4', '7', '8']);
  } finally { finishFirst(); }
});
