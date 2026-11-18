// The ERP data model. The zod schemas are the single source of truth: types are inferred from them,
// and the same schemas validate the data file when the server starts.
import { z } from 'zod';

// Money is stored in minor units (bani, cents) as integers, and all money arithmetic stays in integers.
const minorUnits = z.number().int().nonnegative();
const isoDate = z.iso.date();
export const CurrencySchema = z.enum(['RON', 'EUR']);

export const SupplierSchema = z.object({
  id: z.string().regex(/^SUP-\d{3}$/),
  name: z.string().min(1),
  country: z.string().length(2),
  currency: CurrencySchema,
  paymentTermsDays: z.number().int().positive(),
});

export const PurchaseOrderSchema = z.object({
  id: z.string().regex(/^PO-\d{4}-\d{4}$/),
  supplierId: z.string(),
  orderDate: isoDate,
  currency: CurrencySchema,
  status: z.enum(['open', 'closed']),
  lines: z
    .array(
      z.object({
        lineNo: z.number().int().positive(),
        sku: z.string().min(1),
        description: z.string().min(1),
        quantity: z.number().int().positive(),
        unitPriceMinor: minorUnits,
      }),
    )
    .min(1),
});

export const GoodsReceiptSchema = z.object({
  id: z.string().regex(/^GR-\d{4}$/),
  poId: z.string(),
  receivedDate: isoDate,
  lines: z
    .array(
      z.object({
        lineNo: z.number().int().positive(),
        quantityReceived: z.number().int().positive(),
      }),
    )
    .min(1),
});

export const InvoiceStatusSchema = z.enum(['received', 'on_hold', 'approved', 'rejected', 'paid']);

export const InvoiceSchema = z.object({
  id: z.string().regex(/^INV-\d{4}$/),
  supplierId: z.string(),
  poId: z.string(),
  // The number printed on the supplier's invoice. The same supplier must never send it twice.
  supplierInvoiceNumber: z.string().min(1),
  invoiceDate: isoDate,
  dueDate: isoDate,
  currency: CurrencySchema,
  status: InvoiceStatusSchema,
  lines: z
    .array(
      z.object({
        lineNo: z.number().int().positive(),
        description: z.string().min(1),
        quantity: z.number().int().positive(),
        unitPriceMinor: minorUnits,
      }),
    )
    .min(1),
});

export const ErpDataSchema = z.object({
  suppliers: z.array(SupplierSchema),
  purchaseOrders: z.array(PurchaseOrderSchema),
  goodsReceipts: z.array(GoodsReceiptSchema),
  invoices: z.array(InvoiceSchema),
});

export type Currency = z.infer<typeof CurrencySchema>;
export type Supplier = z.infer<typeof SupplierSchema>;
export type PurchaseOrder = z.infer<typeof PurchaseOrderSchema>;
export type GoodsReceipt = z.infer<typeof GoodsReceiptSchema>;
export type InvoiceStatus = z.infer<typeof InvoiceStatusSchema>;
export type Invoice = z.infer<typeof InvoiceSchema>;
export type ErpData = z.infer<typeof ErpDataSchema>;
