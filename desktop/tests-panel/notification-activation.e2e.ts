import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test('opening the desktop clears old reminders permanently while future background messages still alert', async ({ app, browser }) => {
  let acknowledgments = 0;
  let offline = false;
  let readSequence = 5;
  await browser.addInitScript(() => {
    const state = (window as any).notificationTest = { background: true, count: 0, updates: [] as any[], source: null as any };
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state.background ? 'hidden' : 'visible' });
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => !state.background });
    (window as any).__TAURI__ = { core: { invoke: async (command: string, args: any) => {
      if (command === 'set_desktop_notification') { state.count = args.payload.count; state.updates.push(args.payload); }
    } } };
    (window as any).EventSource = class {
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      constructor() { state.source = this; queueMicrotask(() => this.onopen?.()); }
      close() { if (state.source === this) state.source = null; }
    };
  });
  await browser.route('**/registerSW.js', route => route.fulfill({ body: '' }));
  await browser.route('**/api/**', route => {
    const path = new URL(route.request.url).pathname;
    if (path === '/api/notifications/read') {
      acknowledgments++;
      return route.fulfill({ status: offline ? 503 : 200, json: offline ? { error: 'offline fixture' } : { ok: true, readSequence } });
    }
    const json = path === '/api/auth/me' ? { user: { id: 'test', role: 'admin' } }
      : path === '/api/instances' ? { instances: [{ id: 'fixture', name: '微信', appType: 'wechat', runtime: 'running', wechat: { installed: true, phase: 'done' } }] }
      : { ok: true, free: true, mine: true, quality: 'standard', phase: 'ready' };
    return route.fulfill({ json });
  });
  await browser.route('**/desktop/**', route => route.fulfill({ contentType: 'text/html', body: '<div id="noVNC_container"><canvas></canvas></div>' }));
  await app.open('/i/fixture');
  await expect.poll(() => browser.evaluate(() => !!(window as any).notificationTest.source?.onmessage)).toBe(true);
  const count = () => browser.evaluate(() => (window as any).notificationTest.count);
  const send = (payload: any) => browser.evaluate(payload => {
    (window as any).notificationTest.source.onmessage({ data: JSON.stringify(payload) });
  }, payload);
  const active = (value: boolean) => browser.evaluate(value => {
    (window as any).notificationTest.background = !value;
    window.dispatchEvent(new Event(value ? 'focus' : 'blur'));
    document.dispatchEvent(new Event('visibilitychange'));
  }, value);
  const old = { tag: 'old-chat', count: 3, title: 'old', body: 'fixture', url: '/i/fixture' };
  const fresh = { tag: 'new-chat', count: 1, title: 'new', body: 'fixture', url: '/i/fixture', sequence: 6 };
  await send({ snapshot: true, count: 3, sessions: [old] });
  await expect.poll(count).toBe(3);
  await active(true);
  await expect.poll(count).toBe(0);
  await expect.poll(() => acknowledgments).toBeGreaterThan(0);
  await send({ snapshot: true, count: 3, sessions: [old] });
  await expect.poll(count).toBe(0);
  await active(false);
  await send({ ...fresh, tag: 'late-already-read', sequence: 4 });
  await expect.poll(count).toBe(0);
  await send({ snapshot: true, count: 3, sessions: [old] });
  await expect.poll(count).toBe(0);
  await send(fresh);
  await expect.poll(count).toBe(1);
  await send({ snapshot: true, count: 4, sessions: [old, fresh] });
  await expect.poll(count).toBe(1);
  expect(await browser.evaluate(() => (window as any).notificationTest.updates.at(-1).sessions.map((s: any) => s.tag))).toEqual(['new-chat']);
  // Reading the new reminder also stops it permanently, even if an older
  // snapshot arrives after the app has already returned to the background.
  offline = true;
  readSequence = 6;
  const before = acknowledgments;
  await active(true);
  await expect.poll(count).toBe(0);
  await expect.poll(() => acknowledgments).toBeGreaterThan(before);
  await active(false);
  await send(fresh);
  await send({ snapshot: true, count: 4, sessions: [old, fresh] });
  await expect.poll(count).toBe(0);
  offline = false;
  const retry = acknowledgments;
  await expect.poll(() => acknowledgments).toBeGreaterThan(retry);
  await send({ ...fresh, tag: 'future-chat', sequence: 7 });
  await expect.poll(count).toBe(1);
  await browser.evaluate(() => window.dispatchEvent(new CustomEvent('woc-native-visibility', { detail: { visible: true } })));
  await expect.poll(count).toBe(0);
});
