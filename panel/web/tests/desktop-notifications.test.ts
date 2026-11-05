import assert from 'node:assert/strict';
import test from 'node:test';
import { notifyTaskbar } from '../src/desktopBridge.ts';

test('a slow native notification cannot overwrite the subsequent read snapshot', async () => {
  const values = new Map<string, string>();
  const applied: number[] = [];
  let release!: () => void;
  const delayed = new Promise<void>(resolve => { release = resolve; });
  const globals = ['window', 'document', 'sessionStorage'] as const;
  const previous = globals.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    __TAURI__: { core: { invoke: async (_command: string, { payload }: any) => {
      if (payload.count === 3) await delayed;
      applied.push(payload.count);
    } } },
  } });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { visibilityState: 'hidden' } });
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
    getItem: (key: string) => values.get(key),
    setItem: (key: string, value: string) => values.set(key, value),
  } });
  try {
    const incoming = notifyTaskbar({ count: 3, tag: 'chat' });
    const read = notifyTaskbar({ snapshot: true, count: 0, sessions: [] });
    await new Promise(resolve => setTimeout(resolve, 0));
    release();
    await Promise.all([incoming, read]);
    assert.deepEqual(applied, [3, 0]);
  } finally {
    globals.forEach((key, i) => {
      if (previous[i]) Object.defineProperty(globalThis, key, previous[i]!);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
});
