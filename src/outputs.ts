// What each tool returns, as zod schemas. The server publishes them as the tools' outputSchema, and both the
// SDK server and the client check every structuredContent against them. `satisfies` ties the schemas to the
// types the business code already returns (Money, MatchResult, ApprovalRequest), so the two can't drift apart.
import { z } from 'zod';
import type { ApprovalRequest } from './approvals/store.js';
import { EXCEPTION_CODES, type MatchResult } from './erp/matching.js';
import type { Money } from './erp/money.js';
import { CurrencySchema, GoodsReceiptSchema, InvoiceSchema, PurchaseOrderSchema, SupplierSchema } from './erp/schema.js';

const MoneySchema = z.object({
  amountMinor: z.number().int(),
  currency: CurrencySchema,
  formatted: z.string(),
}) satisfies z.ZodType<Money>;

const ExceptionCodeSchema = z.enum(EXCEPTION_CODES);

const MatchResultSchema = z.object({
  invoiceId: z.string(),
  poId: z.string(),
  status: z.enum(['matched', 'exception']),
  priceTolerancePct: z.number(),
  exceptions: z.array(
    z.object({
      code: ExceptionCodeSchema,
      lineNo: z.number().int().optional(),
      message: z.string(),
    }),
  ),
}) satisfies z.ZodType<MatchResult>;

const ApprovalRequestSchema = z.object({
  id: z.string(),
  invoiceId: z.string(),
  reason: z.string(),
  exceptionCodes: z.array(ExceptionCodeSchema),
  requestedBy: z.string(),
  status: z.literal('pending'),
  createdAt: z.iso.datetime(),
}) satisfies z.ZodType<ApprovalRequest>;

export const SearchInvoicesOutputSchema = z.object({
  total: z.number().int(),
  offset: z.number().int(),
  limit: z.number().int(),
  items: z.array(
    InvoiceSchema.pick({ id: true, supplierInvoiceNumber: true, poId: true, invoiceDate: true, dueDate: true, status: true }).extend({
      supplier: z.object({ id: z.string(), name: z.string().optional() }),
      total: MoneySchema,
    }),
  ),
});

export const GetInvoiceOutputSchema = z.object({
  invoice: InvoiceSchema.extend({ total: MoneySchema }),
  supplier: SupplierSchema,
  purchaseOrder: PurchaseOrderSchema.extend({ total: MoneySchema }),
  goodsReceipts: z.array(GoodsReceiptSchema),
});

export const MatchInvoiceOutputSchema = MatchResultSchema.extend({ invoiceTotal: MoneySchema });

export const RequestApprovalOutputSchema = z.object({
  created: z.boolean(),
  approval: ApprovalRequestSchema,
});

export type SearchInvoicesOutput = z.infer<typeof SearchInvoicesOutputSchema>;
export type GetInvoiceOutput = z.infer<typeof GetInvoiceOutputSchema>;
export type MatchInvoiceOutput = z.infer<typeof MatchInvoiceOutputSchema>;
export type RequestApprovalOutput = z.infer<typeof RequestApprovalOutputSchema>;
