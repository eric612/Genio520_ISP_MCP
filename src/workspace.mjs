import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT_FILES = new Set(['README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'package.json', 'package-lock.json', '.gitignore']);
const DIRECTORIES = new Set(['src', 'tools', 'tests', 'docs', 'examples', 'bin']);
const EXTENSIONS = new Set(['.mjs', '.js', '.ts', '.java', '.xml', '.ps1', '.c', '.h', '.md', '.json']);
const MAX_BYTES = 1024 * 1024;
export function sourcePath(root, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)
      || /[\\:\x00-\x1f<>"|?*]/.test(relative)) throw new Error('Use a repo-relative source path without traversal');
  const pieces = relative.split('/');
  if (pieces.some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)
      || (p.startsWith('.') && relative !== '.gitignore')
      || ['node_modules', 'outputs', 'board-logs'].includes(p.toLowerCase()))) {
    throw new Error('Private, generated or invalid path');
  }
  if (!ROOT_FILES.has(relative) && !(pieces.length > 1 && DIRECTORIES.has(pieces[0])
      && EXTENSIONS.has(path.extname(relative).toLowerCase()))) throw new Error('Path is outside the Genio source allowlist');
  return path.resolve(root, relative);
}
export function sha256(data) { return crypto.createHash('sha256').update(data).digest('hex'); }

export class Workspace {
  constructor(root, { writable = false } = {}) { this.root = path.resolve(root); this.writable = writable; this.changing = false; }
  async resolve(relative, { create = false } = {}) {
    const candidate = sourcePath(this.root, relative);
    const root = await fs.realpath(this.root);
    const pieces = path.relative(this.root, candidate).split(path.sep);
    let cursor = root;
    for (let i = 0; i < pieces.length; i++) {
      cursor = path.join(cursor, pieces[i]);
      try {
        const info = await fs.lstat(cursor);
        if (info.isSymbolicLink()) throw new Error('Symlinks and junctions are not allowed');
        if (i < pieces.length - 1 && !info.isDirectory()) throw new Error('Parent is not a directory');
        if (i === pieces.length - 1 && (!info.isFile() || info.nlink > 1)) throw new Error('Only regular, non-hardlinked files are allowed');
      } catch (error) {
        if (!(create && error.code === 'ENOENT' && i === pieces.length - 1)) throw error;
      }
    }
    return cursor;
  }
  async read(relative) {
    const file = await this.resolve(relative);
    const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink > 1 || info.size > MAX_BYTES) throw new Error('Expected a source file up to 1 MiB');
      const data = await handle.readFile();
      if (data.length > MAX_BYTES || data.includes(0)) throw new Error('Expected a UTF-8 text source file up to 1 MiB');
      const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data);
      return { path: relative, sha256: sha256(data), content };
    } finally { await handle.close(); }
  }
  async list(limit = 300) {
    const found = [];
    let truncated = false;
    const visit = async (relative = '') => {
      const entries = await fs.readdir(path.join(this.root, relative), { withFileTypes: true });
      for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (found.length >= limit) { truncated = true; return; }
        const name = relative ? `${relative}/${e.name}` : e.name;
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) {
          if ((!relative && DIRECTORIES.has(e.name)) || (relative && !e.name.startsWith('.')
              && !['node_modules', 'outputs', 'board-logs'].includes(e.name.toLowerCase()))) await visit(name);
        } else if (e.isFile()) {
          try { await this.resolve(name); found.push(name); } catch { /* Outside the source allowlist. */ }
        }
      }
    };
    await visit();
    return { files: found, truncated, limit };
  }
  async edit({ path: relative, expectedSha256, replacements, content }) {
    if (!this.writable) throw new Error('Source editing is disabled; start with GENIO_ALLOW_SOURCE_WRITE=1');
    if (this.changing) throw new Error('Another source edit is running');
    this.changing = true;
    try {
      const creating = expectedSha256 === 'NEW';
      const file = await this.resolve(relative, { create: creating });
      let next;
      if (creating) {
        if (typeof content !== 'string' || replacements?.length) throw new Error('NEW requires content and no replacements; parent directory must exist');
        next = content;
      } else {
        if (!/^[0-9a-f]{64}$/.test(expectedSha256 || '')) throw new Error('Expected SHA256 or NEW');
        if (content !== undefined || !Array.isArray(replacements) || !replacements.length || replacements.length > 40) throw new Error('Existing files require 1–40 exact replacements');
        const current = await this.read(relative);
        if (current.sha256 !== expectedSha256) throw new Error('Source conflict: read the current file before editing');
        next = current.content;
        for (const { old_text: before, new_text: after } of replacements) {
          if (typeof before !== 'string' || !before || typeof after !== 'string'
              || next.indexOf(before) < 0 || next.indexOf(before) !== next.lastIndexOf(before)) throw new Error('old_text must match exactly once');
          next = next.replace(before, () => after);
        }
      }
      if (Buffer.byteLength(next) > MAX_BYTES || next.includes('\0')) throw new Error('Source content must be text up to 1 MiB');
      // Open only after checks. wx never overwrites a concurrently created file.
      const handle = await fs.open(file, creating ? 'wx' : constants.O_RDWR | (constants.O_NOFOLLOW || 0));
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink > 1) throw new Error('Only regular, non-hardlinked files are allowed');
        if (!creating) {
          const old = await handle.readFile();
          if (sha256(old) !== expectedSha256) throw new Error('Source conflict: file changed during edit');
        }
        const buffer = Buffer.from(next);
        let written = 0;
        while (written < buffer.length) {
          const result = await handle.write(buffer, written, buffer.length - written, written);
          if (!result.bytesWritten) throw new Error('Source write made no progress');
          written += result.bytesWritten;
        }
        await handle.truncate(Buffer.byteLength(next));
        await handle.sync();
      } finally { await handle.close(); }
      return { path: relative, previous_sha256: creating ? null : expectedSha256, sha256: sha256(next), bytes: Buffer.byteLength(next) };
    } finally { this.changing = false; }
  }
}
