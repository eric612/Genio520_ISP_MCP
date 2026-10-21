import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { GenioBackend, validateId, sourcePath, parseCameraDump, childEnvironment } from '../src/backend.mjs';
const exec = promisify(execFile);

test('restricted MCP environment still lets PowerShell wait for native Windows programs', async () => {
  const env = childEnvironment({ SYSTEMROOT: process.env.SYSTEMROOT, PATH: process.env.PATH });
  assert.equal(env.PATHEXT, '.COM;.EXE;.BAT;.CMD');
  assert.equal(childEnvironment({ PATHEXT: '.EXE;.CMD' }).PATHEXT, '.EXE;.CMD');
  if (process.platform !== 'win32') return;
  const result = await exec('powershell.exe', ['-NoProfile', '-Command', '& "$env:SYSTEMROOT\\System32\\cmd.exe" /c exit 7; exit $LASTEXITCODE'], { env, windowsHide: true }).catch(error => error);
  assert.equal(result.code, 7);
});

test('run identifiers and source selection reject traversal and generated/private files', () => {
  assert.equal(validateId('camera-0123'), 'camera-0123');
  for (const id of ['../x', 'x/y', '', 'a'.repeat(65)]) assert.throws(() => validateId(id));
  for (const name of ['../x', 'src/../x', 'outputs/report.json', '.codex/config.toml', '.git/config', 'src\\x', 'D:/foreign.py']) {
    assert.throws(() => sourcePath(process.cwd(), name));
  }
  assert.equal(sourcePath(process.cwd(), 'src/server.mjs'), path.join(process.cwd(), 'src', 'server.mjs'));
});

test('metadata parser keeps multiline mode declarations and counts cameras', () => {
  const parsed = parseCameraDump('Number of camera devices: 1\n      android.sensor.info.sensitivityRange (f0001): int32[2]\n        [100 2400 ]\n      android.request.availableCapabilities (c000c): byte[3]\n        [RAW MANUAL_SENSOR\n        [MANUAL_POST_PROCESSING ]\n');
  assert.equal(parsed.camera_count, 1);
  assert.equal(parsed.advertised_metadata['android.sensor.info.sensitivityRange'], '[100 2400 ]');
});

test('commit selection preserves unrelated work and handles literal shell-like messages', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'genio-git-test-'));
  try {
    await exec('git', ['init'], { cwd: root });
    await exec('git', ['config', 'user.name', 'Genio test'], { cwd: root });
    await exec('git', ['config', 'user.email', 'genio-test@example.invalid'], { cwd: root });
    await fs.mkdir(path.join(root, 'src'));
    await fs.writeFile(path.join(root, 'src', 'candidate.c'), 'candidate\n');
    await fs.writeFile(path.join(root, 'README.md'), 'unrelated\n');
    await exec('git', ['add', 'README.md'], { cwd: root });
    const backend = new GenioBackend({ root, sdkRoot: root });
    await assert.rejects(backend.commitCandidate(['src/candidate.c'], 'candidate'), /Unrelated files/);
    const staged = await exec('git', ['diff', '--cached', '--name-only'], { cwd: root });
    assert.equal(staged.stdout.trim(), 'README.md');
    await exec('git', ['rm', '--cached', 'README.md'], { cwd: root });
    const message = 'literal $(whoami) `echo` test';
    const committed = await backend.commitCandidate(['src/candidate.c'], message);
    assert.match(committed.commit_sha, /^[0-9a-f]{40}$/);
    const files = await exec('git', ['show', '--pretty=', '--name-only', 'HEAD'], { cwd: root });
    assert.equal(files.stdout.trim(), 'src/candidate.c');
    const body = await exec('git', ['log', '-1', '--format=%B'], { cwd: root });
    assert.equal(body.stdout.trim(), message);
    await assert.rejects(backend.commitCandidate(['../outside'], 'bad'));
  } finally {
    // Only remove this verified, uniquely created temporary test directory.
    const tempRoot = await fs.realpath(os.tmpdir());
    const resolved = await fs.realpath(root);
    assert.equal(path.dirname(resolved).toLowerCase(), tempRoot.toLowerCase());
    assert.match(path.basename(resolved), /^genio-git-test-/);
    await fs.rm(resolved, { recursive: true, force: true });
  }
});
