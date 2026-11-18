// Approval requests: the human-in-the-loop step. An agent finds an exception, a person decides.
// Two stores implement the same interface: in memory (the default, for trying the server out) and the
// approvals platform's REST API (http-store.ts), where people review requests in a dashboard.
import type { ExceptionCode } from '../erp/matching.js';
import type { Money } from '../erp/money.js';

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
  requestedBy: string;
  // Context for the approver; the in-memory store doesn't need it.
  invoiceTotal: Money;
  supplierName: string;
}

export interface SubmitResult {
  created: boolean;
  approval: ApprovalRequest;
}

export interface ApprovalStore {
  // Creates a pending request, or returns the one already pending for this invoice: agents retry.
  submit(request: NewApprovalRequest): Promise<SubmitResult>;
}

export class InMemoryApprovalStore implements ApprovalStore {
  private readonly requests: ApprovalRequest[] = [];

  constructor(private readonly now: () => Date = () => new Date()) {}

  async submit({ invoiceId, reason, exceptionCodes, requestedBy }: NewApprovalRequest): Promise<SubmitResult> {
    const pending = this.requests.find((request) => request.invoiceId === invoiceId && request.status === 'pending');
    if (pending) return { created: false, approval: pending };

    const approval: ApprovalRequest = {
      id: `APR-${String(this.requests.length + 1).padStart(4, '0')}`,
      invoiceId,
      reason,
      exceptionCodes,
      requestedBy,
      status: 'pending',
      createdAt: this.now().toISOString(),
    };
    this.requests.push(approval);
    return { created: true, approval };
  }

  list(): readonly ApprovalRequest[] {
    return this.requests;
  }
}
