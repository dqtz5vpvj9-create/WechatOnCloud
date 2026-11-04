import { test } from '@e2e-dev/web';
import { credentials, expect } from 'e2e';

test('admin can sign in through the Tauri WebView', async ({ app, browser, screen }) => {
  const admin = credentials.user('admin');

  await app.open('/login');
  await screen.getByPlaceholder('用户名').fill(admin.username);
  await screen.getByPlaceholder('密码').fill(admin.password);
  await screen.getByRole('button', '登录').tap();

  await expect(browser).toHaveURL('https://wechat.tail.lixinrui000.cn/');
  await expect(browser.locator('.ws-title')).toHaveText('主页');
});
