import { beforeEach, describe, expect, it } from 'vitest';
import { ApprovalsApiError, HttpApprovalStore } from '../src/approvals/http-store.js';
import type { NewApprovalRequest } from '../src/approvals/store.js';
import { money } from '../src/erp/money.js';

interface Call {
  url: string;
  method: string;
  authorization: string | undefined;
  body: any;
}

// A fake fetch that answers from a queue of responses (status, body, optional headers) and records every call.
function fakeFetch(...responses: Array<[number, unknown, Record<string, string>?] | Error>) {
  const calls: Call[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    calls.push({
      url,
      method: init.method ?? 'GET',
      authorization: headers.authorization,
      body: init.body === undefined ? undefined : JSON.parse(init.body as string),
    });
    const next = responses.shift();
    if (!next) throw new Error('unexpected request');
    if (next instanceof Error) throw next;
    const [status, json, extraHeaders] = next;
    return new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json', ...extraHeaders } });
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
  exceptions: [{ code: 'DUPLICATE_INVOICE' }, { code: 'QUANTITY_EXCEEDS_PO', lineNo: 1, excess: 40 }],
  requestedBy: 'claude',
  invoiceTotal: money(966000, 'RON'),
  supplierName: 'Carpathian Office Supplies SRL',
};

// Retries don't really wait in tests; the delays they would have waited are recorded instead.
let delays: number[] = [];
beforeEach(() => {
  delays = [];
});
const sleep = async (ms: number) => {
  delays.push(ms);
};

const store = (fetch: typeof globalThis.fetch) =>
  new HttpApprovalStore({ baseUrl: 'http://api.test/', email: 'agent@example.com', password: 'secret', fetch, sleep });

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
        // What the approver sees, per line and by how much: an approval is checked against it before it is applied.
        exceptions: [{ code: 'DUPLICATE_INVOICE' }, { code: 'QUANTITY_EXCEEDS_PO', lineNo: 1, excess: 40 }],
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

  it('names each exception kind once when several lines share it', async () => {
    const { fetch, calls } = fakeFetch(login('t1'), created(true));
    await store(fetch).submit({ ...request, exceptionCodes: ['DUPLICATE_INVOICE', 'QUANTITY_EXCEEDS_PO', 'QUANTITY_EXCEEDS_PO'] });
    expect(calls[1]!.body).toMatchObject({
      title: 'INV-1002: DUPLICATE_INVOICE, QUANTITY_EXCEEDS_PO',
      tags: ['finance', 'duplicate-invoice', 'quantity-exceeds-po'],
      metadata: { exceptionCodes: ['DUPLICATE_INVOICE', 'QUANTITY_EXCEEDS_PO', 'QUANTITY_EXCEEDS_PO'] },
    });
  });

  it('leaves the per-line detail out rather than go over the platform limit of 10 KB of metadata', async () => {
    const { fetch, calls } = fakeFetch(login('t1'), created(true));
    const exceptions = Array.from({ length: 300 }, (_, index) => ({ code: 'QUANTITY_NOT_RECEIVED' as const, lineNo: index + 1, excess: 1000 }));
    await store(fetch).submit({ ...request, exceptionCodes: ['QUANTITY_NOT_RECEIVED'], exceptions });
    const { metadata } = calls[1]!.body;
    expect(metadata).not.toHaveProperty('exceptions');
    expect(metadata.exceptionCodes).toEqual(['QUANTITY_NOT_RECEIVED']);
    expect(JSON.stringify(metadata).length).toBeLessThanOrEqual(10_000);
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
    const down = new TypeError('fetch failed');
    const { fetch, calls } = fakeFetch(down, down, down);
    await expect(store(fetch).submit(request)).rejects.toThrow(
      'Approvals API at http://api.test is unreachable after 3 attempts: fetch failed',
    );
    expect(calls).toHaveLength(3);
  });
});

