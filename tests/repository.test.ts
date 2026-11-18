import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { ErpDataError, ErpRepository, checkIntegrity } from '../src/erp/repository.js';
import type { ErpData } from '../src/erp/schema.js';

const SAMPLE = new URL('../data/erp-sample.json', import.meta.url);
const sample = async (): Promise<ErpData> => JSON.parse(await readFile(SAMPLE, 'utf8')) as ErpData;

describe('ErpRepository', () => {
  it('loads the bundled sample data', async () => {
    const repository = await ErpRepository.fromFile(SAMPLE);
    expect(repository.listInvoices()).toHaveLength(9);
    expect(repository.getInvoice('INV-1001')?.supplierInvoiceNumber).toBe('COS-2026-0417');
    expect(repository.receiptsFor('PO-2026-0004').map((receipt) => receipt.id)).toEqual(['GR-0004', 'GR-0005']);
  });

  it('rejects a file that does not exist', async () => {
    await expect(ErpRepository.fromFile('does-not-exist.json')).rejects.toThrow(ErpDataError);
  });

  it('rejects data with the wrong shape and says which field', async () => {
    const data = await sample();
    const broken = { ...data, invoices: [{ ...data.invoices[0], dueDate: '09/10/2026' }] };
    expect(() => ErpRepository.fromJson(broken)).toThrow(/dueDate/);
  });

  it('rejects money that is not in whole minor units', async () => {
    const data = await sample();
    const [first] = data.purchaseOrders;
    const broken = { ...data, purchaseOrders: [{ ...first, lines: [{ ...first!.lines[0], unitPriceMinor: 129.5 }] }] };
    expect(() => ErpRepository.fromJson(broken)).toThrow(ErpDataError);
  });

  it('lists only earlier invoices that still count as prior invoices', async () => {
    const data = await sample();
    data.invoices = data.invoices.map((invoice) => (invoice.id === 'INV-1003' ? { ...invoice, status: 'rejected' } : invoice));
    const repository = ErpRepository.fromJson(data);
    const prior = repository.priorInvoices(repository.getInvoice('INV-1005')!).map((invoice) => invoice.id);
    // INV-1005 is dated 2026-09-25: INV-1006 has the same date but a higher id, so it comes later.
    expect(prior).toEqual(['INV-1001', 'INV-1002', 'INV-1007']);
  });
});

describe('checkIntegrity', () => {
  it('passes the sample data', async () => {
    expect(checkIntegrity(await sample())).toEqual([]);
  });

  it('catches broken references, like a foreign key would', async () => {
    const data = await sample();
    data.purchaseOrders[0]!.supplierId = 'SUP-999';
    data.invoices[0]!.poId = 'PO-2026-9999';
    data.goodsReceipts[0]!.lines.push({ lineNo: 7, quantityReceived: 1 });
    expect(checkIntegrity(data)).toEqual([
      'PO-2026-0001 references unknown supplier SUP-999',
      'GR-0001 receives line 7, which is not on PO-2026-0001',
      'INV-1001 references unknown purchase order PO-2026-9999',
    ]);
  });

  it('catches duplicate ids and repeated PO line numbers, like a unique constraint would', async () => {
    const data = await sample();
    data.invoices.push({ ...data.invoices[0]! });
    data.purchaseOrders[1]!.lines.push({ ...data.purchaseOrders[1]!.lines[0]! });
    expect(checkIntegrity(data)).toEqual(['Duplicate invoice id INV-1001', 'PO-2026-0002 repeats a line number']);
  });

  it('makes the repository refuse inconsistent data', async () => {
    const data = await sample();
    data.invoices[0]!.supplierId = 'SUP-999';
    expect(() => new ErpRepository(data)).toThrow(/unknown supplier SUP-999/);
  });
});
