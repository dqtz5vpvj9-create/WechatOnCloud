import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Docker from 'dockerode';
import { watchClipboardChanges } from '../src/docker.js';
import type { Instance } from '../src/store.js';

test('clipboard events follow the correct X display and stop after disconnect', { timeout: 40_000 }, async () => {
  const image = process.env.WOC_CLIPBOARD_TEST_IMAGE;
  assert.ok(image);
  const docker = new Docker();
  const name = 'woc-clip-events-' + randomUUID().slice(0, 8);
  const container = await docker.createContainer({ name, Image: image, Entrypoint: ['sleep'], Cmd: ['90'], User: 'root', HostConfig: { NetworkMode: 'none', SecurityOpt: ['seccomp=unconfined'] } });
  const run = async (script: string) => {
    const exec = await container.exec({ Cmd: ['sh', '-c', script], AttachStdout: true, AttachStderr: true });
    const stream = await exec.start({ hijack: true, stdin: false });
    const chunks: Buffer[] = [];
    for await (const part of stream) chunks.push(Buffer.from(part));
    assert.equal((await exec.inspect()).ExitCode, 0, Buffer.concat(chunks).toString());
  };
  try {
    await container.start();
    await run('Xvnc :1 -geometry 64x64 -ac -noWebsocket -UseIPv6=0 -publicIP 127.0.0.1 -SecurityTypes None -DLP_ClipTypes text/html -rfbport 5901 >/tmp/x1.log 2>&1 & Xvnc :2 -geometry 64x64 -ac -noWebsocket -UseIPv6=0 -publicIP 127.0.0.1 -SecurityTypes None -DLP_ClipTypes text/html -rfbport 5902 >/tmp/x2.log 2>&1 &');
    await run("timeout 10 sh -c 'until DISPLAY=:1 xdpyinfo >/dev/null 2>&1 && DISPLAY=:2 xdpyinfo >/dev/null 2>&1; do sleep .1; done'");
    let ready!: () => void, changed!: () => void;
    const readyEvent = new Promise<void>(resolve => { ready = resolve; });
    const changedEvent = new Promise<void>(resolve => { changed = resolve; });
    let changes = 0;
    const stop = await watchClipboardChanges({ id: name, containerName: name } as Instance, false, line => {
      if (line === 'ready') ready();
      if (line === 'changed') { changes++; changed(); }
    }, () => {});
    await Promise.race([readyEvent, new Promise((_, reject) => setTimeout(() => reject(new Error('watcher was not ready')), 5000))]);
    await run("printf other | DISPLAY=:2 xclip -selection clipboard -i");
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(changes, 0);
    await run("printf selected | DISPLAY=:1 xclip -selection clipboard -i");
    await Promise.race([changedEvent, new Promise((_, reject) => setTimeout(() => reject(new Error('clipboard event missing')), 5000))]);
    assert.equal(changes, 1);
    stop();
    await run("timeout 9 sh -c 'while pgrep -f \"[S]tream XFixes clipboard ownership changes\" >/dev/null; do sleep .2; done'");
  } finally { await container.remove({ force: true, v: true }); }
});
