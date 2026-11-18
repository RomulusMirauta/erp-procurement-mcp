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
  // Tests pass one that returns at once and records the delays.
  sleep?: (ms: number) => Promise<void>;
}

export const SOURCE = 'erp-procurement-mcp';

// Retrying is safe here because both calls are idempotent. Signing in has no side effect, and the platform
// allows one pending request per (source, externalRef): a repeated POST /v1/requests returns the request the
// first attempt created instead of a duplicate, even if that attempt's response was lost on the way back.
const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 500;
// A tool call is waiting on this, so never sleep longer than this, whatever Retry-After says.
const MAX_DELAY_MS = 10_000;

// Worth another attempt: rate limited (429) or a server-side problem (5xx, e.g. the API's 503 while its
// database wakes up). Any other 4xx means the request itself is wrong and would fail the same way again.
const isRetryableStatus = (status: number) => status === 429 || status >= 500;

// Retry-After is either seconds or an HTTP date. Without it: exponential backoff (500 ms, 1 s) with jitter, so
// many agents failing at the same moment don't all come back at the same moment.
function retryDelay(attempt: number, response?: Response): number {
  const header = response?.headers.get('retry-after');
  if (header) {
    const ms = /^\d+$/.test(header) ? Number(header) * 1000 : Date.parse(header) - Date.now();
    if (!Number.isNaN(ms)) return Math.min(Math.max(ms, 0), MAX_DELAY_MS);
  }
  const backoff = BASE_DELAY_MS * 2 ** (attempt - 1);
  return Math.min(backoff / 2 + (Math.random() * backoff) / 2, MAX_DELAY_MS);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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
  private readonly sleep: (ms: number) => Promise<void>;
  private token: string | undefined;

  constructor(private readonly options: HttpApprovalStoreOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetch = options.fetch ?? globalThis.fetch;
    this.sleep = options.sleep ?? sleep;
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

  // Retries network errors, timeouts, 429 and 5xx (see MAX_ATTEMPTS for why that is safe). The last response
  // is returned even if it failed, so read() reports it; a 401 goes back to post(), which signs in again.
  private async send(path: string, body: unknown, token?: string): Promise<Response> {
    for (let attempt = 1; ; attempt++) {
      let response: Response | undefined;
      try {
        response = await this.fetch(`${this.baseUrl}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10_000),
        });
      } catch (error) {
        if (attempt === MAX_ATTEMPTS) {
          throw new ApprovalsApiError(
            `Approvals API at ${this.baseUrl} is unreachable after ${MAX_ATTEMPTS} attempts: ${(error as Error).message}`,
          );
        }
      }
      if (response && (!isRetryableStatus(response.status) || attempt === MAX_ATTEMPTS)) return response;
      // Discard the failed response's body, which would otherwise keep its connection busy until garbage collected.
      await response?.body?.cancel();
      await this.sleep(retryDelay(attempt, response));
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
