import assert from 'node:assert/strict';
import { test } from 'node:test';
import { api } from '../src/api.ts';

test('image transfer progress reports received bytes and the actual response length', async () => {
  const original = globalThis.fetch;
  const chunks = [new Uint8Array([1, 2]), new Uint8Array([3, 4, 5])];
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); },
  }), { headers: { 'content-type': 'image/png', 'content-length': '5' } });
  try {
    const progress: Array<[number, number | null]> = [];
    const image = await api.clipboardImage('test', (received, total) => progress.push([received, total]));
    assert.deepEqual(progress, [[2, 5], [5, 5]]);
    assert.deepEqual([...new Uint8Array(await image.arrayBuffer())], [1, 2, 3, 4, 5]);
  } finally { globalThis.fetch = original; }
});

test('image transfer does not invent a total when the server omits it', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(new Uint8Array([1, 2]), { headers: { 'content-type': 'image/png' } });
  try {
    const progress: Array<[number, number | null]> = [];
    await api.clipboardImage('test', (received, total) => progress.push([received, total]));
    assert.deepEqual(progress, [[2, null]]);
  } finally { globalThis.fetch = original; }
});