describe('HttpApprovalStore retries', () => {
  const unavailable = (headers?: Record<string, string>): [number, unknown, Record<string, string>?] => [
    503,
    { title: 'Service Unavailable', detail: 'The service is temporarily unavailable' },
    headers,
  ];

  it('retries network errors and 5xx, then succeeds', async () => {
    const { fetch, calls } = fakeFetch(login('t1'), new TypeError('fetch failed'), unavailable(), created(true));
    const result = await store(fetch).submit(request);
    expect(result.created).toBe(true);
    // The same request body each time: the API's idempotency on (source, externalRef) makes that safe.
    expect(calls.slice(1).map((call) => call.body.externalRef)).toEqual(['INV-1002', 'INV-1002', 'INV-1002']);
    // Exponential backoff with jitter: within [base/2, base] for 500 ms, then 1 s.
    expect(delays).toHaveLength(2);
    expect(delays[0]).toBeGreaterThanOrEqual(250);
    expect(delays[0]).toBeLessThanOrEqual(500);
    expect(delays[1]).toBeGreaterThanOrEqual(500);
    expect(delays[1]).toBeLessThanOrEqual(1000);
  });

  it("waits as long as the server's Retry-After asks", async () => {
    const { fetch } = fakeFetch(login('t1'), [429, { title: 'Too Many Requests' }, { 'retry-after': '2' }], created(true));
    await store(fetch).submit(request);
    expect(delays).toEqual([2000]);
  });

  it('caps a long Retry-After so a tool call is not left hanging', async () => {
    const { fetch } = fakeFetch(login('t1'), unavailable({ 'retry-after': '3600' }), created(true));
    await store(fetch).submit(request);
    expect(delays).toEqual([10_000]);
  });

  it('gives up after 3 attempts with the last error', async () => {
    const { fetch, calls } = fakeFetch(login('t1'), unavailable(), unavailable(), unavailable());
    await expect(store(fetch).submit(request)).rejects.toThrow(
      new ApprovalsApiError('Approvals API /v1/requests failed with 503 (Service Unavailable: The service is temporarily unavailable)'),
    );
    expect(calls).toHaveLength(4);
  });

  it.each([
    [400, 'Bad Request'],
    [409, 'Conflict'],
  ])('does not retry a %i: the request itself is wrong', async (status, title) => {
    const { fetch, calls } = fakeFetch(login('t1'), [status, { title }]);
    await expect(store(fetch).submit(request)).rejects.toThrow(`failed with ${status}`);
    expect(calls).toHaveLength(2);
    expect(delays).toEqual([]);
  });

  it('still signs in again on a 401 after a retried 503', async () => {
    const { fetch, calls } = fakeFetch(login('old'), unavailable(), [401, { title: 'Unauthorized' }], login('new'), created(true));
    await store(fetch).submit(request);
    expect(calls.map((call) => call.authorization)).toEqual([undefined, 'Bearer old', 'Bearer old', undefined, 'Bearer new']);
  });
});

