import { readFileSync } from 'node:fs';
import { test, beforeEach } from '@e2e-dev/web';
import { expect } from 'e2e';

const source = readFileSync(new URL('../src-tauri/src/update-status.js', import.meta.url), 'utf8');
beforeEach(async ({ browser }) => {
  await browser.route('**/login', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html><head><meta charset="utf-8"></head><body><h1>云微更新测试</h1><script>
    window.updateActions = [];
    window.updateState = {phase:'available',currentVersion:'0.2.0',version:'0.3.0'};
    window.__TAURI__ = {core:{invoke:async (command,args) => {
      if(command !== 'desktop_update') throw Error(command);
      window.updateActions.push(args.action);
      if(args.action === 'install') { window.updateState.phase = 'downloading'; }
      return window.updateState;
    }}};
    ${source}
  </script></body></html>` }));
});

test('update is opt-in, shows download progress and can be postponed', async ({ app, browser, screen }) => {
  await app.open('/login');
  await expect(screen.getByText('云微 0.3.0 已就绪')).toBeVisible();
  expect(await browser.evaluate(() => (window as any).updateActions.includes('install'))).toBe(false);
  await screen.getByRole('button', '稍后').click();
  await expect(screen.getByRole('button', '更新并重启')).toHaveCount(0);
  await browser.evaluate(() => window.dispatchEvent(new Event('yunwei-check-updates')));
  await screen.getByRole('button', '更新并重启').click();
  await browser.evaluate(() => Object.assign((window as any).updateState, {downloaded:50,total:100}));
  await expect(screen.getByText('正在下载更新 50%')).toBeVisible();
  expect(await browser.evaluate(() => (window as any).updateActions.filter((action: string) => action === 'install').length)).toBe(1);
});

test('manual checks display current version and network errors remain retryable', async ({ app, browser, screen }) => {
  await app.open('/login');
  await browser.evaluate(() => {
    (window as any).updateState = {phase:'error',currentVersion:'0.2.0'};
    window.dispatchEvent(new Event('yunwei-check-updates'));
  });
  await expect(screen.getByText('检查更新失败，请稍后重试')).toBeVisible();
  await browser.evaluate(() => (window as any).updateState = {phase:'current',currentVersion:'0.2.0'});
  await screen.getByRole('button', '重试').click();
  await expect(screen.getByText('云微 0.2.0 已是最新版本')).toBeVisible();
});
