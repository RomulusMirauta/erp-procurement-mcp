// Applying a person's decision to the ERP invoice: the other half of the human-in-the-loop. A rejection rejects the
// invoice. An approval approves it for payment only if the exceptions are still the ones the person saw: the server
// re-runs the match, as request_approval does, because things change while a request waits (another invoice on the
// same PO gets approved and uses up its quantity). "The ones the person saw" means the same check on the same line,
// and no further past the rule than it was then: the same code on another line, a larger price variance or a larger
// over-bill is something the approver never agreed to. Anything else holds the invoice, with a note saying why.
import {
  DEFAULT_PRICE_TOLERANCE_PCT,
  exceptionDetails,
  isAwaitingDecision,
  matchInvoice,
  type ExceptionCode,
  type ExceptionDetail,
} from '../erp/matching.js';
import type { ErpRepository } from '../erp/repository.js';
import type { Invoice, InvoiceDecision } from '../erp/schema.js';
import type { ApprovalRecord } from './store.js';

export type DecisionOutcome =
  | { result: 'approved' | 'rejected' | 'held'; invoice: Invoice }
  | { result: 'unchanged' | 'ignored'; reason: string; invoice: Invoice };

export interface DecisionOptions {
  // The newest approval request for the invoice (ApprovalStore.find without an approval id). A decision on any other
  // request is ignored: a newer request replaced it, so the approver of the newer one decides.
  latestApprovalId: string | undefined;
  priceTolerancePct?: number;
}

const list = (codes: readonly ExceptionCode[]) => [...new Set(codes)].join(', ');
const label = ({ code, lineNo }: ExceptionDetail) => (lineNo === undefined ? code : `${code} on line ${lineNo}`);
const key = ({ code, lineNo }: ExceptionDetail) => `${code}:${lineNo ?? ''}`;
const HOLD = 'Not approved for payment: send it for approval again.';

// Idempotent: each approval request is applied once, and a repeat returns 'unchanged'. Notes are the server's own
// words, built from ids, exception codes and line numbers only: the approver's comment stays in the approval record.
export function applyDecision(
  repository: ErpRepository,
  approval: ApprovalRecord,
  { latestApprovalId, priceTolerancePct = DEFAULT_PRICE_TOLERANCE_PCT }: DecisionOptions,
): DecisionOutcome {
  if (approval.status !== 'approved' && approval.status !== 'rejected') {
    throw new Error(`Approval ${approval.id} is ${approval.status}; only a decision can be applied`);
  }
  const invoice = repository.getInvoice(approval.invoiceId);
  if (!invoice) throw new Error(`Invoice ${approval.invoiceId} does not exist`);
  if (invoice.decision?.approvalId === approval.id) {
    return { result: 'unchanged', reason: `Approval ${approval.id} was already applied.`, invoice };
  }
  // A late delivery for an older request (the sender retried it while the agent raised a new one) must not decide
  // for the newer request, which may cover different exceptions and is still waiting for its own approver.
  if (latestApprovalId !== approval.id) {
    return { result: 'ignored', reason: `Superseded: approval ${approval.id} is not the newest request for ${invoice.id}.`, invoice };
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
  const hold = (note: string): DecisionOutcome => ({
    result: 'held',
    invoice: repository.setDecision(invoice.id, 'on_hold', decision(`${note} ${HOLD}`)),
  });

  if (approval.status === 'rejected') {
    const updated = repository.setDecision(invoice.id, 'rejected', decision(`Rejected in approval ${approval.id}.`));
    return { result: 'rejected', invoice: updated };
  }

  const match = matchInvoice(invoice, repository.matchContext(invoice), priceTolerancePct);
  if (match.exceptions.length === 0) {
    const note = `Approved in approval ${approval.id}; the invoice now passes three-way matching.`;
    return { result: 'approved', invoice: repository.setDecision(invoice.id, 'approved', decision(note)) };
  }

  const found = exceptionDetails(match.exceptions);
  // Fail safe: without a record of what the approver saw, the approval can't be checked, so it doesn't count.
  if (!approval.exceptions) {
    return hold(
      `Approval ${approval.id} does not record which lines the approver saw or by how much (the request predates that ` +
        `record, or it can't be read), and three-way matching now finds ${found.map(label).join(', ')}.`,
    );
  }

  const seen = new Map(approval.exceptions.map((exception) => [key(exception), exception]));
  const changed = found.flatMap((exception) => {
    const before = seen.get(key(exception));
    if (!before) return [`${label(exception)} (not on the request)`];
    const grew = exception.excess !== undefined && (before.excess === undefined || exception.excess > before.excess);
    return grew ? [`${label(exception)} (larger than when it was sent)`] : [];
  });
  if (changed.length > 0) {
    const covered = approval.exceptions.length > 0 ? approval.exceptions.map(label).join(', ') : 'no exceptions';
    return hold(`Approval ${approval.id} covered ${covered}, but three-way matching now finds ${changed.join(', ')}.`);
  }

  const note = `Approved in approval ${approval.id}, overriding ${list(found.map((exception) => exception.code))}.`;
  return { result: 'approved', invoice: repository.setDecision(invoice.id, 'approved', decision(note)) };
}
