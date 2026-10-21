import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const packages = [];
async function scan(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const folder = path.join(directory, entry.name);
    if (entry.name.startsWith('@')) { await scan(folder); continue; }
    const metadata = JSON.parse(await fs.readFile(path.join(folder, 'package.json'), 'utf8'));
    if (!['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause'].includes(metadata.license)) throw new Error(`Review dependency license: ${metadata.name} ${metadata.license}`);
    const files = (await fs.readdir(folder)).filter(name => /^(?:licen[cs]e|copying|notice)(?:\..*)?$/i.test(name));
    if (!files.length) throw new Error(`No license text found: ${metadata.name}`);
    const texts = [];
    for (const name of files) if ((await fs.stat(path.join(folder, name))).isFile()) texts.push(await fs.readFile(path.join(folder, name), 'utf8'));
    if (!texts.length) throw new Error(`No readable license text: ${metadata.name}`);
    packages.push({ name: metadata.name, version: metadata.version, license: metadata.license, texts });
    try { await scan(path.join(folder, 'node_modules')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
await scan(path.join(root, 'node_modules'));
const sections = packages.sort((a,b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`))
  .map(p => `## ${p.name}@${p.version} (${p.license})\n\n${p.texts.join('\n\n').replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trimEnd()}\n`);
await fs.writeFile(path.join(root, 'THIRD_PARTY_NOTICES.md'), ('# Third-party notices\n\nLicense and notice texts from the installed, locked dependency tree. Android SDK/NDK and JDK are installed separately and are not distributed with this source.\n\n' + sections.join('\n')).trimEnd() + '\n');
console.log(`Preserved license texts for ${packages.length} installed package instances.`);
