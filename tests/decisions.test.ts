// Applying a person's decision to the ERP invoice, without HTTP: the re-check, the note and idempotency.
import { beforeEach, describe, expect, it } from 'vitest';
import { applyDecision, type DecisionOptions } from '../src/approvals/decisions.js';
import type { ApprovalRecord } from '../src/approvals/store.js';
import { ErpRepository } from '../src/erp/repository.js';
import type { ErpData, Invoice } from '../src/erp/schema.js';

let repository: ErpRepository;

beforeEach(async () => {
  repository = await ErpRepository.fromFile(new URL('../data/erp-sample.json', import.meta.url));
});

const approval = (changes: Partial<ApprovalRecord> = {}): ApprovalRecord => ({
  id: 'APR-0001',
  invoiceId: 'INV-1003',
  status: 'approved',
  exceptionCodes: ['PRICE_VARIANCE'],
  // INV-1003 bills line 2 at 34.56 against the PO's 32.00.
  exceptions: [{ code: 'PRICE_VARIANCE', lineNo: 2, excess: 256 }],
  comment: 'ok',
  decidedBy: 'Ana Pop',
  decidedAt: '2026-11-18T10:00:00.000Z',
  createdAt: '2026-11-18T09:00:00.000Z',
  ...changes,
});

// The request is the newest one for its invoice unless a test says otherwise.
const apply = (record: ApprovalRecord, options: Partial<DecisionOptions> = {}) =>
  applyDecision(repository, record, { latestApprovalId: record.id, ...options });

describe('applyDecision', () => {
  it('approves an invoice whose exceptions are the ones the person saw, and says which it overrides', () => {
    const outcome = apply(approval());
    expect(outcome).toMatchObject({ result: 'approved', invoice: { id: 'INV-1003', status: 'approved' } });
    expect(repository.getInvoice('INV-1003')?.decision).toEqual({
      approvalId: 'APR-0001',
      decision: 'approved',
      decidedBy: 'Ana Pop',
      decidedAt: '2026-11-18T10:00:00.000Z',
      note: expect.stringMatching(/overrid.*PRICE_VARIANCE/),
    });
  });

  it('shows up in the repository: search and later matches see the new status', () => {
    apply(approval());
    expect(repository.listInvoices().find((invoice) => invoice.id === 'INV-1003')?.status).toBe('approved');
    // INV-1003 now counts as settled, so it uses up quantity on PO-2026-0002.
    expect(repository.priorInvoices(repository.getInvoice('INV-1005')!).map((invoice) => invoice.id)).toContain('INV-1003');
  });

  it('rejects an invoice', () => {
    const outcome = apply(approval({ status: 'rejected' }));
    expect(outcome).toMatchObject({ result: 'rejected', invoice: { status: 'rejected', decision: { decision: 'rejected' } } });
  });

  it('holds an approval when matching now finds an exception the person did not see', () => {
    const outcome = apply(approval({ exceptionCodes: [], exceptions: [] }));
    expect(outcome).toMatchObject({ result: 'held', invoice: { status: 'on_hold' } });
    const note = repository.getInvoice('INV-1003')?.decision?.note ?? '';
    expect(note).toMatch(/PRICE_VARIANCE/);
    expect(note).toMatch(/not approved for payment/i);
  });

  it('respects the server price tolerance in the re-check', () => {
    // At 10% the 8% price variance is within tolerance: the invoice now matches, so approving it is safe.
    const outcome = apply(approval({ exceptionCodes: [], exceptions: [] }), { priceTolerancePct: 10 });
    expect(outcome).toMatchObject({ result: 'approved' });
    expect(repository.getInvoice('INV-1003')?.decision?.note).toMatch(/passes three-way matching/);
  });

  it('applies each approval request once', () => {
    apply(approval());
    const before = structuredClone(repository.getInvoice('INV-1003'));
    expect(apply(approval())).toMatchObject({ result: 'unchanged' });
    expect(apply(approval({ status: 'rejected' }))).toMatchObject({ result: 'unchanged' });
    expect(repository.getInvoice('INV-1003')).toEqual(before);
  });

  it('applies a new approval request after an earlier one was held', () => {
    apply(approval({ exceptionCodes: [], exceptions: [] }));
    expect(apply(approval({ id: 'APR-0002' }))).toMatchObject({ result: 'approved' });
  });

  it.each(['INV-1001', 'INV-1007'])('never changes an invoice that is already settled (%s)', (invoiceId) => {
    const status = repository.getInvoice(invoiceId)?.status;
    expect(apply(approval({ invoiceId, status: 'rejected' }))).toMatchObject({ result: 'unchanged' });
    expect(repository.getInvoice(invoiceId)?.status).toBe(status);
  });

  it('refuses a request that is not decided', () => {
    expect(() => apply(approval({ status: 'pending' }))).toThrow(/pending/);
  });

  it('ignores a decision on a request that a newer request for the invoice has superseded', () => {
    // APR-0001 was approved, but its delivery was retried while the agent raised APR-0002 for the same invoice.
    const outcome = apply(approval(), { latestApprovalId: 'APR-0002' });
    expect(outcome).toMatchObject({ result: 'ignored', reason: expect.stringMatching(/superseded/i) });
    expect(repository.getInvoice('INV-1003')).toMatchObject({ status: 'on_hold' });
    expect(repository.getInvoice('INV-1003')?.decision).toBeUndefined();
    // A rejection on the older request is ignored the same way, and so is a request the store can't place.
    expect(apply(approval({ status: 'rejected' }), { latestApprovalId: 'APR-0002' })).toMatchObject({ result: 'ignored' });
    expect(apply(approval(), { latestApprovalId: undefined })).toMatchObject({ result: 'ignored' });
  });
});

