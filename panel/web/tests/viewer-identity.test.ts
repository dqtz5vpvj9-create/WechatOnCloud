import test from 'node:test';
import assert from 'node:assert/strict';
import { NATIVE_VIEWER_KEY, viewerIdentity } from '../src/viewerIdentity.ts';

test('native window keeps its identity across documents, browser documents stay independent', () => {
  const values = new Map<string, string>();
  const storage = { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => { values.set(k, v); } };
  let serial = 0;
  const random = () => `viewer-identity-${++serial}`;
  const initial = viewerIdentity(true, storage, random);
  assert.equal(viewerIdentity(true, storage, random), initial);
  assert.notEqual(viewerIdentity(false, storage, random), initial);
  assert.notEqual(viewerIdentity(false, storage, random), initial);
  values.delete(NATIVE_VIEWER_KEY);
  assert.notEqual(viewerIdentity(true, storage, random), initial, 'explicit reclaim rotates the identity');
  assert.doesNotThrow(() => viewerIdentity(true, { getItem() { throw new Error('restricted'); }, setItem() {} }, random));
});
