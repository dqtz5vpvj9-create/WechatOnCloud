import { beforeEach, test } from '@e2e-dev/web';
import { expect } from 'e2e';

beforeEach(async ({ app, browser }) => {
  await browser.addInitScript(() => {
    // Exercise the macOS-only compatibility layer even on a Windows runner.
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel' });
    const calls = (window as any).clipboardCalls = { read: 0, write: 0 };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: Object.create({
      read() { calls.read++; return Promise.resolve([]); },
      readText() { calls.read++; return Promise.resolve('explicit paste'); },
      write() { calls.write++; return Promise.resolve(); },
      writeText() { calls.write++; return Promise.resolve(); },
    }) });
    localStorage.setItem('enable_ime', 'true');
  });
  await app.open(`/?guard=${process.env.WOC_INPUT_GUARD === '0' ? 'off' : 'on'}`);
  await expect.poll(() => browser.evaluate(() => Boolean((document.querySelector('iframe')!.contentWindow as any)?.inputTest?.ready))).toBe(true);
});

test('IME tap release delivered before its press finishes as one released click', async ({ browser }) => {
  await browser.evaluate(() => {
    const t = (document.querySelector('iframe')!.contentWindow as any).inputTest;
    t.send('mouseup', { timestamp: 20 });
    t.send('mousedown', { buttons: 1, timestamp: 10 });
  });
  await expect.poll(() => browser.evaluate(() => (document.querySelector('iframe')!.contentWindow as any).inputTest.events.map((e: any) => [e.type, e.mask]))).toEqual([['mousedown', 1], ['mouseup', 0]]);
  await browser.evaluate(() => (document.querySelector('iframe')!.contentWindow as any).inputTest.send('mousemove', { clientX: 250, buttons: 0 }));
  expect(await browser.evaluate(() => (document.querySelector('iframe')!.contentWindow as any).inputTest.events.at(-1).mask)).toBe(0);
});

test('a missing release is repaired before the next hover moves the remote pointer', async ({ browser }) => {
  await browser.evaluate(() => {
    const t = (document.querySelector('iframe')!.contentWindow as any).inputTest;
    t.send('mousedown', { buttons: 1 });
    t.send('mousemove', { clientX: 250, buttons: 0 });
  });
  expect(await browser.evaluate(() => (document.querySelector('iframe')!.contentWindow as any).inputTest.events.map((e: any) => [e.type, e.mask, e.x]))).toEqual([
    ['mousedown', 1, 100], ['mouseup', 0, 100], ['mousemove', 0, 250],
  ]);
});

test('a release re-entering the IME focus listener reaches VNC after the press', async ({ browser }) => {
  await browser.evaluate(() => {
    const t = (document.querySelector('iframe')!.contentWindow as any).inputTest;
    t.reentrant = true;
    t.send('mousedown', { buttons: 1 });
  });
  await expect.poll(() => browser.evaluate(() => (document.querySelector('iframe')!.contentWindow as any).inputTest.events.map((e: any) => [e.type, e.mask]))).toEqual([['mousedown', 1], ['mouseup', 0]]);
});

test('a genuine held drag and consecutive clicks retain their button state', async ({ browser }) => {
  const box = await browser.evaluate(() => {
    const frame = document.querySelector('iframe')!.getBoundingClientRect();
    return { x: frame.left + 100, y: frame.top + 100 };
  });
  await browser.mouse.move(box.x, box.y);
  await browser.mouse.down();
  await browser.mouse.move(box.x + 60, box.y + 30);
  expect(await browser.evaluate(() => (document.querySelector('iframe')!.contentWindow as any).inputTest.mask)).toBe(1);
  await browser.mouse.up();
  expect(await browser.evaluate(() => (document.querySelector('iframe')!.contentWindow as any).inputTest.mask)).toBe(0);
  await browser.evaluate(() => { (document.querySelector('iframe')!.contentWindow as any).inputTest.events = []; });
  for (let click = 0; click < 2; click++) {
    await browser.mouse.down();
    await browser.mouse.up();
  }
  expect(await browser.evaluate(() => (document.querySelector('iframe')!.contentWindow as any).inputTest.events.filter((e: any) => e.type !== 'mousemove').map((e: any) => [e.type, e.mask]))).toEqual([
    ['mousedown', 1], ['mouseup', 0], ['mousedown', 1], ['mouseup', 0],
  ]);
});

