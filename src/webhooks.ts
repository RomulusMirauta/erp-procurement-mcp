// POST /webhooks/approvals: the approvals platform tells this server what a person decided, and the decision is
// applied to the ERP invoice. Deliveries follow the Standard Webhooks spec (standardwebhooks.com): the platform signs
// `${webhook-id}.${webhook-timestamp}.${raw body}` with HMAC-SHA256 and a shared secret, so a valid signature proves
// the body came from the platform unchanged, and the timestamp limits how long a captured delivery can be replayed.
// The route needs no MCP token: the signature is the authentication.
//
// The sender retries anything but 2xx (at-least-once delivery), so the answer is 4xx only when the request can't be
// trusted (headers, signature, replay window, size), 503 when the approvals API is unreachable and a retry can help,
// and 200 for everything else, including events this server ignores.
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { applyDecision } from './approvals/decisions.js';
import { ApprovalsApiError, SOURCE } from './approvals/http-store.js';
import type { ServerDeps } from './server.js';

const SECRET_PREFIX = 'whsec_';
// The spec asks for 24 to 64 random bytes; the platform refuses fewer than 24 as well.
const MIN_SECRET_BYTES = 24;
// How far webhook-timestamp may be from this server's clock, either way.
const TOLERANCE_SECONDS = 5 * 60;
// A decision event is well under 2 KiB; 64 KiB leaves room for long comments and still stops a huge body.
const MAX_BODY_BYTES = 64 * 1024;
// Webhook ids already processed. The set lives in this process's memory, like the rate limit: it is lost on restart,
// and each instance of a multi-instance deployment has its own. Applying a decision is idempotent per approval
// request as well (see applyDecision), so a repeat that slips past the set still changes nothing.
const MAX_REMEMBERED_IDS = 10_000;
const MAX_ID_LENGTH = 256;

export type WebhookHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

export interface WebhookOptions {
  deps: ServerDeps;
  // The decoded key bytes (readWebhookSecret).
  secret: Buffer;
  maxBodyBytes?: number;
  // Milliseconds, like Date.now(); tests move the clock.
  now?: () => number;
}

// APPROVALS_WEBHOOK_SECRET=whsec_<base64>. Unset: undefined, and the route is not registered. Set but malformed:
// throws at startup, without echoing the value.
export function readWebhookSecret(env: NodeJS.ProcessEnv = process.env): Buffer | undefined {
  const secret = env.APPROVALS_WEBHOOK_SECRET;
  if (!secret) return undefined;
  const encoded = secret.startsWith(SECRET_PREFIX) ? secret.slice(SECRET_PREFIX.length) : '';
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new Error(`APPROVALS_WEBHOOK_SECRET must be "${SECRET_PREFIX}" followed by base64, as the approvals platform prints it`);
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length < MIN_SECRET_BYTES) {
    throw new Error(`APPROVALS_WEBHOOK_SECRET must decode to at least ${MIN_SECRET_BYTES} bytes`);
  }
  return bytes;
}

export interface SignedDelivery {
  id: string;
  timestamp: string;
  body: Buffer;
  // The webhook-signature header: space-separated `v1,<base64>` entries. During a secret rotation the sender lists
  // several; one match is enough. Other versions are skipped.
  signature: string;
  secret: Buffer;
}

export function verifyWebhookSignature({ id, timestamp, body, signature, secret }: SignedDelivery): boolean {
  const expected = createHmac('sha256', secret)
    .update(`${id}.${timestamp}.`)
    .update(body)
    .digest();
  let valid = false;
  for (const entry of signature.split(' ')) {
    const [version, encoded] = entry.split(',', 2);
    if (version !== 'v1' || !encoded) continue;
    const given = Buffer.from(encoded, 'base64');
    // timingSafeEqual needs equal lengths; the length of a valid signature is public (32 bytes).
    // Every entry is compared, so timing doesn't say which one matched.
    if (given.length === expected.length && timingSafeEqual(given, expected)) valid = true;
  }
  return valid;
}

// The envelope and the decision payload, with only the fields used here; the platform may add more.
const Envelope = z.object({ id: z.string(), type: z.string(), createdAt: z.string(), payload: z.unknown() });
const HANDLED_TYPES: Record<string, 'approved' | 'rejected'> = {
  'request.approved': 'approved',
  'request.rejected': 'rejected',
};
const DecisionPayload = z.object({
  requestId: z.string().min(1).max(100),
  source: z.string(),
  externalRef: z.string().nullable(),
  decision: z.enum(['approved', 'rejected']),
  // The platform caps comments at 2000 characters; get_approval_status publishes up to 5000.
  comment: z.string().max(5000).nullish(),
  // The approver's user id on the platform; actor carries their name.
  decidedBy: z.string().min(1).max(200),
  decidedAt: z.iso.datetime({ offset: true }),
  actor: z.object({ name: z.string().max(200) }).loose().optional(),
});

type Answer = { status: number; body: Record<string, unknown>; headers?: Record<string, string> };

const answer = (status: number, body: Record<string, unknown>, headers?: Record<string, string>): Answer => ({ status, body, headers });
const ignored = (reason: string) => answer(200, { status: 'ignored', reason });