describe('HttpApprovalStore.find', () => {
  const REQUEST_ID = '5b0c7a8e-2f3d-4e1a-9c6b-1d2e3f4a5b6c';
  const OLDER_ID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
  const summary = (id: string, externalRef: string, status = 'approved') => ({
    id,
    title: `${externalRef}: PRICE_VARIANCE`,
    type: 'invoice_exception',
    status,
    priority: 'normal',
    source: 'erp-procurement-mcp',
    externalRef,
    amount: null,
    requester: { id: OLDER_ID, name: 'ERP agent' },
    tags: [],
    createdAt: '2026-11-18T09:00:00+00:00',
    updatedAt: '2026-11-18T10:00:00+00:00',
    decidedAt: status === 'pending' ? null : '2026-11-18T10:00:00+00:00',
  });
  const detail = (changes: Record<string, unknown> = {}) => ({
    ...summary(REQUEST_ID, 'INV-1003'),
    description: 'reason',
    metadata: {
      exceptionCodes: ['PRICE_VARIANCE'],
      exceptions: [{ code: 'PRICE_VARIANCE', lineNo: 2, excess: 256 }],
      requestedBy: 'claude',
      supplier: 'Somes',
    },
    decisions: [
      {
        id: OLDER_ID,
        approver: { id: OLDER_ID, name: 'Ana Pop' },
        decision: 'approved',
        comment: 'Supplier confirmed the new price list.',
        createdAt: '2026-11-18T10:00:00+00:00',
      },
    ],
    comments: [],
    ...changes,
  });
  const page = (...items: unknown[]) => [200, { items, page: 1, pageSize: 100, total: items.length }] as [number, unknown];

  it('finds the newest request for the invoice, then reads its decision', async () => {
    // The list filter q matches the title or externalRef by substring, so the store keeps only exact matches.
    const { fetch, calls } = fakeFetch(
      login('t1'),
      page(summary(OLDER_ID, 'INV-10031'), summary(REQUEST_ID, 'INV-1003'), summary(OLDER_ID, 'INV-1003', 'rejected')),
      [200, detail()],
    );
    const record = await store(fetch).find({ invoiceId: 'INV-1003' });

    expect(calls[1]).toMatchObject({ method: 'GET', authorization: 'Bearer t1', body: undefined });
    const listUrl = new URL(calls[1]!.url);
    expect(listUrl.pathname).toBe('/v1/requests');
    expect(Object.fromEntries(listUrl.searchParams)).toEqual({ source: 'erp-procurement-mcp', q: 'INV-1003', pageSize: '100' });
    expect(calls[2]).toMatchObject({ method: 'GET', url: `http://api.test/v1/requests/${REQUEST_ID}` });
    expect(record).toEqual({
      id: REQUEST_ID,
      invoiceId: 'INV-1003',
      status: 'approved',
      exceptionCodes: ['PRICE_VARIANCE'],
      exceptions: [{ code: 'PRICE_VARIANCE', lineNo: 2, excess: 256 }],
      comment: 'Supplier confirmed the new price list.',
      decidedBy: 'Ana Pop',
      decidedAt: '2026-11-18T10:00:00.000Z',
      createdAt: '2026-11-18T09:00:00.000Z',
    });
  });

  it('reads a request by id directly', async () => {
    const { fetch, calls } = fakeFetch(login('t1'), [200, detail()]);
    const record = await store(fetch).find({ invoiceId: 'INV-1003', approvalId: REQUEST_ID });
    expect(calls.map((call) => call.url)).toEqual(['http://api.test/v1/auth/login', `http://api.test/v1/requests/${REQUEST_ID}`]);
    expect(record?.status).toBe('approved');
  });

  it.each([
    ['pending', [], null, null, null],
    ['cancelled', [], null, null, '2026-11-18T10:00:00.000Z'],
  ])('reports a %s request without a decision', async (status, decisions, comment, decidedBy, decidedAt) => {
    const { fetch } = fakeFetch(login('t1'), [200, detail({ status, decisions, decidedAt })]);
    expect(await store(fetch).find({ invoiceId: 'INV-1003', approvalId: REQUEST_ID })).toMatchObject({
      status,
      comment,
      decidedBy,
      decidedAt,
    });
  });

  it('reports a rejection with its comment', async () => {
    const rejection = { ...detail().decisions[0], decision: 'rejected', comment: 'Never agreed.' };
    const { fetch } = fakeFetch(login('t1'), [200, detail({ status: 'rejected', decisions: [rejection] })]);
    expect(await store(fetch).find({ invoiceId: 'INV-1003', approvalId: REQUEST_ID })).toMatchObject({
      status: 'rejected',
      comment: 'Never agreed.',
    });
  });

  it('treats a request for another invoice or another source as not found', async () => {
    const other = fakeFetch(login('t1'), [200, detail({ externalRef: 'INV-1005' })]);
    expect(await store(other.fetch).find({ invoiceId: 'INV-1003', approvalId: REQUEST_ID })).toBeUndefined();
    const manual = fakeFetch(login('t1'), [200, detail({ source: 'manual' })]);
    expect(await store(manual.fetch).find({ invoiceId: 'INV-1003', approvalId: REQUEST_ID })).toBeUndefined();
  });

  it('answers undefined for an unknown id (404) or one that is not a platform id, without calling the API', async () => {
    const { fetch } = fakeFetch(login('t1'), [404, { title: 'Not Found' }]);
    expect(await store(fetch).find({ invoiceId: 'INV-1003', approvalId: REQUEST_ID })).toBeUndefined();
    const none = fakeFetch();
    expect(await store(none.fetch).find({ invoiceId: 'INV-1003', approvalId: 'APR-0001' })).toBeUndefined();
    expect(none.calls).toHaveLength(0);
  });

  it('answers undefined when the invoice has no request', async () => {
    const { fetch } = fakeFetch(login('t1'), page());
    expect(await store(fetch).find({ invoiceId: 'INV-1004' })).toBeUndefined();
  });

  it('keeps exception codes it does not know out of the record', async () => {
    const { fetch } = fakeFetch(login('t1'), [200, detail({ metadata: { exceptionCodes: ['PRICE_VARIANCE', 'APPROVE_ME'] } })]);
    expect((await store(fetch).find({ invoiceId: 'INV-1003', approvalId: REQUEST_ID }))?.exceptionCodes).toEqual(['PRICE_VARIANCE']);
  });

  // Metadata is free-form on the platform. Detail that can't be read is dropped as a whole, and the approval then holds
  // the invoice instead of being checked against half of what the approver saw.
  it.each([
    ['missing (a request raised before it was recorded)', undefined],
    ['not a list', 'PRICE_VARIANCE on line 2'],
    ['an unknown code', [{ code: 'PRICE_VARIANCE', lineNo: 2, excess: 256 }, { code: 'APPROVE_ME' }]],
    ['a negative excess', [{ code: 'PRICE_VARIANCE', lineNo: 2, excess: -1 }]],
    ['a line number that is not a whole number', [{ code: 'PRICE_VARIANCE', lineNo: '2', excess: 256 }]],
  ])('reads no per-line detail when it is %s', async (_, exceptions) => {
    const metadata = { exceptionCodes: ['PRICE_VARIANCE'], ...(exceptions !== undefined && { exceptions }) };
    const { fetch } = fakeFetch(login('t1'), [200, detail({ metadata })]);
    const record = await store(fetch).find({ invoiceId: 'INV-1003', approvalId: REQUEST_ID });
    expect(record?.exceptionCodes).toEqual(['PRICE_VARIANCE']);
    expect(record?.exceptions).toBeUndefined();
  });

  it('retries a 503 on reads too', async () => {
    const { fetch } = fakeFetch(login('t1'), [503, { title: 'Service Unavailable' }], [200, detail()]);
    expect((await store(fetch).find({ invoiceId: 'INV-1003', approvalId: REQUEST_ID }))?.status).toBe('approved');
    expect(delays).toHaveLength(1);
  });
});
