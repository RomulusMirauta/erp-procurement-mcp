// End to end over Streamable HTTP: a real node:http server on a free port, called with the SDK's HTTP client
// (as Claude Code does for remote servers) and with plain fetch for the status codes and limits.
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { InMemoryApprovalStore } from '../src/approvals/store.js';
import { ErpRepository } from '../src/erp/repository.js';
import { createHttpHandler, readAllowedOrigins, readAuthToken, type HttpOptions } from '../src/http.js';

const TOKEN = 'test-token-0123456789abcdef0123456789abcdef';
const ALLOWED_ORIGIN = 'https://app.example.com';
let httpServer: Server;
let endpoint: URL;
let client: Client | undefined;

beforeAll(async () => {
  const repository = await ErpRepository.fromFile(new URL('../data/erp-sample.json', import.meta.url));
  const handler = createHttpHandler({
    deps: { repository, approvals: new InMemoryApprovalStore() },
    authToken: TOKEN,
    allowedOrigins: [ALLOWED_ORIGIN],
  });
  httpServer = createServer((req, res) => void handler(req, res));
  // Port 0: the OS picks a free port, so tests never clash with something already running.
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  endpoint = new URL(`http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/mcp`);
});

afterEach(async () => {
  await client?.close();
  client = undefined;
});

afterAll(async () => {
  httpServer.closeAllConnections();
  await new Promise((resolve) => httpServer.close(resolve));
});

function connect(token?: string) {
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  client = new Client({ name: 'http-test', version: '1.0.0' });
  return client.connect(new StreamableHTTPClientTransport(endpoint, { requestInit: { headers } }));
}

const initialize = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fetch', version: '1.0.0' } },
};

function post(headers: Record<string, string>) {
  return fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(initialize),
  });
}

describe('HTTP server with the SDK client', () => {
  it('lists the tools and answers a call with the right token', async () => {
    await connect(TOKEN);
    expect(client?.getServerVersion()).toMatchObject({ name: 'erp-procurement' });
    const { tools } = (await client?.listTools()) ?? { tools: [] };
    expect(tools).toHaveLength(4);
    const result = (await client?.callTool({ name: 'match_invoice', arguments: { invoiceId: 'INV-1001' } })) as CallToolResult;
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ invoiceId: 'INV-1001', status: 'matched' });
  });

  it('cannot connect without a token or with a wrong one', async () => {
    // The client throws StreamableHTTPError, which carries the HTTP status as its code.
    await expect(connect()).rejects.toMatchObject({ code: 401 });
    await expect(connect('wrong-token')).rejects.toMatchObject({ code: 401 });
  });
});

describe('HTTP status codes', () => {
  it('answers 401 with WWW-Authenticate: Bearer when the token is missing or wrong', async () => {
    const attempts: Record<string, string>[] = [{}, { Authorization: 'Bearer wrong-token' }, { Authorization: TOKEN }];
    for (const headers of attempts) {
      const response = await post(headers);
      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toBe('Bearer');
    }
  });

  it('accepts an initialize request with the right token', async () => {
    const response = await post({ Authorization: `Bearer ${TOKEN}` });
    expect(response.status).toBe(200);
  });

  it('answers 405 on GET and DELETE: the server is stateless', async () => {
    for (const method of ['GET', 'DELETE']) {
      const response = await fetch(endpoint, { method, headers: { Authorization: `Bearer ${TOKEN}` } });
      expect(response.status).toBe(405);
      expect(response.headers.get('allow')).toBe('POST');
    }
  });

  it('answers 403 to an Origin outside the allowlist, even with the right token', async () => {
    const response = await post({ Authorization: `Bearer ${TOKEN}`, Origin: 'https://evil.example' });
    expect(response.status).toBe(403);
    expect((await post({ Authorization: `Bearer ${TOKEN}`, Origin: ALLOWED_ORIGIN })).status).toBe(200);
  });

  it('serves /health without a token and 404 elsewhere', async () => {
    expect((await fetch(new URL('/health', endpoint))).status).toBe(200);
    expect((await fetch(new URL('/other', endpoint))).status).toBe(404);
  });
});

