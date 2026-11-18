// Sends approval requests to the approvals platform (github.com/RomulusMirauta/approvals-platform),
// where an approver sees them in the dashboard's exception queue, and reads back what the approver decided.
// The server signs in as an agent account, which sees only the requests it raised.
import { z } from 'zod';
import { EXCEPTION_CODES, type ExceptionCode } from '../erp/matching.js';
import { APPROVAL_STATUSES, type ApprovalQuery, type ApprovalRecord, type ApprovalStore, type NewApprovalRequest, type SubmitResult } from './store.js';

export interface HttpApprovalStoreOptions {
  baseUrl: string;
  email: string;
  password: string;
  fetch?: typeof fetch;
  // Tests pass one that returns at once and records the delays.
  sleep?: (ms: number) => Promise<void>;
}

export const SOURCE = 'erp-procurement-mcp';

// Retrying is safe here because every call is idempotent. Signing in and reading have no side effect, and the platform
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
// GET /v1/requests (RequestPage) and GET /v1/requests/:id (RequestDetail) in the platform's contract.
const RequestSummary = z.object({ id: z.string(), source: z.string(), externalRef: z.string().nullable() });
const RequestPage = z.object({ items: z.array(RequestSummary) });
const RequestDetail = RequestSummary.extend({
  status: z.enum(APPROVAL_STATUSES),
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
  metadata: z.object({ exceptionCodes: z.array(z.string()).optional() }).loose(),
  decisions: z.array(z.object({ approver: z.object({ name: z.string() }), comment: z.string() })),
});
const Problem = z.object({ title: z.string(), detail: z.string().optional() }).loose();

// Request ids on the platform are UUIDs. Anything else can't be one, and must not reach the URL path.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The list's q filter matches by substring, and an invoice has few requests: one page is plenty.
const PAGE_SIZE = 100;
const KNOWN_CODES: ReadonlySet<string> = new Set(EXCEPTION_CODES);

const iso = (value: string) => new Date(value).toISOString();

export class ApprovalsApiError extends Error {
  override name = 'ApprovalsApiError';
  // A private field with a getter, not an own property, so two errors with the same message still compare equal.
  readonly #status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.#status = status;
  }

  // The HTTP status the API answered with; undefined when it was unreachable.
  get status(): number | undefined {
    return this.#status;
  }
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

  async find({ invoiceId, approvalId }: ApprovalQuery): Promise<ApprovalRecord | undefined> {
    let id = approvalId;
    if (id === undefined) {
      const query = new URLSearchParams({ source: SOURCE, q: invoiceId, pageSize: String(PAGE_SIZE) });
      const { items } = RequestPage.parse(await this.call('GET', `/v1/requests?${query}`));
      // Newest first, so the first exact match is the latest request for this invoice.
      id = items.find((item) => item.source === SOURCE && item.externalRef === invoiceId)?.id;
    }
    if (id === undefined || !UUID.test(id)) return undefined;

    let detail: z.infer<typeof RequestDetail>;
    try {
      detail = RequestDetail.parse(await this.call('GET', `/v1/requests/${id}`));
    } catch (error) {
      // Someone else's request answers 404 too, so ids of requests this account can't see leak nothing.
      if (error instanceof ApprovalsApiError && error.status === 404) return undefined;
      throw error;
    }
    if (detail.source !== SOURCE || detail.externalRef !== invoiceId) return undefined;

    const decision = detail.decisions.at(-1);
    return {
      id: detail.id,
      invoiceId,
      status: detail.status,
      // Only codes this server knows: metadata is free-form on the platform.
      exceptionCodes: (detail.metadata.exceptionCodes ?? []).filter((code): code is ExceptionCode => KNOWN_CODES.has(code)),
      comment: decision ? decision.comment : null,
      decidedBy: decision ? decision.approver.name : null,
      decidedAt: detail.decidedAt === null ? null : iso(detail.decidedAt),
      createdAt: iso(detail.createdAt),
    };
  }

  private post(path: string, body: unknown): Promise<unknown> {
    return this.call('POST', path, body);
  }

  private async call(method: 'GET' | 'POST', path: string, body?: unknown, retryOn401 = true): Promise<unknown> {
    this.token ??= await this.login();
    const response = await this.send(method, path, body, this.token);
    // Tokens expire; sign in again once and retry.
    if (response.status === 401 && retryOn401) {
      this.token = undefined;
      return this.call(method, path, body, false);
    }
    return this.read(response, path);
  }

  private async login(): Promise<string> {
    const { email, password } = this.options;
    const response = await this.send('POST', '/v1/auth/login', { email, password });
    return LoginResponse.parse(await this.read(response, '/v1/auth/login')).token;
  }

  // Retries network errors, timeouts, 429 and 5xx (see MAX_ATTEMPTS for why that is safe). The last response
  // is returned even if it failed, so read() reports it; a 401 goes back to post(), which signs in again.
  private async send(method: 'GET' | 'POST', path: string, body?: unknown, token?: string): Promise<Response> {
    for (let attempt = 1; ; attempt++) {
      let response: Response | undefined;
      try {
        response = await this.fetch(`${this.baseUrl}${path}`, {
          method,
          headers: {
            ...(body !== undefined && { 'content-type': 'application/json' }),
            ...(token && { authorization: `Bearer ${token}` }),
          },
          ...(body !== undefined && { body: JSON.stringify(body) }),
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
    throw new ApprovalsApiError(`Approvals API ${path} failed with ${response.status}${detail && ` (${detail})`}`, response.status);
  }
}
