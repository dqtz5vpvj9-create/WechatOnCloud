import { fileURLToPath } from 'node:url';
import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';

const panel = process.env.WOC_PANEL_WEB || fileURLToPath(new URL('../panel/web/', import.meta.url));
const browsers = (process.env.WOC_PANEL_BROWSERS?.split(',').filter((value): value is 'chromium' | 'webkit' =>
  value === 'chromium' || value === 'webkit') || ['chromium', 'webkit']);
export default {
  tests: 'tests-panel/**/*.e2e.ts', workers: 1, cache: 'off', timeout: 30000, trace: 'retain-on-failure',
  output: '.e2e/panel',
  targets: browsers.map((browser, index) => ({
    name: browser,
    engine: web({ browser }),
    app: {
      url: `http://127.0.0.1:${19448 + index}/`, environment: 'test',
      permissions: browser === 'chromium' ? { 'clipboard-read': 'grant', 'clipboard-write': 'grant', 'local-network-access': 'grant' } : { 'clipboard-read': 'grant' },
      command: {
        executable: process.execPath,
        args: ['node_modules/vite/bin/vite.js', ...(process.env.WOC_PANEL_PREVIEW ? ['preview'] : []), '--host', '127.0.0.1', '--port', String(19448 + index), '--strictPort'],
        cwd: panel,
      },
    },
  })),
} satisfies E2EConfig;
