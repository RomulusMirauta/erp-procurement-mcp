// Drives the real MCP server through the SDK client over an in-memory transport:
// the same protocol messages Claude sends, without starting a process.
import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyDecision } from '../src/approvals/decisions.js';
import { InMemoryApprovalStore, type ApprovalRecord, type ApprovalStore } from '../src/approvals/store.js';
import { ErpRepository } from '../src/erp/repository.js';
import { createServer } from '../src/server.js';

let client: Client;
let approvals: InMemoryApprovalStore;
let repository: ErpRepository;

async function connect(priceTolerancePct?: number, store?: ApprovalStore) {
  repository = await ErpRepository.fromFile(new URL('../data/erp-sample.json', import.meta.url));
  approvals = new InMemoryApprovalStore(() => new Date('2026-11-18T09:00:00Z'));
  const server = createServer({
    repository,
    approvals: store ?? approvals,
    ...(priceTolerancePct === undefined ? {} : { priceTolerancePct }),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  // The client checks each structuredContent against the tool's outputSchema, but only for tools it has listed,
  // as Claude does on connect. So every successful call in these tests also proves the output fits its schema.
  await client.listTools();
}

beforeEach(async () => {
  await connect();
});

afterEach(async () => {
  await client.close();
});

async function call(name: string, args: Record<string, unknown> = {}) {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  const [first] = result.content;
  const text = first?.type === 'text' ? first.text : '';
  return { isError: result.isError ?? false, text, data: result.structuredContent as Record<string, any> };
}

describe('server info', () => {
  it('reports the package version', async () => {
    const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(client.getServerVersion()?.version).toBe(version);
  });
});

describe('tool list', () => {
  it('exposes the five tools with read-only hints on the queries', async () => {
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
    expect(Object.keys(byName).sort()).toEqual([
      'get_approval_status',
      'get_invoice',
      'match_invoice',
      'request_approval',
      'search_invoices',
    ]);
    expect(byName.search_invoices?.annotations?.readOnlyHint).toBe(true);
    expect(byName.match_invoice?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get_approval_status?.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true });
    expect(byName.request_approval?.annotations).toMatchObject({ readOnlyHint: false, idempotentHint: true });
  });

  it('publishes input schemas the model can follow', async () => {
    const { tools } = await client.listTools();
    const match = tools.find((tool) => tool.name === 'match_invoice');
    expect(match?.inputSchema.required).toEqual(['invoiceId']);
    // The price tolerance is finance policy set on the server, so the agent cannot loosen it.
    expect(match?.inputSchema.properties).not.toHaveProperty('priceTolerancePct');
  });

  it('publishes strict output schemas for every tool', async () => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(tool.outputSchema, tool.name).toMatchObject({ type: 'object', additionalProperties: false });
    }
    const match = tools.find((tool) => tool.name === 'match_invoice');
    expect(match?.outputSchema?.required).toEqual(['invoiceId', 'poId', 'status', 'priceTolerancePct', 'exceptions', 'invoiceTotal']);
  });
});

describe('tool results', () => {
  it('carry the same data as structuredContent and as JSON text', async () => {
    const result = await call('get_invoice', { invoiceId: 'INV-1003' });
    expect(JSON.parse(result.text)).toEqual(result.data);
  });

  it('carry no structuredContent on errors', async () => {
    const result = await call('match_invoice', { invoiceId: 'INV-9999' });
    expect(result).toMatchObject({ isError: true, data: undefined });
  });
});

describe('search_invoices', () => {
  it('returns all invoices, soonest due first', async () => {
    const result = (await call('search_invoices')).data;
    expect(result.total).toBe(9);
    expect(result.items[0]).toMatchObject({ id: 'INV-1007', dueDate: '2026-10-06' });
    expect(result.items.at(-1)).toMatchObject({ id: 'INV-1004', dueDate: '2026-11-23' });
  });

  it('filters by status, supplier name and due date together', async () => {
    const result = (await call('search_invoices', { status: 'received', supplier: 'somes', dueBefore: '2026-11-10' })).data;
    expect(result.items.map((item: { id: string }) => item.id)).toEqual(['INV-1005']);
  });

  it('accepts a supplier id', async () => {
    const result = (await call('search_invoices', { supplier: 'SUP-004' })).data;
    expect(result.items.map((item: { id: string }) => item.id)).toEqual(['INV-1007', 'INV-1008']);
  });

  it('pages through results', async () => {
    const result = (await call('search_invoices', { limit: 2, offset: 8 })).data;
    expect(result).toMatchObject({ total: 9, offset: 8, limit: 2 });
    expect(result.items).toHaveLength(1);
  });

  it('formats totals from minor units', async () => {
    const result = (await call('search_invoices', { supplier: 'SUP-003' })).data;
    expect(result.items[0].total).toEqual({ amountMinor: 499000, currency: 'EUR', formatted: '4,990.00 EUR' });
  });

  it('rejects invalid input before the tool runs', async () => {
    const result = await call('search_invoices', { limit: 500 });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/limit/);
  });
});

