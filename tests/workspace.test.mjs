import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Workspace, sourcePath } from '../src/workspace.mjs';
import { removeTemp } from './temp.mjs';

test('workspace edits preserve unrelated content, reject stale reads and never overwrite NEW', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'genio-edit-test-'));
  try {
    await fs.mkdir(path.join(root, 'src'));
    await fs.writeFile(path.join(root, 'src/a.c'), 'int gain = 1;\n// keep\n');
    const locked = new Workspace(root);
    await assert.rejects(locked.edit({ path: 'src/a.c' }), /disabled/);
    const ws = new Workspace(root, { writable: true });
    const original = await ws.read('src/a.c');
    const changed = await ws.edit({ path: 'src/a.c', expectedSha256: original.sha256, replacements: [{ old_text: 'gain = 1', new_text: 'gain = 2' }] });
    assert.notEqual(changed.sha256, original.sha256);
    assert.equal((await ws.read('src/a.c')).content, 'int gain = 2;\n// keep\n');
    await assert.rejects(ws.edit({ path: 'src/a.c', expectedSha256: original.sha256, replacements: [{ old_text: 'gain = 2', new_text: 'gain = 3' }] }), /conflict/);
    await ws.edit({ path: 'src/new.c', expectedSha256: 'NEW', content: 'literal $& `command`\n' });
    await assert.rejects(ws.edit({ path: 'src/new.c', expectedSha256: 'NEW', content: 'overwrite' }), /EEXIST/);
    await fs.writeFile(path.join(root, 'src/ambiguous.c'), 'same same');
    const repeated = await ws.read('src/ambiguous.c');
    await assert.rejects(ws.edit({ path: 'src/ambiguous.c', expectedSha256: repeated.sha256, replacements: [{ old_text: 'same', new_text: 'once' }] }), /exactly once/);
    const listing = await ws.list();
    assert.deepEqual(new Set(listing.files), new Set(['src/a.c', 'src/new.c', 'src/ambiguous.c']));
  } finally { await removeTemp(root); }
});

test('source paths reject Windows aliases, hidden/generated files, junctions and hardlinks', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'genio-boundary-test-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'genio-outside-test-'));
  try {
    for (const name of ['src/a.c:secret', 'src/CON.c', 'src/.. /a.c', 'src/a.c.', 'src/.env', 'src/node_modules/a.js', 'src/../a.c', 'C:/foreign.c', '.codex/config.toml', 'docs/assets/photo.jpg']) {
      assert.throws(() => sourcePath(root, name), name);
    }
    await fs.mkdir(path.join(root, 'src'));
    await fs.writeFile(path.join(outside, 'private.c'), 'outside');
    await fs.symlink(outside, path.join(root, 'src/junction'), process.platform === 'win32' ? 'junction' : 'dir');
    await fs.link(path.join(outside, 'private.c'), path.join(root, 'src/hardlink.c'));
    const ws = new Workspace(root, { writable: true });
    await assert.rejects(ws.read('src/junction/private.c'), /Symlinks/);
    await assert.rejects(ws.read('src/hardlink.c'), /non-hardlinked/);
    assert.deepEqual((await ws.list()).files, []);
    assert.equal(await fs.readFile(path.join(outside, 'private.c'), 'utf8'), 'outside');
  } finally {
    await removeTemp(root);
    await removeTemp(outside);
  }
});
