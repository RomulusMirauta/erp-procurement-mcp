import { describe, expect, it } from 'vitest';
import { ApprovalsApiError, HttpApprovalStore } from '../src/approvals/http-store.js';
import type { NewApprovalRequest } from '../src/approvals/store.js';
import { money } from '../src/erp/money.js';

interface Call {
  url: string;
  authorization: string | undefined;
  body: any;
}

// A fake fetch that answers from a queue of responses and records every call.
function fakeFetch(...responses: Array<[number, unknown] | Error>) {
  const calls: Call[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    calls.push({ url, authorization: headers.authorization, body: JSON.parse(init.body as string) });
    const next = responses.shift();
    if (!next) throw new Error('unexpected request');
    if (next instanceof Error) throw next;
    const [status, json] = next;
    return new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const login = (token: string): [number, unknown] => [200, { token, expiresIn: 28800, user: {} }];
const created = (createdFlag: boolean, metadata: Record<string, unknown> = { requestedBy: 'claude' }): [number, unknown] => [
  createdFlag ? 201 : 200,
  {
    created: createdFlag,
    request: { id: '6f1c', status: 'pending', createdAt: '2026-11-18T09:00:00+00:00', requester: { name: 'ERP agent' }, metadata },
  },
];

const request: NewApprovalRequest = {
  invoiceId: 'INV-1002',
  reason: 'Same supplier invoice number as the paid INV-1001.',
  exceptionCodes: ['DUPLICATE_INVOICE', 'QUANTITY_EXCEEDS_PO'],
  requestedBy: 'claude',
  invoiceTotal: money(966000, 'RON'),
  supplierName: 'Carpathian Office Supplies SRL',
};

const store = (fetch: typeof globalThis.fetch) =>
  new HttpApprovalStore({ baseUrl: 'http://api.test/', email: 'agent@example.com', password: 'secret', fetch });

describe('HttpApprovalStore', () => {
  it('signs in, then creates the request with the details an approver needs', async () => {
    const { fetch, calls } = fakeFetch(login('t1'), created(true));
    const result = await store(fetch).submit(request);

    expect(calls[0]).toMatchObject({ url: 'http://api.test/v1/auth/login', body: { email: 'agent@example.com', password: 'secret' } });
    expect(calls[1]).toMatchObject({ url: 'http://api.test/v1/requests', authorization: 'Bearer t1' });
    expect(calls[1]!.body).toEqual({
      title: 'INV-1002: DUPLICATE_INVOICE, QUANTITY_EXCEEDS_PO',
      description: request.reason,
      type: 'invoice_exception',
      priority: 'high',
      source: 'erp-procurement-mcp',
      externalRef: 'INV-1002',
      amount: { amountMinor: 966000, currency: 'RON' },
      tags: ['finance', 'duplicate-invoice', 'quantity-exceeds-po'],
      metadata: {
        exceptionCodes: ['DUPLICATE_INVOICE', 'QUANTITY_EXCEEDS_PO'],
        requestedBy: 'claude',
        supplier: 'Carpathian Office Supplies SRL',
      },
    });
    expect(result).toEqual({
      created: true,
      approval: {
        id: '6f1c',
        invoiceId: 'INV-1002',
        reason: request.reason,
        exceptionCodes: request.exceptionCodes,
        requestedBy: 'claude',
        status: 'pending',
        createdAt: '2026-11-18T09:00:00.000Z',
      },
    });
  });

  it('uses normal priority when nothing points at fraud', async () => {
    const { fetch, calls } = fakeFetch(login('t1'), created(true));
    await store(fetch).submit({ ...request, exceptionCodes: ['PRICE_VARIANCE'] });
    expect(calls[1]!.body.priority).toBe('normal');
  });

  it('reports the request that was already pending, with its original requester', async () => {
    const { fetch } = fakeFetch(login('t1'), created(false, { requestedBy: 'first-agent' }));
    const result = await store(fetch).submit(request);
    expect(result).toMatchObject({ created: false, approval: { requestedBy: 'first-agent' } });
  });

  it('falls back to the requester account for requests raised without a requestedBy', async () => {
    const { fetch } = fakeFetch(login('t1'), created(false, {}));
    expect((await store(fetch).submit(request)).approval.requestedBy).toBe('ERP agent');
  });

  it('signs in once and reuses the token', async () => {
    const { fetch, calls } = fakeFetch(login('t1'), created(true), created(false));
    const approvals = store(fetch);
    await approvals.submit(request);
    await approvals.submit(request);
    expect(calls.map((call) => call.url)).toEqual([
      'http://api.test/v1/auth/login',
      'http://api.test/v1/requests',
      'http://api.test/v1/requests',
    ]);
  });

  it('signs in again once when the token has expired', async () => {
    const { fetch, calls } = fakeFetch(login('old'), [401, { title: 'Unauthorized' }], login('new'), created(true));
    await store(fetch).submit(request);
    expect(calls.map((call) => call.authorization)).toEqual([undefined, 'Bearer old', undefined, 'Bearer new']);
  });

  it('turns an API problem into a clear error', async () => {
    const { fetch } = fakeFetch(login('t1'), [409, { title: 'Conflict', detail: 'Pending request belongs to another user' }]);
    await expect(store(fetch).submit(request)).rejects.toThrow(
      new ApprovalsApiError('Approvals API /v1/requests failed with 409 (Conflict: Pending request belongs to another user)'),
    );
  });

  it('fails clearly when the credentials are wrong', async () => {
    const { fetch } = fakeFetch([401, { title: 'Unauthorized', detail: 'Wrong email or password' }]);
    await expect(store(fetch).submit(request)).rejects.toThrow(/auth\/login failed with 401/);
  });

  it('fails clearly when the API is down', async () => {
    const { fetch } = fakeFetch(new TypeError('fetch failed'));
    await expect(store(fetch).submit(request)).rejects.toThrow('Approvals API at http://api.test is unreachable: fetch failed');
  });
});
