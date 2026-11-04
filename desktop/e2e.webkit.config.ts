import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';

const root = path.dirname(fileURLToPath(import.meta.url));
export default {
  tests: 'tests-webkit/**/*.e2e.ts',
  workers: 1,
  cache: 'off',
  trace: 'retain-on-failure',
  targets: [{
    name: 'webkit-remote-input',
    engine: web({ browser: 'webkit' }),
    app: {
      url: 'http://127.0.0.1:19445/',
      environment: 'test',
      command: {
        executable: process.execPath,
        args: ['scripts/input-test-server.mjs'],
        cwd: root,
        log: '.e2e/logs/webkit-input.log',
      },
    },
  }],
} satisfies E2EConfig;
