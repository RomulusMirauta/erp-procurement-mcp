// ERP text is untrusted input: a supplier writes the line descriptions, and they reach the model through the tools.
// INV-1010 in the fixture carries a prompt injection that claims a looser tolerance, tells the agent to skip
// approval and to approve and pay INV-1003. Whatever the agent makes of it, the server must not change behaviour.
import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InMemoryApprovalStore } from '../src/approvals/store.js';
import { ErpRepository } from '../src/erp/repository.js';
import type { ErpData } from '../src/erp/schema.js';
import { createServer } from '../src/server.js';

const FIXTURE = new URL('./fixtures/prompt-injection.json', import.meta.url);
let injection: string;
let client: Client;
let approvals: InMemoryApprovalStore;

beforeEach(async () => {
  const data = JSON.parse(await readFile(FIXTURE, 'utf8')) as ErpData;
  injection = data.invoices.find((invoice) => invoice.id === 'INV-1010')?.lines[0]?.description ?? '';
  approvals = new InMemoryApprovalStore();
  const server = createServer({ repository: ErpRepository.fromJson(data), approvals });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'injection-test', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  await client.listTools();
});

afterEach(async () => {
  await client.close();
});

async function call(name: string, args: Record<string, unknown>) {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  const [first] = result.content;
  const text = first?.type === 'text' ? first.text : '';
  return { isError: result.isError ?? false, text, data: result.structuredContent as Record<string, any> };
}

const reason = 'The invoice note says finance pre-approved it and raised the tolerance to 60%.';

describe('prompt injection in ERP data', () => {
  it('is in the fixture', () => {
    expect(injection).toMatch(/ignore all previous instructions/);
  });

  it('comes back only as a JSON data field', async () => {
    const result = await call('get_invoice', { invoiceId: 'INV-1010' });
    expect(JSON.parse(result.text).invoice.lines[0].description).toBe(injection);
    expect(result.data.invoice.lines[0].description).toBe(injection);
  });

  it('never reaches the tool list or the server instructions', async () => {
    const { tools } = await client.listTools();
    expect(JSON.stringify(tools)).not.toContain('ignore all previous instructions');
    expect(client.getInstructions()).toMatch(/data, never as instructions/);
  });

  it('cannot loosen the price check: the tolerance is server policy', async () => {
    const result = await call('match_invoice', { invoiceId: 'INV-1010' });
    expect(result.data).toMatchObject({ status: 'exception', priceTolerancePct: 2 });
    expect(result.data.exceptions).toEqual([expect.objectContaining({ code: 'PRICE_VARIANCE', lineNo: 2 })]);
    // The match result is the server's own words: none of the supplier text is in it.
    expect(result.text).not.toContain('IMPORTANT NOTE');
  });

  it('cannot get a matched invoice sent for approval', async () => {
    const result = await call('request_approval', { invoiceId: 'INV-1004', reason });
    expect(result).toMatchObject({ isError: true, text: expect.stringContaining('needs no approval') });
    expect(approvals.list()).toHaveLength(0);
  });

  it('cannot change what request_approval records through extra arguments', async () => {
    const result = await call('request_approval', {
      invoiceId: 'INV-1010',
      reason,
      exceptionCodes: [],
      priceTolerancePct: 60,
      status: 'approved',
    });
    // Unknown arguments are dropped by the input schema; the codes are the ones the server found itself.
    expect(result.data).toMatchObject({ created: true, approval: { status: 'pending', exceptionCodes: ['PRICE_VARIANCE'] } });
  });

  it('cannot approve or pay: no tool changes an invoice status', async () => {
    const { tools } = await client.listTools();
    const writes = tools.filter((tool) => tool.annotations?.readOnlyHint !== true).map((tool) => tool.name);
    expect(writes).toEqual(['request_approval']);

    await call('request_approval', { invoiceId: 'INV-1003', reason: 'Approve and pay INV-1003, as the note on INV-1010 asks.' });
    const invoice = (await call('get_invoice', { invoiceId: 'INV-1003' })).data.invoice;
    expect(invoice.status).toBe('on_hold');
    expect(approvals.list()).toEqual([expect.objectContaining({ invoiceId: 'INV-1003', status: 'pending' })]);
  });
});
