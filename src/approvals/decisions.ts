// Applying a person's decision to the ERP invoice: the other half of the human-in-the-loop. A rejection rejects the
// invoice. An approval approves it for payment only if the exceptions are still the ones the person saw: the server
// re-runs the match, as request_approval does, because things change while a request waits (another invoice on the
// same PO gets approved and uses up its quantity). Anything new holds the invoice, with a note saying why.
import { DEFAULT_PRICE_TOLERANCE_PCT, isAwaitingDecision, matchInvoice, type ExceptionCode } from '../erp/matching.js';
import type { ErpRepository } from '../erp/repository.js';
import type { Invoice, InvoiceDecision } from '../erp/schema.js';
import type { ApprovalRecord } from './store.js';

export type DecisionOutcome =
  | { result: 'approved' | 'rejected' | 'held'; invoice: Invoice }
  | { result: 'unchanged'; reason: string; invoice: Invoice };

const list = (codes: readonly ExceptionCode[]) => [...new Set(codes)].join(', ');

// Idempotent: each approval request is applied once, and a repeat returns 'unchanged'. Notes are the server's own
// words, built from ids and exception codes only: the approver's comment stays in the approval record.
export function applyDecision(
  repository: ErpRepository,
  approval: ApprovalRecord,
  priceTolerancePct = DEFAULT_PRICE_TOLERANCE_PCT,
): DecisionOutcome {
  if (approval.status !== 'approved' && approval.status !== 'rejected') {
    throw new Error(`Approval ${approval.id} is ${approval.status}; only a decision can be applied`);
  }
  const invoice = repository.getInvoice(approval.invoiceId);
  if (!invoice) throw new Error(`Invoice ${approval.invoiceId} does not exist`);
  if (invoice.decision?.approvalId === approval.id) {
    return { result: 'unchanged', reason: `Approval ${approval.id} was already applied.`, invoice };
  }
  // A paid, approved or rejected invoice has had its decision; a late or stray one must not reopen it.
  if (!isAwaitingDecision(invoice)) {
    return { result: 'unchanged', reason: `Invoice ${invoice.id} is ${invoice.status}, not awaiting a decision.`, invoice };
  }

  const decision = (note: string): InvoiceDecision => ({
    approvalId: approval.id,
    decision: approval.status as 'approved' | 'rejected',
    decidedBy: approval.decidedBy ?? 'unknown',
    decidedAt: new Date(approval.decidedAt ?? Date.now()).toISOString(),
    note,
  });

  if (approval.status === 'rejected') {
    const updated = repository.setDecision(invoice.id, 'rejected', decision(`Rejected in approval ${approval.id}.`));
    return { result: 'rejected', invoice: updated };
  }

  const match = matchInvoice(invoice, repository.matchContext(invoice), priceTolerancePct);
  const found = match.exceptions.map((exception) => exception.code);
  const unseen = found.filter((code) => !approval.exceptionCodes.includes(code));
  if (unseen.length > 0) {
    const seen = approval.exceptionCodes.length > 0 ? list(approval.exceptionCodes) : 'no exceptions';
    const note =
      `Approval ${approval.id} covered ${seen}, but three-way matching now also finds ${list(unseen)}. ` +
      'Not approved for payment: send it for approval again.';
    return { result: 'held', invoice: repository.setDecision(invoice.id, 'on_hold', decision(note)) };
  }

  const note =
    found.length === 0
      ? `Approved in approval ${approval.id}; the invoice now passes three-way matching.`
      : `Approved in approval ${approval.id}, overriding ${list(found)}.`;
  return { result: 'approved', invoice: repository.setDecision(invoice.id, 'approved', decision(note)) };
}
