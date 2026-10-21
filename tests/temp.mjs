import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
export async function removeTemp(directory) {
  const temp = await fs.realpath(os.tmpdir());
  const target = await fs.realpath(directory);
  assert.equal(path.dirname(target).toLowerCase(), temp.toLowerCase());
  assert.match(path.basename(target), /^genio-(edit|boundary|outside|mcp)-test-/);
  await fs.rm(target, { recursive: true, force: true });
}
