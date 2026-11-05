import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { chromium } from 'playwright';

test('dismissing from the tray forwards server read acknowledgments to the main window', async () => {
  const connection = await chromium.connectOverCDP(`http://127.0.0.1:${process.env.WOC_E2E_CDP_PORT ?? '9333'}`);
  try {
    await expect.poll(() => connection.contexts().flatMap(context => context.pages()).some(page => page.url().includes('tray-preview.html'))).toBe(true);
    await expect.poll(() => connection.contexts().flatMap(context => context.pages()).some(page => page.url().startsWith('https://wechat.tail.lixinrui000.cn/'))).toBe(true);
    const pages = connection.contexts().flatMap(context => context.pages());
    const main = pages.find(page => page.url().startsWith('https://wechat.tail.lixinrui000.cn/'))!;
    const preview = pages.find(page => page.url().includes('tray-preview.html'))!;
    await main.waitForFunction(() => typeof (window as any).__TAURI__?.core?.invoke === 'function');
    await preview.waitForFunction(() => typeof (window as any).__TAURI__?.core?.invoke === 'function');
    await main.evaluate(async () => {
      (window as any).readAcks = [];
      window.addEventListener('woc-notification-read', (event: Event) => (window as any).readAcks.push((event as CustomEvent).detail));
      await (window as any).__TAURI__.core.invoke('set_desktop_notification', { payload: {
        snapshot:true,count:5,notify:false,sessions:[
          {tag:'one',title:'one',body:'fixture',count:2,url:'/i/fixture'},
          {tag:'two',title:'two',body:'fixture',count:3,url:'/i/fixture'},
        ],
      }});
    });
    await preview.evaluate(() => (window as any).__TAURI__.core.invoke('dismiss_tray_message', {tag:'one'}));
    await expect.poll(() => main.evaluate(() => (window as any).readAcks)).toEqual([{tag:'one'}]);
    const state = await main.evaluate(() => (window as any).__TAURI__.core.invoke('get_taskbar_unread_state'));
    expect(state[0]).toBe(3);
    expect(state[3]).toBe(1);
    await preview.evaluate(() => (window as any).__TAURI__.core.invoke('dismiss_all_tray_messages'));
    await expect.poll(() => main.evaluate(() => (window as any).readAcks)).toEqual([{tag:'one'},{all:true}]);
    expect((await main.evaluate(() => (window as any).__TAURI__.core.invoke('get_taskbar_unread_state')))[0]).toBe(0);
  } finally { await connection.close(); }
});
