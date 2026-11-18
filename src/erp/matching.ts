// Three-way matching: an invoice is paid only when it agrees with the purchase order (what was ordered,
// at what price) and the goods receipts (what actually arrived). Anything else is an exception for a human.
import type { GoodsReceipt, Invoice, PurchaseOrder } from './schema.js';

export type ExceptionCode =
  | 'SUPPLIER_MISMATCH'
  | 'CURRENCY_MISMATCH'
  | 'DUPLICATE_INVOICE'
  | 'LINE_NOT_ON_PO'
  | 'PRICE_VARIANCE'
  | 'QUANTITY_EXCEEDS_PO'
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
  // Invoices that come before this one (see ErpRepository.priorInvoices), from any supplier and any PO.
  // The duplicate check uses all of them; the quantity checks use only the settled ones on this PO.
  priorInvoices: readonly Invoice[];
}

export const DEFAULT_PRICE_TOLERANCE_PCT = 2;

// Approved or paid: the company has committed to pay for these quantities.
export const isSettled = (invoice: Invoice) => invoice.status === 'approved' || invoice.status === 'paid';

const sumQuantity = <T>(rows: readonly T[], quantity: (row: T) => number) => rows.reduce((sum, row) => sum + quantity(row), 0);

// Compares in integers (basis points), so a 7% tolerance means exactly 7%, and a PO price of 0 can't divide by zero.
function exceedsTolerance(invoicePrice: number, poPrice: number, tolerancePct: number): boolean {
  const toleranceBasisPoints = Math.round(tolerancePct * 100);
  return Math.abs(invoicePrice - poPrice) * 10_000 > toleranceBasisPoints * poPrice;
}

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

  // Pending invoices don't use up quantity: only what is already approved or paid does. When one of two
  // competing invoices gets approved, the other one fails its next check.
  const settledOnPo = priorInvoices.filter((other) => other.poId === po.id && isSettled(other));
  // The same PO line can appear on several invoice lines (partial batches), so this invoice's lines add up too.
  const billedOnThisInvoice = new Map<number, number>();

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

    if (sameCurrency && exceedsTolerance(line.unitPriceMinor, poLine.unitPriceMinor, priceTolerancePct)) {
      const difference =
        poLine.unitPriceMinor === 0
          ? `is ${line.unitPriceMinor} but the PO line is free of charge`
          : `differs from the PO by ${(((line.unitPriceMinor - poLine.unitPriceMinor) / poLine.unitPriceMinor) * 100).toFixed(2)}%`;
      exceptions.push({
        code: 'PRICE_VARIANCE',
        lineNo: line.lineNo,
        message: `Unit price ${difference} (tolerance ±${priceTolerancePct}%).`,
      });
    }

    const billedHere = (billedOnThisInvoice.get(line.lineNo) ?? 0) + line.quantity;
    billedOnThisInvoice.set(line.lineNo, billedHere);
    const received = sumQuantity(
      receipts.flatMap((receipt) => receipt.lines.filter((row) => row.lineNo === line.lineNo)),
      (row) => row.quantityReceived,
    );
    const alreadyInvoiced = sumQuantity(
      settledOnPo.flatMap((other) => other.lines.filter((row) => row.lineNo === line.lineNo)),
      (row) => row.quantity,
    );
    if (alreadyInvoiced + billedHere > poLine.quantity) {
      exceptions.push({
        code: 'QUANTITY_EXCEEDS_PO',
        lineNo: line.lineNo,
        message: `Invoiced ${billedHere}, but only ${poLine.quantity} ordered and ${alreadyInvoiced} already invoiced.`,
      });
    } else if (alreadyInvoiced + billedHere > received) {
      exceptions.push({
        code: 'QUANTITY_NOT_RECEIVED',
        lineNo: line.lineNo,
        message: `Invoiced ${billedHere}, but only ${received} received and ${alreadyInvoiced} already invoiced.`,
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
