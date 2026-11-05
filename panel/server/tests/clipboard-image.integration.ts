import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { crc32 } from 'node:zlib';
import Docker from 'dockerode';
import { readClipboardImage, typeInInstance } from '../src/docker.js';
import { tarSingleFile } from '../src/tar.js';
import type { Instance } from '../src/store.js';

// WOC_CLIPBOARD_TEST_IMAGE must name an already-present instance image.
// The test creates isolated X displays, uses generated images, and removes its container.
test('real X clipboards preserve PNG bytes, display isolation and pending typing restoration', { timeout: 60_000 }, async t => {
  const image = process.env.WOC_CLIPBOARD_TEST_IMAGE;
  assert.ok(image, 'set WOC_CLIPBOARD_TEST_IMAGE to a local instance image');
  const docker = new Docker();
  const name = 'woc-clipboard-test-' + randomUUID().slice(0, 8);
  const container = await docker.createContainer({
    name, Image: image, Entrypoint: ['sleep'], Cmd: ['120'], User: 'root', Env: ['DISPLAY=:1'],
    HostConfig: { NetworkMode: 'none', SecurityOpt: ['seccomp=unconfined'] },
  });
  const run = async (cmd: string[]) => {
    const execution = await container.exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true });
    const stream = await execution.start({ hijack: true, stdin: false });
    const chunks: Buffer[] = [];
    for await (const data of stream) chunks.push(Buffer.from(data));
    assert.equal((await execution.inspect()).ExitCode, 0, Buffer.concat(chunks).toString());
  };
  const inst = { id: name, containerName: name } as Instance;
  const small = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGP4z8DwH4QZYAwAR8oH+WdZbrcAAAAASUVORK5CYII=', 'base64');
  const body = Buffer.concat([Buffer.from('tEXtNote\0'), Buffer.alloc(1_100_000, 65)]);
  const length = Buffer.alloc(4); length.writeUInt32BE(body.length - 4);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  const large = Buffer.concat([small.subarray(0, -12), length, body, crc, small.subarray(-12)]);
  const put = async (display: number, data: Buffer, mime = 'image/png') => {
    const file = `clipboard-${display}.bin`;
    await container.putArchive(tarSingleFile(file, data), { path: '/tmp' });
    await run(['sh', '-c', `DISPLAY=:${display} xclip -selection clipboard -t ${mime} -i /tmp/${file} >/dev/null 2>&1`]);
  };
  try {
    await container.start();
    await run(['sh', '-c', 'Xvnc :1 -geometry 64x64 -ac -noWebsocket -UseIPv6=0 -publicIP 127.0.0.1 -SecurityTypes None -DLP_ClipTypes text/html -rfbport 5901 >/tmp/x1.log 2>&1 & Xvnc :2 -geometry 64x64 -ac -noWebsocket -UseIPv6=0 -publicIP 127.0.0.1 -SecurityTypes None -DLP_ClipTypes text/html -rfbport 5902 >/tmp/x2.log 2>&1 &']);
    await run(['sh', '-c', 'timeout 10 sh -c \'until DISPLAY=:1 xdpyinfo >/dev/null 2>&1 && DISPLAY=:2 xdpyinfo >/dev/null 2>&1; do sleep 0.1; done\'']);
    await t.test('reads distinct images from the two displays, including an INCR-sized PNG', async () => {
      await put(1, small); await put(2, large);
      const [wechat, weflow] = await Promise.all([readClipboardImage(inst), readClipboardImage(inst, true)]);
      assert.deepEqual(wechat, small);
      assert.deepEqual(weflow, large);
    });
    await t.test('restores the image temporarily borrowed by seamless typing', async () => {
      await typeInInstance(inst, 'clipboard regression');
      assert.deepEqual(await readClipboardImage(inst), small);
      assert.deepEqual(await readClipboardImage(inst, true), large);
    });
    await t.test('text-only clipboard fails without disturbing the other display', async () => {
      await put(1, Buffer.from('text-only'), 'UTF8_STRING');
      await assert.rejects(readClipboardImage(inst), /没有图片/);
      assert.deepEqual(await readClipboardImage(inst, true), large);
    });
    await t.test('truncated PNG is rejected', async () => {
      await put(1, small.subarray(0, -12));
      await assert.rejects(readClipboardImage(inst), /不完整或格式无效/);
    });
  } finally {
    await container.remove({ force: true, v: true });
  }
});
