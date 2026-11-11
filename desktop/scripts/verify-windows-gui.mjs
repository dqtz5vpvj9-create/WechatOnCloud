import { readFile } from 'node:fs/promises';

// Inspect the actual release binary, not the source attribute or installer.
const file = process.argv[2];
if (!file) throw new Error('Expected a Windows application executable path');
const data = await readFile(file);
if (data.length < 0x40 || data.toString('ascii', 0, 2) !== 'MZ') {
  throw new Error('Application is not a Windows PE executable');
}
const pe = data.readUInt32LE(0x3c);
const optional = pe + 24;
if (pe > data.length - 24 || data.readUInt32LE(pe) !== 0x00004550 ||
    data.readUInt16LE(pe + 20) < 70 || optional > data.length - 70 ||
    ![0x10b, 0x20b].includes(data.readUInt16LE(optional))) {
  throw new Error('Application has an invalid PE optional header');
}
const subsystem = data.readUInt16LE(optional + 68);
if (subsystem !== 2) {
  throw new Error(`Expected Windows GUI subsystem 2; found ${subsystem}. A console build opens an unwanted terminal.`);
}
console.log(`Verified Windows GUI subsystem: ${file}`);
