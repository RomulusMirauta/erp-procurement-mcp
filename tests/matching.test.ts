import { describe, expect, it } from 'vitest';
import { matchInvoice, type MatchContext } from '../src/erp/matching.js';
import type { GoodsReceipt, Invoice, PurchaseOrder } from '../src/erp/schema.js';

const po: PurchaseOrder = {
  id: 'PO-2026-0001',
  supplierId: 'SUP-001',
  orderDate: '2026-09-01',
  currency: 'RON',
  status: 'open',
  lines: [
    { lineNo: 1, sku: 'A', description: 'Widget', quantity: 100, unitPriceMinor: 1000 },
    { lineNo: 2, sku: 'B', description: 'Gadget', quantity: 10, unitPriceMinor: 5000 },
  ],
};

const fullReceipt: GoodsReceipt = {
  id: 'GR-0001',
  poId: po.id,
  receivedDate: '2026-09-05',
  lines: [
    { lineNo: 1, quantityReceived: 100 },
    { lineNo: 2, quantityReceived: 10 },
  ],
};

function invoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: 'INV-1001',
    supplierId: 'SUP-001',
    poId: po.id,
    supplierInvoiceNumber: 'S-1',
    invoiceDate: '2026-09-10',
    dueDate: '2026-10-10',
    currency: 'RON',
    status: 'received',
    lines: [
      { lineNo: 1, description: 'Widget', quantity: 100, unitPriceMinor: 1000 },
      { lineNo: 2, description: 'Gadget', quantity: 10, unitPriceMinor: 5000 },
    ],
    ...overrides,
  };
}

const context = (overrides: Partial<MatchContext> = {}): MatchContext => ({
  purchaseOrder: po,
  receipts: [fullReceipt],
  priorInvoices: [],
  ...overrides,
});

const codes = (result: ReturnType<typeof matchInvoice>) => result.exceptions.map((exception) => exception.code);

describe('matchInvoice', () => {
  it('matches an invoice that agrees with the PO and the receipts', () => {
    const result = matchInvoice(invoice(), context());
    expect(result).toMatchObject({ invoiceId: 'INV-1001', poId: po.id, status: 'matched', exceptions: [] });
  });

  it('flags an invoice from a different supplier than the PO', () => {
    expect(codes(matchInvoice(invoice({ supplierId: 'SUP-009' }), context()))).toEqual(['SUPPLIER_MISMATCH']);
  });

  it('flags a different currency and skips the price check', () => {
    const lines = [{ lineNo: 1, description: 'Widget', quantity: 100, unitPriceMinor: 200 }];
    expect(codes(matchInvoice(invoice({ currency: 'EUR', lines }), context()))).toEqual(['CURRENCY_MISMATCH']);
  });

  it('flags a supplier invoice number that an earlier invoice already used', () => {
    const earlier = invoice({ id: 'INV-0999', invoiceDate: '2026-09-01', poId: 'PO-2026-0099' });
    expect(codes(matchInvoice(invoice(), context({ priorInvoices: [earlier] })))).toEqual(['DUPLICATE_INVOICE']);
  });

  it('does not treat the same invoice number from another supplier as a duplicate', () => {
    const other = invoice({ id: 'INV-0999', supplierId: 'SUP-002', poId: 'PO-2026-0099' });
    expect(matchInvoice(invoice(), context({ priorInvoices: [other] })).status).toBe('matched');
  });

  it('flags a line that is not on the PO', () => {
    const lines = [...invoice().lines, { lineNo: 3, description: 'Setup fee', quantity: 1, unitPriceMinor: 9900 }];
    const result = matchInvoice(invoice({ lines }), context());
    expect(result.exceptions).toEqual([expect.objectContaining({ code: 'LINE_NOT_ON_PO', lineNo: 3 })]);
  });

  describe('price tolerance', () => {
    const withLine1Price = (unitPriceMinor: number) =>
      invoice({ lines: [{ lineNo: 1, description: 'Widget', quantity: 100, unitPriceMinor }] });

    it.each([
      [1020, 'matched'],
      [980, 'matched'],
      [1021, 'exception'],
      [979, 'exception'],
    ] as const)('unit price %i against 1000 at the default 2%% is %s', (price, status) => {
      expect(matchInvoice(withLine1Price(price), context()).status).toBe(status);
    });

    it('uses the tolerance it is given', () => {
      expect(matchInvoice(withLine1Price(1050), context(), 5).status).toBe('matched');
      expect(matchInvoice(withLine1Price(1050), context(), 4).status).toBe('exception');
    });

    it('reports the variance on the right line', () => {
      const result = matchInvoice(withLine1Price(1100), context());
      expect(result.exceptions).toEqual([
        expect.objectContaining({ code: 'PRICE_VARIANCE', lineNo: 1, message: expect.stringContaining('10.00%') }),
      ]);
    });
  });

  describe('received quantity', () => {
    it('flags billing for more than was received', () => {
      const partial: GoodsReceipt = { ...fullReceipt, lines: [{ lineNo: 1, quantityReceived: 60 }, { lineNo: 2, quantityReceived: 10 }] };
      const result = matchInvoice(invoice(), context({ receipts: [partial] }));
      expect(result.exceptions).toEqual([expect.objectContaining({ code: 'QUANTITY_NOT_RECEIVED', lineNo: 1 })]);
    });

    it('adds up several receipts for the same line', () => {
      const first: GoodsReceipt = { ...fullReceipt, lines: [{ lineNo: 1, quantityReceived: 60 }, { lineNo: 2, quantityReceived: 10 }] };
      const second: GoodsReceipt = { id: 'GR-0002', poId: po.id, receivedDate: '2026-09-07', lines: [{ lineNo: 1, quantityReceived: 40 }] };
      expect(matchInvoice(invoice(), context({ receipts: [first, second] })).status).toBe('matched');
    });

    it('accepts a split invoice while the total stays within what was received', () => {
      const half = [{ lineNo: 1, description: 'Widget', quantity: 50, unitPriceMinor: 1000 }];
      const first = invoice({ id: 'INV-1001', supplierInvoiceNumber: 'S-1', lines: half });
      const second = invoice({ id: 'INV-1002', supplierInvoiceNumber: 'S-2', invoiceDate: '2026-09-11', lines: half });
      expect(matchInvoice(second, context({ priorInvoices: [first] })).status).toBe('matched');
    });

    it('flags quantity that earlier invoices on the same PO already billed', () => {
      const earlier = invoice({ id: 'INV-1000', supplierInvoiceNumber: 'S-0', invoiceDate: '2026-09-06' });
      expect(codes(matchInvoice(invoice(), context({ priorInvoices: [earlier] })))).toEqual([
        'QUANTITY_NOT_RECEIVED',
        'QUANTITY_NOT_RECEIVED',
      ]);
    });

    it('ignores earlier invoices on other POs', () => {
      const otherPo = invoice({ id: 'INV-1000', supplierInvoiceNumber: 'S-0', poId: 'PO-2026-0099' });
      expect(matchInvoice(invoice(), context({ priorInvoices: [otherPo] })).status).toBe('matched');
    });
  });

  it('reports every exception it finds, not just the first', () => {
    const lines = [{ lineNo: 1, description: 'Widget', quantity: 500, unitPriceMinor: 2000 }];
    expect(codes(matchInvoice(invoice({ supplierId: 'SUP-009', lines }), context()))).toEqual([
      'SUPPLIER_MISMATCH',
      'PRICE_VARIANCE',
      'QUANTITY_NOT_RECEIVED',
    ]);
  });
});
