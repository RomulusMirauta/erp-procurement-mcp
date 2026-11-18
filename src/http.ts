// Streamable HTTP transport, for running the server remotely. Stateless: every POST gets its own MCP server and
// transport, so no session lives between requests and the same handler runs on a long-lived Node process or on
// a serverless function (api/mcp.js). The ERP data and the approval store are loaded once and shared.
import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { loadServerDeps } from './config.js';
import { RateLimiter, type RateLimitOptions } from './rate-limit.js';
import { createServer, type ServerDeps } from './server.js';

export type HttpHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

export interface HttpOptions {
  deps: ServerDeps;
  // Shared secret the client sends as "Authorization: Bearer <token>".
  authToken: string;
  // Browser origins allowed to call /mcp. Unset: any Origin passes, and the token is the only check.
  allowedOrigins?: string[];
  // The defaults below suit an agent; tests pass small values.
  maxBodyBytes?: number;
  rateLimit?: RateLimitOptions;
  requestTimeoutMs?: number;
}

const MIN_TOKEN_LENGTH = 32;
// A tool call is a few hundred bytes of JSON-RPC, so 1 MiB leaves plenty of room and still stops a client from
// making the server buffer a huge body. Larger bodies get 413.
const MAX_BODY_BYTES = 1024 * 1024;
// A burst of 60 requests, then one per second, per client. An agent checking a batch of invoices stays well within it.
const RATE_LIMIT: RateLimitOptions = { capacity: 60, refillPerSecond: 1 };
// Covers a slow upload as well as a slow tool. The longest tool call, request_approval against the approvals API,
// gives up after 3 attempts of at most 10 s plus the waits between them, so 60 s leaves it room to finish.
const REQUEST_TIMEOUT_MS = 60_000;

export function readAuthToken(env: NodeJS.ProcessEnv = process.env): string {
  const token = env.MCP_AUTH_TOKEN ?? '';
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new Error(`MCP_AUTH_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters, for example: openssl rand -hex 32`);
  }
  return token;
}

export function readAllowedOrigins(env: NodeJS.ProcessEnv = process.env): string[] | undefined {
  const origins = (env.MCP_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  return origins.length > 0 ? origins : undefined;
}

// Hashing first gives both sides the same length, which timingSafeEqual requires, and hides the token's length.
const digest = (value: string) => createHash('sha256').update(value).digest();

function isAuthorized(header: string | undefined, expected: Buffer): boolean {
  const match = /^Bearer (.+)$/.exec(header ?? '');
  return match?.[1] !== undefined && timingSafeEqual(digest(match[1]), expected);
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers }).end(JSON.stringify(body));
}

// Errors on /mcp use the JSON-RPC error shape, like the SDK's own responses.
const rpcError = (message: string, code = -32000) => ({ jsonrpc: '2.0', error: { code, message }, id: null });

export function createHttpHandler({
  deps,
  authToken,
  allowedOrigins,
  maxBodyBytes = MAX_BODY_BYTES,
  rateLimit = RATE_LIMIT,
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
}: HttpOptions): HttpHandler {
  const expectedToken = digest(authToken);
  const limiter = new RateLimiter(rateLimit);

  return async (req, res) => {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');
    // For load balancers and uptime checks; says nothing about the data, so it needs no token.
    if (pathname === '/health') return sendJson(res, 200, { status: 'ok' });
    if (pathname !== '/mcp') return sendJson(res, 404, { error: 'Not found' });

    // DNS rebinding: a malicious page can make a browser send requests to a server on the user's network.
    // Browsers always send Origin on such requests; clients like Claude Code don't send it at all.
    const origin = req.headers.origin;
    if (origin && allowedOrigins && !allowedOrigins.includes(origin)) {
      return sendJson(res, 403, rpcError(`Origin ${origin} is not allowed`));
    }

    // Before the token check, so guessing tokens is throttled too. Keyed by IP address, not by token: every client
    // shares the one token, so a per-token bucket would be a single bucket for all of them. With per-user OAuth
    // tokens, the user would be the better key. X-Forwarded-For is not used: any client can set it to anything.
    const limit = limiter.take(req.socket.remoteAddress ?? 'unknown');
    if (!limit.allowed) {
      return sendJson(res, 429, rpcError('Too many requests'), { 'Retry-After': String(limit.retryAfterSeconds) });
    }

    if (!isAuthorized(req.headers.authorization, expectedToken)) {
      return sendJson(res, 401, rpcError('Missing or invalid bearer token'), { 'WWW-Authenticate': 'Bearer' });
    }

    // Stateless mode has no session: no GET stream for server-initiated messages and nothing to DELETE.
    if (req.method !== 'POST') {
      return sendJson(res, 405, rpcError('Method not allowed. This server is stateless: use POST.'), { Allow: 'POST' });
    }

    const server = createServer(deps);
    // The transport reads the body and answers 413 once it passes maxRequestBodySize, without buffering the rest.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, maxRequestBodySize: maxBodyBytes });
    // A client that sends its body slowly, or a tool that hangs, must not hold the request open forever.
    const timeout = setTimeout(() => {
      if (!res.headersSent) sendJson(res, 503, rpcError('Request timed out'));
      else res.destroy();
    }, requestTimeoutMs);
    res.on('close', () => {
      clearTimeout(timeout);
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error('Error handling MCP request:', error);
      if (!res.headersSent) sendJson(res, 500, rpcError('Internal server error', -32603));
    }
  };
}

// Reads everything from the environment and refuses to start on a missing or weak token.
export async function createHttpHandlerFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ handler: HttpHandler; summary: string }> {
  const authToken = readAuthToken(env);
  const allowedOrigins = readAllowedOrigins(env);
  const { deps, summary } = await loadServerDeps(env);
  return {
    handler: createHttpHandler({ deps, authToken, allowedOrigins }),
    summary: `${summary}, allowed origins: ${allowedOrigins?.join(' ') ?? 'any'}`,
  };
}
