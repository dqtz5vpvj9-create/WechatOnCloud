import { readdir, readFile, writeFile, copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// GitHub rewrites non-ASCII asset names and strips a leading dot. Normalize
// before upload so the manifest URLs match the actual published asset names.
function assetName(name) { return name.replace(/[^\x00-\x7F]/g, '').replace(/^\.+/, ''); }

export async function collect(source, destination) {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const file = path.join(source, entry.name);
    if (entry.isDirectory()) await collect(file, destination);
    else if (/\.(exe|app\.tar\.gz|dmg)(\.sig)?$/.test(entry.name)) await copyFile(file, path.join(destination, assetName(entry.name)));
  }
}

export async function manifest(directory, version, repository) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('A release needs a numeric desktop version');
  const files = await readdir(directory);
  const platforms = {};
  for (const [pattern, targets] of [
    [/\.exe$/, ['windows-x86_64']],
    [/(?:^|\.)app\.tar\.gz$/, ['darwin-x86_64', 'darwin-aarch64']],
  ]) {
    const candidates = files.filter(file => pattern.test(file));
    if (candidates.length !== 1) throw new Error(`Expected exactly one installer for ${targets}`);
    const file = candidates[0];
    const signature = (await readFile(path.join(directory, `${file}.sig`), 'utf8')).trim();
    if (!signature || !Buffer.from(signature, 'base64').toString().includes('signature')) throw new Error('Invalid updater signature');
    const url = `https://github.com/${repository}/releases/download/desktop-v${version}/${encodeURIComponent(assetName(file))}`;
    for (const target of targets) platforms[target] = { signature, url };
  }
  return { version, notes: `云微 ${version}，支持应用内更新。`, pub_date: new Date().toISOString(), platforms };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, source, destination, repository] = process.argv.slice(2);
  if (mode === 'collect') await collect(source, destination);
  else if (mode === 'manifest') await writeFile(path.join(source, 'latest.json'), JSON.stringify(await manifest(source, destination, repository), null, 2));
  else throw new Error('Expected collect or manifest');
}
