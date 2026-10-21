import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const client = new Client({ name: 'genio-isp-inventory', version: '0.1.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'bin/genio-dev-mcp.mjs')], stderr: 'inherit',
  env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('GENIO_') || ['JAVA_HOME', 'ANDROID_HOME', 'ANDROID_SDK_ROOT'].includes(key))) });
const evidence = { timestamp_utc: new Date().toISOString(), runs: [] };
async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 150000 });
  if (result.isError) throw new Error(`${name}: ${result.content[0]?.text}`);
  return JSON.parse(result.content[0].text);
}
try {
  await client.connect(transport);
  evidence.target = await call('get_target_info');
  await call('build_camera_probe');
  const suites = process.argv.includes('--nr-only') ? ['nr'] : ['inventory', 'raw', ...(process.argv.includes('--controls') ? ['controls'] : []), ...(process.argv.includes('--nr') ? ['nr'] : [])];
  for (const suite of suites) {
    const job = await call('run_camera_validation', { suite });
    console.log(`${suite}: JOB=${job.id}`);
    let status, previous;
    const deadline = Date.now() + 180000;
    do {
      await new Promise(resolve => setTimeout(resolve, 1500));
      status = await call('get_job', { job_id: job.id });
      if (status.status !== previous) console.log(`${suite}: ${status.status}`);
      previous = status.status;
    } while (status.status === 'running' && Date.now() < deadline);
    let report;
    try { report = await call('get_report', { run_id: job.run_id }); }
    catch (error) { report = { status: 'NO_REPORT', error: error.message }; }
    evidence.runs.push({ suite, job: status, report });
    if (status.status !== 'succeeded' || report.status !== 'PASS') {
      evidence.failed = true; console.log(`${suite}: FAIL ${report.error || status.exit_code}`);
    } else if (suite === 'raw') console.log(`raw: ${report.raw.width}x${report.raw.height}, timestamps=${report.raw_yuv_timestamps_match}, DNG=${report.raw.dng_status}`);
    else if (suite === 'inventory') console.log(`inventory: ${report.inventory_summary.characteristics} characteristics, ${report.inventory_summary.request_keys} request keys`);
    else console.log(`${suite}: ${report.cases.length} cases, readback=${report.controls_readback_match}`);
  }
  evidence.status = evidence.failed ? 'FAIL' : 'PASS';
  if (evidence.failed) process.exitCode = 1;
} catch (error) {
  evidence.status = 'FAIL'; evidence.error = error.message; process.exitCode = 1;
  console.error(error.message);
} finally {
  const directory = path.join(root, 'outputs/isp-validation');
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, `validation-${Date.now()}.json`);
  await fs.writeFile(file, JSON.stringify(evidence, null, 2));
  console.log(`EVIDENCE=${file}`);
  await client.close();
}
