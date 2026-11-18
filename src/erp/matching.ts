// Three-way matching: an invoice is paid only when it agrees with the purchase order (what was ordered,
// at what price) and the goods receipts (what actually arrived). Anything else is an exception for a human.
import type { GoodsReceipt, Invoice, PurchaseOrder } from './schema.js';

export type ExceptionCode =
  | 'SUPPLIER_MISMATCH'
  | 'CURRENCY_MISMATCH'
  | 'DUPLICATE_INVOICE'
  | 'LINE_NOT_ON_PO'
  | 'PRICE_VARIANCE'
  | 'QUANTITY_NOT_RECEIVED';

export interface MatchException {
  code: ExceptionCode;
  lineNo?: number;
  message: string;
}

export interface MatchResult {
  invoiceId: string;
  poId: string;
  status: 'matched' | 'exception';
  priceTolerancePct: number;
  exceptions: MatchException[];
}

export interface MatchContext {
  purchaseOrder: PurchaseOrder;
  receipts: readonly GoodsReceipt[];
  // Invoices issued before this one that still count, from any supplier and any PO.
  priorInvoices: readonly Invoice[];
}

export const DEFAULT_PRICE_TOLERANCE_PCT = 2;

const sumQuantity = <T>(rows: readonly T[], quantity: (row: T) => number) => rows.reduce((sum, row) => sum + quantity(row), 0);

export function matchInvoice(
  invoice: Invoice,
  { purchaseOrder: po, receipts, priorInvoices }: MatchContext,
  priceTolerancePct = DEFAULT_PRICE_TOLERANCE_PCT,
): MatchResult {
  const exceptions: MatchException[] = [];

  if (invoice.supplierId !== po.supplierId) {
    exceptions.push({
      code: 'SUPPLIER_MISMATCH',
      message: `Invoice is from ${invoice.supplierId}, but ${po.id} was placed with ${po.supplierId}.`,
    });
  }
  const sameCurrency = invoice.currency === po.currency;
  if (!sameCurrency) {
    exceptions.push({
      code: 'CURRENCY_MISMATCH',
      message: `Invoice is in ${invoice.currency}, but ${po.id} is in ${po.currency}. Prices were not compared.`,
    });
  }
  const duplicate = priorInvoices.find(
    (other) => other.supplierId === invoice.supplierId && other.supplierInvoiceNumber === invoice.supplierInvoiceNumber,
  );
  if (duplicate) {
    exceptions.push({
      code: 'DUPLICATE_INVOICE',
      message: `Supplier invoice number ${invoice.supplierInvoiceNumber} was already booked as ${duplicate.id}.`,
    });
  }

  const priorOnPo = priorInvoices.filter((other) => other.poId === po.id);
  for (const line of invoice.lines) {
    const poLine = po.lines.find((candidate) => candidate.lineNo === line.lineNo);
    if (!poLine) {
      exceptions.push({
        code: 'LINE_NOT_ON_PO',
        lineNo: line.lineNo,
        message: `Line ${line.lineNo} ("${line.description}") is not on ${po.id}.`,
      });
      continue;
    }

    if (sameCurrency) {
      const variancePct = ((line.unitPriceMinor - poLine.unitPriceMinor) / poLine.unitPriceMinor) * 100;
      if (Math.abs(variancePct) > priceTolerancePct) {
        exceptions.push({
          code: 'PRICE_VARIANCE',
          lineNo: line.lineNo,
          message: `Unit price differs from the PO by ${variancePct.toFixed(2)}% (tolerance ±${priceTolerancePct}%).`,
        });
      }
    }

    // Quantity check: what was received, minus what earlier invoices already billed, must cover this invoice.
    const received = sumQuantity(
      receipts.flatMap((receipt) => receipt.lines.filter((row) => row.lineNo === line.lineNo)),
      (row) => row.quantityReceived,
    );
    const alreadyInvoiced = sumQuantity(
      priorOnPo.flatMap((other) => other.lines.filter((row) => row.lineNo === line.lineNo)),
      (row) => row.quantity,
    );
    if (line.quantity > received - alreadyInvoiced) {
      exceptions.push({
        code: 'QUANTITY_NOT_RECEIVED',
        lineNo: line.lineNo,
        message: `Invoiced ${line.quantity}, but only ${received} received and ${alreadyInvoiced} already invoiced.`,
      });
    }
  }

  return {
    invoiceId: invoice.id,
    poId: po.id,
    status: exceptions.length === 0 ? 'matched' : 'exception',
    priceTolerancePct,
    exceptions,
  };
}
