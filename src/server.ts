// The MCP layer: tool definitions only. Business rules live in src/erp and src/approvals,
// so they can be tested without MCP and reused by other transports or a REST API.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { ApprovalStore } from './approvals/store.js';
import { DEFAULT_PRICE_TOLERANCE_PCT, matchInvoice, type MatchContext } from './erp/matching.js';
import { lineTotalMinor, money } from './erp/money.js';
import type { ErpRepository } from './erp/repository.js';
import { InvoiceStatusSchema, type Invoice } from './erp/schema.js';

export const SERVER_NAME = 'erp-procurement';
export const SERVER_VERSION = '0.1.0';

export interface ServerDeps {
  repository: ErpRepository;
  approvals: ApprovalStore;
  // A finance policy set by whoever runs the server, not a tool argument: an agent must not be able to
  // loosen the rules it is checking against.
  priceTolerancePct?: number;
}

// Only invoices still waiting for a decision can be sent for one.
const AWAITING_DECISION = new Set<Invoice['status']>(['received', 'on_hold']);

const invoiceId = z
  .string()
  .regex(/^INV-\d{4}$/, 'Invoice ids look like INV-1001')
  .describe('Internal invoice id, for example INV-1001');

// Tool results are JSON text, which every MCP client can show to the model.
const ok = (data: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });

// Expected failures are returned as tool errors, not thrown, so the model reads them and can correct itself.
const fail = (message: string): CallToolResult => ({ isError: true, content: [{ type: 'text', text: message }] });

const unknownInvoice = (id: string) => fail(`Invoice ${id} does not exist. Use search_invoices to find valid ids.`);

function matchContext(repository: ErpRepository, invoice: Invoice): MatchContext {
  const purchaseOrder = repository.getPurchaseOrder(invoice.poId);
  // The repository's integrity checks guarantee this; failing loudly beats matching against nothing.
  if (!purchaseOrder) throw new Error(`${invoice.id} references missing purchase order ${invoice.poId}`);
  return {
    purchaseOrder,
    receipts: repository.receiptsFor(purchaseOrder.id),
    priorInvoices: repository.priorInvoices(invoice),
  };
}

export function createServer({
  repository,
  approvals,
  priceTolerancePct = DEFAULT_PRICE_TOLERANCE_PCT,
}: ServerDeps): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.registerTool(
    'search_invoices',
    {
      title: 'Search invoices',
      description:
        'Lists supplier invoices from the ERP, soonest due first. Filter by status, supplier (id or part of the name) ' +
        'and due date. Use it to find invoices to check before payment.',
      inputSchema: {
        status: InvoiceStatusSchema.optional().describe('Only invoices with this status'),
        supplier: z.string().min(1).optional().describe('Supplier id (SUP-001) or part of the supplier name'),
        dueBefore: z.iso.date().optional().describe('Only invoices due on or before this date (YYYY-MM-DD)'),
        limit: z.number().int().min(1).max(50).default(20).describe('Page size, 1-50'),
        offset: z.number().int().min(0).default(0).describe('Number of results to skip'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ status, supplier, dueBefore, limit, offset }) => {
      const needle = supplier?.toLowerCase();
      const matches = repository
        .listInvoices()
        .filter((invoice) => !status || invoice.status === status)
        .filter((invoice) => !dueBefore || invoice.dueDate <= dueBefore)
        .filter((invoice) => {
          if (!needle) return true;
          const name = repository.getSupplier(invoice.supplierId)?.name.toLowerCase() ?? '';
          return invoice.supplierId.toLowerCase() === needle || name.includes(needle);
        })
        .toSorted((a, b) => a.dueDate.localeCompare(b.dueDate) || a.id.localeCompare(b.id));

      return ok({
        total: matches.length,
        offset,
        limit,
        items: matches.slice(offset, offset + limit).map((invoice) => ({
          id: invoice.id,
          supplierInvoiceNumber: invoice.supplierInvoiceNumber,
          supplier: { id: invoice.supplierId, name: repository.getSupplier(invoice.supplierId)?.name },
          poId: invoice.poId,
          invoiceDate: invoice.invoiceDate,
          dueDate: invoice.dueDate,
          status: invoice.status,
          total: money(lineTotalMinor(invoice.lines), invoice.currency),
        })),
      });
    },
  );

  server.registerTool(
    'get_invoice',
    {
      title: 'Get invoice',
      description:
        'Returns one invoice with its lines, the supplier, the purchase order it bills and the goods receipts for that order.',
      inputSchema: { invoiceId },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ invoiceId: id }) => {
      const invoice = repository.getInvoice(id);
      if (!invoice) return unknownInvoice(id);
      const purchaseOrder = repository.getPurchaseOrder(invoice.poId);
      return ok({
        invoice: { ...invoice, total: money(lineTotalMinor(invoice.lines), invoice.currency) },
        supplier: repository.getSupplier(invoice.supplierId),
        purchaseOrder: purchaseOrder && {
          ...purchaseOrder,
          total: money(lineTotalMinor(purchaseOrder.lines), purchaseOrder.currency),
        },
        goodsReceipts: repository.receiptsFor(invoice.poId),
      });
    },
  );

  server.registerTool(
    'match_invoice',
    {
      title: 'Three-way match an invoice',
      description:
        'Checks an invoice against its purchase order and goods receipts: supplier, currency, duplicate invoice number, ' +
        'lines on the PO, unit price within the tolerance set by finance, quantity ordered and quantity received. ' +
        'Returns "matched" or a list of exceptions.',
      inputSchema: { invoiceId },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ invoiceId: id }) => {
      const invoice = repository.getInvoice(id);
      if (!invoice) return unknownInvoice(id);
      return ok({
        ...matchInvoice(invoice, matchContext(repository, invoice), priceTolerancePct),
        invoiceTotal: money(lineTotalMinor(invoice.lines), invoice.currency),
      });
    },
  );

  server.registerTool(
    'request_approval',
    {
      title: 'Request human approval',
      description:
        'Sends an invoice that failed three-way matching to a person for approval. Only received or on-hold invoices ' +
        'with exceptions are accepted. Calling it again for the same invoice returns the pending request instead of ' +
        'creating a second one.',
      inputSchema: {
        invoiceId,
        reason: z
          .string()
          .trim()
          .min(10)
          .max(1000)
          .describe('Why a person should look at this invoice, in plain language, for the approver'),
        requestedBy: z.string().trim().min(1).max(100).default('ai-agent').describe('Who is asking, for the audit trail'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ invoiceId: id, reason, requestedBy }) => {
      const invoice = repository.getInvoice(id);
      if (!invoice) return unknownInvoice(id);
      if (!AWAITING_DECISION.has(invoice.status)) {
        return fail(`Invoice ${id} is ${invoice.status}; only received or on-hold invoices can be sent for approval.`);
      }

      const existing = approvals.findPending(id);
      if (existing) return ok({ created: false, approval: existing });

      // The server re-checks the invoice itself instead of trusting the agent's claim that it failed.
      const match = matchInvoice(invoice, matchContext(repository, invoice), priceTolerancePct);
      if (match.status === 'matched') {
        return fail(`Invoice ${id} passes three-way matching, so it needs no approval.`);
      }
      const approval = approvals.create({
        invoiceId: id,
        reason,
        requestedBy,
        exceptionCodes: match.exceptions.map((exception) => exception.code),
      });
      return ok({ created: true, approval });
    },
  );

  return server;
}