test('an old unmatched release never ends a newer real press', async ({ browser }) => {
  await browser.evaluate(() => {
    const t = (document.querySelector('iframe')!.contentWindow as any).inputTest;
    t.send('mouseup', { timestamp: 10 });
    t.send('mousedown', { buttons: 1, timestamp: 20 });
  });
  expect(await browser.evaluate(() => (document.querySelector('iframe')!.contentWindow as any).inputTest.mask)).toBe(1);
  await browser.evaluate(() => (document.querySelector('iframe')!.contentWindow as any).inputTest.send('mouseup'));
  expect(await browser.evaluate(() => (document.querySelector('iframe')!.contentWindow as any).inputTest.mask)).toBe(0);
});

test('right and middle clicks do not release another held button', async ({ browser }) => {
  await browser.evaluate(() => {
    const t = (document.querySelector('iframe')!.contentWindow as any).inputTest;
    t.send('mousedown', { button: 0, buttons: 1 });
    t.send('mousedown', { button: 2, buttons: 3 });
    t.send('mouseup', { button: 2, buttons: 1 });
    t.send('mousemove', { buttons: 1 });
  });
  expect(await browser.evaluate(() => (document.querySelector('iframe')!.contentWindow as any).inputTest.mask)).toBe(1);
  await browser.evaluate(() => {
    const t = (document.querySelector('iframe')!.contentWindow as any).inputTest;
    t.send('mouseup');
    t.send('mousedown', { button: 1, buttons: 4 });
    t.send('mouseup', { button: 1 });
  });
  expect(await browser.evaluate(() => (document.querySelector('iframe')!.contentWindow as any).inputTest.mask)).toBe(0);
});

test('releasing over the panel and losing window focus clear the remote hold', async ({ browser, screen }) => {
  await browser.evaluate(() => {
    (document.querySelector('iframe')!.contentWindow as any).inputTest.send('mousedown', { buttons: 1 });
    window.dispatchEvent(new MouseEvent('mouseup', { button: 0, buttons: 0 }));
  });
  expect(await browser.evaluate(() => (document.querySelector('iframe')!.contentWindow as any).inputTest.mask)).toBe(0);
  await browser.evaluate(() => { (document.querySelector('iframe')!.contentWindow as any).inputTest.send('mousedown', { buttons: 1 }); });
  await screen.getByLabel('面板输入').focus();
  await expect.poll(() => browser.evaluate(() => (document.querySelector('iframe')!.contentWindow as any).inputTest.mask)).toBe(0);
});

test('clicking cannot request clipboard access; explicit paste, writes and file drops still work', async ({ browser }) => {
  const box = await browser.evaluate(() => {
    const frame = document.querySelector('iframe')!.getBoundingClientRect();
    return { x: frame.left + 100, y: frame.top + 100 };
  });
  await browser.mouse.move(box.x, box.y);
  await browser.mouse.down();
  await browser.mouse.up();
  expect(await browser.evaluate(() => (document.querySelector('iframe')!.contentWindow as any).clipboardCalls.read)).toBe(0);
  await browser.evaluate(() => (document.querySelector('iframe')!.contentDocument!.getElementById('explicit-paste') as HTMLButtonElement).click());
  expect(await browser.evaluate(() => (document.querySelector('iframe')!.contentWindow as any).clipboardCalls.read)).toBe(1);
  await browser.evaluate(async () => {
    const w = document.querySelector('iframe')!.contentWindow as any;
    await w.navigator.clipboard.writeText('remote copy');
    const paste = new w.DataTransfer();
    paste.setData('text/plain', 'paste fixture');
    w.document.dispatchEvent(new w.ClipboardEvent('paste', { clipboardData: paste, bubbles: true }));
    const drop = new w.DataTransfer();
    drop.items.add(new w.File(['drop fixture'], 'check.txt', { type: 'text/plain' }));
    w.document.dispatchEvent(new w.DragEvent('drop', { dataTransfer: drop, bubbles: true, cancelable: true }));
  });
  expect(await browser.evaluate(() => (document.querySelector('iframe')!.contentWindow as any).clipboardCalls.write)).toBe(1);
  expect(await browser.evaluate(() => (document.querySelector('iframe')!.contentWindow as any).inputTest.pasted)).toBe('paste fixture');
  await expect.poll(() => browser.evaluate(() => (document.querySelector('iframe')!.contentWindow as any).inputTest.dropped)).toBe('drop fixture');
});
