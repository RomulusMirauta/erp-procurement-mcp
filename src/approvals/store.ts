// Approval requests: the human-in-the-loop step. An agent finds an exception, a person decides.
// Two stores implement the same interface: in memory (the default, for trying the server out) and the
// approvals platform's REST API (http-store.ts), where people review requests in a dashboard.
import type { ExceptionCode, ExceptionDetail } from '../erp/matching.js';
import type { Money } from '../erp/money.js';

// The approvals platform's request statuses. A person approves or rejects; the requester can cancel.
export const APPROVAL_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];
export type DecisionValue = 'approved' | 'rejected';

export interface ApprovalRequest {
  id: string;
  invoiceId: string;
  reason: string;
  exceptionCodes: ExceptionCode[];
  requestedBy: string;
  status: 'pending';
  createdAt: string;
}

export interface NewApprovalRequest {
  invoiceId: string;
  reason: string;
  exceptionCodes: ExceptionCode[];
  // The same exceptions per code and line, with how far past the rule each one is (exceptionDetails). An approval is
  // checked against them before it is applied.
  exceptions: ExceptionDetail[];
  requestedBy: string;
  // Context for the approver; the in-memory store doesn't need it.
  invoiceTotal: Money;
  supplierName: string;
}

export interface SubmitResult {
  created: boolean;
  approval: ApprovalRequest;
}

// A request as it stands now, with the decision once there is one.
export interface ApprovalRecord {
  id: string;
  invoiceId: string;
  status: ApprovalStatus;
  // The exceptions the server found when the request was raised: what the person saw when deciding.
  exceptionCodes: ExceptionCode[];
  // The same per code and line, with how far past the rule each was. Undefined when the request doesn't record it
  // (raised before this server recorded it, or unreadable): an approval of it then holds the invoice.
  exceptions?: ExceptionDetail[];
  // The approver's comment and name, null until someone decides.
  comment: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
}

export interface ApprovalQuery {
  invoiceId: string;
  // A specific request; without it, the newest request for the invoice.
  approvalId?: string;
}

export interface DecisionRecord {
  approvalId: string;
  invoiceId: string;
  decision: DecisionValue;
  comment: string | null;
  decidedBy: string;
  decidedAt: string;
}

export interface ApprovalStore {
  // Creates a pending request, or returns the one already pending for this invoice: agents retry.
  submit(request: NewApprovalRequest): Promise<SubmitResult>;
  // The request for this invoice (the given one, or the newest), or undefined when there is none.
  // A request id that belongs to another invoice counts as none.
  find(query: ApprovalQuery): Promise<ApprovalRecord | undefined>;
  // Stores that keep decisions themselves record one that arrives by webhook. The approvals platform already
  // has it, so its store has no such method. Returns the request as it stands afterwards: a request that was
  // already decided keeps its first decision.
  recordDecision?(decision: DecisionRecord): Promise<ApprovalRecord | undefined>;
}

interface StoredRequest extends ApprovalRecord {
  reason: string;
  requestedBy: string;
}

// Copies, so a caller can't change the store's rows.
function toRecord(stored: StoredRequest): ApprovalRecord {
  const { id, invoiceId, status, exceptionCodes, exceptions, comment, decidedBy, decidedAt, createdAt } = stored;
  return {
    id,
    invoiceId,
    status,
    exceptionCodes: [...exceptionCodes],
    ...(exceptions && { exceptions: exceptions.map((exception) => ({ ...exception })) }),
    comment,
    decidedBy,
    decidedAt,
    createdAt,
  };
}

function toRequest(stored: StoredRequest): ApprovalRequest {
  const { id, invoiceId, reason, exceptionCodes, requestedBy, createdAt } = stored;
  return { id, invoiceId, reason, exceptionCodes: [...exceptionCodes], requestedBy, status: 'pending', createdAt };
}

export class InMemoryApprovalStore implements ApprovalStore {
  private readonly requests: StoredRequest[] = [];

  constructor(private readonly now: () => Date = () => new Date()) {}

  async submit({ invoiceId, reason, exceptionCodes, exceptions, requestedBy }: NewApprovalRequest): Promise<SubmitResult> {
    const pending = this.requests.find((request) => request.invoiceId === invoiceId && request.status === 'pending');
    if (pending) return { created: false, approval: toRequest(pending) };

    const stored: StoredRequest = {
      id: `APR-${String(this.requests.length + 1).padStart(4, '0')}`,
      invoiceId,
      reason,
      exceptionCodes,
      exceptions: exceptions.map((exception) => ({ ...exception })),
      requestedBy,
      status: 'pending',
      comment: null,
      decidedBy: null,
      decidedAt: null,
      createdAt: this.now().toISOString(),
    };
    this.requests.push(stored);
    return { created: true, approval: toRequest(stored) };
  }

  async find(query: ApprovalQuery): Promise<ApprovalRecord | undefined> {
    const stored = this.lookup(query);
    return stored && toRecord(stored);
  }

  async recordDecision({ approvalId, invoiceId, decision, comment, decidedBy, decidedAt }: DecisionRecord) {
    const stored = this.lookup({ invoiceId, approvalId });
    if (stored?.status === 'pending') Object.assign(stored, { status: decision, comment, decidedBy, decidedAt });
    return stored && toRecord(stored);
  }

  list(): readonly ApprovalRecord[] {
    return this.requests.map(toRecord);
  }

  private lookup({ invoiceId, approvalId }: ApprovalQuery): StoredRequest | undefined {
    if (approvalId) return this.requests.find((request) => request.id === approvalId && request.invoiceId === invoiceId);
    return this.requests.findLast((request) => request.invoiceId === invoiceId);
  }
}
