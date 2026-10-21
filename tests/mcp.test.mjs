import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { request } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { GenioBackend } from '../src/backend.mjs';
import { startHttp } from '../src/transport.mjs';
import { removeTemp } from './temp.mjs';
const execute = promisify(execFile);
const repo = fileURLToPath(new URL('..', import.meta.url));
async function exercise(transport) {
  const client = new Client({ name: 'genio-source-flow-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    assert.equal((await client.listTools()).tools.length, 12);
    async function call(name, args) {
      const result = await client.callTool({ name, arguments: args });
      assert.equal(result.isError, undefined, result.content[0]?.text);
      return JSON.parse(result.content[0].text);
    }
    assert.ok((await call('list_source_files', {})).files.includes('src/fixture.c'));
    const original = await call('read_source_file', { path: 'src/fixture.c' });
    await call('edit_source_file', { path: 'src/fixture.c', expected_sha256: original.sha256, replacements: [{ old_text: 'gain = 1', new_text: 'gain = 2' }] });
    assert.match((await call('get_source_diff', { files: ['src/fixture.c'] })).diff, /gain = 2/);
    const stale = await client.callTool({ name: 'edit_source_file', arguments: { path: 'src/fixture.c', expected_sha256: original.sha256, replacements: [{ old_text: 'gain = 2', new_text: 'gain = 9' }] } });
    assert.equal(stale.isError, true);
    const committed = await call('commit_candidate', { files: ['src/fixture.c'], message: 'MCP source edit and validation fixture' });
    assert.match(committed.commit_sha, /^[a-f0-9]{40}$/);
  } finally { await client.close(); }
}
for (const kind of ['stdio', 'HTTP']) test(`${kind} MCP reads, edits, checks conflicts and commits in an isolated Git workspace`, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'genio-mcp-test-'));
  let service;
  try {
    await execute('git', ['init'], { cwd: root });
    await execute('git', ['config', 'user.name', 'MCP test'], { cwd: root });
    await execute('git', ['config', 'user.email', 'mcp-test@example.invalid'], { cwd: root });
    await fs.mkdir(path.join(root, 'src'));
    await fs.writeFile(path.join(root, 'src/fixture.c'), 'int gain = 1;\n');
    await execute('git', ['add', 'src/fixture.c'], { cwd: root });
    await execute('git', ['commit', '-m', 'fixture'], { cwd: root });
    if (kind === 'stdio') await exercise(new StdioClientTransport({ command: process.execPath,
      args: [path.join(repo, 'bin/genio-dev-mcp.mjs'), '--workspace', root, '--write'], stderr: 'inherit' }));
    else {
      const token = 'test-only-'.repeat(8);
      service = await startHttp(new GenioBackend({ root, sdkRoot: root, allowSourceWrite: true }), { port: 0, token });
      assert.equal((await fetch(service.url)).status, 401);
      const auth = { Authorization: `Bearer ${token}` };
      assert.equal((await fetch(service.url, { headers: { ...auth, Origin: 'https://untrusted.invalid' } })).status, 403);
      const wrongHost = await new Promise((resolve, reject) => {
        const req = request(service.url, { headers: { ...auth, Host: 'untrusted.invalid' } }, res => { res.resume(); resolve(res.statusCode); });
        req.on('error', reject); req.end();
      });
      assert.equal(wrongHost, 403);
      await exercise(new StreamableHTTPClientTransport(new URL(service.url), { requestInit: { headers: auth } }));
    }
    assert.equal(await fs.readFile(path.join(root, 'src/fixture.c'), 'utf8'), 'int gain = 2;\n');
    assert.equal((await execute('git', ['status', '--porcelain'], { cwd: root })).stdout, '');
  } finally { if (service) await service.close(); await removeTemp(root); }
});