describe('HTTP limits', () => {
  // Each test gets its own server with small limits, so the counters start from zero and the tests stay fast.
  let limited: Server | undefined;

  afterEach(async () => {
    limited?.closeAllConnections();
    await new Promise((resolve) => limited?.close(resolve));
  });

  async function startLimited(options: Partial<HttpOptions>): Promise<URL> {
    const repository = await ErpRepository.fromFile(new URL('../data/erp-sample.json', import.meta.url));
    const handler = createHttpHandler({ deps: { repository, approvals: new InMemoryApprovalStore() }, authToken: TOKEN, ...options });
    limited = createServer((req, res) => void handler(req, res));
    await new Promise<void>((resolve) => limited?.listen(0, '127.0.0.1', resolve));
    return new URL(`http://127.0.0.1:${(limited.address() as AddressInfo).port}/mcp`);
  }

  const headers = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  // A valid initialize request, padded past the limit with a long client name.
  const oversized = JSON.stringify({ ...initialize, params: { ...initialize.params, clientInfo: { name: 'x'.repeat(2048), version: '1' } } });

  it('answers 413 to a body over the limit, with or without Content-Length', async () => {
    const url = await startLimited({ maxBodyBytes: 1024 });
    expect((await fetch(url, { method: 'POST', headers, body: JSON.stringify(initialize) })).status).toBe(200);
    expect((await fetch(url, { method: 'POST', headers, body: oversized })).status).toBe(413);
    // A streamed body has no Content-Length, so the limit is enforced while reading.
    const stream = new Blob([oversized]).stream();
    const chunked = await fetch(url, { method: 'POST', headers, body: stream, duplex: 'half' } as RequestInit);
    expect(chunked.status).toBe(413);
  });

  it('answers 429 with Retry-After once a client has used up its bucket, even without a token', async () => {
    const url = await startLimited({ rateLimit: { capacity: 2, refillPerSecond: 0.5 } });
    expect((await fetch(url, { method: 'POST', headers, body: JSON.stringify(initialize) })).status).toBe(200);
    expect((await fetch(url, { method: 'POST' })).status).toBe(401);
    const limitedResponse = await fetch(url, { method: 'POST', headers, body: JSON.stringify(initialize) });
    expect(limitedResponse.status).toBe(429);
    expect(limitedResponse.headers.get('retry-after')).toBe('2');
  });

  it('answers 503 when a request takes longer than the timeout', async () => {
    const url = await startLimited({ requestTimeoutMs: 100 });
    // Announces 100 bytes and sends 10: the server waits for the rest until the timeout.
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(url, { method: 'POST', headers: { ...headers, 'Content-Length': '100' } }, (res) => {
        resolve(res.statusCode);
        req.destroy();
      });
      req.on('error', reject);
      req.write('{"jsonrpc"');
    });
    expect(status).toBe(503);
  });
});

describe('HTTP configuration', () => {
  it('refuses a missing or short MCP_AUTH_TOKEN', () => {
    expect(() => readAuthToken({})).toThrow(/at least 32 characters/);
    expect(() => readAuthToken({ MCP_AUTH_TOKEN: 'short' })).toThrow(/at least 32 characters/);
    expect(readAuthToken({ MCP_AUTH_TOKEN: TOKEN })).toBe(TOKEN);
  });

  it('reads the origin allowlist as a comma-separated list', () => {
    expect(readAllowedOrigins({})).toBeUndefined();
    expect(readAllowedOrigins({ MCP_ALLOWED_ORIGINS: ' https://a.example, https://b.example ,' })).toEqual([
      'https://a.example',
      'https://b.example',
    ]);
  });
});
