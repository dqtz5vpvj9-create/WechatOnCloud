import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

test('native hide/show retains its WebSocket even after the old idle timeout', async ({ app, browser }) => {
  let connections = 0;
  const sockets = new Set<any>();
  const server = createServer();
  server.on('upgrade', (request, socket) => {
    const accept = createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    connections++;
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('data', data => { if ((data[0] & 15) === 8) socket.end(Buffer.from([0x88, 0])); });
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as any).port;
  try {
    // Advance only the background-release timer; ordinary UI/network timers
    // keep running so real iframe navigation and socket closure are observed.
    await browser.addInitScript(() => {
      const originalSet = window.setTimeout.bind(window);
      const originalClear = window.clearTimeout.bind(window);
      const timers = new Map<number, () => void>();
      let next = -1;
      window.setTimeout = ((callback: () => void, delay?: number, ...args: any[]) => {
        if (delay !== 60_000) return originalSet(callback, delay, ...args);
        const id = next--;
        timers.set(id, callback);
        return id;
      }) as typeof window.setTimeout;
      window.clearTimeout = id => { if (!timers.delete(id!)) originalClear(id); };
      (window as any).expireBackground = () => { const jobs = [...timers.values()]; timers.clear(); jobs.forEach(job => job()); };
    });
    await browser.route('**/registerSW.js', route => route.fulfill({ body: '' }));
    await browser.route('**/api/**', route => {
      const path = new URL(route.request.url).pathname;
      const json = path === '/api/auth/me' ? { user: { id: 'test', role: 'admin' } }
        : path === '/api/instances' ? { instances: [{ id: 'fixture', name: '微信', runtime: 'running', appType: 'wechat', wechat: { installed: true, phase: 'done' } }] }
        : { ok: true, free: true, mine: true, quality: 'standard', phase: 'ready' };
      return route.fulfill({ json });
    });
    await browser.route('**/desktop/**', route => route.fulfill({ contentType: 'text/html',
      body: `<div id="noVNC_container"></div><script>window.socket=new WebSocket('ws://127.0.0.1:${port}');</script>` }));
    await app.open('/i/fixture');
    await expect.poll(() => sockets.size).toBe(1);
    await browser.evaluate(() => { (window as any).originalFrame = document.querySelector('iframe')!.contentWindow!.document; });
    const visibility = (visible: boolean) => browser.evaluate((visible: boolean) => {
      window.dispatchEvent(new CustomEvent('woc-native-visibility', { detail: { visible } }));
    }, visible);
    await visibility(false);
    await expect.poll(() => browser.locator('iframe').getAttribute('src')).not.toBe('about:blank');
    await visibility(true);
    await browser.evaluate(() => (window as any).expireBackground());
    expect(connections).toBe(1);
    expect(await browser.evaluate(() => document.querySelector('iframe')!.contentWindow!.document === (window as any).originalFrame)).toBe(true);
    await visibility(false);
    await browser.evaluate(() => (window as any).expireBackground());
    await expect.poll(() => browser.locator('iframe').getAttribute('src')).not.toBe('about:blank');
    expect(sockets.size).toBe(1);
    await visibility(true);
    for (let i = 0; i < 10; i++) {
      await visibility(false);
      await browser.evaluate(() => (window as any).expireBackground());
      await visibility(true);
    }
    expect(connections).toBe(1);
    expect(await browser.evaluate(() => document.querySelector('iframe')!.contentWindow!.document === (window as any).originalFrame)).toBe(true);
    await expect.poll(() => sockets.size).toBe(1);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
