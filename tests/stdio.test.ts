// End to end: starts the server as a child process and talks to it over stdio, as Claude Code does.
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
let client: Client | undefined;

afterEach(async () => {
  await client?.close();
});

function start(env: Record<string, string> = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', 'src/index.ts'],
    cwd: root,
    env: { ...(process.env as Record<string, string>), ...env },
    stderr: 'pipe',
  });
  client = new Client({ name: 'stdio-test', version: '1.0.0' });
  return { transport, client };
}

describe('stdio server', () => {
  it('starts, lists its tools and answers a call', async () => {
    const { transport, client } = start();
    await client.connect(transport);
    expect(client.getServerVersion()).toMatchObject({ name: 'erp-procurement' });
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(4);
    const result = await client.callTool({ name: 'match_invoice', arguments: { invoiceId: 'INV-1001' } });
    expect(result.isError).toBeFalsy();
  }, 20_000);

  it('exits with a clear error when the data file is missing', async () => {
    const { transport, client } = start({ ERP_DATA_FILE: 'missing.json' });
    let stderr = '';
    transport.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    await expect(client.connect(transport)).rejects.toThrow();
    expect(stderr).toMatch(/Cannot read ERP data file missing\.json/);
  }, 20_000);
});
