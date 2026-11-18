// Access to the ERP data, loaded once from a JSON file. The only write is recording a person's decision on an
// invoice (status and decision); it lives in memory, like the rest of the mock ERP, and is lost on restart.
import { readFile } from 'node:fs/promises';
import { isSettled, type MatchContext } from './matching.js';
import {
  ErpDataSchema,
  type ErpData,
  type GoodsReceipt,
  type Invoice,
  type InvoiceDecision,
  type InvoiceStatus,
  type PurchaseOrder,
  type Supplier,
} from './schema.js';

export class ErpDataError extends Error {
  override name = 'ErpDataError';
}

// The checks a database would do with primary keys, foreign keys and unique constraints.
export function checkIntegrity(data: ErpData): string[] {
  const problems: string[] = [];
  const ids = (rows: { id: string }[], kind: string) => {
    const seen = new Set<string>();
    for (const { id } of rows) {
      if (seen.has(id)) problems.push(`Duplicate ${kind} id ${id}`);
      seen.add(id);
    }
    return seen;
  };
  const supplierIds = ids(data.suppliers, 'supplier');
  const poIds = ids(data.purchaseOrders, 'purchase order');
  ids(data.goodsReceipts, 'goods receipt');
  ids(data.invoices, 'invoice');

  const lineNumbers = new Map(data.purchaseOrders.map((po) => [po.id, new Set(po.lines.map((line) => line.lineNo))]));
  for (const po of data.purchaseOrders) {
    if (!supplierIds.has(po.supplierId)) problems.push(`${po.id} references unknown supplier ${po.supplierId}`);
    if (lineNumbers.get(po.id)?.size !== po.lines.length) problems.push(`${po.id} repeats a line number`);
  }
  for (const receipt of data.goodsReceipts) {
    const poLines = lineNumbers.get(receipt.poId);
    if (!poLines) {
      problems.push(`${receipt.id} references unknown purchase order ${receipt.poId}`);
      continue;
    }
    for (const line of receipt.lines) {
      if (!poLines.has(line.lineNo)) problems.push(`${receipt.id} receives line ${line.lineNo}, which is not on ${receipt.poId}`);
    }
  }
  // Invoice lines may legitimately be missing from the PO: that is a matching exception, not bad data.
  for (const invoice of data.invoices) {
    if (!supplierIds.has(invoice.supplierId)) problems.push(`${invoice.id} references unknown supplier ${invoice.supplierId}`);
    if (!poIds.has(invoice.poId)) problems.push(`${invoice.id} references unknown purchase order ${invoice.poId}`);
  }
  return problems;
}

// Which of two invoices comes first. Settled invoices (approved or paid) always come before pending ones,
// so a new invoice can never turn an already paid one into a duplicate, even when it is backdated.
// Within each group, the earlier invoice date wins, then the lower id.
export function comesBefore(a: Invoice, b: Invoice): boolean {
  if (isSettled(a) !== isSettled(b)) return isSettled(a);
  return a.invoiceDate < b.invoiceDate || (a.invoiceDate === b.invoiceDate && a.id < b.id);
}

export class ErpRepository {
  private readonly suppliers: Map<string, Supplier>;
  private readonly purchaseOrders: Map<string, PurchaseOrder>;
  private readonly invoices: Map<string, Invoice>;

  constructor(private readonly data: ErpData) {
    const problems = checkIntegrity(data);
    if (problems.length > 0) throw new ErpDataError(`ERP data failed integrity checks:\n- ${problems.join('\n- ')}`);
    this.suppliers = new Map(data.suppliers.map((row) => [row.id, row]));
    this.purchaseOrders = new Map(data.purchaseOrders.map((row) => [row.id, row]));
    this.invoices = new Map(data.invoices.map((row) => [row.id, row]));
  }

  static fromJson(json: unknown): ErpRepository {
    const parsed = ErpDataSchema.safeParse(json);
    if (!parsed.success) throw new ErpDataError(`ERP data has the wrong shape:\n${parsed.error.message}`);
    return new ErpRepository(parsed.data);
  }

  static async fromFile(path: string | URL): Promise<ErpRepository> {
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (error) {
      throw new ErpDataError(`Cannot read ERP data file ${String(path)}: ${(error as Error).message}`);
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (error) {
      throw new ErpDataError(`ERP data file ${String(path)} is not valid JSON: ${(error as Error).message}`);
    }
    return ErpRepository.fromJson(json);
  }

  getSupplier(id: string): Supplier | undefined {
    return this.suppliers.get(id);
  }

  getPurchaseOrder(id: string): PurchaseOrder | undefined {
    return this.purchaseOrders.get(id);
  }

  getInvoice(id: string): Invoice | undefined {
    return this.invoices.get(id);
  }

  listInvoices(): readonly Invoice[] {
    return this.data.invoices;
  }

  receiptsFor(poId: string): GoodsReceipt[] {
    return this.data.goodsReceipts.filter((receipt) => receipt.poId === poId);
  }

  // Every invoice that comes before this one, except rejected ones, which will never be paid.
  priorInvoices(invoice: Invoice): Invoice[] {
    return this.data.invoices.filter(
      (other) => other.id !== invoice.id && other.status !== 'rejected' && comesBefore(other, invoice),
    );
  }

  // Everything matchInvoice needs to check this invoice.
  matchContext(invoice: Invoice): MatchContext {
    const purchaseOrder = this.getPurchaseOrder(invoice.poId);
    // The integrity checks guarantee this; failing loudly beats matching against nothing.
    if (!purchaseOrder) throw new Error(`${invoice.id} references missing purchase order ${invoice.poId}`);
    return { purchaseOrder, receipts: this.receiptsFor(purchaseOrder.id), priorInvoices: this.priorInvoices(invoice) };
  }

  // Records a decision. Rows are replaced, never edited in place, so an invoice a caller already holds keeps
  // the values it had when it was read.
  setDecision(id: string, status: InvoiceStatus, decision: InvoiceDecision): Invoice {
    const index = this.data.invoices.findIndex((invoice) => invoice.id === id);
    const current = this.data.invoices[index];
    if (!current) throw new Error(`Invoice ${id} does not exist`);
    const updated: Invoice = { ...current, status, decision };
    this.data.invoices[index] = updated;
    this.invoices.set(id, updated);
    return updated;
  }
}