describe('get_invoice', () => {
  it('returns the invoice with its supplier, PO and receipts', async () => {
    const result = (await call('get_invoice', { invoiceId: 'INV-1008' })).data;
    expect(result.invoice).toMatchObject({ id: 'INV-1008', total: { formatted: '2,295.00 EUR' } });
    expect(result.supplier.name).toBe('Napoca Freight SRL');
    expect(result.purchaseOrder).toMatchObject({ id: 'PO-2026-0004', total: { formatted: '22,800.00 RON' } });
    expect(result.goodsReceipts).toHaveLength(2);
  });

  it('returns a tool error for an unknown invoice', async () => {
    const result = await call('get_invoice', { invoiceId: 'INV-9999' });
    expect(result).toMatchObject({ isError: true, text: expect.stringContaining('search_invoices') });
  });

  it('rejects a malformed id', async () => {
    expect((await call('get_invoice', { invoiceId: 'banana' })).isError).toBe(true);
  });
});

describe('match_invoice', () => {
  // Every invoice in the sample data exists to show one case.
  it.each([
    ['INV-1001', []],
    ['INV-1002', ['DUPLICATE_INVOICE', 'QUANTITY_EXCEEDS_PO', 'QUANTITY_EXCEEDS_PO']],
    ['INV-1003', ['PRICE_VARIANCE']],
    ['INV-1004', []],
    ['INV-1005', ['QUANTITY_NOT_RECEIVED']],
    ['INV-1006', ['LINE_NOT_ON_PO']],
    ['INV-1007', []],
    ['INV-1008', ['CURRENCY_MISMATCH']],
    ['INV-1009', ['SUPPLIER_MISMATCH']],
  ])('%s → %j', async (invoiceId, expected) => {
    const result = (await call('match_invoice', { invoiceId })).data;
    expect(result.exceptions.map((exception: { code: string }) => exception.code)).toEqual(expected);
    expect(result.status).toBe(expected.length === 0 ? 'matched' : 'exception');
  });

  it('uses the price tolerance the server was started with', async () => {
    await client.close();
    await connect(10);
    const result = (await call('match_invoice', { invoiceId: 'INV-1003' })).data;
    expect(result).toMatchObject({ status: 'matched', priceTolerancePct: 10 });
  });
});

describe('request_approval', () => {
  const reason = 'Unit price for bolts is 8% above the PO; supplier needs to confirm.';

  it('creates a pending request with the exception codes the server found', async () => {
    const result = (await call('request_approval', { invoiceId: 'INV-1003', reason })).data;
    expect(result).toEqual({
      created: true,
      approval: {
        id: 'APR-0001',
        invoiceId: 'INV-1003',
        reason,
        exceptionCodes: ['PRICE_VARIANCE'],
        requestedBy: 'ai-agent',
        status: 'pending',
        createdAt: '2026-11-18T09:00:00.000Z',
      },
    });
  });

  it('returns the pending request when asked twice for the same invoice', async () => {
    await call('request_approval', { invoiceId: 'INV-1003', reason });
    const second = (await call('request_approval', { invoiceId: 'INV-1003', reason, requestedBy: 'retrying-agent' })).data;
    expect(second).toMatchObject({ created: false, approval: { id: 'APR-0001', requestedBy: 'ai-agent' } });
    expect(approvals.list()).toHaveLength(1);
  });

  it('refuses an invoice that passes matching', async () => {
    const result = await call('request_approval', { invoiceId: 'INV-1004', reason });
    expect(result).toMatchObject({ isError: true, text: expect.stringContaining('needs no approval') });
    expect(approvals.list()).toHaveLength(0);
  });

  it('refuses an invoice that is already paid or approved', async () => {
    const result = await call('request_approval', { invoiceId: 'INV-1001', reason });
    expect(result).toMatchObject({ isError: true, text: expect.stringContaining('is paid') });
  });

  it('refuses an unknown invoice', async () => {
    expect((await call('request_approval', { invoiceId: 'INV-9999', reason })).isError).toBe(true);
  });

  it('requires a real reason', async () => {
    const result = await call('request_approval', { invoiceId: 'INV-1003', reason: '   ok    ' });
    expect(result.isError).toBe(true);
    expect(approvals.list()).toHaveLength(0);
  });
});

