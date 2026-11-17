import assert from 'node:assert/strict';
import { test } from 'node:test';

test('an upstream-only custom build checks the configured owner without offering self-update', async () => {
  const previous = { ...process.env };
  const originalFetch = globalThis.fetch;
  process.env.WOC_WECHAT_IMAGE = 'ghcr.io/custom-account/wechat-on-cloud:dev';
  process.env.WOC_VERSION = 'dev-custom';
  process.env.WOC_UPDATE_OWNER = 'gloridust';
  process.env.WOC_UPDATE_TRACK_ONLY = '1';
  const urls: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input); urls.push(url);
    if (url.includes('/token?')) return Response.json({ token: 'test-token' });
    if (url.includes('hub.docker.com')) return Response.json({ results: [{ name: '1.9.0' }, { name: 'dev' }] });
    return Response.json({ tags: ['1.10.0'] });
  };
  try {
    const { checkForUpdate } = await import('../src/version.js?track-only');
    const result = await checkForUpdate();
    assert.equal(result.trackOnly, true);
    assert.equal(result.hasUpdate, false);
    assert.equal(result.latest, 'v1.10.0');
    assert.equal(result.error, null);
    assert.ok(urls.every(url => url.includes('gloridust/woc-panel')));
  } finally { globalThis.fetch = originalFetch; process.env = previous; }
});

test('missing or inaccessible repositories are not reported as network failure', async () => {
  const previous = { ...process.env };
  const originalFetch = globalThis.fetch;
  delete process.env.WOC_UPDATE_OWNER;
  delete process.env.WOC_UPDATE_TRACK_ONLY;
  process.env.WOC_WECHAT_IMAGE = 'ghcr.io/custom-account/wechat-on-cloud:dev';
  globalThis.fetch = async (input) => new Response('', { status: String(input).includes('hub.docker.com') ? 404 : 403 });
  try {
    const { checkForUpdate } = await import('../src/version.js?missing-repository');
    const result = await checkForUpdate();
    assert.match(result.error || '', /不存在或无权访问/);
    assert.equal(result.trackOnly, false);
  } finally { globalThis.fetch = originalFetch; process.env = previous; }
});
