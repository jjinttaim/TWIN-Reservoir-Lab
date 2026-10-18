// Sets the Windows icon and version information of the packaged exe without Wine or rcedit.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ResEdit from 'resedit';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf-8'));
const exe = join(here, 'out', 'TWIN Reservoir Lab-win32-x64', 'TWIN Reservoir Lab.exe');
if (!existsSync(exe)) throw new Error(`packaged exe not found: ${exe}`);
const data = readFileSync(exe);
const pe = ResEdit.NtExecutable.from(data, { ignoreCert: true });
const res = ResEdit.NtExecutableResource.from(pe);

// icon
const ico = ResEdit.Data.IconFile.from(readFileSync(join(here, 'icon.ico')));
ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, 1, 1033, ico.icons.map((i) => i.data));

// version info: edit the entry Electron ships instead of adding a second string table
const [major, minor, patch] = pkg.version.split('.').map((n) => Number(n) || 0);
const existing = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
const vi = existing[0] || ResEdit.Resource.VersionInfo.createEmpty();
vi.setFileVersion(major, minor, patch, 0, 1033);
vi.setProductVersion(major, minor, patch, 0, 1033);
const strings = {
  CompanyName: 'TWIN research team',
  FileDescription: 'TWIN Reservoir Lab',
  FileVersion: pkg.version,
  InternalName: 'TWIN Reservoir Lab',
  LegalCopyright: 'TWIN research prototype',
  OriginalFilename: 'TWIN Reservoir Lab.exe',
  ProductName: 'TWIN Reservoir Lab',
  ProductVersion: pkg.version,
};
const langs = vi.getAllLanguagesForStringValues();
for (const lang of (langs.length ? langs : [{ lang: 1033, codepage: 1200 }])) {
  vi.setStringValues(lang, strings);
  vi.removeStringValue(lang, 'SquirrelAwareVersion');
}
vi.outputToResourceEntries(res.entries);
res.outputResource(pe);
const out = Buffer.from(pe.generate());
// Refresh the PE checksum (resedit leaves the old value). Same algorithm as CheckSumMappedFile.
const peOffset = out.readUInt32LE(0x3c);
const checksumOffset = peOffset + 4 + 20 + 64;
out.writeUInt32LE(0, checksumOffset);
let sum = 0;
for (let i = 0; i + 1 < out.length; i += 2) {
  if (i === checksumOffset || i === checksumOffset + 2) continue;
  sum += out.readUInt16LE(i);
  sum = (sum & 0xffff) + (sum >>> 16);
}
if (out.length & 1) { sum += out[out.length - 1]; sum = (sum & 0xffff) + (sum >>> 16); }
sum = (sum & 0xffff) + (sum >>> 16);
out.writeUInt32LE((sum + out.length) >>> 0, checksumOffset);
writeFileSync(exe, out);
console.log('windows resources written', exe);