describe('get_approval_status', () => {
  const reason = 'Unit price for bolts is 8% above the PO; supplier needs to confirm.';
  const decide = async (decision: 'approved' | 'rejected', comment: string) => {
    const approval = await approvals.recordDecision({
      approvalId: 'APR-0001',
      invoiceId: 'INV-1003',
      decision,
      comment,
      decidedBy: 'Ana Pop',
      decidedAt: '2026-11-18T10:00:00.000Z',
    });
    applyDecision(repository, approval!);
  };

  it('reports a pending request with the invoice still on hold', async () => {
    await call('request_approval', { invoiceId: 'INV-1003', reason });
    const result = await call('get_approval_status', { invoiceId: 'INV-1003' });
    expect(result.isError).toBe(false);
    expect(result.data).toEqual({
      invoice: { id: 'INV-1003', status: 'on_hold' },
      approval: {
        id: 'APR-0001',
        status: 'pending',
        exceptionCodes: ['PRICE_VARIANCE'],
        comment: null,
        decidedBy: null,
        decidedAt: null,
        createdAt: '2026-11-18T09:00:00.000Z',
      },
    });
    expect(JSON.parse(result.text)).toEqual(result.data);
  });

  it('reports an approval, its comment and the invoice now approved for payment', async () => {
    await call('request_approval', { invoiceId: 'INV-1003', reason });
    await decide('approved', 'Supplier confirmed the new price list.');
    const { data } = await call('get_approval_status', { invoiceId: 'INV-1003', approvalId: 'APR-0001' });
    expect(data.approval).toMatchObject({
      status: 'approved',
      comment: 'Supplier confirmed the new price list.',
      decidedBy: 'Ana Pop',
      decidedAt: '2026-11-18T10:00:00.000Z',
    });
    expect(data.invoice).toMatchObject({
      status: 'approved',
      decision: { approvalId: 'APR-0001', decision: 'approved', note: expect.stringContaining('PRICE_VARIANCE') },
    });
  });

  it('reports a rejection and the invoice rejected', async () => {
    await call('request_approval', { invoiceId: 'INV-1003', reason });
    await decide('rejected', 'Price increase was never agreed.');
    const { data } = await call('get_approval_status', { invoiceId: 'INV-1003' });
    expect(data.approval).toMatchObject({ status: 'rejected', comment: 'Price increase was never agreed.' });
    expect(data.invoice.status).toBe('rejected');
  });

  it('reports a cancelled request from the store', async () => {
    const cancelled: ApprovalRecord = {
      id: '5b0c7a8e-2f3d-4e1a-9c6b-1d2e3f4a5b6c',
      invoiceId: 'INV-1005',
      status: 'cancelled',
      exceptionCodes: ['QUANTITY_NOT_RECEIVED'],
      comment: null,
      decidedBy: null,
      decidedAt: '2026-11-18T11:00:00.000Z',
      createdAt: '2026-11-18T09:00:00.000Z',
    };
    const store: ApprovalStore = {
      submit: () => Promise.reject(new Error('not used')),
      find: async ({ invoiceId }) => (invoiceId === 'INV-1005' ? cancelled : undefined),
    };
    await client.close();
    await connect(undefined, store);
    const { data } = await call('get_approval_status', { invoiceId: 'INV-1005' });
    expect(data).toEqual({ invoice: { id: 'INV-1005', status: 'received' }, approval: cancelled });
  });

  it('returns approval: null for an invoice that was never sent for approval', async () => {
    const { isError, data } = await call('get_approval_status', { invoiceId: 'INV-1004' });
    expect(isError).toBe(false);
    expect(data).toEqual({ invoice: { id: 'INV-1004', status: 'received' }, approval: null });
  });

  it('returns a tool error for an unknown invoice or an approval id that is not for this invoice', async () => {
    await call('request_approval', { invoiceId: 'INV-1003', reason });
    expect(await call('get_approval_status', { invoiceId: 'INV-9999' })).toMatchObject({ isError: true });
    const wrong = await call('get_approval_status', { invoiceId: 'INV-1005', approvalId: 'APR-0001' });
    expect(wrong).toMatchObject({ isError: true, text: expect.stringContaining('APR-0001') });
  });

  it('rejects an approval id that could change the API path', async () => {
    expect((await call('get_approval_status', { invoiceId: 'INV-1003', approvalId: '../auth/login' })).isError).toBe(true);
  });

  it('does not change anything', async () => {
    await call('request_approval', { invoiceId: 'INV-1003', reason });
    await call('get_approval_status', { invoiceId: 'INV-1003' });
    expect(approvals.list()).toHaveLength(1);
    expect(repository.getInvoice('INV-1003')?.status).toBe('on_hold');
  });
});
