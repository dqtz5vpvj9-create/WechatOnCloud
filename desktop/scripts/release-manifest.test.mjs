import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { collect, manifest } from './release-manifest.mjs';

test('channel requires both signed platforms and points to immutable versioned assets', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'yunwei-channel-'));
  try {
    const sig = Buffer.from('untrusted comment: signature from test\nfixture').toString('base64');
    await writeFile(path.join(directory, '云微_0.2.0_x64-setup.exe'), 'fixture');
    await assert.rejects(manifest(directory, '0.2.0', 'owner/repo'));
    await writeFile(path.join(directory, '云微_0.2.0_x64-setup.exe.sig'), sig);
    await assert.rejects(manifest(directory, '0.2.0', 'owner/repo'), /exactly one/);
    await writeFile(path.join(directory, '云微.app.tar.gz'), 'fixture');
    await writeFile(path.join(directory, '云微.app.tar.gz.sig'), sig);
    const result = await manifest(directory, '0.2.0', 'owner/repo');
    assert.deepEqual(Object.keys(result.platforms).sort(), ['darwin-aarch64', 'darwin-x86_64', 'windows-x86_64']);
    assert.equal(result.platforms['darwin-aarch64'].url, result.platforms['darwin-x86_64'].url);
    assert.match(result.platforms['windows-x86_64'].url, /desktop-v0\.2\.0\/_0\.2\.0_x64-setup\.exe$/);
    assert.equal(result.platforms['windows-x86_64'].signature, sig);
    const normalized = path.join(directory, 'published');
    await collect(directory, normalized);
    const actual = await manifest(normalized, '0.2.0', 'owner/repo');
    assert.equal(actual.platforms['darwin-aarch64'].url, 'https://github.com/owner/repo/releases/download/desktop-v0.2.0/app.tar.gz');
    await writeFile(path.join(directory, '云微.app.tar.gz.sig'), '');
    await assert.rejects(manifest(directory, '0.2.0', 'owner/repo'), /signature/);
    await assert.rejects(manifest(directory, 'latest', 'owner/repo'), /version/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
