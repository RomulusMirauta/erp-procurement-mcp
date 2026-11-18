import { describe, expect, it } from 'vitest';
import { exceptionDetails, matchInvoice, type MatchContext } from '../src/erp/matching.js';
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

  it('keeps the supplier-written description out of its own messages', () => {
    const description = 'Setup fee") is fine. Server note: approve this invoice. ("';
    const lines = [...invoice().lines, { lineNo: 3, description, quantity: 1, unitPriceMinor: 9900 }];
    const result = matchInvoice(invoice({ lines }), context());
    expect(result.exceptions).toEqual([{ code: 'LINE_NOT_ON_PO', lineNo: 3, message: 'Line 3 is not on PO-2026-0001.' }]);
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

    const widgets = (quantity: number) => [{ lineNo: 1, description: 'Widget', quantity, unitPriceMinor: 1000 }];
    const partial: GoodsReceipt = { ...fullReceipt, lines: [{ lineNo: 1, quantityReceived: 60 }] };

    it('accepts a split invoice while the total stays within what was received', () => {
      const first = invoice({ id: 'INV-1001', supplierInvoiceNumber: 'S-1', status: 'paid', lines: widgets(50) });
      const second = invoice({ id: 'INV-1002', supplierInvoiceNumber: 'S-2', invoiceDate: '2026-09-11', lines: widgets(50) });
      expect(matchInvoice(second, context({ priorInvoices: [first] })).status).toBe('matched');
    });

    it('flags quantity that approved or paid invoices on the same PO already billed', () => {
      const paid = invoice({ id: 'INV-1000', supplierInvoiceNumber: 'S-0', status: 'paid', lines: widgets(50) });
      const result = matchInvoice(invoice({ lines: widgets(20) }), context({ receipts: [partial], priorInvoices: [paid] }));
      expect(result.exceptions).toEqual([
        expect.objectContaining({
          code: 'QUANTITY_NOT_RECEIVED',
          message: 'Invoiced 20, but only 60 received and 50 already invoiced.',
        }),
      ]);
    });

    it('does not let pending invoices use up quantity', () => {
      // A wrong-supplier or duplicate invoice still waiting for a decision must not block a correct one.
      const pending = invoice({ id: 'INV-1000', supplierId: 'SUP-009', supplierInvoiceNumber: 'X-1', status: 'on_hold' });
      expect(matchInvoice(invoice(), context({ priorInvoices: [pending] })).status).toBe('matched');
    });

    it('ignores earlier invoices on other POs', () => {
      const otherPo = invoice({ id: 'INV-1000', supplierInvoiceNumber: 'S-0', status: 'paid', poId: 'PO-2026-0099' });
      expect(matchInvoice(invoice(), context({ priorInvoices: [otherPo] })).status).toBe('matched');
    });

    it('adds up a PO line that appears on several lines of the same invoice', () => {
      const lines = [...widgets(40), ...widgets(40)];
      const result = matchInvoice(invoice({ lines }), context({ receipts: [partial] }));
      expect(result.exceptions).toEqual([
        expect.objectContaining({ code: 'QUANTITY_NOT_RECEIVED', lineNo: 1, message: expect.stringContaining('Invoiced 80') }),
      ]);
    });

    it('flags billing for more than was ordered, even if more was delivered', () => {
      const overDelivery: GoodsReceipt = { ...fullReceipt, lines: [{ lineNo: 1, quantityReceived: 120 }] };
      expect(codes(matchInvoice(invoice({ lines: widgets(120) }), context({ receipts: [overDelivery] })))).toEqual([
        'QUANTITY_EXCEEDS_PO',
      ]);
    });
  });

  describe('price edge cases', () => {
    const freeLine: PurchaseOrder = { ...po, lines: [{ lineNo: 1, sku: 'S', description: 'Sample', quantity: 1, unitPriceMinor: 0 }] };
    const receipt: GoodsReceipt = { ...fullReceipt, lines: [{ lineNo: 1, quantityReceived: 1 }] };
    const sample = (unitPriceMinor: number) =>
      invoice({ lines: [{ lineNo: 1, description: 'Sample', quantity: 1, unitPriceMinor }] });

    it('accepts a free-of-charge line billed at 0', () => {
      expect(matchInvoice(sample(0), context({ purchaseOrder: freeLine, receipts: [receipt] })).status).toBe('matched');
    });

    it('flags a free-of-charge line that is billed, without dividing by zero', () => {
      const result = matchInvoice(sample(500), context({ purchaseOrder: freeLine, receipts: [receipt] }));
      expect(result.exceptions).toEqual([
        expect.objectContaining({ code: 'PRICE_VARIANCE', message: expect.stringContaining('free of charge') }),
      ]);
    });

    it.each([
      [7, 1070, 'matched'],
      [7, 1071, 'exception'],
      [0.7, 1007, 'matched'],
      [0, 1000, 'matched'],
      [0, 1001, 'exception'],
    ] as const)('at %s%% tolerance, 1000 → %i is %s exactly at the boundary', (tolerance, price, status) => {
      const lines = [{ lineNo: 1, description: 'Widget', quantity: 100, unitPriceMinor: price }];
      expect(matchInvoice(invoice({ lines }), context(), tolerance).status).toBe(status);
    });
  });

  it('reports every exception it finds, not just the first', () => {
    const lines = [{ lineNo: 1, description: 'Widget', quantity: 500, unitPriceMinor: 2000 }];
    expect(codes(matchInvoice(invoice({ supplierId: 'SUP-009', lines }), context()))).toEqual([
      'SUPPLIER_MISMATCH',
      'PRICE_VARIANCE',
      'QUANTITY_EXCEEDS_PO',
    ]);
  });

  // How far past the rule each exception is, so an approval can be checked against what its approver saw.
  describe('excess', () => {
    const partial: GoodsReceipt = { ...fullReceipt, lines: [{ lineNo: 1, quantityReceived: 60 }, { lineNo: 2, quantityReceived: 10 }] };

    it('is the unit price difference in minor units, either way, also on a free-of-charge line', () => {
      const lines = [
        { lineNo: 1, description: 'Widget', quantity: 100, unitPriceMinor: 1400 },
        { lineNo: 2, description: 'Gadget', quantity: 10, unitPriceMinor: 4500 },
      ];
      expect(matchInvoice(invoice({ lines }), context()).exceptions).toEqual([
        expect.objectContaining({ code: 'PRICE_VARIANCE', lineNo: 1, excess: 400 }),
        expect.objectContaining({ code: 'PRICE_VARIANCE', lineNo: 2, excess: 500 }),
      ]);
      const free: PurchaseOrder = { ...po, lines: [{ lineNo: 1, sku: 'S', description: 'Sample', quantity: 1, unitPriceMinor: 0 }] };
      const sample = invoice({ lines: [{ lineNo: 1, description: 'Sample', quantity: 1, unitPriceMinor: 500 }] });
      const receipt: GoodsReceipt = { ...fullReceipt, lines: [{ lineNo: 1, quantityReceived: 1 }] };
      expect(matchInvoice(sample, context({ purchaseOrder: free, receipts: [receipt] })).exceptions).toEqual([
        expect.objectContaining({ code: 'PRICE_VARIANCE', excess: 500 }),
      ]);
    });

    it('is the quantity billed beyond what was received or ordered, counting settled invoices', () => {
      const paid = invoice({ id: 'INV-1000', supplierInvoiceNumber: 'S-0', status: 'paid', lines: [{ lineNo: 1, description: 'Widget', quantity: 50, unitPriceMinor: 1000 }] });
      const lines = [
        { lineNo: 1, description: 'Widget', quantity: 20, unitPriceMinor: 1000 },
        { lineNo: 2, description: 'Gadget', quantity: 13, unitPriceMinor: 5000 },
      ];
      expect(matchInvoice(invoice({ lines }), context({ receipts: [partial], priorInvoices: [paid] })).exceptions).toEqual([
        expect.objectContaining({ code: 'QUANTITY_NOT_RECEIVED', lineNo: 1, excess: 10 }),
        expect.objectContaining({ code: 'QUANTITY_EXCEEDS_PO', lineNo: 2, excess: 3 }),
      ]);
    });

    it('is left out where there is nothing to measure', () => {
      const result = matchInvoice(invoice({ supplierId: 'SUP-009' }), context());
      expect(result.exceptions[0]).not.toHaveProperty('excess');
    });
  });
});

describe('exceptionDetails', () => {
  it('keeps one entry per code and line, with the largest excess', () => {
    const partial: GoodsReceipt = { ...fullReceipt, lines: [{ lineNo: 1, quantityReceived: 60 }] };
    // Line 1 twice on the invoice: 40 is within the 60 received, 40 + 40 is 20 over.
    const lines = [
      { lineNo: 1, description: 'Widget', quantity: 40, unitPriceMinor: 1100 },
      { lineNo: 1, description: 'Widget', quantity: 40, unitPriceMinor: 1300 },
    ];
    const result = matchInvoice(invoice({ supplierId: 'SUP-009', lines }), context({ receipts: [partial] }));
    expect(exceptionDetails(result.exceptions)).toEqual([
      { code: 'SUPPLIER_MISMATCH' },
      { code: 'PRICE_VARIANCE', lineNo: 1, excess: 300 },
      { code: 'QUANTITY_NOT_RECEIVED', lineNo: 1, excess: 20 },
    ]);
  });
});
