// Applying a person's decision to the ERP invoice, without HTTP: the re-check, the note and idempotency.
import { beforeEach, describe, expect, it } from 'vitest';
import { applyDecision } from '../src/approvals/decisions.js';
import type { ApprovalRecord } from '../src/approvals/store.js';
import { ErpRepository } from '../src/erp/repository.js';

let repository: ErpRepository;

beforeEach(async () => {
  repository = await ErpRepository.fromFile(new URL('../data/erp-sample.json', import.meta.url));
});

const approval = (changes: Partial<ApprovalRecord> = {}): ApprovalRecord => ({
  id: 'APR-0001',
  invoiceId: 'INV-1003',
  status: 'approved',
  exceptionCodes: ['PRICE_VARIANCE'],
  comment: 'ok',
  decidedBy: 'Ana Pop',
  decidedAt: '2026-11-18T10:00:00.000Z',
  createdAt: '2026-11-18T09:00:00.000Z',
  ...changes,
});

describe('applyDecision', () => {
  it('approves an invoice whose exceptions are the ones the person saw, and says which it overrides', () => {
    const outcome = applyDecision(repository, approval());
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
    applyDecision(repository, approval());
    expect(repository.listInvoices().find((invoice) => invoice.id === 'INV-1003')?.status).toBe('approved');
    // INV-1003 now counts as settled, so it uses up quantity on PO-2026-0002.
    expect(repository.priorInvoices(repository.getInvoice('INV-1005')!).map((invoice) => invoice.id)).toContain('INV-1003');
  });

  it('rejects an invoice', () => {
    const outcome = applyDecision(repository, approval({ status: 'rejected' }));
    expect(outcome).toMatchObject({ result: 'rejected', invoice: { status: 'rejected', decision: { decision: 'rejected' } } });
  });

  it('holds an approval when matching now finds an exception the person did not see', () => {
    const outcome = applyDecision(repository, approval({ exceptionCodes: [] }));
    expect(outcome).toMatchObject({ result: 'held', invoice: { status: 'on_hold' } });
    const note = repository.getInvoice('INV-1003')?.decision?.note ?? '';
    expect(note).toMatch(/PRICE_VARIANCE/);
    expect(note).toMatch(/not approved for payment/i);
  });

  it('respects the server price tolerance in the re-check', () => {
    // At 10% the 8% price variance is within tolerance: the invoice now matches, so approving it is safe.
    const outcome = applyDecision(repository, approval({ exceptionCodes: [] }), 10);
    expect(outcome).toMatchObject({ result: 'approved' });
    expect(repository.getInvoice('INV-1003')?.decision?.note).toMatch(/passes three-way matching/);
  });

  it('applies each approval request once', () => {
    applyDecision(repository, approval());
    const before = structuredClone(repository.getInvoice('INV-1003'));
    expect(applyDecision(repository, approval())).toMatchObject({ result: 'unchanged' });
    expect(applyDecision(repository, approval({ status: 'rejected' }))).toMatchObject({ result: 'unchanged' });
    expect(repository.getInvoice('INV-1003')).toEqual(before);
  });

  it('applies a new approval request after an earlier one was held', () => {
    applyDecision(repository, approval({ exceptionCodes: [] }));
    expect(applyDecision(repository, approval({ id: 'APR-0002' }))).toMatchObject({ result: 'approved' });
  });

  it.each(['INV-1001', 'INV-1007'])('never changes an invoice that is already settled (%s)', (invoiceId) => {
    const status = repository.getInvoice(invoiceId)?.status;
    expect(applyDecision(repository, approval({ invoiceId, status: 'rejected' }))).toMatchObject({ result: 'unchanged' });
    expect(repository.getInvoice(invoiceId)?.status).toBe(status);
  });

  it('refuses a request that is not decided', () => {
    expect(() => applyDecision(repository, approval({ status: 'pending' }))).toThrow(/pending/);
  });
});
