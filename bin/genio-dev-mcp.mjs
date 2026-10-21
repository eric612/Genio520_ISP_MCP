#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { configuration } from '../src/config.mjs';
import { GenioBackend } from '../src/backend.mjs';
import { startStdio, startHttp } from '../src/transport.mjs';
import { doctor } from '../src/doctor.mjs';

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    help: { type: 'boolean', short: 'h' }, workspace: { type: 'string' }, sdk: { type: 'string' },
    jdk: { type: 'string' }, serial: { type: 'string' }, write: { type: 'boolean' },
    transport: { type: 'string', default: 'stdio' }, port: { type: 'string', default: '4317' },
  } });
  if (values.help) {
    console.log('genio-dev-mcp [doctor] [--workspace PATH] [--sdk PATH] [--jdk PATH] [--serial ID] [--write] [--transport stdio|http] [--port 4317]\nSource edits and commits require --write. HTTP requires GENIO_HTTP_TOKEN (>=32 chars); binds only to 127.0.0.1. No Trail installation is required.');
  } else {
    if (positionals.length > 1 || positionals.some(p => p !== 'doctor')) throw new Error('Unknown command; use --help');
    const env = { ...process.env };
    for (const [key, variable] of Object.entries({ workspace: 'GENIO_WORKSPACE', sdk: 'GENIO_ANDROID_SDK', jdk: 'GENIO_JDK', serial: 'GENIO_SERIAL' })) {
      if (values[key] !== undefined) env[variable] = values[key];
    }
    if (values.write) env.GENIO_ALLOW_SOURCE_WRITE = '1';
    const config = configuration(env);
    if (positionals[0] === 'doctor') {
      const report = await doctor(config);
      console.log(JSON.stringify(report, null, 2));
      if (report.status !== 'PASS') process.exitCode = 1;
    } else {
      if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node.js 22 or later is required');
      const backend = new GenioBackend(config);
      if (values.transport === 'stdio') await startStdio(backend);
      else if (values.transport === 'http') {
        const service = await startHttp(backend, { port: Number(values.port), token: env.GENIO_HTTP_TOKEN,
          origins: (env.GENIO_HTTP_ORIGINS || '').split(',').filter(Boolean) });
        console.error(`Genio MCP listening at ${service.url}; source writes ${config.allowSourceWrite ? 'enabled' : 'disabled'}`);
        for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void service.close().then(() => process.exit(0)); });
      } else throw new Error('Transport must be stdio or http');
    }
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
