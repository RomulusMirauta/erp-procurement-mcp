#!/usr/bin/env node
// Entry point: loads the ERP data and serves the tools over stdio, the transport Claude Code and Claude Desktop use
// for local servers. stdout carries the protocol, so all logging goes to stderr.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { HttpApprovalStore } from './approvals/http-store.js';
import { InMemoryApprovalStore, type ApprovalStore } from './approvals/store.js';
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

// With APPROVALS_API_URL set, approval requests go to the approvals platform; otherwise they stay in memory.
function createApprovalStore(): { store: ApprovalStore; description: string } {
  const { APPROVALS_API_URL: baseUrl, APPROVALS_API_EMAIL: email, APPROVALS_API_PASSWORD: password } = process.env;
  if (!baseUrl) return { store: new InMemoryApprovalStore(), description: 'in memory' };
  if (!email || !password) {
    throw new Error('APPROVALS_API_URL is set, so APPROVALS_API_EMAIL and APPROVALS_API_PASSWORD are required too');
  }
  return { store: new HttpApprovalStore({ baseUrl, email, password }), description: baseUrl };
}

async function main() {
  const dataFile = process.env.ERP_DATA_FILE || SAMPLE_DATA;
  const priceTolerancePct = readTolerance();
  const repository = await ErpRepository.fromFile(dataFile);
  const approvals = createApprovalStore();
  const server = createServer({ repository, approvals: approvals.store, priceTolerancePct });
  await server.connect(new StdioServerTransport());
  console.error(
    `erp-procurement MCP server running on stdio, data: ${String(dataFile)}, price tolerance: ±${priceTolerancePct}%, approvals: ${approvals.description}`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
