// Sends approval requests to the approvals platform (github.com/RomulusMirauta/approvals-platform),
// where an approver sees them in the dashboard's exception queue. The server signs in as an agent account.
import { z } from 'zod';
import type { ExceptionCode } from '../erp/matching.js';
import type { ApprovalStore, NewApprovalRequest, SubmitResult } from './store.js';

export interface HttpApprovalStoreOptions {
  baseUrl: string;
  email: string;
  password: string;
  fetch?: typeof fetch;
}

export const SOURCE = 'erp-procurement-mcp';

// These point at possible fraud, so the approver should see them first.
const HIGH_PRIORITY: ReadonlySet<ExceptionCode> = new Set(['DUPLICATE_INVOICE', 'SUPPLIER_MISMATCH']);

// Only the fields this store reads. The response comes over the network, so it is checked, not trusted.
const LoginResponse = z.object({ token: z.string() });
const CreateResponse = z.object({
  created: z.boolean(),
  request: z.object({
    id: z.string(),
    status: z.string(),
    createdAt: z.string(),
    requester: z.object({ name: z.string() }),
    metadata: z.object({ requestedBy: z.string().optional() }).loose(),
  }),
});
const Problem = z.object({ title: z.string(), detail: z.string().optional() }).loose();

export class ApprovalsApiError extends Error {
  override name = 'ApprovalsApiError';
}

export class HttpApprovalStore implements ApprovalStore {
  private readonly baseUrl: string;
  private readonly fetch: typeof fetch;
  private token: string | undefined;

  constructor(private readonly options: HttpApprovalStoreOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  async submit(request: NewApprovalRequest): Promise<SubmitResult> {
    // The same code can occur on several invoice lines; the title and tags name each kind once.
    const kinds = [...new Set(request.exceptionCodes)];
    const body = {
      title: `${request.invoiceId}: ${kinds.join(', ')}`,
      description: request.reason,
      type: 'invoice_exception',
      priority: kinds.some((code) => HIGH_PRIORITY.has(code)) ? 'high' : 'normal',
      source: SOURCE,
      externalRef: request.invoiceId,
      amount: { amountMinor: request.invoiceTotal.amountMinor, currency: request.invoiceTotal.currency },
      tags: ['finance', ...kinds.map((code) => code.toLowerCase().replaceAll('_', '-'))],
      metadata: {
        exceptionCodes: request.exceptionCodes,
        requestedBy: request.requestedBy,
        supplier: request.supplierName,
      },
    };
    const { created, request: saved } = CreateResponse.parse(await this.post('/v1/requests', body));
    return {
      created,
      approval: {
        id: saved.id,
        invoiceId: request.invoiceId,
        reason: request.reason,
        exceptionCodes: request.exceptionCodes,
        // On a retry the API returns the request that was already pending: report who raised it originally.
        requestedBy: saved.metadata.requestedBy ?? saved.requester.name,
        status: 'pending',
        createdAt: new Date(saved.createdAt).toISOString(),
      },
    };
  }

  private async post(path: string, body: unknown, retryOn401 = true): Promise<unknown> {
    this.token ??= await this.login();
    const response = await this.send(path, body, this.token);
    // Tokens expire; sign in again once and retry.
    if (response.status === 401 && retryOn401) {
      this.token = undefined;
      return this.post(path, body, false);
    }
    return this.read(response, path);
  }

  private async login(): Promise<string> {
    const { email, password } = this.options;
    const response = await this.send('/v1/auth/login', { email, password });
    return LoginResponse.parse(await this.read(response, '/v1/auth/login')).token;
  }

  private async send(path: string, body: unknown, token?: string): Promise<Response> {
    try {
      return await this.fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      throw new ApprovalsApiError(`Approvals API at ${this.baseUrl} is unreachable: ${(error as Error).message}`);
    }
  }

  private async read(response: Response, path: string): Promise<unknown> {
    const json: unknown = await response.json().catch(() => undefined);
    if (response.ok) return json;
    const problem = Problem.safeParse(json);
    const detail = problem.success ? `${problem.data.title}${problem.data.detail ? `: ${problem.data.detail}` : ''}` : '';
    throw new ApprovalsApiError(`Approvals API ${path} failed with ${response.status}${detail && ` (${detail})`}`);
  }
}
