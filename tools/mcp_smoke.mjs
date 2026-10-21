import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'bin', 'genio-dev-mcp.mjs')], stderr: 'inherit',
  env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('GENIO_') || ['ANDROID_HOME', 'ANDROID_SDK_ROOT', 'JAVA_HOME'].includes(key))) });
const client = new Client({ name: 'genio-validation-client', version: '0.1.0' });
const evidence = { timestamp_utc: new Date().toISOString(), transport: 'MCP stdio SDK client', calls: [] };
async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 120000 });
  if (result.isError) throw new Error(`${name}: ${result.content[0]?.text}`);
  const value = JSON.parse(result.content[0].text);
  evidence.calls.push({ tool: name, result: value });
  return value;
}
try {
  await client.connect(transport);
  const listing = await client.listTools();
  evidence.tools = listing.tools.map(tool => tool.name);
  const info = await call('get_target_info');
  console.log(`ADB: ${info.state}, Android ${info.properties['ro.build.version.release']}`);
  const caps = await call('get_camera_capabilities');
  console.log(`Cameras: ${caps.camera_count}`);
  if (process.argv.includes('--run')) {
    await call('build_camera_probe');
    const job = await call('run_camera_validation', { suite: 'controls', camera_id: '0' });
    console.log(`JOB=${job.id}`);
    const deadline = Date.now() + 180000;
    let status;
    do {
      await new Promise(resolve => setTimeout(resolve, 1500));
      status = await call('get_job', { job_id: job.id });
      console.log(`status=${status.status}`);
    } while (status.status === 'running' && Date.now() < deadline);
    if (status.status !== 'succeeded') throw new Error(`Validation job: ${status.status}`);
    const report = await call('get_report', { run_id: job.run_id });
    if (report.status !== 'PASS' || !report.controls_readback_match) throw new Error('Control validation did not pass');
    console.log(`PASS: ${report.cases.length} camera cases via MCP`);
    evidence.run_id = job.run_id;
  }
  evidence.status = 'PASS';
} catch (error) {
  evidence.status = 'FAIL'; evidence.error = error.message;
  throw error;
} finally {
  const directory = path.join(root, 'outputs', 'mcp-smoke');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'latest.json'), JSON.stringify(evidence, null, 2));
  await client.close();
}
