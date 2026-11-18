// Approval requests: the human-in-the-loop step. An agent finds an exception, a person decides.
// This in-memory store lives as long as the server process. The approvals platform will replace it with an API.
import type { ExceptionCode } from '../erp/matching.js';

export interface ApprovalRequest {
  id: string;
  invoiceId: string;
  reason: string;
  exceptionCodes: ExceptionCode[];
  requestedBy: string;
  status: 'pending';
  createdAt: string;
}

export type NewApprovalRequest = Pick<ApprovalRequest, 'invoiceId' | 'reason' | 'exceptionCodes' | 'requestedBy'>;

export interface ApprovalStore {
  findPending(invoiceId: string): ApprovalRequest | undefined;
  create(request: NewApprovalRequest): ApprovalRequest;
  list(): readonly ApprovalRequest[];
}

export class InMemoryApprovalStore implements ApprovalStore {
  private readonly requests: ApprovalRequest[] = [];

  constructor(private readonly now: () => Date = () => new Date()) {}

  findPending(invoiceId: string): ApprovalRequest | undefined {
    return this.requests.find((request) => request.invoiceId === invoiceId && request.status === 'pending');
  }

  create(request: NewApprovalRequest): ApprovalRequest {
    const created: ApprovalRequest = {
      ...request,
      id: `APR-${String(this.requests.length + 1).padStart(4, '0')}`,
      status: 'pending',
      createdAt: this.now().toISOString(),
    };
    this.requests.push(created);
    return created;
  }

  list(): readonly ApprovalRequest[] {
    return this.requests;
  }
}
