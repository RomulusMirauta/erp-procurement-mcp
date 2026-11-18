import type { Currency } from './schema.js';

export interface Money {
  amountMinor: number;
  currency: Currency;
  formatted: string;
}

const formatter = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function money(amountMinor: number, currency: Currency): Money {
  return { amountMinor, currency, formatted: `${formatter.format(amountMinor / 100)} ${currency}` };
}

export function lineTotalMinor(lines: readonly { quantity: number; unitPriceMinor: number }[]): number {
  return lines.reduce((sum, line) => sum + line.quantity * line.unitPriceMinor, 0);
}
