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

### Example session

> **You:** Check the invoices from Somes that are still waiting and flag anything wrong.
>
> **Claude:** *calls `search_invoices` with supplier "somes", then `match_invoice` for each.*
> INV-1004 matches (the grease is 1.5% above the PO price, inside the 2% tolerance). INV-1005 bills 150 bearings, but only 120 have arrived so far. I've sent it for approval as APR-0001.

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

## How it's built

```
src/
  index.ts              entry point: loads data, serves over stdio
  server.ts             MCP layer: the four tool definitions, nothing else
  erp/schema.ts         data model as zod schemas; types are inferred from them
  erp/repository.ts     loads and validates the data, integrity checks, lookups
  erp/matching.ts       three-way matching rules (pure function)
  erp/money.ts          money in minor units and formatting
  approvals/store.ts    approval requests (in memory for now)
tests/
  matching.test.ts      the rules, case by case, including tolerance boundaries
  repository.test.ts    schema and integrity checks
  server.test.ts        every tool through a real MCP client (in-memory transport)
  stdio.test.ts         the server as a child process over stdio, like Claude runs it
```

### Design decisions

- **Business rules don't know about MCP.** `matching.ts` is a pure function with no SDK imports. The same rules could sit behind a REST endpoint or a queue consumer, and the tests exercise them directly.
- **Money is stored as integers in minor units** (bani, cents). `0.1 + 0.2 !== 0.3` in JavaScript, and an invoice total can't drift by a cent.
- **The data is validated like a database would validate it.** zod checks the shape and types. `checkIntegrity` then checks what foreign keys and unique constraints would: every PO points to a real supplier, receipts only receive lines that are on the PO, and ids are unique.
- **Expected failures are tool results, not exceptions.** An unknown invoice id returns `isError: true` with a message that tells the model what to do next (use `search_invoices`). The model reads it and corrects itself, instead of the call failing with a protocol error.
- **The server doesn't trust the agent.** `request_approval` re-runs the match itself and records the exception codes it found, not the ones the agent claimed. A matched invoice can't be sent for approval.
- **The agent can't loosen the rules.** The price tolerance is finance policy, set when the server starts. It is deliberately not a tool argument, so a prompt-injected invoice can't talk the agent into a looser check.
- **Only approved and paid invoices use up quantity.** Pending invoices, including wrong ones, don't block a correct invoice. Once one of two competing invoices is approved, the other fails its next check. For duplicates, approved and paid invoices always count as earlier, so a backdated copy of a paid invoice is still caught.
- **Writes are idempotent.** Agents retry. A second `request_approval` for the same invoice returns the pending request instead of creating a duplicate. The store is in memory, so this holds within one server process. The approvals platform will enforce it with a unique constraint in the database.
- **Tool annotations** (`readOnlyHint`, `idempotentHint`) tell the client which calls are safe to run without asking the user.
- **stdio transport, logs on stderr.** stdout carries the protocol, so a stray `console.log` would corrupt it.

## Development

```bash
npm run dev         # run from source with tsx
npm test            # Vitest: unit, MCP client and stdio tests
npm run lint        # ESLint with typescript-eslint
npm run typecheck   # tsc, strict mode
npm run build       # compile to dist/
```

CI runs lint, typecheck, tests and the build on Node 22 and 24 (Ubuntu), and on Node 24 (Windows).

## Roadmap

- Send approval requests to the approvals platform (in progress: Node.js API, Postgres, React dashboard) through its REST API, instead of keeping them in memory.
- Streamable HTTP transport with authentication, for running the server remotely.
- Typed tool outputs (`outputSchema` and `structuredContent`).

## License

[MIT](LICENSE)
