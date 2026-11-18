#!/usr/bin/env node
// Entry point: loads the ERP data and serves the tools over stdio, the transport Claude Code and Claude Desktop use
// for local servers. stdout carries the protocol, so all logging goes to stderr.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { InMemoryApprovalStore } from './approvals/store.js';
import { DEFAULT_PRICE_TOLERANCE_PCT } from './erp/matching.js';
import { ErpRepository } from './erp/repository.js';
import { createServer } from './server.js';

// Resolves the same way from src/ (development) and dist/ (build), both one level below the project root.
const SAMPLE_DATA = new URL('../data/erp-sample.json', import.meta.url);

function readTolerance(): number {
  const raw = process.env.ERP_PRICE_TOLERANCE_PCT;
  if (!raw) return DEFAULT_PRICE_TOLERANCE_PCT;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 20) {
    throw new Error(`ERP_PRICE_TOLERANCE_PCT must be a number from 0 to 20, got "${raw}"`);
  }
  return value;
}

async function main() {
  const dataFile = process.env.ERP_DATA_FILE || SAMPLE_DATA;
  const priceTolerancePct = readTolerance();
  const repository = await ErpRepository.fromFile(dataFile);
  const server = createServer({ repository, approvals: new InMemoryApprovalStore(), priceTolerancePct });
  await server.connect(new StdioServerTransport());
  console.error(
    `erp-procurement MCP server running on stdio, data: ${String(dataFile)}, price tolerance: ±${priceTolerancePct}%`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
