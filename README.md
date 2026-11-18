# ERP Procurement MCP Server

[![CI](https://github.com/RomulusMirauta/erp-procurement-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/RomulusMirauta/erp-procurement-mcp/actions/workflows/ci.yml)

An [MCP](https://modelcontextprotocol.io) server that lets an AI agent work through supplier invoices in an ERP: find them, check each one against its purchase order and goods receipts (**three-way matching**), and send the ones that fail to a person for approval.

It runs over a mock ERP (a validated JSON file), so it works out of the box. The ERP sits behind one repository class, so a real ERP API can replace it without touching the tools.

## Why three-way matching

Accounts payable teams don't pay an invoice just because it arrived. They check it against:

1. the **purchase order**: was this ordered, from this supplier, at this price?
2. the **goods receipts**: did it actually arrive, and was it already billed?

Most invoices pass, so this check suits an agent. The ones that don't pass need a human decision. That's the human-in-the-loop flow: the agent does the checking, a person decides on the exceptions, and the server makes sure the agent can't skip the rules.

## Tools

| Tool | What it does | Read-only |
|---|---|---|
| `search_invoices` | Lists invoices, soonest due first. Filters: status, supplier (id or part of the name), due date. Paginated. | yes |
| `get_invoice` | One invoice with its supplier, purchase order and goods receipts. | yes |
| `match_invoice` | Runs the three-way match and returns `matched` or the list of exceptions. | yes |
| `request_approval` | Sends a failed invoice to a person. Re-checks the invoice itself, refuses invoices that match or are already paid, and returns the existing request on a retry. | no |

### Exceptions the match finds

| Code | Meaning |
|---|---|
| `SUPPLIER_MISMATCH` | The invoice comes from a different supplier than the PO. |
| `CURRENCY_MISMATCH` | The invoice currency differs from the PO (prices are then not compared). |
| `DUPLICATE_INVOICE` | The same supplier already sent an invoice with this number. |
| `LINE_NOT_ON_PO` | The invoice bills something that was never ordered. |
| `PRICE_VARIANCE` | A unit price is outside the tolerance (±2% by default, set by `ERP_PRICE_TOLERANCE_PCT`). |
| `QUANTITY_EXCEEDS_PO` | More is billed than was ordered, counting what approved and paid invoices already billed. |
| `QUANTITY_NOT_RECEIVED` | More is billed than was received, counting what approved and paid invoices already billed. |

The sample data in [data/erp-sample.json](data/erp-sample.json) has one invoice for each case (INV-1001 to INV-1009), and the tests check all of them.

### A real session

Recorded with Claude Code in headless mode (`claude -p`) against the bundled sample data, unedited apart from shortening the tool results.

**Prompt:** *Check the invoices from Somes that are still waiting for a decision and flag anything wrong. Send the ones that need a person to approval, with a clear reason.*

Tool calls Claude made:

```text
search_invoices   { supplier: "Somes", status: "received" }   → INV-1004, INV-1005
search_invoices   { supplier: "Somes", status: "on_hold" }    → INV-1003
match_invoice     { invoiceId: "INV-1003" }                   → exception: PRICE_VARIANCE (line 2)
match_invoice     { invoiceId: "INV-1004" }                   → matched
match_invoice     { invoiceId: "INV-1005" }                   → exception: QUANTITY_NOT_RECEIVED (line 1)
request_approval  { invoiceId: "INV-1003", reason: "Line 2 unit price is 8% higher than the PO price
                    (tolerance is ±2%). Please verify whether Somes communicated a price increase
                    or if this is a billing error before approving 3,602.40 RON." } → APR-0001
request_approval  { invoiceId: "INV-1005", reason: "Line 1 invoices 150 units but only 120 were
                    received. Somes is billing for 30 units we haven't received yet. Please confirm
                    whether a delivery is pending or if the quantity should be corrected before
                    approving 2,775.00 RON." } → APR-0002
```

Claude's answer:

> | Invoice | Amount | Due | Match result | Action |
> |---|---|---|---|---|
> | **INV-1004** (SIC-88502) | 1,644.30 RON | 23 Nov | Clean match | Ready to pay, no issues. |
> | **INV-1003** (SIC-88213) | 3,602.40 RON | 28 Oct *(overdue)* | Price variance: line 2 is 8% above PO (limit ±2%) | Sent for approval (APR-0001) |
> | **INV-1005** (SIC-88340) | 2,775.00 RON | 9 Nov *(overdue)* | Quantity mismatch: invoiced 150 units, only 120 received | Sent for approval (APR-0002) |
>
> - **INV-1003** looks like either an unauthorised price increase or a billing error.
> - **INV-1005** bills for 30 units we never received: could be a pending delivery or overbilling.
> - **INV-1004** is clean and can proceed to payment.

The agent did the checking; the two decisions went to a person.

## Use it with Claude

Requires Node.js 22.12 or newer.

```bash
git clone https://github.com/RomulusMirauta/erp-procurement-mcp.git
cd erp-procurement-mcp
npm ci
npm run build
```

**Claude Code:**

```bash
claude mcp add erp-procurement -- node /absolute/path/to/erp-procurement-mcp/dist/index.js
```

**Claude Desktop:** add this to `claude_desktop_config.json` and restart Claude Desktop:

```json
{
  "mcpServers": {
    "erp-procurement": {
      "command": "node",
      "args": ["/absolute/path/to/erp-procurement-mcp/dist/index.js"]
    }
  }
}
```

**MCP Inspector**, to call the tools by hand: `npm run inspect`.

To use your own data, set `ERP_DATA_FILE` to the absolute path of a JSON file with the same shape as the sample. To change the price tolerance, set `ERP_PRICE_TOLERANCE_PCT` (see [.env.example](.env.example)). The server checks both at startup and refuses to start on bad values.

### Send approvals to a real dashboard

By default, approval requests stay in memory. Point the server at the [approvals platform](https://github.com/RomulusMirauta/approvals-platform) ([live demo](https://approvals-platform-eta.vercel.app)) and they land in its exception queue, where an approver accepts or rejects them:

```bash
claude mcp add erp-procurement   -e APPROVALS_API_URL=http://localhost:3000   -e APPROVALS_API_EMAIL=erp-agent@example.com   -e APPROVALS_API_PASSWORD=demo-password   -- node /absolute/path/to/erp-procurement-mcp/dist/index.js
```

The server signs in with an account that has the `agent` role, sends each request with the invoice amount, supplier and exception codes, and marks duplicates and supplier mismatches as high priority. The platform allows one pending request per invoice, so a retry returns the existing request, even across server restarts.

## Run it remotely (HTTP)

The same tools can be served over [Streamable HTTP](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#streamable-http), so the server can run on another machine and several clients can share it. Every client must send a shared secret as a bearer token.

```bash
export MCP_AUTH_TOKEN=$(openssl rand -hex 32)
npm run build
npm run start:http      # POST http://127.0.0.1:3000/mcp, GET /health
```

| Variable | |
|---|---|
| `MCP_AUTH_TOKEN` | Required. Clients send it as `Authorization: Bearer <token>`. At least 32 characters; the server refuses to start otherwise. |
| `MCP_ALLOWED_ORIGINS` | Optional. Comma-separated browser origins allowed to call `/mcp`. A request with any other `Origin` header gets `403`. |
| `HOST`, `PORT` | Optional. Default `127.0.0.1` and `3000`. Set `HOST=0.0.0.0` to accept connections from other machines, behind HTTPS. |

`ERP_DATA_FILE`, `ERP_PRICE_TOLERANCE_PCT` and the `APPROVALS_API_*` variables work exactly as with stdio: both entry points share one startup module (`src/config.ts`).

**Claude Code:**

```bash
claude mcp add --transport http erp-procurement https://your-host.example.com/mcp \
  --header "Authorization: Bearer $MCP_AUTH_TOKEN"
```

How it works:

- **Stateless.** Each `POST /mcp` gets a fresh MCP server and transport (`sessionIdGenerator: undefined`); the ERP data and the approval store are loaded once and shared. Nothing ties a client to one process, so it also runs on serverless platforms. `GET` and `DELETE` answer `405`: there is no session to stream to or to end.
- **Authentication** is a shared secret, compared in constant time (both sides are hashed, then compared with `timingSafeEqual`), so response timing doesn't leak how much of a guess was right. A missing or wrong token gets `401` with `WWW-Authenticate: Bearer`. This is a simple first step: the production path is [OAuth 2.1](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization), as the MCP authorization spec describes, with per-user tokens that can be scoped and revoked.
- **DNS rebinding.** The MCP spec asks servers to validate the `Origin` header, because a web page can make a browser send requests to servers on the user's network. With `MCP_ALLOWED_ORIGINS` set, unknown origins are refused before the token is checked. Clients like Claude Code don't send `Origin`, so they are not affected. Without the allowlist, the token is still required, and a page can't know it.
- **`/health`** needs no token and returns only `{"status":"ok"}`, for uptime checks.

**Vercel (not deployed yet).** [api/mcp.js](api/mcp.js) wraps the same handler as a serverless function and [vercel.json](vercel.json) maps `/mcp` and `/health` to it. Set `MCP_AUTH_TOKEN` (and optionally the other variables) in the project settings and deploy. Use `APPROVALS_API_URL` there: the in-memory approval store lives in one function instance, so requests would be lost between instances.

## How it's built

```
src/
  index.ts              entry point: serves over stdio
  http-main.ts          entry point: serves over Streamable HTTP (node:http)
  http.ts               HTTP handler: bearer token, Origin check, one stateless MCP server per request
  config.ts             startup shared by both entry points: environment, data, approval store
  server.ts             MCP layer: the four tool definitions, nothing else
  outputs.ts            what each tool returns, as zod schemas (published as outputSchema)
  erp/schema.ts         data model as zod schemas; types are inferred from them
  erp/repository.ts     loads and validates the data, integrity checks, lookups
  erp/matching.ts       three-way matching rules (pure function)
  erp/money.ts          money in minor units and formatting
  approvals/store.ts    approval store interface, in-memory implementation
  approvals/http-store.ts  sends approval requests to the approvals platform's REST API
tests/
  matching.test.ts      the rules, case by case, including tolerance boundaries
  repository.test.ts    schema and integrity checks
  server.test.ts        every tool through a real MCP client (in-memory transport)
  http-store.test.ts    the approvals API client against a fake fetch: sign-in, retry, errors
  stdio.test.ts         the server as a child process over stdio, like Claude runs it
  http.test.ts          the HTTP server on a free port: SDK client, 401, 403, 405, /health
api/mcp.js              Vercel serverless function wrapping the HTTP handler
```

### Design decisions

- **Business rules don't know about MCP.** `matching.ts` is a pure function with no SDK imports. The same rules could sit behind a REST endpoint or a queue consumer, and the tests exercise them directly.
- **Money is stored as integers in minor units** (bani, cents). `0.1 + 0.2 !== 0.3` in JavaScript, and an invoice total can't drift by a cent.
- **The data is validated like a database would validate it.** zod checks the shape and types. `checkIntegrity` then checks what foreign keys and unique constraints would: every PO points to a real supplier, receipts only receive lines that are on the PO, and ids are unique.
- **Expected failures are tool results, not exceptions.** An unknown invoice id returns `isError: true` with a message that tells the model what to do next (use `search_invoices`). The model reads it and corrects itself, instead of the call failing with a protocol error.
- **The server doesn't trust the agent.** `request_approval` re-runs the match itself and records the exception codes it found, not the ones the agent claimed. A matched invoice can't be sent for approval.
- **The agent can't loosen the rules.** The price tolerance is finance policy, set when the server starts. It is deliberately not a tool argument, so a prompt-injected invoice can't talk the agent into a looser check.
- **Only approved and paid invoices use up quantity.** Pending invoices, including wrong ones, don't block a correct invoice. Once one of two competing invoices is approved, the other fails its next check. For duplicates, approved and paid invoices always count as earlier, so a backdated copy of a paid invoice is still caught.
- **Writes are idempotent.** Agents retry. A second `request_approval` for the same invoice returns the pending request instead of creating a duplicate. With the in-memory store this holds within one server process; with the approvals platform, a partial unique index in Postgres enforces it.
- **Typed outputs.** Each tool publishes an `outputSchema` and returns `structuredContent`, so a client gets checked data instead of parsing text. The schemas reuse the data model and are tied to the business types (`Money`, `MatchResult`, `ApprovalRequest`) with `satisfies`, so a change on one side fails the typecheck. The same JSON is still sent as text for clients that only read text, and errors stay plain text.
- **Tool annotations** (`readOnlyHint`, `idempotentHint`) tell the client which calls are safe to run without asking the user.
- **Logs on stderr.** Over stdio, stdout carries the protocol, so a stray `console.log` would corrupt it. The HTTP entry logs to stderr too, for consistency.

## Development

```bash
npm run dev         # run from source with tsx (dev:http for the HTTP entry)
npm test            # Vitest: unit, MCP client, stdio and HTTP tests
npm run lint        # ESLint with typescript-eslint
npm run typecheck   # tsc, strict mode
npm run build       # compile to dist/
```

CI runs lint, typecheck, tests and the build on Node 22 and 24 (Ubuntu), and on Node 24 (Windows).

## Roadmap

- OAuth 2.1 for the HTTP transport, per the MCP authorization spec, replacing the shared bearer token.

## License

[MIT](LICENSE)