// The re-check compares what the approver saw (code, line and how far past the rule) with what matching finds now.
// One PO with two lines: 10 ordered and 6 received on line 1, 20 ordered and 10 received on line 2, at 10.00 each.
describe('applyDecision: what the approver saw, line by line', () => {
  const line = (lineNo: number, quantity: number, unitPriceMinor = 1000) => ({ lineNo, description: 'Part', quantity, unitPriceMinor });
  const invoice = (id: string, lines: Invoice['lines']): Invoice => ({
    id,
    supplierId: 'SUP-001',
    poId: 'PO-2026-0009',
    supplierInvoiceNumber: `S-${id}`,
    invoiceDate: '2026-10-01',
    dueDate: '2026-11-01',
    currency: 'RON',
    status: 'received',
    lines,
  });
  const erp = (...invoices: Invoice[]): ErpData => ({
    suppliers: [{ id: 'SUP-001', name: 'Supplier', country: 'RO', currency: 'RON', paymentTermsDays: 30 }],
    purchaseOrders: [
      {
        id: 'PO-2026-0009',
        supplierId: 'SUP-001',
        orderDate: '2026-09-01',
        currency: 'RON',
        status: 'open',
        lines: [
          { lineNo: 1, sku: 'A', description: 'Part', quantity: 10, unitPriceMinor: 1000 },
          { lineNo: 2, sku: 'B', description: 'Part', quantity: 20, unitPriceMinor: 1000 },
        ],
      },
    ],
    goodsReceipts: [
      {
        id: 'GR-0009',
        poId: 'PO-2026-0009',
        receivedDate: '2026-09-20',
        lines: [
          { lineNo: 1, quantityReceived: 6 },
          { lineNo: 2, quantityReceived: 10 },
        ],
      },
    ],
    invoices,
  });
  const seen = (exceptions: NonNullable<ApprovalRecord['exceptions']>, changes: Partial<ApprovalRecord> = {}) =>
    approval({ invoiceId: 'INV-9001', exceptionCodes: exceptions.map((exception) => exception.code), exceptions, ...changes });
  // Another invoice on the same PO is approved while the request waits, so it now uses up quantity.
  const approveOther = (id: string) =>
    repository.setDecision(id, 'approved', {
      approvalId: 'APR-0099',
      decision: 'approved',
      decidedBy: 'Ana Pop',
      decidedAt: '2026-11-18T09:30:00.000Z',
      note: 'Approved in approval APR-0099.',
    });
  const note = () => repository.getInvoice('INV-9001')?.decision?.note ?? '';

  it('holds when the same code turns up on a line the approver did not see', () => {
    // INV-9001 bills 10 of the 6 received on line 1 and 5 of the 10 on line 2: only line 1 is short when it is sent.
    repository = new ErpRepository(erp(invoice('INV-9001', [line(1, 10), line(2, 5)]), invoice('INV-9002', [line(2, 10)])));
    const record = seen([{ code: 'QUANTITY_NOT_RECEIVED', lineNo: 1, excess: 4 }]);
    // Then INV-9002 takes the 10 received on line 2, so line 2 of INV-9001 is short as well.
    approveOther('INV-9002');
    expect(apply(record)).toMatchObject({ result: 'held', invoice: { status: 'on_hold' } });
    expect(note()).toMatch(/QUANTITY_NOT_RECEIVED on line 2/);
    expect(note()).toMatch(/not approved for payment/i);
  });

  it('holds when the price variance on a line has grown since the approver saw it', () => {
    repository = new ErpRepository(erp(invoice('INV-9001', [line(1, 5, 1400)])));
    // The approver saw a 3% variance (0.30 per unit); matching now finds 40% (4.00 per unit).
    expect(apply(seen([{ code: 'PRICE_VARIANCE', lineNo: 1, excess: 30 }]))).toMatchObject({ result: 'held' });
    expect(note()).toMatch(/PRICE_VARIANCE on line 1/);
  });

  it('holds when the quantity over the PO has grown since the approver saw it', () => {
    repository = new ErpRepository(erp(invoice('INV-9001', [line(2, 21)]), invoice('INV-9002', [line(2, 10)])));
    // Sent at 1 over the 20 ordered; once INV-9002's 10 are approved it is 11 over.
    const record = seen([{ code: 'QUANTITY_EXCEEDS_PO', lineNo: 2, excess: 1 }]);
    approveOther('INV-9002');
    expect(apply(record)).toMatchObject({ result: 'held' });
    expect(note()).toMatch(/QUANTITY_EXCEEDS_PO on line 2/);
  });

  it.each([
    ['unchanged', 4],
    ['smaller now than when the approver saw them', 7],
  ])('approves when every exception is one the approver saw, %s', (_, excess) => {
    repository = new ErpRepository(erp(invoice('INV-9001', [line(1, 10), line(2, 5)])));
    expect(apply(seen([{ code: 'QUANTITY_NOT_RECEIVED', lineNo: 1, excess }]))).toMatchObject({
      result: 'approved',
      invoice: { status: 'approved' },
    });
    expect(note()).toMatch(/overrid.*QUANTITY_NOT_RECEIVED/);
  });

  it('holds, and says why, when the request does not record what the approver saw', () => {
    repository = new ErpRepository(erp(invoice('INV-9001', [line(1, 10)])));
    // Requests raised before this check carry exception codes only.
    const outcome = apply(seen([], { exceptionCodes: ['QUANTITY_NOT_RECEIVED'], exceptions: undefined }));
    expect(outcome).toMatchObject({ result: 'held', invoice: { status: 'on_hold' } });
    expect(note()).toMatch(/does not record/);
    expect(note()).toMatch(/QUANTITY_NOT_RECEIVED on line 1/);
    expect(note()).toMatch(/approval again/);
  });

  it('still approves an invoice that now passes matching, even without that record', () => {
    repository = new ErpRepository(erp(invoice('INV-9001', [line(1, 6)])));
    const outcome = apply(seen([], { exceptionCodes: ['QUANTITY_NOT_RECEIVED'], exceptions: undefined }));
    expect(outcome).toMatchObject({ result: 'approved' });
    expect(note()).toMatch(/passes three-way matching/);
  });
});
