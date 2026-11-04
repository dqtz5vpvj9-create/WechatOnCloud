import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const executable = process.env.WOC_DESKTOP_EXE;
const port = process.env.WOC_E2E_CDP_PORT;

if (!executable || !existsSync(executable)) {
  throw new Error(`WOC_DESKTOP_EXE does not exist: ${executable ?? '<unset>'}`);
}
if (!port || !/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
  throw new Error(`WOC_E2E_CDP_PORT is invalid: ${port ?? '<unset>'}`);
}

const environment = { ...process.env };
const profile = process.env.WOC_E2E_PROFILE;
if (profile && profile !== 'app') {
  environment.WEBVIEW2_USER_DATA_FOLDER = path.resolve(profile);
}

const child = spawn(executable, [`--automation-port=${port}`], {
  cwd: path.dirname(executable),
  env: environment,
  stdio: 'inherit',
  windowsHide: false,
});

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopping = true;
    if (child.exitCode === null) child.kill();
  });
}

child.on('error', (error) => {
  throw error;
});
child.on('exit', (code) => {
  process.exitCode = stopping ? 0 : (code ?? 1);
});
