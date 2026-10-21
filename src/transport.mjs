import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from './server.mjs';

export async function startStdio(backend) {
  const server = createServer(backend);
  await server.connect(new StdioServerTransport());
  return server;
}

export async function startHttp(backend, { port = 4317, token, origins = [] } = {}) {
  if (typeof token !== 'string' || token.length < 32 || /[\r\n]/.test(token)) throw new Error('Set GENIO_HTTP_TOKEN to a random secret of at least 32 characters');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid HTTP port');
  const secret = Buffer.from(`Bearer ${token}`);
  const active = new Set();
  const listener = http.createServer(async (req, res) => {
    const reject = (code, message) => { req.resume(); res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: message })); };
    // Accept only this listener's local Host values, even behind a forwarding service.
    const localPort = listener.address().port;
    if (![`127.0.0.1:${localPort}`, `localhost:${localPort}`].includes(req.headers.host)) return reject(403, 'Invalid Host');
    if (req.headers.origin && !origins.includes(req.headers.origin)) return reject(403, 'Origin is not allowed');
    const presented = Buffer.from(req.headers.authorization || '');
    if (presented.length !== secret.length || !timingSafeEqual(presented, secret)) return reject(401, 'Authentication required');
    if (req.url !== '/mcp') return reject(404, 'Not found');
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return reject(405, 'Only POST is supported; this endpoint is stateless'); }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: 2 * 1024 * 1024 });
    const server = createServer(backend);
    const connection = { server, transport };
    active.add(connection);
    res.once('close', () => { active.delete(connection); void server.close().catch(() => {}); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error('MCP request failed:', error.message);
      if (!res.headersSent) reject(500, 'MCP request failed');
      else res.end();
    }
  });
  listener.requestTimeout = 150000;
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(port, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${listener.address().port}/mcp`;
  return {
    url,
    async close() {
      for (const { server } of active) await server.close();
      listener.closeIdleConnections();
      await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
    },
  };
}
