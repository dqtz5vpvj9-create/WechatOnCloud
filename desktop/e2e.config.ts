import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';

const root = path.dirname(fileURLToPath(import.meta.url));
const cdpPort = process.env.WOC_E2E_CDP_PORT ?? '9333';
const cdpEndpoint = `http://127.0.0.1:${cdpPort}`;

export default {
  tests: 'tests/**/*.e2e.ts',
  workers: 1,
  cache: 'off',
  trace: 'retain-on-failure',
  targets: [
    {
      name: 'yunwei-webview2',
      engine: web({
        browser: 'chromium',
        connect: {
          cdpEndpoint: async () => cdpEndpoint,
          reconnectEndpoint: async () => cdpEndpoint,
        },
        viewport: null,
      }),
      app: {
        url: 'https://wechat.tail.lixinrui000.cn/',
        readyUrl: `${cdpEndpoint}/json/version`,
        environment: 'test',
        command: {
          executable: process.execPath,
          args: ['scripts/start-webview-test.mjs'],
          cwd: root,
          env: {
            WOC_E2E_CDP_PORT: cdpPort,
            WOC_E2E_PROFILE: process.env.WOC_E2E_PROFILE ?? path.join(root, '.e2e', 'webview-profile'),
            WOC_DESKTOP_EXE:
              process.env.WOC_DESKTOP_EXE ?? path.join(root, 'src-tauri', 'target', 'release', 'yunwei.exe'),
          },
          startupTimeout: 30_000,
          shutdownTimeout: 10_000,
          log: '.e2e/logs/desktop.log',
        },
      },
    },
  ],
  credentials: {
    admin: {
      username: process.env.WOC_E2E_USERNAME ?? 'admin',
      password: () => process.env.WOC_E2E_PASSWORD ?? '',
    },
  },
} satisfies E2EConfig;
