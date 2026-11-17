import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test('custom panel checks the upstream version without offering to replace its image', async ({ app, browser, screen }) => {
  let checks = 0;
  const version = { current: 'dev-custom', latest: 'v1.10.0', hasUpdate: false, isDev: true, checkedAt: Date.now(), source: 'dockerhub+ghcr', error: null, trackOnly: true };
  await browser.route('**/registerSW.js', route => route.fulfill({ body: '' }));
  await browser.route('**/api/**', route => {
    const pathname = new URL(route.request.url).pathname;
    let value: any = { ok: true, instances: [], users: [], volumes: [], containers: [] };
    if (pathname === '/api/auth/me') value = { user: { id: 'admin', username: 'admin', role: 'admin', allowedInstances: [] } };
    if (pathname === '/api/version') value = version;
    if (pathname === '/api/admin/version/check') { checks++; value = version; }
    return route.fulfill({ json: value });
  });
  await app.open('/admin');
  await screen.getByRole('tab', '系统').click();
  await expect(screen.getByText('上游最新发布', { exact: true })).toBeVisible();
  await expect(screen.getByText('v1.10.0', { exact: true })).toBeVisible();
  await expect(screen.getByText('当前面板为定制构建，上游版本仅供参考。', { exact: false })).toBeVisible();
  expect(await screen.getByRole('button', '升级到正式版').count()).toBe(0);
  await screen.getByText('检查更新', { exact: true }).click();
  await expect.poll(() => checks).toBe(1);
  await expect(screen.getByText('上游最新发布 v1.10.0', { exact: true })).toBeVisible();
});