// Reads the raw bytes, up to the limit: the signature covers exactly what was sent, so the body is not parsed first.
// Past the limit it stops keeping chunks and resolves at once; the rest is read and dropped, so the client still
// gets its 413 instead of a reset connection.
function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer | undefined> {
  if (Number(req.headers['content-length'] ?? 0) > maxBytes) return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) resolve(undefined);
      else chunks.push(chunk);
    });
    req.on('end', () => resolve(size > maxBytes ? undefined : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const header = (req: IncomingMessage, name: string) => {
  const value = req.headers[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
};

export function createWebhookHandler({ deps, secret, maxBodyBytes = MAX_BODY_BYTES, now = Date.now }: WebhookOptions): WebhookHandler {
  const processed = new Set<string>();
  const remember = (id: string) => {
    processed.add(id);
    // A Set keeps insertion order, so the first entry is the oldest.
    if (processed.size > MAX_REMEMBERED_IDS) processed.delete(processed.values().next().value as string);
  };

  async function handle(req: IncomingMessage): Promise<Answer> {
    if (req.method !== 'POST') return answer(405, { error: 'Method not allowed' }, { Allow: 'POST' });

    const id = header(req, 'webhook-id');
    const timestamp = header(req, 'webhook-timestamp');
    const signature = header(req, 'webhook-signature');
    if (!id || !timestamp || !signature) {
      return answer(400, { error: 'webhook-id, webhook-timestamp and webhook-signature are required' });
    }
    if (id.length > MAX_ID_LENGTH || !/^\d{1,12}$/.test(timestamp)) {
      return answer(400, { error: 'webhook-id is too long or webhook-timestamp is not unix seconds' });
    }

    const body = await readBody(req, maxBodyBytes);
    if (!body) return answer(413, { error: `Body over ${maxBodyBytes} bytes` });

    // Checked before the signature is computed: cheap, and the timestamp is covered by the signature anyway.
    if (Math.abs(now() / 1000 - Number(timestamp)) > TOLERANCE_SECONDS) {
      return answer(401, { error: 'webhook-timestamp is outside the 5 minute window' });
    }
    if (!verifyWebhookSignature({ id, timestamp, body, signature, secret })) {
      return answer(401, { error: 'Invalid signature' });
    }

    // From here on the delivery is authentic.
    if (processed.has(id)) return answer(200, { status: 'duplicate' });
    const result = await applyEvent(body);
    // Not remembered on 5xx, so the sender's retry applies it.
    if (result.status < 500) remember(id);
    return result;
  }

  async function applyEvent(body: Buffer): Promise<Answer> {
    let json: unknown;
    try {
      json = JSON.parse(body.toString('utf8'));
    } catch {
      return ignored('Body is not JSON');
    }
    const envelope = Envelope.safeParse(json);
    if (!envelope.success) return ignored('Body is not an event { id, type, createdAt, payload }');
    const expected = HANDLED_TYPES[envelope.data.type];
    if (!expected) return ignored('Only request.approved and request.rejected are handled');
    const parsed = DecisionPayload.safeParse(envelope.data.payload);
    if (!parsed.success) return ignored('Payload is not a decision');
    const payload = parsed.data;
    if (payload.decision !== expected) return ignored('Event type and decision disagree');
    if (payload.source !== SOURCE) return ignored(`Only requests from ${SOURCE} are handled`);

    // Ids only from here: externalRef is checked against the ERP before it is used or echoed.
    const invoiceId = payload.externalRef ?? '';
    const invoice = /^INV-\d{4}$/.test(invoiceId) ? deps.repository.getInvoice(invoiceId) : undefined;
    if (!invoice) return ignored('Unknown invoice');

    const { approvals, repository, priceTolerancePct } = deps;
    let approval;
    try {
      approval = await approvals.find({ invoiceId, approvalId: payload.requestId });
      if (approval?.status === 'pending' && approvals.recordDecision) {
        approval = await approvals.recordDecision({
          approvalId: approval.id,
          invoiceId,
          decision: payload.decision,
          comment: payload.comment ?? null,
          decidedBy: payload.actor?.name ?? payload.decidedBy,
          decidedAt: new Date(payload.decidedAt).toISOString(),
        });
      }
    } catch (error) {
      if (!(error instanceof ApprovalsApiError)) throw error;
      console.error('Approvals webhook: cannot read the request from the approvals API:', error.message);
      return answer(503, { error: 'Approvals API unavailable, retry later' }, { 'Retry-After': '30' });
    }
    if (!approval) return ignored('Unknown approval request');
    // The store of record must agree: a request already decided the other way keeps its first decision.
    if (approval.status !== payload.decision) return ignored(`Approval request is ${approval.status}`);

    const outcome = applyDecision(repository, approval, priceTolerancePct);
    return answer(200, { status: 'applied', result: outcome.result, invoiceId, invoiceStatus: outcome.invoice.status });
  }

  return async (req, res) => {
    let result: Answer;
    try {
      result = await handle(req);
    } catch (error) {
      console.error('Error handling approvals webhook:', error);
      result = answer(500, { error: 'Internal server error' });
    }
    if (res.headersSent) return;
    // An unread body (413, or an early 4xx) is discarded rather than left in the socket.
    if (!req.readableEnded) req.resume();
    res.writeHead(result.status, { 'Content-Type': 'application/json', ...result.headers }).end(JSON.stringify(result.body));
  };
}
